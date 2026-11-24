package zn

import "testing"

func TestAllowedRequiresTheWholeInputChecked(t *testing.T) {
	allow := func(li *LongInput) *Result { return &Result{Verdict: VerdictAllow, LongInput: li} }
	cases := []struct {
		name string
		res  *Result
		want bool
	}{
		{"short input", allow(nil), true},
		{"all windows scored", allow(&LongInput{Mode: "windows", Windows: 3, Scored: 3}), true},
		{"partial", allow(&LongInput{Mode: "windows", Windows: 5, Scored: 2, Partial: true}), false},
		{"capped", allow(&LongInput{Mode: "windows", Windows: 20, Scored: 20, Capped: true}), false},
		{"truncate fallback", allow(&LongInput{Mode: "truncate", Reason: "fallback"}), false},
		{"truncate not scored", allow(&LongInput{Mode: "truncate", Reason: "not_scored"}), false},
		{"unknown mode", allow(&LongInput{Mode: "other"}), false},
		{"block", &Result{Verdict: VerdictBlock}, false},
		{"nil result", nil, false},
	}
	for _, c := range cases {
		if got := c.res.Allowed(); got != c.want {
			t.Errorf("%s: Allowed() = %v, want %v", c.name, got, c.want)
		}
	}
	if (*Result)(nil).WholeInputChecked() {
		t.Error("a nil result must not count as checked")
	}
}
