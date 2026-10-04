package frameproto

import (
	"bytes"
	"fmt"
	"math/rand"
	"runtime"
	"testing"
	"time"
	"unsafe"
)

// The oracle below is a third, test-local implementation of the CRC
// range math (bit-loop updates, shift matrices built by direct zero-byte
// simulation), independent of crc16.go. It is additionally spot-checked
// against the direct byte-loop Checksum on the actual stress data.

func testUpdate(crc uint16, b byte) uint16 {
	crc ^= uint16(b) << 8
	for i := 0; i < 8; i++ {
		if crc&0x8000 != 0 {
			crc = crc<<1 ^ 0x1021
		} else {
			crc <<= 1
		}
	}
	return crc
}

type testShiftMats [18][16]uint16

func buildTestShiftMats() *testShiftMats {
	m := &testShiftMats{}
	for j := 0; j < len(m); j++ {
		zeros := 1 << j
		for i := 0; i < 16; i++ {
			r := uint16(1 << i)
			for z := 0; z < zeros; z++ {
				r = testUpdate(r, 0)
			}
			m[j][i] = r
		}
	}
	return m
}

func (m *testShiftMats) shift(r uint16, k int) uint16 {
	for j := 0; k != 0; j++ {
		if k&1 != 0 {
			var out uint16
			for i := 0; i < 16; i++ {
				if r&(1<<i) != 0 {
					out ^= m[j][i]
				}
			}
			r = out
		}
		k >>= 1
	}
	return r
}

