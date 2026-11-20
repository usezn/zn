package zn

// Verdict values returned by the API.
const (
	VerdictAllow = "allow"
	VerdictBlock = "block"
)

// Result is the response of POST /v30/analyze.
//
// Fields the API leaves out or sets to null are left at their zero value
// (nil for pointers).
type Result struct {
	// Verdict is "allow" or "block".
	Verdict string `json:"verdict"`
	// Confidence is how sure the API is of the verdict, 0 to 1. When the
	// rules decide, it comes from the rules, not from a model.
	// Score is the model score for the input, 0 to 1, and is nil when no
	// model scored the text (the rules decided, or the model was
	// unavailable).
	Confidence float64  `json:"confidence"`
	Score      *float64 `json:"score"`
	// Threshold is the score at or above which the model that decided
	// blocks.
	Threshold float64 `json:"threshold"`
	// RequestMode is "monitor" or "enforce" when the call set a mode, empty
	// otherwise. WouldBlock is set only in monitor mode: the verdict is then
	// always "allow" and WouldBlock says what it would have been.
	RequestMode string `json:"request_mode"`
	WouldBlock  *bool  `json:"would_block"`
	// Rule and Reason say what decided the verdict. Reason may be empty.
	Rule   string `json:"rule"`
	Reason string `json:"reason"`
	// DecidedBy is "rules" or "ml"; fallback values such as
	// "ml-error-rules-fallback" appear when the model is unavailable.
	DecidedBy string `json:"decided_by"`
	// RulesVersion and MLVersion identify what produced the verdict, for
	// audits.
	RulesVersion string   `json:"rules_version"`
	MLVersion    string   `json:"ml_version"`
	MLThreshold  *float64 `json:"ml_threshold"`
	// RouterLevel is "rules", "advanced" or "deep": how far the call went.
	RouterLevel string `json:"router_level"`
	// Mode is the server-side detector mode, not the mode of the request
	// (see RequestMode).
	Mode string `json:"mode"`
	// Model is the Galvanize model that checked the text, or empty when no
	// model scored it. ModelRequested is the model the call was routed to,
	// and is set only when it differs from Model.
	Model          string `json:"model"`
	ModelRequested string `json:"model_requested"`
	// EvidenceID is the record in your dashboard evidence vault.
	EvidenceID string `json:"evidence_id"`
	// LatencyMS is the server-side processing time.
	LatencyMS int `json:"latency_ms"`
	// InputChars is the number of characters of the input (Unicode code
	// points). BilledCalls is the number of calls the request used from
	// your quota.
	InputChars  int `json:"input_chars"`
	BilledCalls int `json:"billed_calls"`
	// LongInput is set when the text was scored in windows.
	LongInput *LongInput `json:"long_input,omitempty"`
}

// LongInput describes how a long input was scored.
type LongInput struct {
	// Mode is "windows", or "truncate" when windows did not run.
	Mode string `json:"mode"`
	// Reason is set with "truncate": "fallback" or "not_scored".
	Reason string `json:"reason,omitempty"`
	// Windows is the number of windows the input needed (at most 20),
	// Scored the number scored in time, TopWindow the window that decided
	// (0 is the start of the input).
	Windows   int `json:"windows"`
	Scored    int `json:"scored"`
	TopWindow int `json:"top_window"`
	// Capped is true when the input needed more than 20 windows.
	Capped bool `json:"capped"`
	// Partial is true when some windows were not scored in time.
	Partial bool `json:"partial"`
}

// WouldHaveBlocked reports whether a monitor-mode call would have been
// blocked in enforce mode. It is false outside monitor mode.
func (r *Result) WouldHaveBlocked() bool {
	return r != nil && r.WouldBlock != nil && *r.WouldBlock
}

// Blocked reports whether the verdict is "block".
func (r *Result) Blocked() bool { return r != nil && r.Verdict == VerdictBlock }

// Allowed reports whether the verdict is exactly "allow". To fail closed,
// treat anything that is not Allowed as a stop.
func (r *Result) Allowed() bool { return r != nil && r.Verdict == VerdictAllow }

// Partial reports whether only part of a long input was scored in time:
// the windows already scored decided the verdict, and the rest were not
// checked.
func (r *Result) Partial() bool { return r != nil && r.LongInput != nil && r.LongInput.Partial }
