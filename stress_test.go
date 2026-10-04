package frame

import (
	"bytes"
	"encoding/binary"
	"math/rand"
	"testing"
	"time"
)

const stressLen = 16 << 20 // 16 MiB

// buildStressStream plants a candidate declaring a near-maximum payload
// every 32 bytes (so almost every complete candidate survives until its
// CRC check fails) and hides valid frames inside the stream.
func buildStressStream() ([]byte, []Frame) {
	stream := make([]byte, stressLen)
	for p := 0; p+4 <= stressLen; p += 32 {
		stream[p] = syncHi
		stream[p+1] = syncLo
		stream[p+2] = 0xFF // payload length 65535
		stream[p+3] = 0xFF
	}
	rng := rand.New(rand.NewSource(7))
	var planted []Frame
	for i := 0; i < 64; i++ {
		payload := make([]byte, rng.Intn(300))
		rng.Read(payload)
		f := Encode(payload)
		off := rng.Intn(stressLen - len(f))
		copy(stream[off:], f)
		planted = append(planted, Frame{Offset: uint64(off), Payload: payload})
	}
	return stream, planted
}

// referenceParseFast is an independent full-stream parser using prefix
// zero-init CRC states for O(log L) window CRC queries.
func referenceParseFast(stream []byte) []Frame {
	z := make([]uint16, len(stream)+1)
	for i, b := range stream {
		z[i+1] = stepA(z[i]) ^ crcTable[b]
	}
	var frames []Frame
	i := 0
	for i+2 <= len(stream) {
		if stream[i] != syncHi || stream[i+1] != syncLo {
			i++
			continue
		}
		if i+headerLen > len(stream) {
			i++
			continue
		}
		l := int(stream[i+2])<<8 | int(stream[i+3])
		total := headerLen + l + crcLen
		if i+total > len(stream) {
			i++
			continue
		}
		want := binary.BigEndian.Uint16(stream[i+headerLen+l : i+total])
		if crcWindow(z, i+2, i+headerLen+l) == want {
			payload := append([]byte(nil), stream[i+headerLen:i+headerLen+l]...)
			frames = append(frames, Frame{Offset: uint64(i), Payload: payload})
			i += total
		} else {
			i++
		}
	}
	return frames
}

func TestStress16MiB(t *testing.T) {
	stream, planted := buildStressStream()
	want := referenceParseFast(stream)

	// Sanity: the stream really is hostile — candidates everywhere,
	// almost all of them failing only at the CRC stage.
	t.Logf("stream=%d bytes, planted=%d valid frames, reference frames=%d", len(stream), len(planted), len(want))

	start := time.Now()
	var d Decoder
	got := d.Feed(stream)
	got = append(got, d.Finish()...)
	elapsed := time.Since(start)

	if !framesEqual(got, want) {
		t.Fatalf("one-shot: got %d frames, want %d", len(got), len(want))
	}

	// Chunked feeds must produce identical output (3-byte chunks slice
	// through sync words, length fields and CRCs alike).
	var d2 Decoder
	var got2 []Frame
	for pos := 0; pos < len(stream); pos += 3 {
		n := 3
		if n > len(stream)-pos {
			n = len(stream) - pos
		}
		got2 = append(got2, d2.Feed(stream[pos:pos+n])...)
	}
	got2 = append(got2, d2.Finish()...)
	if !framesEqual(got2, want) {
		t.Fatalf("3-byte chunks: got %d frames, want %d", len(got2), len(want))
	}

	// Planted valid frames must survive (a handful may legitimately be
	// swallowed by accidental CRC-valid noise frames).
	if len(got) < len(planted)-4 {
		t.Fatalf("only %d of %d planted frames emitted", len(got), len(planted))
	}

	// Extra peak memory: internal buffers must stay below 1 MiB.
	extra := cap(d.buf) + 2*cap(d.z)
	t.Logf("one-shot decode of 16 MiB took %s; internal buffers: buf=%d B, z=%d B (total %d B)",
		elapsed, cap(d.buf), 2*cap(d.z), extra)
	if extra > 1<<20 {
		t.Fatalf("internal buffers use %d bytes, budget is 1 MiB", extra)
	}
}

func BenchmarkFeedStress(b *testing.B) {
	stream, _ := buildStressStream()
	b.ReportAllocs()
	b.SetBytes(int64(len(stream)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var d Decoder
		for pos := 0; pos < len(stream); pos += 64 << 10 {
			n := 64 << 10
			if n > len(stream)-pos {
				n = len(stream) - pos
			}
			d.Feed(stream[pos : pos+n])
		}
		d.Finish()
	}
}

func BenchmarkFeedValidFrames(b *testing.B) {
	var stream []byte
	payload := bytes.Repeat([]byte("benchmark-payload"), 4)
	for len(stream) < 4<<20 {
		stream = append(stream, Encode(payload)...)
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(stream)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var d Decoder
		d.Feed(stream)
		d.Finish()
	}
}
