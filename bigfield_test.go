package terrasync

import (
	"bytes"
	"strings"
	"testing"
	"unicode/utf16"
)

// TestLargeQuotedFieldByteByByte streams an 8 MiB quoted field one byte at a
// time. This must complete quickly and correctly; any rescanning or repeated
// copying of the accumulated partial record would make it quadratic.
func TestLargeQuotedFieldByteByByte(t *testing.T) {
	const size = 8 << 20
	var sb strings.Builder
	sb.Grow(size)
	for sb.Len() < size {
		sb.WriteString("abc,\"\r\n💪") // comma, quote, CRLF, non-BMP inside quotes
	}
	body := sb.String() // logical field value, rune-aligned, >= 8 MiB

	data := make([]byte, 0, 2*size+8)
	data = append(data, 0xEF, 0xBB, 0xBF) // BOM
	data = append(data, '"')
	data = append(data, strings.ReplaceAll(body, `"`, `""`)...)
	data = append(data, '"', ',', 'z', '\n')

	p := New(UTF8)
	var recs []Record
	for i := 0; i < len(data); i++ {
		r, err := p.Feed(data[i : i+1])
		if err != nil {
			t.Fatalf("byte %d: %v", i, err)
		}
		recs = append(recs, r...)
	}
	tail, err := p.Finish()
	if err != nil {
		t.Fatal(err)
	}
	recs = append(recs, tail...)

	if len(recs) != 1 {
		t.Fatalf("records = %d, want 1", len(recs))
	}
	rec := recs[0]
	want := []string{body, "z"}
	if len(rec.Fields) != 2 || rec.Fields[0] != want[0] || rec.Fields[1] != "z" {
		t.Fatalf("field mismatch: got %d fields, first len %d", len(rec.Fields), len(rec.Fields[0]))
	}
	if rec.Start != 3 || rec.End != int64(len(data)) {
		t.Fatalf("span = [%d,%d), want [3,%d)", rec.Start, rec.End, len(data))
	}
}

// TestCheckpointMidLargeField snapshots in the middle of a large quoted
// field and confirms the restored parser finishes the record alone.
func TestCheckpointMidLargeField(t *testing.T) {
	const size = 1 << 20
	body := strings.Repeat("x,\"\n", size/4) // logical value with quote and newline
	data := []byte("\"" + strings.ReplaceAll(body, `"`, `""`) + "\"\n")

	cut := len(data) / 2
	p := New(UTF8)
	if _, err := p.Feed(data[:cut]); err != nil {
		t.Fatal(err)
	}
	state, off, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if off != int64(cut) {
		t.Fatalf("offset = %d, want %d", off, cut)
	}
	p = nil

	q, err := Restore(state)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, q, data[cut:])
	if len(got) != 1 || len(got[0].Fields) != 1 || got[0].Fields[0] != body {
		t.Fatalf("restored record mismatch: %+v", got)
	}
	if got[0].Start != 0 || got[0].End != int64(len(data)) {
		t.Fatalf("span = [%d,%d), want [0,%d)", got[0].Start, got[0].End, len(data))
	}
}

// TestLargeFieldUTF16LE repeats the streaming check for UTF-16LE with a
// checkpoint taken on an odd byte boundary.
func TestLargeFieldUTF16LE(t *testing.T) {
	const units = 1 << 19 // 1 MiB of UTF-16 code units
	var buf bytes.Buffer
	buf.Write([]byte{0xFF, 0xFE})
	put := func(s string) {
		for _, u := range utf16units(s) {
			buf.WriteByte(byte(u))
			buf.WriteByte(byte(u >> 8))
		}
	}
	put("\"")
	body := strings.Repeat("ab💪\r\n", units/5)
	put(body)
	put("\"\n")
	data := buf.Bytes()

	cut := len(data)/2 | 1 // odd cut: splits a UTF-16 code unit
	p := New(UTF16LE)
	if _, err := p.Feed(data[:cut]); err != nil {
		t.Fatal(err)
	}
	state, _, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	q, err := Restore(state)
	if err != nil {
		t.Fatal(err)
	}
	var recs []Record
	for i := cut; i < len(data); i++ {
		r, err := q.Feed(data[i : i+1])
		if err != nil {
			t.Fatalf("byte %d: %v", i, err)
		}
		recs = append(recs, r...)
	}
	tail, err := q.Finish()
	if err != nil {
		t.Fatal(err)
	}
	recs = append(recs, tail...)
	if len(recs) != 1 || len(recs[0].Fields) != 1 || recs[0].Fields[0] != body {
		t.Fatalf("record mismatch: %d records", len(recs))
	}
	if recs[0].Start != 2 || recs[0].End != int64(len(data)) {
		t.Fatalf("span = [%d,%d), want [2,%d)", recs[0].Start, recs[0].End, len(data))
	}
}

func utf16units(s string) []uint16 {
	return utf16.Encode([]rune(s))
}
