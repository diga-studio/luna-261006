package terrasync

import (
	"bytes"
	"encoding/gob"
	"errors"
	"fmt"
)

// checkpointMagic identifies the snapshot format and version.
const checkpointMagic = "terrasync\x00\x01"

// checkpointState is the serialized, self-contained parser snapshot.
type checkpointState struct {
	Enc           Encoding
	State         parseState
	Undecoded     []byte
	NextOffset    int64
	RecordStart   int64
	RecordStarted bool
	AtFileStart   bool
	Fields        []string
	FieldBuf      []byte
}

// Checkpoint exports a self-contained snapshot of the parser state plus the
// absolute offset of the next input byte the caller must provide. It is
// valid after any Feed that did not report an error, at any byte boundary;
// it fails after Finish or after an error.
func (p *Parser) Checkpoint() (state []byte, nextOffset int64, err error) {
	if p.err != nil {
		return nil, 0, fmt.Errorf("terrasync: cannot checkpoint after error: %w", p.err)
	}
	if p.finished {
		return nil, 0, errors.New("terrasync: cannot checkpoint after Finish")
	}
	snap := checkpointState{
		Enc:           p.enc,
		State:         p.state,
		Undecoded:     append([]byte(nil), p.undecoded...),
		NextOffset:    p.nextOffset,
		RecordStart:   p.recordStart,
		RecordStarted: p.recordStarted,
		AtFileStart:   p.atFileStart,
		Fields:        append([]string(nil), p.fields...),
		FieldBuf:      append([]byte(nil), p.fieldBuf...),
	}
	var buf bytes.Buffer
	buf.WriteString(checkpointMagic)
	if err := gob.NewEncoder(&buf).Encode(snap); err != nil {
		return nil, 0, fmt.Errorf("terrasync: checkpoint encode: %w", err)
	}
	return buf.Bytes(), p.nextOffset, nil
}

// Restore recreates a parser from checkpoint bytes produced by Checkpoint.
// The caller continues feeding data starting at the offset Checkpoint
// returned; the original parser may already be destroyed.
func Restore(state []byte) (*Parser, error) {
	if len(state) < len(checkpointMagic) || string(state[:len(checkpointMagic)]) != checkpointMagic {
		return nil, errors.New("terrasync: invalid checkpoint header")
	}
	var snap checkpointState
	if err := gob.NewDecoder(bytes.NewReader(state[len(checkpointMagic):])).Decode(&snap); err != nil {
		return nil, fmt.Errorf("terrasync: checkpoint decode: %w", err)
	}
	return &Parser{
		enc:           snap.Enc,
		state:         snap.State,
		undecoded:     snap.Undecoded,
		nextOffset:    snap.NextOffset,
		recordStart:   snap.RecordStart,
		recordStarted: snap.RecordStarted,
		atFileStart:   snap.AtFileStart,
		fields:        snap.Fields,
		fieldBuf:      snap.FieldBuf,
	}, nil
}
