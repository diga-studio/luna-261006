package frameproto

import (
	"bytes"
	"testing"
)

func mustEncode(t *testing.T, payload []byte) []byte {
	t.Helper()
	b, err := Encode(payload)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	return b
}

func feedAll(t *testing.T, d *Decoder, chunks ...[]byte) (frames []Frame) {
	t.Helper()
	for _, c := range chunks {
		frames = append(frames, d.Feed(c)...)
	}
	return append(frames, d.Finish()...)
}

func TestRoundTrip(t *testing.T) {
	var stream []byte
	var want []Frame
	off := int64(0)
	for _, p := range [][]byte{nil, {}, {0}, bytes.Repeat([]byte{7}, 300)} {
		stream = append(stream, mustEncode(t, p)...)
		want = append(want, Frame{Offset: off, Payload: p})
		off += int64(6 + len(p))
	}
	got := feedAll(t, NewDecoder(), stream)
	if len(got) != len(want) {
		t.Fatalf("got %d frames, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].Offset != want[i].Offset || !bytes.Equal(got[i].Payload, want[i].Payload) {
			t.Errorf("frame %d: got {%d %x}, want {%d %x}", i, got[i].Offset, got[i].Payload, want[i].Offset, want[i].Payload)
		}
	}
}

func TestEncodeTooLarge(t *testing.T) {
	if _, err := Encode(make([]byte, MaxPayload+1)); err == nil {
		t.Fatal("expected error for oversize payload")
	}
}

// A corrupted outer candidate (bad CRC) wraps a valid inner frame: the
// inner frame must be emitted, but only once the outer candidate has
// completed and failed.
func TestCorruptOuterWrapsInner(t *testing.T) {
	inner := mustEncode(t, []byte("inner"))
	outerLen := 4 + len(inner) // padding + inner frame as outer payload
	outer := make([]byte, 0, 6+outerLen)
	outer = append(outer, Sync0, Sync1, byte(outerLen>>8), byte(outerLen))
	outer = append(outer, 0, 0, 0, 0)
	innerOff := int64(len(outer))
	outer = append(outer, inner...)
	outer = append(outer, 0xDE, 0xAD) // wrong CRC

	d := NewDecoder()
	// Feed everything but the last byte: outer incomplete, inner complete.
	if got := d.Feed(outer[:len(outer)-1]); len(got) != 0 {
		t.Fatalf("emitted %d frames before outer candidate resolved", len(got))
	}
	got := d.Feed(outer[len(outer)-1:])
	if len(got) != 1 || got[0].Offset != innerOff || !bytes.Equal(got[0].Payload, []byte("inner")) {
		t.Fatalf("got %+v, want inner frame at %d", got, innerOff)
	}
	if got := d.Finish(); len(got) != 0 {
		t.Fatalf("Finish emitted %d extra frames", len(got))
	}
}

// A valid outer frame whose payload contains a sync word: the frame is
// emitted whole and the inner sync is never interpreted.
func TestValidOuterHidesInnerSync(t *testing.T) {
	payload := []byte{0xA5, 0x5A, 0x00, 0x00, 0x11, 0x22}
	stream := mustEncode(t, payload)
	stream = append(stream, 0x99) // trailing noise

	got := feedAll(t, NewDecoder(), stream)
	if len(got) != 1 || got[0].Offset != 0 || !bytes.Equal(got[0].Payload, payload) {
		t.Fatalf("got %+v, want single outer frame", got)
	}
}

// An EOF-truncated candidate wraps a complete valid inner frame: Feed
// must emit nothing; Finish recovers the inner frame.
func TestTruncatedOuterAtEOF(t *testing.T) {
	inner := mustEncode(t, []byte("deep"))
	outerLen := 4 + len(inner) + 10 // declares more than will ever arrive
	outer := make([]byte, 0, 4+outerLen)
	outer = append(outer, Sync0, Sync1, byte(outerLen>>8), byte(outerLen))
	outer = append(outer, 1, 1, 1, 1)
	innerOff := int64(len(outer))
	outer = append(outer, inner...)

	d := NewDecoder()
	if got := d.Feed(outer); len(got) != 0 {
		t.Fatalf("Feed emitted %d frames from truncated candidate", len(got))
	}
	got := d.Finish()
	if len(got) != 1 || got[0].Offset != innerOff || !bytes.Equal(got[0].Payload, []byte("deep")) {
		t.Fatalf("Finish got %+v, want inner frame at %d", got, innerOff)
	}
}

// Noise that happens to form a CRC-valid frame is emitted as valid.
func TestNoiseFormingValidFrame(t *testing.T) {
	frame := mustEncode(t, []byte("sneaky"))
	stream := append([]byte{0x00, 0xFF, 0xA5}, frame...) // stray 0xA5 before real sync
	got := feedAll(t, NewDecoder(), stream)
	if len(got) != 1 || got[0].Offset != 3 {
		t.Fatalf("got %+v, want one frame at offset 3", got)
	}
}
