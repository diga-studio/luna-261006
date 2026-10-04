package frame

import (
	"bytes"
	"encoding/binary"
	"math/rand"
	"testing"
)

// referenceParse is a simple, independent offline parser implementing the
// required earliest-candidate semantics. It uses the bitwise CRC reference
// and is only used on small streams.
func referenceParse(stream []byte) []Frame {
	var frames []Frame
	i := 0
	for i+2 <= len(stream) {
		if stream[i] != syncHi || stream[i+1] != syncLo {
			i++
			continue
		}
		if i+headerLen > len(stream) {
			i++ // truncated header at EOF: exclude this start
			continue
		}
		l := int(stream[i+2])<<8 | int(stream[i+3])
		total := headerLen + l + crcLen
		if i+total > len(stream) {
			i++ // truncated candidate at EOF: exclude this start
			continue
		}
		want := binary.BigEndian.Uint16(stream[i+headerLen+l : i+total])
		if crc16Bitwise(stream[i+2:i+headerLen+l]) == want {
			payload := make([]byte, l)
			copy(payload, stream[i+headerLen:i+headerLen+l])
			frames = append(frames, Frame{Offset: uint64(i), Payload: payload})
			i += total
		} else {
			i++
		}
	}
	return frames
}

// decodeAll feeds stream in chunks of the given sizes and returns all
// frames emitted by Feed and Finish.
func decodeAll(stream []byte, chunkSizes ...int) []Frame {
	var d Decoder
	var frames []Frame
	pos := 0
	ci := 0
	for pos < len(stream) {
		n := chunkSizes[ci%len(chunkSizes)]
		ci++
		if n <= 0 {
			n = 1
		}
		if n > len(stream)-pos {
			n = len(stream) - pos
		}
		frames = append(frames, d.Feed(stream[pos:pos+n])...)
		pos += n
	}
	frames = append(frames, d.Finish()...)
	return frames
}

func framesEqual(a, b []Frame) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Offset != b[i].Offset || !bytes.Equal(a[i].Payload, b[i].Payload) {
			return false
		}
	}
	return true
}

func corruptCRC(frame []byte) []byte {
	out := append([]byte(nil), frame...)
	out[len(out)-1] ^= 0xFF
	return out
}

// A CRC-bad outer candidate wraps a valid inner frame: the inner frame
// must be emitted, and only after the outer candidate completes.
func TestBadOuterWrapsInner(t *testing.T) {
	inner := Encode([]byte("inner-payload"))
	outerPayload := append(append([]byte(nil), inner...), 0x11, 0x22, 0x33)
	outer := corruptCRC(Encode(outerPayload))

	// Feed everything except the last byte: the outer candidate is still
	// incomplete, so the complete inner frame must not be emitted yet.
	var d Decoder
	if got := d.Feed(outer[:len(outer)-1]); len(got) != 0 {
		t.Fatalf("premature frames before outer candidate completed: %+v", got)
	}
	got := d.Feed(outer[len(outer)-1:])
	if len(got) != 1 || got[0].Offset != 4 || !bytes.Equal(got[0].Payload, []byte("inner-payload")) {
		t.Fatalf("got %+v, want inner frame at offset 4", got)
	}
	if got := d.Finish(); len(got) != 0 {
		t.Fatalf("unexpected frames at EOF: %+v", got)
	}
}

// A CRC-correct outer frame wraps sync words: only the outer frame is
// emitted; sync words inside it are not interpreted.
func TestGoodOuterWrapsSync(t *testing.T) {
	inner := Encode([]byte("hidden"))
	outerPayload := append(append([]byte{0x00}, inner...), 0xA5, 0x5A, 0x00)
	outer := Encode(outerPayload)

	got := decodeAll(outer, len(outer))
	if len(got) != 1 || got[0].Offset != 0 || !bytes.Equal(got[0].Payload, outerPayload) {
		t.Fatalf("got %+v, want only the outer frame at offset 0", got)
	}
}

// An EOF-truncated candidate wraps a complete valid frame: Feed waits,
// Finish treats the candidate as failed and emits the inner frame.
func TestTruncatedOuterWrapsInner(t *testing.T) {
	inner := Encode([]byte("salvaged"))
	var stream []byte
	stream = append(stream, syncHi, syncLo, 0x01, 0x00) // declares 256-byte payload
	stream = append(stream, inner...)
	stream = append(stream, 0x00, 0x00, 0x00) // then EOF: candidate incomplete

	var d Decoder
	if got := d.Feed(stream); len(got) != 0 {
		t.Fatalf("frames emitted before EOF: %+v", got)
	}
	got := d.Finish()
	if len(got) != 1 || got[0].Offset != 4 || !bytes.Equal(got[0].Payload, []byte("salvaged")) {
		t.Fatalf("got %+v, want inner frame at offset 4", got)
	}
}

