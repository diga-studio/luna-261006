package terrasync

import (
	"bytes"
	"reflect"
	"testing"
)

// sampleFile builds the shared test file: BOM, a record with escaped quotes
// and CRLF terminator, a record with a non-BMP character and a quoted CRLF,
// and a final unterminated record ended by Finish.
func sampleFile(enc Encoding) (data []byte, want []Record) {
	segs := []string{
		"name,\"he said \"\"hi\"\"\"\r\n",
		"emoji😀,\"line1\r\nline2\"\n",
		"x,",
	}
	wantFields := [][]string{
		{"name", `he said "hi"`},
		{"emoji😀", "line1\r\nline2"},
		{"x", ""},
	}
	data = append(data, bom(enc)...)
	off := int64(len(data))
	for i, s := range segs {
		b := encode(enc, s)
		data = append(data, b...)
		want = append(want, Record{
			Fields: wantFields[i],
			Start:  off,
			End:    off + int64(len(b)),
		})
		off += int64(len(b))
	}
	return data, want
}

func parseOneShot(t *testing.T, enc Encoding, data []byte) []Record {
	t.Helper()
	p := New(enc)
	recs, err := p.Feed(data)
	if err != nil {
		t.Fatalf("one-shot Feed: %v", err)
	}
	fin, err := p.Finish()
	if err != nil {
		t.Fatalf("one-shot Finish: %v", err)
	}
	return append(recs, fin...)
}

func TestSampleFileOneShot(t *testing.T) {
	for _, enc := range []Encoding{UTF8, UTF16LE} {
		data, want := sampleFile(enc)
		got := parseOneShot(t, enc, data)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("enc=%v one-shot:\n got %+v\nwant %+v", enc, got, want)
		}
	}
}

// TestCheckpointEveryCutPoint feeds the sample file up to every possible
// byte cut point, checkpoints, restores into a fresh parser, interleaves
// empty Feeds, and requires the exact expected records and byte ranges.
func TestCheckpointEveryCutPoint(t *testing.T) {
	for _, enc := range []Encoding{UTF8, UTF16LE} {
		data, want := sampleFile(enc)
		for cut := 0; cut <= len(data); cut++ {
			p := New(enc)
			var got []Record
			recs, err := p.Feed(data[:cut])
			if err != nil {
				t.Fatalf("enc=%v cut=%d: Feed prefix: %v", enc, cut, err)
			}
			got = append(got, recs...)
			if _, err := p.Feed(nil); err != nil { // empty Feed is a no-op
				t.Fatalf("enc=%v cut=%d: empty Feed: %v", enc, cut, err)
			}
			state, nextOff, err := p.Checkpoint()
			if err != nil {
				t.Fatalf("enc=%v cut=%d: Checkpoint: %v", enc, cut, err)
			}
			if nextOff != int64(cut) {
				t.Fatalf("enc=%v cut=%d: next offset = %d, want %d", enc, cut, nextOff, cut)
			}
			q, restoreOff, err := Restore(state)
			if err != nil {
				t.Fatalf("enc=%v cut=%d: Restore: %v", enc, cut, err)
			}
			if restoreOff != int64(cut) {
				t.Fatalf("enc=%v cut=%d: restore offset = %d, want %d", enc, cut, restoreOff, cut)
			}
			if _, err := q.Feed(nil); err != nil {
				t.Fatalf("enc=%v cut=%d: empty Feed after restore: %v", enc, cut, err)
			}
			recs, err = q.Feed(data[cut:])
			if err != nil {
				t.Fatalf("enc=%v cut=%d: Feed suffix: %v", enc, cut, err)
			}
			got = append(got, recs...)
			recs, err = q.Finish()
			if err != nil {
				t.Fatalf("enc=%v cut=%d: Finish: %v", enc, cut, err)
			}
			got = append(got, recs...)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("enc=%v cut=%d:\n got %+v\nwant %+v", enc, cut, got, want)
			}
		}
	}
}

// TestCheckpointEveryCutPointByteByByte restores at every cut point and then
// feeds the remainder one byte at a time.
func TestCheckpointEveryCutPointByteByByte(t *testing.T) {
	for _, enc := range []Encoding{UTF8, UTF16LE} {
		data, want := sampleFile(enc)
		for cut := 0; cut <= len(data); cut++ {
			p := New(enc)
			var got []Record
			for i := 0; i < cut; i++ {
				recs, err := p.Feed(data[i : i+1])
				if err != nil {
					t.Fatalf("enc=%v cut=%d: Feed byte %d: %v", enc, cut, i, err)
				}
				got = append(got, recs...)
			}
			state, _, err := p.Checkpoint()
			if err != nil {
				t.Fatalf("enc=%v cut=%d: Checkpoint: %v", enc, cut, err)
			}
			q, _, err := Restore(state)
			if err != nil {
				t.Fatalf("enc=%v cut=%d: Restore: %v", enc, cut, err)
			}
			for i := cut; i < len(data); i++ {
				recs, err := q.Feed(data[i : i+1])
				if err != nil {
					t.Fatalf("enc=%v cut=%d: Feed byte %d: %v", enc, cut, i, err)
				}
				got = append(got, recs...)
			}
			recs, err := q.Finish()
			if err != nil {
				t.Fatalf("enc=%v cut=%d: Finish: %v", enc, cut, err)
			}
			got = append(got, recs...)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("enc=%v cut=%d byte-by-byte:\n got %+v\nwant %+v", enc, cut, got, want)
			}
		}
	}
}

func TestRestoreRejectsGarbage(t *testing.T) {
	if _, _, err := Restore([]byte("not a checkpoint")); err == nil {
		t.Fatal("expected error for garbage state")
	}
	p := New(UTF8)
	state, _, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	state = bytes.Clone(state)
	state[len(state)-1] ^= 0xFF
	if _, _, err := Restore(state); err == nil {
		t.Fatal("expected error for corrupted state")
	}
}

func TestCheckpointAfterFinishFails(t *testing.T) {
	p := New(UTF8)
	if _, err := p.Finish(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.Checkpoint(); err == nil {
		t.Fatal("expected checkpoint-after-Finish error")
	}
}
