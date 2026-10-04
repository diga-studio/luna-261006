package frame

// CRC16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor.
//
// The CRC state update is linear over GF(2): processing one byte maps
// (state, b) -> A(state) ^ table[b], where A is the linear map "advance the
// state as if a zero byte arrived". Thanks to linearity, the state after a
// message m starting from init s is A^len(m)(s) ^ Z(m), where Z(m) is the
// zero-init state of m. Keeping zero-init prefix states z[i] for the buffer
// therefore yields an O(log k) window-CRC query for any sub-slice:
//
//	CRC(buf[a:b]) = A^k(0xFFFF) ^ z[b] ^ A^k(z[a]),  k = b-a
//
// A^k is applied via precomputed binary powers of A (18 matrices of 16
// uint16 each cover k < 2^18, more than the max frame length 65541).

const crcPoly = 0x1021
const crcInit = 0xFFFF

var crcTable [256]uint16

// matPow[p][j] is A^(2^p) applied to the basis vector 1<<j.
var matPow [18][16]uint16

func init() {
	for i := 0; i < 256; i++ {
		c := uint16(i) << 8
		for j := 0; j < 8; j++ {
			if c&0x8000 != 0 {
				c = (c << 1) ^ crcPoly
			} else {
				c <<= 1
			}
		}
		crcTable[i] = c
	}
	for j := 0; j < 16; j++ {
		matPow[0][j] = stepA(1 << uint(j))
	}
	for p := 1; p < len(matPow); p++ {
		for j := 0; j < 16; j++ {
			matPow[p][j] = applyMat(&matPow[p-1], matPow[p-1][j])
		}
	}
}

// crc16 computes CRC16/CCITT-FALSE over data.
func crc16(data []byte) uint16 {
	crc := uint16(crcInit)
	for _, b := range data {
		crc = (crc << 8) ^ crcTable[uint8(crc>>8)^b]
	}
	return crc
}

// stepA applies the one-zero-byte state transition A to a CRC state.
func stepA(s uint16) uint16 {
	return (s << 8) ^ crcTable[s>>8]
}

// applyMat applies the 16x16 GF(2) matrix m (column images) to x.
func applyMat(m *[16]uint16, x uint16) uint16 {
	var r uint16
	for j := 0; j < 16; j++ {
		if x&(1<<uint(j)) != 0 {
			r ^= m[j]
		}
	}
	return r
}

// applyK applies A^k to a CRC state in O(log k). Requires k < 1<<18.
func applyK(x uint16, k int) uint16 {
	p := 0
	for k > 0 {
		if k&1 != 0 {
			x = applyMat(&matPow[p], x)
		}
		k >>= 1
		p++
	}
	return x
}

// crcWindow returns CRC16/CCITT-FALSE of the buffered bytes [a:b), where z
// holds zero-init prefix states aligned with the buffer (z[i] is the state
// after the stream prefix ending at buffer index i).
func crcWindow(z []uint16, a, b int) uint16 {
	k := b - a
	return applyK(crcInit, k) ^ z[b] ^ applyK(z[a], k)
}
