package terrasync

import (
	"errors"
	"unicode/utf8"
)

// Encoding selects the strict text encoding of the CSV byte stream.
type Encoding int

const (
	UTF8 Encoding = iota
	UTF16LE
)

// Record is one completed CSV record.
// Start and End are the half-open byte interval in the original file,
// including the record terminator and excluding a leading BOM.
type Record struct {
	Fields []string
	Start  int64
	End    int64
}

// parseState is the CSV state machine state.
type parseState int

const (
	stateFieldStart    parseState = iota // at the beginning of a field
	stateInField                         // inside an unquoted field
	stateInQuoted                        // inside a quoted field
	stateQuoteInQuoted                   // saw a '"' inside a quoted field
	stateCRSeen                          // saw CR outside quotes; expect LF
)

// Parser is an incremental, checkpointable CSV parser for append-only files.
// Memory use is proportional to the current unfinished record only.
type Parser struct {
	enc           Encoding
	state         parseState
	undecoded     []byte // raw bytes not yet decodable (incomplete unit)
	nextOffset    int64  // absolute offset of the next byte to be fed
	recordStart   int64  // absolute offset of the current record's first byte
	recordStarted bool   // current record has consumed at least one byte
	atFileStart   bool   // no rune consumed yet (a single BOM may follow)
	fields        []string
	fieldBuf      []byte
	finished      bool
	err           error
}

// New creates a parser for a fresh file using the given encoding.
func New(enc Encoding) *Parser {
	return &Parser{enc: enc, state: stateFieldStart, atFileStart: true}
}

// Feed consumes the next chunk of bytes and returns every record that
// completes within it. Empty input is allowed and does not signal end of
// file. On error, records completed before the failure are still returned.
func (p *Parser) Feed(data []byte) ([]Record, error) {
	if p.err != nil {
		return nil, p.err
	}
	if p.finished {
		return nil, errors.New("terrasync: Feed after Finish")
	}
	if len(data) > 0 {
		p.undecoded = append(p.undecoded, data...)
		p.nextOffset += int64(len(data))
	}
	var recs []Record
	for len(p.undecoded) > 0 {
		off := p.nextOffset - int64(len(p.undecoded))
		r, width, needMore, err := decodeRune(p.enc, p.undecoded, off)
		if err != nil {
			p.err = err
			return recs, err
		}
		if needMore {
			break
		}
		rec, ok, err := p.step(r, off, off+int64(width))
		if err != nil {
			p.err = err
			return recs, err
		}
		p.undecoded = p.undecoded[width:]
		if ok {
			recs = append(recs, rec)
		}
	}
	// Release the input staging buffer once drained; keep at most a few
	// bytes of an incomplete encoded character, never the fed chunk.
	if len(p.undecoded) == 0 {
		p.undecoded = nil
	} else if cap(p.undecoded) > 64 {
		p.undecoded = append([]byte(nil), p.undecoded...)
	}
	return recs, nil
}

// Finish signals permanent end of file. It returns the final record if the
// file ends without a terminator, or an error for an unterminated quote,
// incomplete code unit, unpaired surrogate, or trailing lone CR.
func (p *Parser) Finish() ([]Record, error) {
	if p.err != nil {
		return nil, p.err
	}
	if p.finished {
		return nil, errors.New("terrasync: Finish called twice")
	}
	p.finished = true
	if len(p.undecoded) > 0 {
		off := p.nextOffset - int64(len(p.undecoded))
		p.err = &ParseError{Offset: off, Msg: "incomplete encoded character at end of file"}
		return nil, p.err
	}
	switch p.state {
	case stateInQuoted:
		p.err = &ParseError{Offset: p.recordStart, Msg: "unterminated quoted field"}
		return nil, p.err
	case stateCRSeen:
		off := p.nextOffset
		if p.enc == UTF16LE {
			off -= 2
		} else {
			off--
		}
		p.err = &ParseError{Offset: off, Msg: "lone CR at end of file"}
		return nil, p.err
	}
	if !p.recordStarted {
		return nil, nil // empty file, BOM-only file, or trailing newline
	}
	p.endField()
	rec := p.emitRecord(p.nextOffset)
	return []Record{rec}, nil
}

// step advances the state machine by one rune occupying [start, end) in the
// original file. It reports a record when the rune completes one.
func (p *Parser) step(r rune, start, end int64) (Record, bool, error) {
	if p.atFileStart {
		p.atFileStart = false
		if r == 0xFEFF { // strip a single leading BOM
			p.recordStart = end
			return Record{}, false, nil
		}
	}
	switch p.state {
	case stateFieldStart:
		p.recordStarted = true
		switch r {
		case '"':
			p.state = stateInQuoted
		case ',':
			p.endField()
		case '\n':
			p.endField()
			return p.emitRecord(end), true, nil
		case '\r':
			p.state = stateCRSeen
		default:
			p.fieldBuf = utf8.AppendRune(p.fieldBuf, r)
			p.state = stateInField
		}
	case stateInField:
		switch r {
		case ',':
			p.endField()
			p.state = stateFieldStart
		case '\n':
			p.endField()
			return p.emitRecord(end), true, nil
		case '\r':
			p.state = stateCRSeen
		case '"':
			return Record{}, false, &ParseError{Offset: start, Msg: "quote not at field start"}
		default:
			p.fieldBuf = utf8.AppendRune(p.fieldBuf, r)
		}
	case stateInQuoted:
		if r == '"' {
			p.state = stateQuoteInQuoted
		} else {
			p.fieldBuf = utf8.AppendRune(p.fieldBuf, r)
		}
	case stateQuoteInQuoted:
		switch r {
		case '"':
			p.fieldBuf = append(p.fieldBuf, '"')
			p.state = stateInQuoted
		case ',':
			p.endField()
			p.state = stateFieldStart
		case '\n':
			p.endField()
			return p.emitRecord(end), true, nil
		case '\r':
			p.state = stateCRSeen
		default:
			return Record{}, false, &ParseError{Offset: start, Msg: "unexpected character after closing quote"}
		}
	case stateCRSeen:
		if r != '\n' {
			off := start
			if p.enc == UTF16LE {
				off -= 2
			} else {
				off--
			}
			return Record{}, false, &ParseError{Offset: off, Msg: "lone CR not followed by LF"}
		}
		p.endField()
		return p.emitRecord(end), true, nil
	}
	return Record{}, false, nil
}

// endField closes the pending field and appends it to the current record.
func (p *Parser) endField() {
	p.fields = append(p.fields, string(p.fieldBuf))
	p.fieldBuf = p.fieldBuf[:0]
}

// emitRecord packs the completed fields and resets per-record state.
// end is the absolute offset just past the record terminator (or EOF).
func (p *Parser) emitRecord(end int64) Record {
	rec := Record{Fields: p.fields, Start: p.recordStart, End: end}
	p.fields = nil
	p.fieldBuf = nil // drop capacity of the completed record
	p.state = stateFieldStart
	p.recordStart = end
	p.recordStarted = false
	return rec
}
