package terrasync

import (
	"reflect"
	"testing"
)

// encode renders s in the given encoding, without BOM.
func encode(enc Encoding, s string) []byte {
	if enc == UTF8 {
		return []byte(s)
	}
	runes := []rune(s)
	out := make([]byte, 0, len(s)*2)
	for _, r := range runes {
		if r > 0xFFFF {
			r -= 0x10000
			hi := uint16(0xD800 + (r >> 10))
			lo := uint16(0xDC00 + (r & 0x3FF))
			out = append(out, byte(hi), byte(hi>>8), byte(lo), byte(lo>>8))
		} else {
			out = append(out, byte(r), byte(r>>8))
		}
	}
	return out
}

func bom(enc Encoding) []byte {
	if enc == UTF8 {
		return []byte{0xEF, 0xBB, 0xBF}
	}
	return []byte{0xFF, 0xFE}
}

// feedAll feeds data to p in one shot and finishes.
func feedAll(t *testing.T, p *Parser, data []byte) ([]Record, error) {
	t.Helper()
	recs, err := p.Feed(data)
	if err != nil {
		return recs, err
	}
	fin, err := p.Finish()
	return append(recs, fin...), err
}

func TestBasicCases(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []Record
	}{
		{"empty", "", nil},
		{"empty line", "\n", []Record{{Fields: []string{""}, Start: 0, End: 1}}},
		{"two empty lines", "\n\n", []Record{
			{Fields: []string{""}, Start: 0, End: 1},
			{Fields: []string{""}, Start: 1, End: 2},
		}},
		{"simple", "a,b\n", []Record{{Fields: []string{"a", "b"}, Start: 0, End: 4}}},
		{"crlf", "a,b\r\n", []Record{{Fields: []string{"a", "b"}, Start: 0, End: 5}}},
		{"no trailing newline", "a,b", []Record{{Fields: []string{"a", "b"}, Start: 0, End: 3}}},
		{"trailing comma", "a,\n", []Record{{Fields: []string{"a", ""}, Start: 0, End: 3}}},
		{"trailing comma eof", "a,", []Record{{Fields: []string{"a", ""}, Start: 0, End: 2}}},
		{"no extra record after newline", "a\n", []Record{{Fields: []string{"a"}, Start: 0, End: 2}}},
		{"quoted", `"x,y"` + "\n", []Record{{Fields: []string{"x,y"}, Start: 0, End: 6}}},
		{"quoted crlf inside", "\"a\r\nb\"\n", []Record{{Fields: []string{"a\r\nb"}, Start: 0, End: 7}}},
		{"escaped quote", `"a""b"`, []Record{{Fields: []string{`a"b`}, Start: 0, End: 6}}},
		{"empty quoted", `""`, []Record{{Fields: []string{""}, Start: 0, End: 2}}},
		{"spaces kept", " a , b \n", []Record{{Fields: []string{" a ", " b "}, Start: 0, End: 8}}},
		{"two records", "a\nb\n", []Record{
			{Fields: []string{"a"}, Start: 0, End: 2},
			{Fields: []string{"b"}, Start: 2, End: 4},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := feedAll(t, New(UTF8), []byte(tc.in))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestBasicErrors(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		wantOff int64
	}{
		{"lone cr", "a\rb", 1},
		{"lone cr eof", "a\r", 1},
		{"quote in unquoted", `ab"`, 2},
		{"char after closing quote", `"ab"x`, 4},
		{"unterminated quote", `"ab`, 0},
		{"bad utf8", "a\xffb", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := feedAll(t, New(UTF8), []byte(tc.in))
			pe, ok := err.(*ParseError)
			if !ok {
				t.Fatalf("expected ParseError, got %v", err)
			}
			if pe.Offset != tc.wantOff {
				t.Fatalf("error offset = %d, want %d", pe.Offset, tc.wantOff)
			}
		})
	}
}

func TestBOMAndUTF16(t *testing.T) {
	// BOM stripped; record range excludes it. Second BOM-like char is content.
	data := append(bom(UTF8), []byte("a\n")...)
	got, err := feedAll(t, New(UTF8), data)
	if err != nil {
		t.Fatal(err)
	}
	want := []Record{{Fields: []string{"a"}, Start: 3, End: 5}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// UTF-16LE with BOM.
	data16 := append(bom(UTF16LE), encode(UTF16LE, "a,b\r\n")...)
	got, err = feedAll(t, New(UTF16LE), data16)
	if err != nil {
		t.Fatal(err)
	}
	want = []Record{{Fields: []string{"a", "b"}, Start: 2, End: 12}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// UTF-16LE unpaired surrogates and truncated unit.
	if _, err := feedAll(t, New(UTF16LE), []byte{0x00, 0xD8, 'a', 0}); err == nil {
		t.Fatal("expected error for high surrogate followed by non-low")
	}
	if _, err := feedAll(t, New(UTF16LE), []byte{0x00, 0xDC}); err == nil {
		t.Fatal("expected error for lone low surrogate")
	}
	if _, err := feedAll(t, New(UTF16LE), []byte{'a'}); err == nil {
		t.Fatal("expected error for truncated code unit at Finish")
	}
}
