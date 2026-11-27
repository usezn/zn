package zn

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSplitForAnalyze(t *testing.T) {
	emoji := "\U0001F600"
	tests := []struct {
		name string
		text string
		max  int
		want []string // nil: only check the invariants
	}{
		{name: "empty", text: "", max: 10, want: nil},
		{name: "fits", text: "hello", max: 10, want: []string{"hello"}},
		{name: "paragraphs packed", text: "aaaa\n\nbbbb\n\ncccc", max: 12, want: []string{"aaaa\n\nbbbb\n\n", "cccc"}},
		{name: "one paragraph per piece", text: "aaaa\n\nbbbb\n\ncccc", max: 6, want: []string{"aaaa\n\n", "bbbb\n\n", "cccc"}},
		{name: "blank line with spaces", text: "aa\n \nbb", max: 5, want: []string{"aa\n \n", "bb"}},
		{name: "long paragraph cut at line break", text: "aaa\nbbb\nccc", max: 8, want: []string{"aaa\nbbb\n", "ccc"}},
		{name: "long paragraph cut at space", text: "aaa bbb ccc", max: 8, want: []string{"aaa bbb ", "ccc"}},
		{name: "hard cut", text: "abcdefghij", max: 4, want: []string{"abcd", "efgh", "ij"}},
		{name: "emoji never split", text: strings.Repeat(emoji, 5), max: 5, want: []string{emoji + emoji, emoji + emoji, emoji}},
		{name: "small tail joins next paragraph", text: "aaaaaaaa\n\nbb", max: 6},
		{name: "default max", text: "short", max: 0, want: []string{"short"}},
		{name: "tiny max raised", text: "ab", max: 1, want: []string{"ab"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := SplitForAnalyze(tc.text, tc.max)
			limit := tc.max
			if limit <= 0 {
				limit = MaxInputUnits
			}
			if limit < 2 {
				limit = 2
			}
			if strings.Join(got, "") != tc.text {
				t.Errorf("not lossless: %q -> %q", tc.text, got)
			}
			for _, p := range got {
				if p == "" {
					t.Error("empty piece")
				}
				if UTF16Len(p) > limit {
					t.Errorf("piece %q has %d units, limit %d", p, UTF16Len(p), limit)
				}
				if !utf8.ValidString(p) {
					t.Errorf("piece %q is not valid UTF-8", p)
				}
			}
			if tc.want != nil || tc.text == "" {
				if len(got) != len(tc.want) {
					t.Fatalf("got %q, want %q", got, tc.want)
				}
				for i := range got {
					if got[i] != tc.want[i] {
						t.Errorf("piece %d = %q, want %q", i, got[i], tc.want[i])
					}
				}
			}
		})
	}
}

func TestSplitForAnalyzeLargeDefault(t *testing.T) {
	para := strings.Repeat("word ", 1000) + "\n\n" // 5,002 units
	text := strings.Repeat(para, 10)               // 50,020 units
	got := SplitForAnalyze(text, 0)
	if len(got) < 3 {
		t.Fatalf("pieces = %d", len(got))
	}
	for i, p := range got {
		if UTF16Len(p) > MaxInputUnits {
			t.Errorf("piece %d has %d units", i, UTF16Len(p))
		}
	}
	if strings.Join(got, "") != text {
		t.Error("not lossless")
	}
	// Pieces break on paragraph boundaries here: each ends with a blank line.
	for i, p := range got[:len(got)-1] {
		if !strings.HasSuffix(p, "\n\n") {
			t.Errorf("piece %d does not end on a paragraph boundary", i)
		}
	}
}

func TestSplitInvalidUTF8NoLoop(t *testing.T) {
	text := strings.Repeat("\xff", 50)
	got := SplitForAnalyze(text, 7)
	if strings.Join(got, "") != text {
		t.Error("not lossless")
	}
}