// stressOracle parses the whole stream with spec semantics, using
// test-local prefix CRCs and shift matrices.
func stressOracle(stream []byte, mats *testShiftMats) []Frame {
	p0 := make([]uint16, len(stream)+1)
	for i, b := range stream {
		p0[i+1] = testUpdate(p0[i], b)
	}
	rangeCRC := func(a, b int) uint16 {
		k := b - a
		return p0[b] ^ mats.shift(p0[a], k) ^ mats.shift(0xFFFF, k)
	}

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
		if s+4 > len(stream) {
			pos = s + 1
			continue
		}
		l := int(stream[s+2])<<8 | int(stream[s+3])
		end := s + 6 + l
		if end > len(stream) {
			pos = s + 1
			continue
		}
		if rangeCRC(s+2, s+4+l) == uint16(stream[end-2])<<8|uint16(stream[end-1]) {
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

// buildStressStream returns a >=16 MiB stream where a sync word appears
// every 32 bytes, each declaring the maximum payload length, so nearly
// every candidate becomes complete and fails only at the CRC check.
// Valid frames are planted every 2048 cells; the returned offsets are
// computed from the final layout.
func buildStressStream() (stream []byte, planted []Frame) {
	rng := rand.New(rand.NewSource(7))

	cell := make([]byte, 32)
	cell[0], cell[1] = Sync0, Sync1
	cell[2], cell[3] = 0xFF, 0xFF // declare max payload: 65541-byte candidate
	for i := 4; i < 32; i++ {
		b := byte(rng.Intn(256))
		if cell[i-1] == Sync0 && b == Sync1 {
			b = 0 // keep syncs exactly on the 32-byte grid
		}
		cell[i] = b
	}

	const target = 16 << 20
	frameNo := 0
	for len(stream) < target {
		for i := 0; i < 2048; i++ {
			stream = append(stream, cell...)
		}
		payload := []byte(fmt.Sprintf("valid-frame-%04d", frameNo))
		b, err := Encode(payload)
		if err != nil {
			panic(err)
		}
		planted = append(planted, Frame{Offset: int64(len(stream)), Payload: payload})
		stream = append(stream, b...)
		frameNo++
	}
	return stream, planted
}

func TestStress16MiB(t *testing.T) {
	stream, planted := buildStressStream()
	if len(stream) < 16<<20 {
		t.Fatalf("stream too small: %d", len(stream))
	}
	t.Logf("stream length: %d bytes, planted valid frames: %d", len(stream), len(planted))

	mats := buildTestShiftMats()

	// Test-local prefix CRCs over the whole stream, reused by the
	// spot-checks below.
	fullP0 := make([]uint16, len(stream)+1)
	for j, by := range stream {
		fullP0[j+1] = testUpdate(fullP0[j], by)
	}

	// Spot-check the oracle's range CRC against direct Checksum on the
	// real stress data.
	rng := rand.New(rand.NewSource(9))
	for i := 0; i < 200; i++ {
		a := rng.Intn(len(stream) - 66000)
		b := a + 1 + rng.Intn(66000)
		k := b - a
		got := fullP0[b] ^ mats.shift(fullP0[a], k) ^ mats.shift(0xFFFF, k)
		if want := Checksum(stream[a:b]); got != want {
			t.Fatalf("oracle range CRC wrong at [%d:%d]: got %#04x want %#04x", a, b, got, want)
		}
	}

	want := stressOracle(stream, mats)
	t.Logf("oracle recovered %d frames", len(want))

	// All planted frames must be recovered by the oracle.
	if len(want) < len(planted) {
		t.Fatalf("oracle found %d frames, fewer than planted %d", len(want), len(planted))
	}

	var m1, m2 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&m1)
	start := time.Now()

	d := NewDecoder()
	var got []Frame
	const chunk = 1 << 20
	for i := 0; i < len(stream); i += chunk {
		end := i + chunk
		if end > len(stream) {
			end = len(stream)
		}
		got = append(got, d.Feed(stream[i:end])...)
	}
	got = append(got, d.Finish()...)

	elapsed := time.Since(start)
	runtime.ReadMemStats(&m2)

	t.Logf("decode time: %v (%.1f MiB/s)", elapsed, float64(len(stream))/(1<<20)/elapsed.Seconds())
	t.Logf("decoder static size: %d bytes", unsafe.Sizeof(*d))
	t.Logf("total alloc delta: %d bytes (includes returned payloads)", m2.TotalAlloc-m1.TotalAlloc)

	if !equalFrames(got, want) {
		n := 0
		for i := range got {
			if i >= len(want) || got[i].Offset != want[i].Offset || !bytes.Equal(got[i].Payload, want[i].Payload) {
				t.Errorf("first mismatch at %d: got {%d len=%d}, want {%d len=%d}",
					i, got[i].Offset, len(got[i].Payload), want[i].Offset, len(want[i].Payload))
				n++
				if n > 3 {
					break
				}
			}
		}
		t.Fatalf("decoder emitted %d frames, oracle %d", len(got), len(want))
	}

	// Every planted frame must appear in the decoder output.
	byOffset := make(map[int64][]byte, len(got))
	for _, f := range got {
		byOffset[f.Offset] = f.Payload
	}
	for _, p := range planted {
		gotP, ok := byOffset[p.Offset]
		if !ok || !bytes.Equal(gotP, p.Payload) {
			t.Fatalf("planted frame at %d missing or corrupted", p.Offset)
		}
	}
}

func BenchmarkStress16MiB(b *testing.B) {
	stream, _ := buildStressStream()
	b.SetBytes(int64(len(stream)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		d := NewDecoder()
		const chunk = 1 << 20
		n := 0
		for off := 0; off < len(stream); off += chunk {
			end := off + chunk
			if end > len(stream) {
				end = len(stream)
			}
			n += len(d.Feed(stream[off:end]))
		}
		n += len(d.Finish())
		if n == 0 {
			b.Fatal("no frames decoded")
		}
	}
}

func BenchmarkWellFormed(b *testing.B) {
	var stream []byte
	payload := bytes.Repeat([]byte{0x42}, 256)
	frame, _ := Encode(payload)
	for len(stream) < 4<<20 {
		stream = append(stream, frame...)
	}
	b.SetBytes(int64(len(stream)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		d := NewDecoder()
		n := len(d.Feed(stream)) + len(d.Finish())
		if n == 0 {
			b.Fatal("no frames decoded")
		}
	}
}