func TestEmptyPayloadAndOffsets(t *testing.T) {
	noise := []byte{0x00, 0xA5, 0x5A, 0x5A, 0xA5} // includes a doomed start
	var stream []byte
	stream = append(stream, noise...)
	stream = append(stream, Encode(nil)...)
	stream = append(stream, Encode([]byte("x"))...)

	want := referenceParse(stream)
	got := decodeAll(stream, len(stream))
	if !framesEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if len(got) != 2 || got[0].Offset != uint64(len(noise)) || got[1].Offset != uint64(len(noise)+6) {
		t.Fatalf("unexpected offsets: %+v", got)
	}
}

func TestMaxPayload(t *testing.T) {
	payload := make([]byte, maxPayload)
	rng := rand.New(rand.NewSource(3))
	rng.Read(payload)
	stream := Encode(payload)
	got := decodeAll(stream, 1) // one byte at a time
	if len(got) != 1 || got[0].Offset != 0 || !bytes.Equal(got[0].Payload, payload) {
		t.Fatalf("max-payload frame mismatch, %d frames", len(got))
	}
}

// Returned payloads must not be modified by later calls.
func TestPayloadIsolation(t *testing.T) {
	var d Decoder
	frames := d.Feed(Encode([]byte("steady")))
	if len(frames) != 1 {
		t.Fatalf("want 1 frame, got %d", len(frames))
	}
	snapshot := append([]byte(nil), frames[0].Payload...)
	// Push enough data through to cycle the internal buffer.
	big := bytes.Repeat(Encode([]byte("flood")), 4000)
	d.Feed(big)
	d.Finish()
	if !bytes.Equal(frames[0].Payload, snapshot) {
		t.Fatal("returned payload was modified by later calls")
	}
}

// Random streams: the decoder must match the independent reference parser,
// with identical results for single-byte, random and one-shot chunking.
func TestRandomStreamsAgainstReference(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	for trial := 0; trial < 300; trial++ {
		var stream []byte
		for len(stream) < 1+rng.Intn(4000) {
			switch rng.Intn(6) {
			case 0: // valid frame, payload may contain sync words
				p := make([]byte, rng.Intn(120))
				rng.Read(p)
				stream = append(stream, Encode(p)...)
			case 1: // CRC-corrupted frame
				p := make([]byte, rng.Intn(120))
				rng.Read(p)
				stream = append(stream, corruptCRC(Encode(p))...)
			case 2: // truncated frame prefix
				p := make([]byte, rng.Intn(120))
				rng.Read(p)
				f := Encode(p)
				stream = append(stream, f[:rng.Intn(len(f))]...)
			case 3: // random noise
				n := make([]byte, rng.Intn(40))
				rng.Read(n)
				stream = append(stream, n...)
			case 4: // sync-heavy noise
				for i := 0; i < rng.Intn(20); i++ {
					stream = append(stream, syncHi, syncLo)
				}
			default: // declared-huge candidate
				stream = append(stream, syncHi, syncLo, 0xFF, 0xFF)
			}
		}

		want := referenceParse(stream)

		if got := decodeAll(stream, len(stream)); !framesEqual(got, want) {
			t.Fatalf("trial %d one-shot: got %d frames, want %d", trial, len(got), len(want))
		}
		if got := decodeAll(stream, 1); !framesEqual(got, want) {
			t.Fatalf("trial %d single-byte: got %d frames, want %d", trial, len(got), len(want))
		}
		// Random chunking, seeded per trial.
		crng := rand.New(rand.NewSource(int64(trial)))
		var sizes []int
		for i := 0; i < 64; i++ {
			sizes = append(sizes, 1+crng.Intn(17))
		}
		if got := decodeAll(stream, sizes...); !framesEqual(got, want) {
			t.Fatalf("trial %d random-chunk: got %d frames, want %d", trial, len(got), len(want))
		}
	}
}

// Sync word, length field and CRC split across chunk boundaries.
func TestSplitFields(t *testing.T) {
	payload := []byte("split me")
	stream := append([]byte{0x99}, Encode(payload)...)
	want := referenceParse(stream)
	// Every possible two-way split, plus three-way splits at field edges.
	for cut := 0; cut <= len(stream); cut++ {
		var d Decoder
		got := append(d.Feed(stream[:cut]), d.Feed(stream[cut:])...)
		got = append(got, d.Finish()...)
		if !framesEqual(got, want) {
			t.Fatalf("split at %d: got %+v, want %+v", cut, got, want)
		}
	}
}
