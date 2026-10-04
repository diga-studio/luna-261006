package frameproto

import "fmt"

const (
	Sync0 = 0xA5
	Sync1 = 0x5A

	// headerLen = sync(2) + length(2); trailerLen = crc(2).
	headerLen  = 4
	trailerLen = 2

	// MaxPayload is the largest encodable payload.
	MaxPayload = 0xFFFF
	// MaxFrameLen is the largest total on-wire frame length.
	MaxFrameLen = headerLen + MaxPayload + trailerLen
)

// Frame is a decoded frame. Offset counts bytes from the stream start.
// Payload is owned by the caller and never modified by the Decoder.
type Frame struct {
	Offset  int64
	Payload []byte
}

// Encode builds the on-wire representation of a frame carrying payload.
func Encode(payload []byte) ([]byte, error) {
	if len(payload) > MaxPayload {
		return nil, fmt.Errorf("frameproto: payload too large: %d > %d", len(payload), MaxPayload)
	}
	out := make([]byte, MaxFrameLen-MaxPayload+len(payload))
	out[0] = Sync0
	out[1] = Sync1
	out[2] = byte(len(payload) >> 8)
	out[3] = byte(len(payload))
	copy(out[4:], payload)
	crc := Checksum(out[2 : 4+len(payload)])
	out[4+len(payload)] = byte(crc >> 8)
	out[5+len(payload)] = byte(crc)
	return out, nil
}
