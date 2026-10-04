package terrasync

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// TestHugeQuotedFieldByteByByte feeds an 8 MiB quoted field one byte at a
// time. Besides correctness this exposes quadratic rescanning or repeated
// copying of the accumulated half-record: with any such behavior the test
// would take minutes instead of milliseconds.
func TestHugeQuotedFieldByteByByte(t *testing.T) {
	const size = 8 << 20 // 8 MiB
	body := strings.Repeat("ab", size/2)
	var buf bytes.Buffer
	buf.WriteString(`"`)
	buf.WriteString(body)
	buf.WriteString(`",tail` + "\n")
	data := buf.Bytes()

	p := New(UTF8)
	start := time.Now()
	var got []Record
	for i := 0; i < len(data); i++ {
		recs, err := p.Feed(data[i : i+1])
		if err != nil {
			t.Fatalf("Feed byte %d: %v", i, err)
		}
		got = append(got, recs...)
	}
	recs, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	got = append(got, recs...)
	elapsed := time.Since(start)
	t.Logf("fed %d bytes byte-by-byte in %v", len(data), elapsed)

	want := []Record{{Fields: []string{body, "tail"}, Start: 0, End: int64(len(data))}}
	if len(got) != 1 {
		t.Fatalf("got %d records, want 1", len(got))
	}
	if got[0].Start != want[0].Start || got[0].End != want[0].End {
		t.Fatalf("range = [%d,%d), want [%d,%d)", got[0].Start, got[0].End, want[0].Start, want[0].End)
	}
	if len(got[0].Fields) != 2 || got[0].Fields[0] != body || got[0].Fields[1] != "tail" {
		t.Fatal("field contents mismatch")
	}
	if elapsed > 30*time.Second {
		t.Fatalf("too slow (%v); likely quadratic rescanning or copying", elapsed)
	}
}

// TestHugeQuotedFieldCheckpointMidway checkpoints in the middle of the huge
// quoted field and resumes byte-by-byte from the restored parser.
func TestHugeQuotedFieldCheckpointMidway(t *testing.T) {
	const size = 1 << 20
	body := strings.Repeat("z", size)
	data := []byte(`"` + body + `"` + "\n")

	p := New(UTF8)
	mid := len(data) / 2
	if _, err := p.Feed(data[:mid]); err != nil {
		t.Fatal(err)
	}
	state, nextOff, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if nextOff != int64(mid) {
		t.Fatalf("next offset = %d, want %d", nextOff, mid)
	}
	q, _, err := Restore(state)
	if err != nil {
		t.Fatal(err)
	}
	var got []Record
	for i := mid; i < len(data); i++ {
		recs, err := q.Feed(data[i : i+1])
		if err != nil {
			t.Fatalf("Feed byte %d: %v", i, err)
		}
		got = append(got, recs...)
	}
	recs, err := q.Finish()
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, recs...)
	if len(got) != 1 || len(got[0].Fields) != 1 || got[0].Fields[0] != body {
		t.Fatal("restored parser produced wrong record")
	}
	if got[0].Start != 0 || got[0].End != int64(len(data)) {
		t.Fatalf("range = [%d,%d), want [0,%d)", got[0].Start, got[0].End, len(data))
	}
}
