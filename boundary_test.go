package terrasync

import (
	"reflect"
	"testing"
)

// splitCase describes pausing inside a sensitive structure, then either
// continuing with the remaining bytes or calling Finish at the pause.
type splitCase struct {
	name    string
	enc     Encoding
	content string   // full intended file content (no BOM)
	cut     int      // byte offset of the pause in the encoded content
	want    []Record // expected when continuing after the pause
	finErr  bool     // Finish at the pause must fail
	finRecs []Record // records expected from Finish at the pause
}

func runSplitCases(t *testing.T, cases []splitCase) {
	t.Helper()
	for _, tc := range cases {
		data := encode(tc.enc, tc.content)
		t.Run(tc.name+"/continue", func(t *testing.T) {
			p := New(tc.enc)
			var got []Record
			recs, err := p.Feed(data[:tc.cut])
			if err != nil {
				t.Fatalf("prefix Feed: %v", err)
			}
			got = append(got, recs...)
			recs, err = p.Feed(data[tc.cut:])
			if err != nil {
				t.Fatalf("suffix Feed: %v", err)
			}
			got = append(got, recs...)
			recs, err = p.Finish()
			if err != nil {
				t.Fatalf("Finish: %v", err)
			}
			got = append(got, recs...)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
		t.Run(tc.name+"/finish-at-pause", func(t *testing.T) {
			p := New(tc.enc)
			got, err := p.Feed(data[:tc.cut])
			if err != nil {
				t.Fatalf("prefix Feed: %v", err)
			}
			recs, err := p.Finish()
			got = append(got, recs...)
			if tc.finErr && err == nil {
				t.Fatal("expected Finish error at pause")
			}
			if !tc.finErr && err != nil {
				t.Fatalf("unexpected Finish error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.finRecs) {
				t.Fatalf("records at pause: got %+v, want %+v", got, tc.finRecs)
			}
		})
	}
}

func TestPauseInsideEncodingUnits(t *testing.T) {
	// "é" is 2 bytes in UTF-8 (0xC3 0xA9); "😀" is 4 bytes (F0 9F 98 80).
	e8 := encode(UTF8, "é")
	eEmoji := encode(UTF8, "😀")
	runSplitCases(t, []splitCase{
		{
			name:    "utf8-two-byte-unit",
			enc:     UTF8,
			content: "aé\n",
			cut:     1 + 1, // after first byte of é
			want:    []Record{{Fields: []string{"aé"}, Start: 0, End: 4}},
			finErr:  true,
		},
		{
			name:    "utf8-four-byte-unit",
			enc:     UTF8,
			content: "😀x\n",
			cut:     2, // middle of the emoji
			want:    []Record{{Fields: []string{"😀x"}, Start: 0, End: 6}},
			finErr:  true,
		},
		{
			name:    "utf16-odd-byte",
			enc:     UTF16LE,
			content: "ab\n",
			cut:     1, // middle of 'a' code unit
			want:    []Record{{Fields: []string{"ab"}, Start: 0, End: 6}},
			finErr:  true,
		},
		{
			name:    "utf16-surrogate-pair",
			enc:     UTF16LE,
			content: "😀\n",
			cut:     2, // after high surrogate, before low
			want:    []Record{{Fields: []string{"😀"}, Start: 0, End: 6}},
			finErr:  true,
		},
		// Sanity: the test's own encoding helpers produce the expected sizes.
		{name: "helper-check", enc: UTF8, content: string(e8) + string(eEmoji), cut: 0, want: []Record{{Fields: []string{"é😀"}, Start: 0, End: 6}}},
	})
}

func TestPauseInsideCSVStructures(t *testing.T) {
	runSplitCases(t, []splitCase{
		{
			name:    "between-escaped-quote-pair",
			enc:     UTF8,
			content: "\"a\"\"b\"\n",
			cut:     3, // between the two quotes of ""
			want:    []Record{{Fields: []string{`a"b`}, Start: 0, End: 7}},
			// At the pause the field is a legally closed quoted field, so
			// Finish completes the record.
			finRecs: []Record{{Fields: []string{"a"}, Start: 0, End: 3}},
		},
		{
			name:    "inside-quoted-field",
			enc:     UTF8,
			content: "\"ab\",c\n",
			cut:     2, // inside the quoted field
			want:    []Record{{Fields: []string{"ab", "c"}, Start: 0, End: 7}},
			finErr:  true, // unterminated quote
		},
		{
			name:    "between-cr-and-lf",
			enc:     UTF8,
			content: "a,b\r\n",
			cut:     4, // after CR, before LF
			want:    []Record{{Fields: []string{"a", "b"}, Start: 0, End: 5}},
			finErr:  true, // lone CR at EOF
		},
		{
			name:    "between-cr-and-lf-utf16",
			enc:     UTF16LE,
			content: "a\r\nb",
			cut:     4, // after CR (2 bytes per unit)
			want:    []Record{{Fields: []string{"a"}, Start: 0, End: 6}, {Fields: []string{"b"}, Start: 6, End: 8}},
			finErr:  true,
		},
		{
			name:    "after-comma",
			enc:     UTF8,
			content: "a,b\n",
			cut:     2, // after the comma; empty field pending
			want:    []Record{{Fields: []string{"a", "b"}, Start: 0, End: 4}},
			// Finish at the pause: "a," ends a record with a trailing
			// empty field.
			finRecs: []Record{{Fields: []string{"a", ""}, Start: 0, End: 2}},
		},
	})
}

// TestErrorPositionStableAcrossChunking feeds a file with a good record
// followed by a bad suffix in many chunkings, requiring identical records
// and identical error offsets each time.
func TestErrorPositionStableAcrossChunking(t *testing.T) {
	content := "good,1\nba\"d\nrest"
	data := []byte(content)
	wantRecs := []Record{{Fields: []string{"good", "1"}, Start: 0, End: 7}}
	wantErrOff := int64(9) // the '"' inside the unquoted field

	run := func(chunks [][]byte) ([]Record, error) {
		p := New(UTF8)
		var got []Record
		var firstErr error
		for _, c := range chunks {
			recs, err := p.Feed(c)
			got = append(got, recs...)
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}
		if _, err := p.Finish(); firstErr == nil {
			firstErr = err
		}
		return got, firstErr
	}

	check := func(name string, chunks [][]byte) {
		t.Helper()
		got, err := run(chunks)
		pe, ok := err.(*ParseError)
		if !ok {
			t.Fatalf("%s: expected ParseError, got %v", name, err)
		}
		if pe.Offset != wantErrOff {
			t.Fatalf("%s: error offset = %d, want %d", name, pe.Offset, wantErrOff)
		}
		if !reflect.DeepEqual(got, wantRecs) {
			t.Fatalf("%s: records = %+v, want %+v", name, got, wantRecs)
		}
	}

	check("one-shot", [][]byte{data})
	check("split-before-error", [][]byte{data[:8], data[8:]})
	check("split-at-error", [][]byte{data[:9], data[9:]})
	check("split-after-record", [][]byte{data[:7], data[7:]})
	// Byte by byte.
	var singles [][]byte
	for i := 0; i < len(data); i++ {
		singles = append(singles, data[i:i+1])
	}
	check("byte-by-byte", singles)
	// With checkpoint/restore right before the bad suffix.
	p := New(UTF8)
	recs, err := p.Feed(data[:7])
	if err != nil {
		t.Fatal(err)
	}
	state, _, err := p.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	q, _, err := Restore(state)
	if err != nil {
		t.Fatal(err)
	}
	_, err = q.Feed(data[7:])
	pe, ok := err.(*ParseError)
	if !ok {
		t.Fatalf("restored: expected ParseError, got %v", err)
	}
	if pe.Offset != wantErrOff {
		t.Fatalf("restored: error offset = %d, want %d", pe.Offset, wantErrOff)
	}
	if !reflect.DeepEqual(recs, wantRecs) {
		t.Fatalf("restored: records = %+v, want %+v", recs, wantRecs)
	}
}

// TestRecordsBeforeErrorReturned checks that a Feed detecting an error still
// returns the records completed earlier in that same call.
func TestRecordsBeforeErrorReturned(t *testing.T) {
	p := New(UTF8)
	recs, err := p.Feed([]byte("a\nb\n\xFF"))
	pe, ok := err.(*ParseError)
	if !ok {
		t.Fatalf("expected ParseError, got %v", err)
	}
	if pe.Offset != 4 {
		t.Fatalf("error offset = %d, want 4", pe.Offset)
	}
	want := []Record{
		{Fields: []string{"a"}, Start: 0, End: 2},
		{Fields: []string{"b"}, Start: 2, End: 4},
	}
	if !reflect.DeepEqual(recs, want) {
		t.Fatalf("got %+v, want %+v", recs, want)
	}
	// Sticky error on subsequent calls.
	if _, err := p.Feed([]byte("x")); err == nil {
		t.Fatal("expected sticky error")
	}
	if _, _, err := p.Checkpoint(); err == nil {
		t.Fatal("expected checkpoint error after parse error")
	}
}
