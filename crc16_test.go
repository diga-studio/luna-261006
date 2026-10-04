package frameproto

import (
	"math/rand"
	"testing"
)

func TestChecksumKnownVector(t *testing.T) {
	// CRC16/CCITT-FALSE of "123456789" is 0x29B1.
	if got := Checksum([]byte("123456789")); got != 0x29B1 {
		t.Fatalf("Checksum = %#04x, want 0x29B1", got)
	}
	if got := Checksum(nil); got != 0xFFFF {
		t.Fatalf("Checksum(empty) = %#04x, want 0xFFFF", got)
	}
}

func TestRangeChecksumMatchesDirect(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	buf := make([]byte, 70000)
	rng.Read(buf)

	// Prefix CRCs with init 0.
	p0 := make([]uint16, len(buf)+1)
	for i, b := range buf {
		p0[i+1] = update(p0[i], b)
	}
	get := func(off int64) uint16 { return p0[off] }

	for i := 0; i < 2000; i++ {
		a := rng.Intn(len(buf))
		b := a + rng.Intn(len(buf)-a+1)
		want := Checksum(buf[a:b])
		got := rangeChecksum(get, int64(a), int64(b))
		if got != want {
			t.Fatalf("range [%d:%d]: got %#04x, want %#04x", a, b, got, want)
		}
	}
}
