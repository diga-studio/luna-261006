package terrasync

import (
	"strings"
	"testing"
)

func parseAll(t *testing.T, enc Encoding, data []byte) ([]Record, error) {
	t.Helper()
	p := New(enc)
	var all []Record
	recs, err := p.Feed(data)
	all = append(all, recs...)
	if err != nil {
		return all, err
	}
	recs, err = p.Finish()
	return append(all, recs...), err
}

func mustParse(t *testing.T, enc Encoding, data []byte) []Record {
	t.Helper()
	recs, err := parseAll(t, enc, data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	return recs
}

func mustFail(t *testing.T, enc Encoding, data []byte, wantOff int64) {
	t.Helper()
	_, err := parseAll(t, enc, data)
	if err == nil {
		t.Fatalf("want error at offset %d, got none", wantOff)
	}
	pe, ok := err.(*ParseError)
	if !ok {
		t.Fatalf("err = %v, want *ParseError", err)
	}
	if pe.Offset != wantOff {
		t.Fatalf("error offset = %d, want %d", pe.Offset, wantOff)
	}
}

func TestEdgeCases(t *testing.T) {
	t.Run("empty file has no records", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, nil), nil)
	})
	t.Run("bom only has no records", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte{0xEF, 0xBB, 0xBF}), nil)
		assertRecords(t, mustParse(t, UTF16LE, []byte{0xFF, 0xFE}), nil)
	})
	t.Run("empty line is one empty field", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte("\n")),
			[]Record{{Fields: []string{""}, Start: 0, End: 1}})
	})
	t.Run("trailing delimiter yields empty field", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte("a,")),
			[]Record{{Fields: []string{"a", ""}, Start: 0, End: 2}})
	})
	t.Run("trailing newline yields no extra record", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte("a\n")),
			[]Record{{Fields: []string{"a"}, Start: 0, End: 2}})
	})
	t.Run("no trailing newline still ends record", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte("a,b")),
			[]Record{{Fields: []string{"a", "b"}, Start: 0, End: 3}})
	})
	t.Run("crlf terminator", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte("a\r\nb\r\n")),
			[]Record{
				{Fields: []string{"a"}, Start: 0, End: 3},
				{Fields: []string{"b"}, Start: 3, End: 6},
			})
	})
	t.Run("quoted crlf and escaped quote", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte("\"x\r\ny\"\"z\",w\n")),
			[]Record{{Fields: []string{"x\r\ny\"z", "w"}, Start: 0, End: 12}})
	})
	t.Run("empty quoted field", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte("\"\"\n")),
			[]Record{{Fields: []string{""}, Start: 0, End: 3}})
	})
	t.Run("whitespace is preserved", func(t *testing.T) {
		assertRecords(t, mustParse(t, UTF8, []byte("  a  , b \n")),
			[]Record{{Fields: []string{"  a  ", " b "}, Start: 0, End: 10}})
	})
	t.Run("bom excluded from span but second bom is content", func(t *testing.T) {
		data := append([]byte{0xEF, 0xBB, 0xBF}, []byte("x\n")...)
		assertRecords(t, mustParse(t, UTF8, data),
			[]Record{{Fields: []string{"x"}, Start: 3, End: 5}})
		data2 := append(data, 0xEF, 0xBB, 0xBF)
		data2 = append(data2, []byte("\n")...)
		recs := mustParse(t, UTF8, data2)
		if recs[1].Fields[0] != "\uFEFF" {
			t.Fatalf("second BOM should be content, got %q", recs[1].Fields[0])
		}
	})
	t.Run("quote not at field start", func(t *testing.T) {
		mustFail(t, UTF8, []byte(`ab"`), 2)
	})
	t.Run("char after closing quote", func(t *testing.T) {
		mustFail(t, UTF8, []byte(`"a"x`), 3)
	})
	t.Run("lone CR outside quotes", func(t *testing.T) {
		mustFail(t, UTF8, []byte("a\rb"), 1)
		mustFail(t, UTF8, []byte("a\r"), 1) // at Finish
	})
	t.Run("unterminated quote", func(t *testing.T) {
		mustFail(t, UTF8, []byte(`"abc`), 0)
	})
	t.Run("invalid utf8", func(t *testing.T) {
		mustFail(t, UTF8, []byte{'a', 0xFF}, 1)
		mustFail(t, UTF8, []byte{0xC3}, 0) // truncated at Finish
	})
	t.Run("utf16 unpaired surrogates", func(t *testing.T) {
		mustFail(t, UTF16LE, []byte{0x3D, 0xD8, 'a', 0}, 0) // high + non-low
		mustFail(t, UTF16LE, []byte{0x00, 0xDC}, 0)         // lone low
		mustFail(t, UTF16LE, []byte{0x3D, 0xD8}, 0)         // high at Finish
		mustFail(t, UTF16LE, []byte{'a'}, 0)                // odd byte at Finish
	})
	t.Run("utf16le full parse", func(t *testing.T) {
		data := encodeUTF16LE("a,\"b\r\nc\"\n💪,z")
		recs := mustParse(t, UTF16LE, data)
		assertRecords(t, recs, []Record{
			{Fields: []string{"a", "b\r\nc"}, Start: 2, End: 20},
			{Fields: []string{"💪", "z"}, Start: 20, End: 28},
		})
	})
	t.Run("error record is not emitted", func(t *testing.T) {
		recs, err := parseAll(t, UTF8, []byte("ok\n\"bad"))
		if err == nil {
			t.Fatal("want error")
		}
		assertRecords(t, recs, []Record{{Fields: []string{"ok"}, Start: 0, End: 3}})
	})
	t.Run("finish twice and feed after finish fail", func(t *testing.T) {
		p := New(UTF8)
		if _, err := p.Finish(); err != nil {
			t.Fatal(err)
		}
		if _, err := p.Finish(); err == nil {
			t.Fatal("want error on second Finish")
		}
		if _, err := p.Feed([]byte("x")); err == nil {
			t.Fatal("want error on Feed after Finish")
		}
		if _, _, err := p.Checkpoint(); err == nil {
			t.Fatal("want error on Checkpoint after Finish")
		}
	})
	t.Run("restore rejects garbage", func(t *testing.T) {
		if _, err := Restore([]byte("junk")); err == nil {
			t.Fatal("want error")
		}
		if _, err := Restore(nil); err == nil {
			t.Fatal("want error")
		}
	})
	t.Run("checkpoint offset tracks feeds", func(t *testing.T) {
		p := New(UTF8)
		if _, err := p.Feed([]byte("ab\ncd")); err != nil {
			t.Fatal(err)
		}
		_, off, err := p.Checkpoint()
		if err != nil {
			t.Fatal(err)
		}
		if off != 5 {
			t.Fatalf("offset = %d, want 5", off)
		}
	})
	t.Run("long unquoted field", func(t *testing.T) {
		field := strings.Repeat("q", 100000)
		recs := mustParse(t, UTF8, []byte(field+"\n"))
		if recs[0].Fields[0] != field {
			t.Fatal("field mismatch")
		}
	})
}
