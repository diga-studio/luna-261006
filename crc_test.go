package frame

import (
	"math/rand"
	"testing"
)

// crc16Bitwise is an independent, deliberately unoptimised reference.
func crc16Bitwise(data []byte) uint16 {
	crc := uint16(0xFFFF)
	for _, b := range data {
		crc ^= uint16(b) << 8
		for i := 0; i < 8; i++ {
			if crc&0x8000 != 0 {
				crc = (crc << 1) ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

func TestCRC16CheckVector(t *testing.T) {
	// CRC16/CCITT-FALSE of "123456789" is 0x29B1.
	if got := crc16([]byte("123456789")); got != 0x29B1 {
		t.Fatalf("crc16 check vector = %#04x, want 0x29B1", got)
	}
	if got := crc16Bitwise([]byte("123456789")); got != 0x29B1 {
		t.Fatalf("crc16Bitwise check vector = %#04x, want 0x29B1", got)
	}
}

func TestCRC16AgainstBitwise(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 200; trial++ {
		data := make([]byte, rng.Intn(300))
		rng.Read(data)
		if got, want := crc16(data), crc16Bitwise(data); got != want {
			t.Fatalf("trial %d: crc16=%#04x, bitwise=%#04x", trial, got, want)
		}
	}
}

func TestCRCWindowAgainstDirect(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	// Larger than one maximal frame so k crosses 2^16.
	buf := make([]byte, maxFrameLen+70000)
	rng.Read(buf)
	z := make([]uint16, len(buf)+1)
	for i, b := range buf {
		z[i+1] = stepA(z[i]) ^ crcTable[b]
	}
	for trial := 0; trial < 2000; trial++ {
		a := rng.Intn(len(buf))
		b := a + rng.Intn(len(buf)-a+1)
		if got, want := crcWindow(z, a, b), crc16(buf[a:b]); got != want {
			t.Fatalf("window [%d:%d] (k=%d): got %#04x, want %#04x", a, b, b-a, got, want)
		}
	}
}
