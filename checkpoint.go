package terrasync

import (
	"bytes"
	"encoding/gob"
	"errors"
	"fmt"
)

// checkpointMagic identifies and versions the checkpoint format.
const checkpointMagic = "terrasync-csv-1"

// checkpointState is the serializable form of a Parser. It contains no
// process-local handles; sizes grow only with the unfinished record.
type checkpointState struct {
	Magic      string
	Encoding   Encoding
	State      int
	BOMChecked bool
	RecActive  bool
	RecStart   int64
	NextOff    int64
	Fields     []string
	Field      string
	Pending    []byte
	CROff      int64
}

// Checkpoint exports a self-contained parser state plus the absolute offset
// of the next input byte the caller should supply. It may be called after
// any Feed that did not report an error; no record boundary is required.
// The caller may continue using the parser afterwards.
func (p *Parser) Checkpoint() (state []byte, nextOffset int64, err error) {
	if p.err != nil {
		return nil, 0, p.err
	}
	if p.finished {
		return nil, 0, fmt.Errorf("csv: cannot checkpoint after Finish")
	}
	cs := checkpointState{
		Magic:      checkpointMagic,
		Encoding:   p.enc,
		State:      p.state,
		BOMChecked: p.bomChecked,
		RecActive:  p.recActive,
		RecStart:   p.recStart,
		NextOff:    p.nextOff,
		Fields:     p.fields,
		Field:      p.field.String(),
		Pending:    p.pending,
		CROff:      p.crOff,
	}
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(cs); err != nil {
		return nil, 0, err
	}
	// The caller has already supplied the undecoded pending bytes, so the
	// next input offset lies past them; the parser still tracks their
	// absolute position internally.
	return buf.Bytes(), p.nextOff + int64(len(p.pending)), nil
}

// Restore recreates a parser from checkpoint state bytes. The caller must
// continue feeding data starting at the returned absolute offset; no file
// prefix needs to be re-read.
func Restore(state []byte) (p *Parser, nextOffset int64, err error) {
	var cs checkpointState
	if err := gob.NewDecoder(bytes.NewReader(state)).Decode(&cs); err != nil {
		return nil, 0, fmt.Errorf("csv: invalid checkpoint: %w", err)
	}
	if cs.Magic != checkpointMagic {
		return nil, 0, errors.New("csv: unsupported checkpoint format")
	}
	if cs.Encoding != UTF8 && cs.Encoding != UTF16LE {
		return nil, 0, errors.New("csv: checkpoint has unknown encoding")
	}
	p = &Parser{
		enc:        cs.Encoding,
		state:      cs.State,
		bomChecked: cs.BOMChecked,
		recActive:  cs.RecActive,
		recStart:   cs.RecStart,
		nextOff:    cs.NextOff,
		fields:     cs.Fields,
		pending:    cs.Pending,
		crOff:      cs.CROff,
	}
	p.field.WriteString(cs.Field)
	// As in Checkpoint, the caller-visible resume offset lies past the
	// already-supplied pending bytes.
	return p, cs.NextOff + int64(len(cs.Pending)), nil
}
