package terrasync

import (
	"strings"
	"testing"
)

// TestCheckpointSizeIndependentOfHistory feeds many completed records and a
// large completed field, then asserts the checkpoint stays small: its size
// may only track the unfinished record, never history.
func TestCheckpointSizeIndependentOfHistory(t *testing.T) {
	p := New(UTF8)

	big := strings.Repeat("x", 4<<20)
	chunk := "\"" + big + "\"\n" + strings.Repeat("a,b,c\n", 100000)
	if _, err := p.Feed([]byte(chunk)); err != nil {
		t.Fatal(err)
	}
	state, _, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if len(state) > 4096 {
		t.Fatalf("checkpoint after completed history = %d bytes, want < 4096", len(state))
	}

	// A genuinely unfinished large record may (and must) be reflected.
	if _, err := p.Feed([]byte("\"" + big)); err != nil {
		t.Fatal(err)
	}
	state2, _, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if len(state2) < len(big) {
		t.Fatalf("checkpoint with pending %d-byte field = %d bytes", len(big), len(state2))
	}
}

// TestManyRecordsByteByByte ensures small records fed byte-by-byte complete
// promptly and are not buffered until Finish.
func TestManyRecordsByteByByte(t *testing.T) {
	data := []byte(strings.Repeat("k,v\n", 10000))
	p := New(UTF8)
	count := 0
	for i := 0; i < len(data); i++ {
		recs, err := p.Feed(data[i : i+1])
		if err != nil {
			t.Fatal(err)
		}
		count += len(recs)
	}
	if count != 10000 {
		t.Fatalf("records before Finish = %d, want 10000", count)
	}
	tail, err := p.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 0 {
		t.Fatalf("Finish returned %d extra records", len(tail))
	}
}
