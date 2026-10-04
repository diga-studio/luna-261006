// Package frame implements streaming frame extraction for a fixed wire
// format: sync word A5 5A, two-byte big-endian payload length, payload,
// two-byte big-endian CRC16/CCITT-FALSE over the length field and payload.
//
// The decoder only performs framing and CRC validation; payloads are kept
// as raw bytes. Feed accepts arbitrarily sized chunks; Finish signals EOF.
// For any finite stream, the frames, their order and their offsets after
// Finish are identical regardless of how the input was chunked.
package frame

import (
	"bytes"
	"encoding/binary"
)

const (
	syncHi      = 0xA5
	syncLo      = 0x5A
	headerLen   = 4 // sync word + length field
	crcLen      = 2
	maxPayload  = 65535
	maxFrameLen = headerLen + maxPayload + crcLen // 65541

	// feedBlock bounds how much of a single Feed chunk is buffered at once
	// while scanning noise for the next sync word.
	feedBlock = 32 << 10
	// bufCap bounds the internal buffer: one maximal candidate plus one
	// noise scan block. Well under the 1 MiB extra-memory budget.
	bufCap = maxFrameLen + feedBlock + 16
)

var syncWord = []byte{syncHi, syncLo}

// Frame is a decoded frame. Offset is the byte offset of the sync word
// counted from the start of the stream. Payload holds the raw payload
// bytes; it is a private copy and is never modified by later calls.
type Frame struct {
	Offset  uint64
	Payload []byte
}

// Encode builds a wire frame for payload. It panics if the payload exceeds
// 65535 bytes.
func Encode(payload []byte) []byte {
	if len(payload) > maxPayload {
		panic("frame: payload exceeds 65535 bytes")
	}
	out := make([]byte, headerLen+len(payload)+crcLen)
	out[0] = syncHi
	out[1] = syncLo
	binary.BigEndian.PutUint16(out[2:], uint16(len(payload)))
	copy(out[headerLen:], payload)
	binary.BigEndian.PutUint16(out[headerLen+len(payload):], crc16(out[2:headerLen+len(payload)]))
	return out
}

// Decoder incrementally extracts frames from a byte stream. The zero value
// is ready to use. It is not safe for concurrent use.
//
// Internally it keeps at most one incomplete candidate (<= 65541 bytes)
// plus a bounded noise-scan block, so peak extra memory stays far below
// 1 MiB regardless of stream or chunk sizes.
type Decoder struct {
	buf  []byte   // backing store; valid data is buf[head:tail]
	z    []uint16 // zero-init CRC prefix states aligned with buf
	head int      // index of first unprocessed byte
	tail int      // index one past the last buffered byte
	base uint64   // absolute stream offset of buf[head]
}

// Feed consumes one chunk of the stream and returns the frames that became
// determinable during this call. If the earliest candidate is incomplete,
// Feed waits for more data and does not emit frames nested inside it.
func (d *Decoder) Feed(chunk []byte) []Frame {
	var frames []Frame
	rest := chunk
	for {
		frames = append(frames, d.process(false)...)
		if len(rest) == 0 {
			return frames
		}
		n := d.needed()
		if n <= 0 {
			n = feedBlock
		}
		if n > len(rest) {
			n = len(rest)
		}
		d.appendBytes(rest[:n])
		rest = rest[n:]
	}
}

// Finish signals end of stream. Incomplete candidates are treated as
// failed; their interiors and any later candidates are still examined.
// It returns the remaining determinable frames.
func (d *Decoder) Finish() []Frame {
	return d.process(true)
}

// process scans buffered data and emits all currently determinable frames.
// In EOF mode an incomplete candidate is discarded one byte at a time so
// that valid frames nested inside it can still be found.
func (d *Decoder) process(eof bool) []Frame {
	var frames []Frame
	for {
		b := d.buf[d.head:d.tail]
		i := bytes.Index(b, syncWord)
		if i < 0 {
			// No sync word. Keep a trailing 0xA5: it may pair with a
			// 0x5A arriving in the next chunk.
			keep := 0
			if !eof && len(b) > 0 && b[len(b)-1] == syncHi {
				keep = 1
			}
			d.drop(len(b) - keep)
			break
		}
		if i > 0 {
			d.drop(i) // noise before the earliest sync word
			b = d.buf[d.head:d.tail]
		}
		if len(b) < headerLen {
			if eof {
				d.drop(1)
				continue
			}
			break // wait for the rest of the header
		}
		l := int(b[2])<<8 | int(b[3])
		total := headerLen + l + crcLen
		if len(b) < total {
			if eof {
				d.drop(1) // truncated candidate failed; look inside it
				continue
			}
			break // wait for the rest of the candidate
		}
		want := uint16(b[total-2])<<8 | uint16(b[total-1])
		if crcWindow(d.z, d.head+2, d.head+headerLen+l) == want {
			payload := make([]byte, l)
			copy(payload, b[headerLen:headerLen+l])
			frames = append(frames, Frame{Offset: d.base, Payload: payload})
			d.drop(total) // continue after the frame; inner syncs ignored
		} else {
			d.drop(1) // exclude only this start; rescan the interior
		}
	}
	return frames
}

// needed reports how many more bytes are required to complete the earliest
// buffered candidate, or 0 when no sync word is currently buffered.
func (d *Decoder) needed() int {
	b := d.buf[d.head:d.tail]
	if len(b) < 2 || b[0] != syncHi || b[1] != syncLo {
		return 0
	}
	if len(b) < headerLen {
		return headerLen - len(b)
	}
	total := headerLen + (int(b[2])<<8 | int(b[3])) + crcLen
	if len(b) < total {
		return total - len(b)
	}
	return 0
}

// appendBytes buffers p and extends the zero-init CRC prefix states.
func (d *Decoder) appendBytes(p []byte) {
	if d.buf == nil {
		d.buf = make([]byte, bufCap)
		d.z = make([]uint16, bufCap+1)
	}
	if d.tail+len(p) > cap(d.buf) {
		d.compact()
	}
	for _, b := range p {
		d.buf[d.tail] = b
		d.z[d.tail+1] = stepA(d.z[d.tail]) ^ crcTable[b]
		d.tail++
	}
}

// compact moves buffered data to the front of the backing store. The
// prefix states stay valid: window CRCs only depend on state differences.
func (d *Decoder) compact() {
	n := d.tail - d.head
	copy(d.buf, d.buf[d.head:d.tail])
	copy(d.z, d.z[d.head:d.tail+1])
	d.head = 0
	d.tail = n
}

// drop discards k bytes from the front of the buffer.
func (d *Decoder) drop(k int) {
	d.head += k
	d.base += uint64(k)
}
