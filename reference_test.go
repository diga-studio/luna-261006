package frameproto

import (
	"bytes"
	"math/rand"
	"testing"
)

// referenceParse is a deliberately simple whole-stream parser used only
// to cross-check the streaming Decoder. It follows the spec directly:
// earliest sync forms a candidate; complete+valid emits and continues
// past the frame; failed or EOF-truncated candidates exclude only their
// start offset.
func referenceParse(stream []byte) []Frame {
	var frames []Frame
	pos := 0
	for pos+1 < len(stream) {
		s := -1
		for i := pos; i+1 < len(stream); i++ {
			if stream[i] == Sync0 && stream[i+1] == Sync1 {
				s = i
				break
			}
		}
		if s < 0 {
			break
		}
		if s+4 > len(stream) { // truncated header at EOF
			pos = s + 1
			continue
		}
		l := int(stream[s+2])<<8 | int(stream[s+3])
		end := s + 6 + l
		if end > len(stream) { // truncated frame at EOF
			pos = s + 1
			continue
		}
		crc := Checksum(stream[s+2 : s+4+l])
		stored := uint16(stream[end-2])<<8 | uint16(stream[end-1])
		if crc == stored {
			payload := make([]byte, l)
			copy(payload, stream[s+4:end-2])
			frames = append(frames, Frame{Offset: int64(s), Payload: payload})
			pos = end
		} else {
			pos = s + 1
		}
	}
	return frames
}

func decodeWithChunks(stream []byte, chunks [][]byte) []Frame {
	d := NewDecoder()
	var frames []Frame
	for _, c := range chunks {
		frames = append(frames, d.Feed(c)...)
	}
	return append(frames, d.Finish()...)
}

func equalFrames(a, b []Frame) bool {
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

// randomStream builds a stream mixing valid frames, corrupted frames,
// truncated-looking candidates and raw noise, with many embedded syncs.
func randomStream(rng *rand.Rand) []byte {
	var stream []byte
	parts := 1 + rng.Intn(12)
	for i := 0; i < parts; i++ {
		switch rng.Intn(6) {
		case 0: // valid frame, payload may contain syncs
			p := make([]byte, rng.Intn(40))
			rng.Read(p)
			if rng.Intn(2) == 0 && len(p) > 2 {
				p[0], p[1] = Sync0, Sync1
			}
			b, _ := Encode(p)
			stream = append(stream, b...)
		case 1: // corrupted valid frame (bad CRC)
			p := make([]byte, rng.Intn(40))
			rng.Read(p)
			b, _ := Encode(p)
			b[len(b)-1] ^= 0xFF
			stream = append(stream, b...)
		case 2: // bare sync + declared length, no body (truncated candidate)
			stream = append(stream, Sync0, Sync1, byte(rng.Intn(256)), byte(rng.Intn(256)))
		case 3: // noise with frequent sync-ish bytes
			n := rng.Intn(30)
			for j := 0; j < n; j++ {
				stream = append(stream, []byte{0xA5, 0x5A, 0xA5, 0x00}[rng.Intn(4)])
			}
		default: // pure noise
			n := rng.Intn(30)
			for j := 0; j < n; j++ {
				stream = append(stream, byte(rng.Intn(256)))
			}
		}
	}
	return stream
}

func splitRandom(stream []byte, rng *rand.Rand) [][]byte {
	var chunks [][]byte
	for i := 0; i < len(stream); {
		n := 1 + rng.Intn(17)
		if i+n > len(stream) {
			n = len(stream) - i
		}
		chunks = append(chunks, stream[i:i+n])
		i += n
	}
	return chunks
}

func splitSingleBytes(stream []byte) [][]byte {
	chunks := make([][]byte, len(stream))
	for i := range stream {
		chunks[i] = stream[i : i+1]
	}
	return chunks
}

func TestChunkingEquivalence(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 300; trial++ {
		stream := randomStream(rng)
		want := referenceParse(stream)

		whole := decodeWithChunks(stream, [][]byte{stream})
		if !equalFrames(whole, want) {
			t.Fatalf("trial %d: whole-stream mismatch\nstream=%x\ngot=%+v\nwant=%+v", trial, stream, whole, want)
		}
		bytewise := decodeWithChunks(stream, splitSingleBytes(stream))
		if !equalFrames(bytewise, want) {
			t.Fatalf("trial %d: single-byte mismatch\nstream=%x\ngot=%+v\nwant=%+v", trial, stream, bytewise, want)
		}
		for rep := 0; rep < 3; rep++ {
			got := decodeWithChunks(stream, splitRandom(stream, rng))
			if !equalFrames(got, want) {
				t.Fatalf("trial %d rep %d: random-chunk mismatch\nstream=%x\ngot=%+v\nwant=%+v", trial, stream, rep, got, want)
			}
		}
	}
}

// Splitting exactly across sync, length and CRC boundaries.
func TestBoundarySplits(t *testing.T) {
	f1 := mustEncode(t, []byte{1, 2, 3})
	f2 := mustEncode(t, []byte{4, 5})
	stream := append(append([]byte{0xDE, 0xAD}, f1...), f2...)
	want := referenceParse(stream)
	for cut := 0; cut <= len(stream); cut++ {
		got := decodeWithChunks(stream, [][]byte{stream[:cut], stream[cut:]})
		if !equalFrames(got, want) {
			t.Fatalf("cut %d: got %+v, want %+v", cut, got, want)
		}
	}
}
