package terrasync

import (
	"testing"
)

// TestPauseMidCodeUnit stops the stream inside multi-byte encoded
// characters, then either resumes or finishes.
func TestPauseMidCodeUnit(t *testing.T) {
	// "é" is 2 bytes in UTF-8 (0xC3 0xA9); 💪 is 4 bytes.
	full := []byte("ok,\xc3\xa9,\xf0\x9f\x92\xaa\n")

	t.Run("resume utf8 2-byte", func(t *testing.T) {
		p := New(UTF8)
		recs, err := p.Feed(full[:4]) // stops after 0xC3
		if err != nil || len(recs) != 0 {
			t.Fatalf("prefix: recs=%v err=%v", recs, err)
		}
		got := collect(t, p, full[4:])
		assertRecords(t, got, []Record{{Fields: []string{"ok", "é", "💪"}, Start: 0, End: int64(len(full))}})
	})

	t.Run("resume utf8 4-byte", func(t *testing.T) {
		p := New(UTF8)
		if _, err := p.Feed(full[:8]); err != nil { // stops after 2 of 4 emoji bytes
			t.Fatal(err)
		}
		got := collect(t, p, full[8:])
		assertRecords(t, got, []Record{{Fields: []string{"ok", "é", "💪"}, Start: 0, End: int64(len(full))}})
	})

	t.Run("finish mid utf8 unit", func(t *testing.T) {
		p := New(UTF8)
		if _, err := p.Feed(full[:4]); err != nil {
			t.Fatal(err)
		}
		_, err := p.Finish()
		pe, ok := err.(*ParseError)
		if !ok {
			t.Fatalf("err = %v, want *ParseError", err)
		}
		if pe.Offset != 3 {
			t.Fatalf("error offset = %d, want 3", pe.Offset)
		}
	})

	// UTF-16LE: 💪 = surrogate pair D83D DCAA -> bytes 3D D8 AA DC.
	full16 := []byte{'o', 0, 'k', 0, ',', 0, 0x3D, 0xD8, 0xAA, 0xDC, '\n', 0}

	t.Run("resume mid surrogate pair", func(t *testing.T) {
		p := New(UTF16LE)
		if _, err := p.Feed(full16[:8]); err != nil { // high surrogate pending
			t.Fatal(err)
		}
		got := collect(t, p, full16[8:])
		assertRecords(t, got, []Record{{Fields: []string{"ok", "💪"}, Start: 0, End: int64(len(full16))}})
	})

	t.Run("resume mid utf16 unit", func(t *testing.T) {
		p := New(UTF16LE)
		if _, err := p.Feed(full16[:7]); err != nil { // odd byte pending
			t.Fatal(err)
		}
		got := collect(t, p, full16[7:])
		assertRecords(t, got, []Record{{Fields: []string{"ok", "💪"}, Start: 0, End: int64(len(full16))}})
	})

	t.Run("finish mid surrogate pair", func(t *testing.T) {
		p := New(UTF16LE)
		if _, err := p.Feed(full16[:8]); err != nil {
			t.Fatal(err)
		}
		_, err := p.Finish()
		pe, ok := err.(*ParseError)
		if !ok {
			t.Fatalf("err = %v, want *ParseError", err)
		}
		if pe.Offset != 6 {
			t.Fatalf("error offset = %d, want 6", pe.Offset)
		}
	})
}

// TestPauseMidQuoteAndCRLF stops inside quoted constructs and CRLF pairs.
func TestPauseMidQuoteAndCRLF(t *testing.T) {
	data := []byte("\"ab\"\r\nnext")

	t.Run("resume mid quote", func(t *testing.T) {
		p := New(UTF8)
		if _, err := p.Feed(data[:1]); err != nil { // just the opening quote
			t.Fatal(err)
		}
		got := collect(t, p, data[1:])
		assertRecords(t, got, []Record{
			{Fields: []string{"ab"}, Start: 0, End: 6},
			{Fields: []string{"next"}, Start: 6, End: 10},
		})
	})

	t.Run("finish mid quote", func(t *testing.T) {
		p := New(UTF8)
		if _, err := p.Feed(data[:3]); err != nil { // `"ab` unterminated
			t.Fatal(err)
		}
		if _, err := p.Finish(); err == nil {
			t.Fatal("want unterminated quote error")
		}
	})

	t.Run("resume mid crlf", func(t *testing.T) {
		p := New(UTF8)
		recs, err := p.Feed(data[:5]) // stops right after CR
		if err != nil || len(recs) != 0 {
			t.Fatalf("prefix: recs=%v err=%v", recs, err)
		}
		got := collect(t, p, data[5:])
		assertRecords(t, got, []Record{
			{Fields: []string{"ab"}, Start: 0, End: 6},
			{Fields: []string{"next"}, Start: 6, End: 10},
		})
	})

	t.Run("finish after lone cr", func(t *testing.T) {
		p := New(UTF8)
		if _, err := p.Feed(data[:5]); err != nil {
			t.Fatal(err)
		}
		_, err := p.Finish()
		pe, ok := err.(*ParseError)
		if !ok {
			t.Fatalf("err = %v, want *ParseError", err)
		}
		if pe.Offset != 4 {
			t.Fatalf("error offset = %d, want 4", pe.Offset)
		}
	})
}

// TestErrorAfterGoodRecords feeds a valid record followed by a bad suffix in
// many chunkings: completed records must survive and the error offset must
// not depend on chunking.
func TestErrorAfterGoodRecords(t *testing.T) {
	good := []byte("a,b\n")
	cases := []struct {
		name    string
		bad     []byte
		wantOff int64
	}{
		{"quote mid field", []byte(`xy"z`), 6},
		{"char after closing quote", []byte(`"v"w`), 7},
		{"lone cr", []byte("ab\rcd"), 6},
		{"invalid utf8", []byte{'q', 0xFF}, 5},
		{"unterminated quote at finish", []byte(`"v`), 4},
	}
	wantRec := Record{Fields: []string{"a", "b"}, Start: 0, End: 4}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := append(append([]byte{}, good...), tc.bad...)
			for cut := 0; cut <= len(data); cut++ {
				p := New(UTF8)
				var got []Record
				var gotErr error
				feed := func(b []byte) bool {
					recs, err := p.Feed(b)
					got = append(got, recs...)
					if err != nil {
						gotErr = err
						return false
					}
					return true
				}
				if feed(data[:cut]) && feed(data[cut:]) {
					_, gotErr = p.Finish()
				}
				if gotErr == nil {
					t.Fatalf("cut %d: want error", cut)
				}
				pe, ok := gotErr.(*ParseError)
				if !ok {
					t.Fatalf("cut %d: err = %v, want *ParseError", cut, gotErr)
				}
				if pe.Offset != tc.wantOff {
					t.Fatalf("cut %d: error offset = %d, want %d", cut, pe.Offset, tc.wantOff)
				}
				assertRecords(t, got, []Record{wantRec})
			}
		})
	}
}

// TestErrorPoisoning: after an error, further calls keep returning it and
// Checkpoint refuses to snapshot.
func TestErrorPoisoning(t *testing.T) {
	p := New(UTF8)
	if _, err := p.Feed([]byte("a\rb")); err == nil {
		t.Fatal("want error")
	}
	if _, err := p.Feed([]byte("x")); err == nil {
		t.Fatal("want sticky error")
	}
	if _, _, err := p.Checkpoint(); err == nil {
		t.Fatal("want checkpoint refusal")
	}
	if _, err := p.Finish(); err == nil {
		t.Fatal("want sticky error on Finish")
	}
}
