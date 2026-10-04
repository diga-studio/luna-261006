package terrasync

import (
	"fmt"
	"unicode/utf16"
	"unicode/utf8"
)

// decodeRune attempts to decode one rune from buf, whose first byte sits at
// absolute offset off. It returns the rune and its width in bytes. needMore
// is true when buf holds an incomplete but so-far-valid prefix. A decoding
// violation yields an error positioned at the offending raw byte offset.
func decodeRune(enc Encoding, buf []byte, off int64) (rune, int, bool, error) {
	if enc == UTF16LE {
		return decodeUTF16LE(buf, off)
	}
	return decodeUTF8(buf, off)
}

func decodeUTF8(buf []byte, off int64) (rune, int, bool, error) {
	if len(buf) == 0 {
		return 0, 0, true, nil
	}
	r, size := utf8.DecodeRune(buf)
	if r == utf8.RuneError && size == 1 {
		// FullRune is false only for a truncated but valid-looking prefix;
		// an invalid encoding counts as a full width-1 error rune.
		if !utf8.FullRune(buf) {
			return 0, 0, true, nil
		}
		return 0, 0, false, &ParseError{Offset: off, Msg: "invalid UTF-8 byte"}
	}
	return r, size, false, nil
}

func decodeUTF16LE(buf []byte, off int64) (rune, int, bool, error) {
	if len(buf) < 2 {
		return 0, 0, true, nil
	}
	u := uint16(buf[0]) | uint16(buf[1])<<8
	switch {
	case u >= 0xD800 && u < 0xDC00: // high surrogate
		if len(buf) < 4 {
			return 0, 0, true, nil
		}
		u2 := uint16(buf[2]) | uint16(buf[3])<<8
		if u2 >= 0xDC00 && u2 < 0xE000 {
			return utf16.DecodeRune(rune(u), rune(u2)), 4, false, nil
		}
		return 0, 0, false, &ParseError{Offset: off, Msg: "unpaired high surrogate"}
	case u >= 0xDC00 && u < 0xE000: // lone low surrogate
		return 0, 0, false, &ParseError{Offset: off, Msg: "unpaired low surrogate"}
	default:
		return rune(u), 2, false, nil
	}
}

// ParseError reports a format or decoding failure at a raw byte offset.
type ParseError struct {
	Offset int64
	Msg    string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("terrasync: parse error at byte offset %d: %s", e.Offset, e.Msg)
}
