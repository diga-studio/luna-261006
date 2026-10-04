// Package terrasync implements an incremental, checkpointable CSV parser
// for append-only local files. Callers feed bytes in order; the library
// performs no file discovery or scheduling.
package terrasync

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Encoding selects the byte encoding of the input file.
type Encoding int

const (
	UTF8 Encoding = iota
	UTF16LE
)

// Record is one completed CSV record.
type Record struct {
	Fields []string
	Start  int64 // absolute byte offset of the first byte of the record
	End    int64 // absolute byte offset one past the record terminator
}

// ParseError reports a format or decoding error at an absolute byte offset.
type ParseError struct {
	Offset int64
	Msg    string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("csv: parse error at byte offset %d: %s", e.Offset, e.Msg)
}

// fsm states
const (
	stFieldStart   = iota // at the beginning of a field
	stInField             // inside an unquoted field
	stInQuoted            // inside a quoted field
	stQuoteSeen           // saw '"' inside a quoted field
	stCRSeen              // saw CR outside quotes; only LF may follow
)

// Parser is an incremental CSV parser. It is not safe for concurrent use.
type Parser struct {
	enc Encoding

	state      int   // fsm state
	bomChecked bool  // whether the leading-BOM check has been done
	recActive  bool  // current record has seen field content, comma or quote
	recStart   int64 // absolute offset of the first byte of the current record
	nextOff    int64 // absolute offset of the next unconsumed input byte

	fields  []string
	field   strings.Builder
	pending []byte // undecoded trailing bytes (< one full code unit sequence)
	crOff   int64 // absolute offset of the CR seen in stCRSeen

	finished bool
	err      *ParseError // sticky error
}

// New creates a parser for the given encoding.
func New(enc Encoding) *Parser {
	return &Parser{enc: enc, state: stFieldStart}
}

func (p *Parser) fail(offset int64, msg string) *ParseError {
	if p.err == nil {
		p.err = &ParseError{Offset: offset, Msg: msg}
	}
	return p.err
}

// Feed consumes the next chunk of bytes and returns the records that were
// completed by it. An empty input does not mean end of file. Records
// completed before a detected error are still returned alongside the error.
func (p *Parser) Feed(b []byte) ([]Record, error) {
	if p.err != nil {
		return nil, p.err
	}
	if p.finished {
		return nil, p.fail(p.nextOff, "Feed called after Finish")
	}
	if len(b) == 0 {
		return nil, nil
	}
	data := b
	if len(p.pending) > 0 {
		data = make([]byte, 0, len(p.pending)+len(b))
		data = append(data, p.pending...)
		data = append(data, b...)
		p.pending = p.pending[:0]
	}
	var recs []Record
	pos := 0
	for pos < len(data) {
		r, size, ok, bad := p.decodeRune(data[pos:])
		if !ok {
			// Incomplete code unit at end of available bytes: wait for more.
			p.pending = append(p.pending, data[pos:]...)
			break
		}
		if bad {
			p.fail(p.nextOff+int64(pos), "invalid "+encName(p.enc)+" encoding")
			return recs, p.err
		}
		off := p.nextOff + int64(pos)
		pos += size
		if !p.bomChecked {
			p.bomChecked = true
			if r == '\ufeff' {
				// Strip a single BOM at the very start of the file.
				p.recStart = p.nextOff + int64(pos)
				continue
			}
		}
		if rec, ok := p.step(r, off); ok {
			recs = append(recs, rec)
		}
		if p.err != nil {
			return recs, p.err
		}
	}
	p.nextOff += int64(len(data) - len(p.pending))
	return recs, nil
}

// Finish signals permanent end of file. It returns the final record if the
// input ends with a legal unterminated record, or an error for unterminated
// quoted fields, lone CR, or incomplete encoding units.
func (p *Parser) Finish() ([]Record, error) {
	if p.err != nil {
		return nil, p.err
	}
	if p.finished {
		return nil, p.fail(p.nextOff, "Finish called twice")
	}
	p.finished = true
	if len(p.pending) > 0 {
		return nil, p.fail(p.nextOff, "incomplete "+encName(p.enc)+" code unit at end of file")
	}
	switch p.state {
	case stFieldStart:
		if !p.recActive {
			return nil, nil // empty file or trailing newline: no extra record
		}
		p.endField()
		rec := p.emitRecord(p.nextOff)
		return []Record{rec}, nil
	case stInField:
		p.endField()
		rec := p.emitRecord(p.nextOff)
		return []Record{rec}, nil
	case stQuoteSeen:
		p.endField()
		rec := p.emitRecord(p.nextOff)
		return []Record{rec}, nil
	case stInQuoted:
		return nil, p.fail(p.recStart, "unterminated quoted field")
	case stCRSeen:
		return nil, p.fail(p.crOff, "lone CR at end of file")
	}
	return nil, nil
}

