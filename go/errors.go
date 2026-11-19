package zn

import (
	"errors"
	"fmt"
	"time"
)

// Error codes the API sends in the "code" field.
const (
	CodeMonthlyLimitReached = "MONTHLY_LIMIT_REACHED"
	CodeInsufficientQuota   = "INSUFFICIENT_QUOTA"
	CodeTrialEnded          = "TRIAL_ENDED"
)

// Client-side errors.
var (
	// ErrNoAPIKey is returned when the client was created with an empty key.
	ErrNoAPIKey = errors.New("zn: API key is empty")
	// ErrEmptyInput is returned for an empty input; nothing is sent.
	ErrEmptyInput = errors.New("zn: input is empty")
	// ErrInputTooLong is returned, wrapped, when the input is longer than
	// MaxInputUnits UTF-16 code units. Nothing is sent.
	ErrInputTooLong = errors.New("zn: input is too long")
)

// APIError is an error answer from the API.
type APIError struct {
	// Status is the HTTP status code.
	Status int
	// Code is the machine-readable code, when the API sends one, for
	// example MONTHLY_LIMIT_REACHED.
	Code string
	// Message is the human-readable message. Branch on Status and Code,
	// not on this text.
	Message string
	// RetryAfter is the Retry-After header of a 429, or zero. For quota
	// errors it is the time until the monthly quota resets.
	RetryAfter time.Duration
	// Required and Remaining are set with INSUFFICIENT_QUOTA: the calls
	// the input needs and the monthly calls left.
	Required  int
	Remaining int
	// AllowedModels is set with model_not_in_plan.
	AllowedModels []string
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("zn: API error %d", e.Status)
	if e.Code != "" {
		s += " " + e.Code
	}
	if e.Message != "" {
		s += ": " + e.Message
	}
	return s
}

func asAPIError(err error) (*APIError, bool) {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae, true
	}
	return nil, false
}

// IsRateLimited reports whether err is a 429 answer. This includes quota
// answers (monthly limit reached); use IsQuotaExceeded to tell them apart.
func IsRateLimited(err error) bool {
	ae, ok := asAPIError(err)
	return ok && ae.Status == 429
}

// IsQuotaExceeded reports whether err means your calls or credits are used
// up: a 402 answer, or a quota code (MONTHLY_LIMIT_REACHED,
// INSUFFICIENT_QUOTA, TRIAL_ENDED). Retrying does not help until the quota
// resets or you add credits.
func IsQuotaExceeded(err error) bool {
	ae, ok := asAPIError(err)
	if !ok {
		return false
	}
	if ae.Status == 402 {
		return true
	}
	switch ae.Code {
	case CodeMonthlyLimitReached, CodeInsufficientQuota, CodeTrialEnded:
		return true
	}
	return false
}

// IsUnauthorized reports whether err is a 401 answer: the key is missing,
// invalid or revoked.
func IsUnauthorized(err error) bool {
	ae, ok := asAPIError(err)
	return ok && ae.Status == 401
}
