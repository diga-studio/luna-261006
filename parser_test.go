package terrasync

import (
	"reflect"
	"testing"
	"unicode/utf16"
)

// csvContent holds the logical CSV text used by the checkpoint/restore
// sweep: escaped quotes, a CRLF inside quotes, a non-BMP emoji, an empty
// line, a trailing empty field, and an unterminated last line.
const csvContent = "a,\"b\"\"c\r\nd\",💪\n\nx,\ntail"

var csvExpectedFields = [][]string{
	{"a", "b\"c\r\nd", "💪"},
	{""},
	{"x", ""},
	{"tail"},
}

// Byte intervals were computed by hand from the content above.
var csvExpectedUTF8 = []Record{
	{Start: 3, End: 20},
	{Start: 20, End: 21},
	{Start: 21, End: 24},
	{Start: 24, End: 28},
}

var csvExpectedUTF16LE = []Record{
	{Start: 2, End: 32},
	{Start: 32, End: 34},
	{Start: 34, End: 40},
	{Start: 40, End: 48},
}

func encodeUTF8(s string) []byte {
	return append([]byte{0xEF, 0xBB, 0xBF}, []byte(s)...)
}

func encodeUTF16LE(s string) []byte {
	out := []byte{0xFF, 0xFE}
	for _, u := range utf16.Encode([]rune(s)) {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

func expectedRecords(fields [][]string, spans []Record) []Record {
	out := make([]Record, len(fields))
	for i := range fields {
		out[i] = Record{Fields: fields[i], Start: spans[i].Start, End: spans[i].End}
	}
	return out
}

func collect(t *testing.T, p *Parser, chunks ...[]byte) []Record {
	t.Helper()
	var all []Record
	for _, c := range chunks {
		recs, err := p.Feed(c)
		if err != nil {
			t.Fatalf("Feed: %v", err)
		}
		all = append(all, recs...)
	}
	recs, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return append(all, recs...)
}

func assertRecords(t *testing.T, got, want []Record) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("record count = %d, want %d\ngot:  %+v", len(got), len(want), got)
	}
	for i := range want {
		if !reflect.DeepEqual(got[i].Fields, want[i].Fields) {
			t.Errorf("record %d fields = %q, want %q", i, got[i].Fields, want[i].Fields)
		}
		if got[i].Start != want[i].Start || got[i].End != want[i].End {
			t.Errorf("record %d span = [%d,%d), want [%d,%d)", i, got[i].Start, got[i].End, want[i].Start, want[i].End)
		}
	}
}

// TestCheckpointRestoreEveryByteBoundary feeds the file up to every possible
// byte cut, checkpoints, restores into a fresh parser, and streams the rest
// byte-by-byte with empty Feeds interleaved. Results must match the
// explicitly stated fields and byte intervals.
func TestCheckpointRestoreEveryByteBoundary(t *testing.T) {
	cases := []struct {
		name  string
		enc   Encoding
		data  []byte
		spans []Record
	}{
		{"utf8", UTF8, encodeUTF8(csvContent), csvExpectedUTF8},
		{"utf16le", UTF16LE, encodeUTF16LE(csvContent), csvExpectedUTF16LE},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := expectedRecords(csvExpectedFields, tc.spans)

			// Baseline: single shot, no checkpointing.
			assertRecords(t, collect(t, New(tc.enc), tc.data), want)

			for cut := 0; cut <= len(tc.data); cut++ {
				p := New(tc.enc)
				var got []Record
				recs, err := p.Feed(tc.data[:cut])
				if err != nil {
					t.Fatalf("cut %d: Feed prefix: %v", cut, err)
				}
				got = append(got, recs...)
				if _, err := p.Feed(nil); err != nil { // empty Feed before checkpoint
					t.Fatalf("cut %d: empty Feed: %v", cut, err)
				}
				state, off, err := p.Checkpoint()
				if err != nil {
					t.Fatalf("cut %d: Checkpoint: %v", cut, err)
				}
				if off != int64(cut) {
					t.Fatalf("cut %d: next offset = %d", cut, off)
				}
				q, err := Restore(state)
				if err != nil {
					t.Fatalf("cut %d: Restore: %v", cut, err)
				}
				// Stream the remainder byte-by-byte, interleaving empty Feeds.
				for i := cut; i < len(tc.data); i++ {
					recs, err := q.Feed(tc.data[i : i+1])
					if err != nil {
						t.Fatalf("cut %d: Feed byte %d: %v", cut, i, err)
					}
					got = append(got, recs...)
					if i%3 == 0 {
						if _, err := q.Feed(nil); err != nil {
							t.Fatalf("cut %d: empty Feed: %v", cut, err)
						}
					}
				}
				recs, err = q.Finish()
				if err != nil {
					t.Fatalf("cut %d: Finish: %v", cut, err)
				}
				got = append(got, recs...)
				assertRecords(t, got, want)
			}
		})
	}
}

// TestRestoreReplacesOriginal ensures the original parser can be destroyed:
// a restored parser alone must reproduce the one-shot result.
func TestRestoreReplacesOriginal(t *testing.T) {
	data := encodeUTF8(csvContent)
	p := New(UTF8)
	if _, err := p.Feed(data[:7]); err != nil {
		t.Fatal(err)
	}
	state, _, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	p = nil // original gone
	q, err := Restore(state)
	if err != nil {
		t.Fatal(err)
	}
	assertRecords(t, collect(t, q, data[7:]), expectedRecords(csvExpectedFields, csvExpectedUTF8))
}

// TestCheckpointStateIsSelfContained verifies the snapshot carries the
// encoding configuration: restoring without any other context must work.
func TestCheckpointStateIsSelfContained(t *testing.T) {
	data := encodeUTF16LE(csvContent)
	p := New(UTF16LE)
	if _, err := p.Feed(data[:10]); err != nil {
		t.Fatal(err)
	}
	state, off, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	q, err := Restore(state)
	if err != nil {
		t.Fatal(err)
	}
	if off != 10 {
		t.Fatalf("offset = %d, want 10", off)
	}
	assertRecords(t, collect(t, q, data[10:]), expectedRecords(csvExpectedFields, csvExpectedUTF16LE))
}