// decodeRune decodes one rune from b. ok=false means b holds only an
// incomplete prefix and more bytes are needed. bad=true reports a
// definitively invalid encoding.
func (p *Parser) decodeRune(b []byte) (r rune, size int, ok, bad bool) {
	if p.enc == UTF8 {
		if !utf8.FullRune(b) {
			return 0, 0, false, false
		}
		r, size = utf8.DecodeRune(b)
		if r == utf8.RuneError && size <= 1 {
			return 0, size, true, true
		}
		return r, size, true, false
	}
	// UTF-16LE
	if len(b) < 2 {
		return 0, 0, false, false
	}
	u := uint16(b[0]) | uint16(b[1])<<8
	switch {
	case 0xD800 <= u && u < 0xDC00: // high surrogate
		if len(b) < 4 {
			return 0, 0, false, false
		}
		u2 := uint16(b[2]) | uint16(b[3])<<8
		if u2 < 0xDC00 || u2 >= 0xE000 {
			return 0, 2, true, true // unpaired high surrogate
		}
		return rune(u-0xD800)<<10 + rune(u2-0xDC00) + 0x10000, 4, true, false
	case 0xDC00 <= u && u < 0xE000:
		return 0, 2, true, true // lone low surrogate
	default:
		return rune(u), 2, true, false
	}
}

// step advances the CSV state machine by one rune located at absolute byte
// offset off. It returns a completed record when one is finished.
func (p *Parser) step(r rune, off int64) (Record, bool) {
	switch p.state {
	case stFieldStart:
		switch r {
		case '"':
			p.recActive = true
			p.state = stInQuoted
		case ',':
			p.recActive = true
			p.endField()
		case '\n':
			p.endField()
			return p.emitRecord(off + int64(p.runewidth(r))), true
		case '\r':
			p.recActive = true
			p.endField()
			p.crOff = off
			p.state = stCRSeen
		default:
			p.recActive = true
			p.field.WriteRune(r)
			p.state = stInField
		}
	case stInField:
		switch r {
		case ',':
			p.endField()
			p.state = stFieldStart
		case '\n':
			p.endField()
			return p.emitRecord(off + int64(p.runewidth(r))), true
		case '\r':
			p.endField()
			p.crOff = off
			p.state = stCRSeen
		case '"':
			p.fail(off, `unexpected '"' inside unquoted field`)
		default:
			p.field.WriteRune(r)
		}
	case stInQuoted:
		if r == '"' {
			p.state = stQuoteSeen
		} else {
			p.field.WriteRune(r)
		}
	case stQuoteSeen:
		switch r {
		case '"':
			p.field.WriteByte('"')
			p.state = stInQuoted
		case ',':
			p.endField()
			p.state = stFieldStart
		case '\n':
			p.endField()
			return p.emitRecord(off + int64(p.runewidth(r))), true
		case '\r':
			p.endField()
			p.crOff = off
			p.state = stCRSeen
		default:
			p.fail(off, `unexpected character after closing '"'`)
		}
	case stCRSeen:
		if r == '\n' {
			p.state = stFieldStart
			return p.emitRecord(off + int64(p.runewidth(r))), true
		}
		p.fail(p.crOff, "lone CR not followed by LF")
	}
	return Record{}, false
}

// runewidth returns the encoded byte length of r in the parser's encoding.
func (p *Parser) runewidth(r rune) int {
	if p.enc == UTF8 {
		return utf8.RuneLen(r)
	}
	if r > 0xFFFF {
		return 4
	}
	return 2
}

// endField closes the current field and appends it to the pending record.
func (p *Parser) endField() {
	p.fields = append(p.fields, p.field.String())
	p.field.Reset()
}

// emitRecord closes the pending record spanning [recStart, end).
func (p *Parser) emitRecord(end int64) Record {
	rec := Record{Fields: p.fields, Start: p.recStart, End: end}
	p.fields = nil
	p.recActive = false
	p.state = stFieldStart
	p.recStart = end
	return rec
}

func encName(enc Encoding) string {
	if enc == UTF16LE {
		return "UTF-16LE"
	}
	return "UTF-8"
}
