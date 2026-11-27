package zn

import (
	"strings"
	"unicode/utf8"
)

// MaxInputUnits is the longest input the API accepts, in UTF-16 code
// units. Most characters count once; emoji and some rare characters
// count twice.
const MaxInputUnits = 20000

// UTF16Len returns the length of s in UTF-16 code units, the unit the API
// uses for its input limit. Invalid UTF-8 bytes count as one unit each,
// as they are sent as U+FFFD.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		n += runeUnits(r)
	}
	return n
}

func runeUnits(r rune) int {
	if r >= 0x10000 {
		return 2
	}
	return 1
}

// SplitForAnalyze splits text into pieces of at most max UTF-16 code units,
// cutting on paragraph boundaries (blank lines) where it can. A paragraph
// longer than max is cut at a line break, then at a space, and only then
// anywhere (never inside a character). Joining the pieces with an empty
// string gives back text exactly.
//
// Splitting is optional: the API already scans inputs of more than 2,000
// characters in overlapping windows, up to 20,000 UTF-16 units. Use this
// only for text longer than that, or when you want to send pieces yourself.
// Every piece is a separate call and counts against your quota.
//
// A max of zero or less means MaxInputUnits; values below 2 are raised to 2
// so that every character fits.
func SplitForAnalyze(text string, max int) []string {
	if max <= 0 {
		max = MaxInputUnits
	}
	if max < 2 {
		max = 2
	}
	if text == "" {
		return nil
	}
	var pieces []string
	var cur strings.Builder
	curUnits := 0
	flush := func() {
		if curUnits > 0 {
			pieces = append(pieces, cur.String())
			cur.Reset()
			curUnits = 0
		}
	}
	for _, para := range paragraphs(text) {
		u := UTF16Len(para)
		if u > max {
			flush()
			parts := hardSplit(para, max)
			// The last part may be small: keep it open for the next paragraph.
			pieces = append(pieces, parts[:len(parts)-1]...)
			last := parts[len(parts)-1]
			cur.WriteString(last)
			curUnits = UTF16Len(last)
			continue
		}
		if curUnits+u > max {
			flush()
		}
		cur.WriteString(para)
		curUnits += u
	}
	flush()
	return pieces
}

// paragraphs cuts text after each run of blank lines, keeping every byte.
func paragraphs(text string) []string {
	var out []string
	start := 0
	i := 0
	for i < len(text) {
		if text[i] == '\n' {
			// A blank line is a newline, optional spaces, then a newline.
			j := i + 1
			for j < len(text) && (text[j] == ' ' || text[j] == '\t' || text[j] == '\r') {
				j++
			}
			if j < len(text) && text[j] == '\n' {
				// Extend over the whole run of blank lines.
				k := j + 1
				for k < len(text) && (text[k] == '\n' || text[k] == ' ' || text[k] == '\t' || text[k] == '\r') {
					k++
				}
				out = append(out, text[start:k])
				start = k
				i = k
				continue
			}
		}
		i++
	}
	if start < len(text) {
		out = append(out, text[start:])
	}
	return out
}

// hardSplit cuts s into parts of at most max units, preferring a cut after
// a line break, then after a space.
func hardSplit(s string, max int) []string {
	var parts []string
	for s != "" {
		if UTF16Len(s) <= max {
			parts = append(parts, s)
			break
		}
		units := 0
		hard := len(s) // byte offset of the first rune that does not fit
		nl, sp := 0, 0 // byte offsets just after the last line break / space
		for i, r := range s {
			w := runeUnits(r)
			if units+w > max {
				hard = i
				break
			}
			units += w
			size := 1
			if r != utf8.RuneError {
				size = utf8.RuneLen(r)
			}
			switch r {
			case '\n':
				nl = i + size
			case ' ', '\t':
				sp = i + size
			}
		}
		cut := hard
		if nl > 0 {
			cut = nl
		} else if sp > 0 {
			cut = sp
		}
		parts = append(parts, s[:cut])
		s = s[cut:]
	}
	return parts
}
