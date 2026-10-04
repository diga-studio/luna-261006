package frameproto

// ringSize must exceed the largest window we ever hold: one incomplete
// maximal candidate (MaxFrameLen bytes) plus one in-flight byte.
const ringSize = 1 << 17 // 131072 > MaxFrameLen

// Decoder incrementally extracts valid frames from a byte stream.
// Not safe for concurrent use.
//
// Memory: two fixed rings (data + prefix CRCs) of ringSize slots,
// ~384 KiB total, independent of stream length.
//
// Work: O(1) amortized per ingested byte (the scan pointer only moves
// forward) plus O(log L) per candidate via rangeChecksum over prefix
// CRCs, never re-scanning a candidate's payload.
type Decoder struct {
	data [ringSize]byte   // stream bytes, slot = offset & (ringSize-1)
	p0   [ringSize]uint16 // P0(off): CRC of stream[:off] from init 0

	recv  int64  // absolute offset of the next byte to ingest
	scan  int64  // earliest offset not ruled out as a sync start
	cand  int64  // start of the pending earliest candidate, -1 if none
	p0cur uint16 // P0(recv)

	out     []Frame // frames determined by the current call
	started bool
}

// NewDecoder returns a ready-to-use Decoder.
func NewDecoder() *Decoder {
	d := &Decoder{cand: -1}
	d.p0[0] = 0 // P0(0): CRC of empty prefix from init 0
	return d
}

// Feed ingests chunk and returns frames that became certain during this call.
func (d *Decoder) Feed(chunk []byte) []Frame {
	d.started = true
	for _, b := range chunk {
		d.ingest(b)
		d.process(false)
	}
	return d.take()
}

// Finish signals EOF and returns any remaining determinable frames.
// Incomplete candidates at EOF are treated as failed, so valid frames
// nested inside them are still recovered.
func (d *Decoder) Finish() []Frame {
	d.started = true
	d.process(true)
	return d.take()
}

func (d *Decoder) take() []Frame {
	out := d.out
	d.out = nil
	return out
}

func (d *Decoder) ingest(b byte) {
	d.data[d.recv&(ringSize-1)] = b
	d.p0cur = update(d.p0cur, b)
	d.recv++
	d.p0[d.recv&(ringSize-1)] = d.p0cur
}

func (d *Decoder) p0At(off int64) uint16 { return d.p0[off&(ringSize-1)] }

func (d *Decoder) byteAt(off int64) byte { return d.data[off&(ringSize-1)] }

// process advances the framing state machine until it must wait for more
// input (eof=false) or has resolved everything (eof=true).
func (d *Decoder) process(eof bool) {
	for {
		if d.cand < 0 {
			// Find the earliest sync at or after scan.
			for d.scan+2 <= d.recv {
				if d.byteAt(d.scan) == Sync0 && d.byteAt(d.scan+1) == Sync1 {
					d.cand = d.scan
					break
				}
				d.scan++
			}
			if d.cand < 0 {
				// A trailing non-sync byte can never start a frame.
				if d.scan == d.recv-1 && d.byteAt(d.scan) != Sync0 {
					d.scan++
				}
				return
			}
		}

		have := d.recv - d.cand
		if have < headerLen {
			if !eof {
				return // wait for the length field
			}
			d.scan, d.cand = d.cand+1, -1 // truncated header: candidate fails
			continue
		}

		length := int64(d.byteAt(d.cand+2))<<8 | int64(d.byteAt(d.cand+3))
		total := headerLen + length + trailerLen
		if have < total {
			if !eof {
				return // incomplete candidate must wait, even if a
				// valid frame is already complete inside it
			}
			d.scan, d.cand = d.cand+1, -1 // truncated at EOF: candidate fails
			continue
		}

		// Complete candidate: CRC covers the length field and payload.
		a, b := d.cand+2, d.cand+4+length
		crc := rangeChecksum(d.p0At, a, b)
		stored := uint16(d.byteAt(b))<<8 | uint16(d.byteAt(b+1))
		if crc == stored {
			payload := make([]byte, length)
			for i := range payload {
				payload[i] = d.byteAt(d.cand + 4 + int64(i))
			}
			d.out = append(d.out, Frame{Offset: d.cand, Payload: payload})
			d.scan = d.cand + total // syncs inside an emitted frame are inert
		} else {
			d.scan = d.cand + 1 // exclude only this start; inner syncs live
		}
		d.cand = -1
	}
}
