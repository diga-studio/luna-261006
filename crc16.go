package frameproto

// CRC16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
//
// The register update is affine over GF(2): processing message M from
// initial register I yields F(M, 0) ^ T_|M|(I), where T_k is the linear
// map "advance the register by k zero bytes". This lets us compute the
// CRC of any stream range from per-byte prefix CRCs in O(log k):
//
//	CRC(M, init) = F(M,0) ^ T_|M|(init)
//	F(M,0)       = P0(b) ^ T_b-a(P0(a))   for M = stream[a:b]

const (
	poly     = 0x1021
	initCRC  = 0xFFFF
	maxShift = MaxFrameLen // largest CRC-covered span we ever need
)

// byteTable accelerates the per-byte update.
var byteTable [256]uint16

// shiftPow[j] is the 16x16 bit matrix of T_(2^j), stored as images of the
// basis vectors: shiftPow[j][i] = T_(2^j)(1<<i).
var shiftPow [18][16]uint16

func init() {
	for b := 0; b < 256; b++ {
		byteTable[b] = updateSlow(0, byte(b))
	}
	// T_1 images of basis vectors.
	for i := 0; i < 16; i++ {
		shiftPow[0][i] = updateSlow(uint16(1<<i), 0)
	}
	// T_(2^j) = T_(2^(j-1)) composed with itself.
	for j := 1; j < len(shiftPow); j++ {
		for i := 0; i < 16; i++ {
			shiftPow[j][i] = applyShift(&shiftPow[j-1], shiftPow[j-1][i])
		}
	}
	if 1<<(len(shiftPow)-1) < maxShift {
		panic("shift tables too small")
	}
}

func updateSlow(crc uint16, b byte) uint16 {
	crc ^= uint16(b) << 8
	for i := 0; i < 8; i++ {
		if crc&0x8000 != 0 {
			crc = (crc << 1) ^ poly
		} else {
			crc <<= 1
		}
	}
	return crc
}

// update advances the CRC register by one byte.
func update(crc uint16, b byte) uint16 {
	return byteTable[byte(crc>>8)^b] ^ (crc << 8)
}

// Checksum computes CRC16/CCITT-FALSE over data (init 0xFFFF).
func Checksum(data []byte) uint16 {
	crc := uint16(initCRC)
	for _, b := range data {
		crc = update(crc, b)
	}
	return crc
}

// applyShift applies a shift matrix to a register value.
func applyShift(m *[16]uint16, r uint16) uint16 {
	var out uint16
	for i := 0; i < 16; i++ {
		if r&(1<<i) != 0 {
			out ^= m[i]
		}
	}
	return out
}

// shiftCRC returns T_k(r): the register obtained by feeding k zero bytes
// into initial register r.
func shiftCRC(r uint16, k int) uint16 {
	for j := 0; k != 0; j++ {
		if k&1 != 0 {
			r = applyShift(&shiftPow[j], r)
		}
		k >>= 1
	}
	return r
}

// rangeChecksum computes CRC16/CCITT-FALSE (init 0xFFFF) over stream[a:b],
// where p0(off) is the prefix CRC of stream[:off] computed from init 0.
func rangeChecksum(p0 func(off int64) uint16, a, b int64) uint16 {
	k := int(b - a)
	return p0(b) ^ shiftCRC(p0(a), k) ^ shiftCRC(initCRC, k)
}
