package zn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the production API host.
const DefaultBaseURL = "https://api.usezn.com"

const (
	defaultTimeout      = 12 * time.Second
	defaultMaxRetries   = 2
	defaultMaxRetryWait = 30 * time.Second
	defaultBackoffBase  = 500 * time.Millisecond
	maxBackoff          = 8 * time.Second
	maxResponseBytes    = 1 << 20
	userAgent           = "zn-go"
	analyzePath         = "/v30/analyze"
	// A Retry-After above this is capped (it also keeps time.Duration from
	// overflowing). The cap is above any maxRetryWait, so the client still
	// stops retrying.
	maxRetryAfter = 366 * 24 * time.Hour
)

// Client calls the zn Cloud API. It is safe for concurrent use.
type Client struct {
	apiKey       string
	baseURL      string
	httpClient   *http.Client
	timeout      time.Duration
	maxRetries   int
	maxRetryWait time.Duration
	backoffBase  time.Duration
	// baseErr is set when the base URL is refused; Analyze returns it.
	baseErr error
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL sets the API host, for example for a test server. The
// default is DefaultBaseURL. The URL must use https, so the API key is
// never sent in clear text; plain http is accepted only for a loopback
// host (localhost, 127.0.0.1 or [::1]). Any other URL makes Analyze return
// an error that wraps ErrInsecureBaseURL, and nothing is sent.
func WithBaseURL(u string) Option {
	return func(c *Client) {
		c.baseURL = strings.TrimRight(u, "/")
		c.baseErr = checkBaseURL(c.baseURL)
	}
}

// checkBaseURL accepts an https URL, or an http URL whose host is exactly
// a loopback name. The host is compared after parsing, so look-alikes such
// as localhost.example.com or 127.0.0.1.nip.io are refused, and so is a
// URL with credentials in front of a non-loopback host.
func checkBaseURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return fmt.Errorf("%w: not a valid URL with a host", ErrInsecureBaseURL)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return nil
	case "http":
		switch strings.ToLower(u.Hostname()) {
		case "localhost", "127.0.0.1", "::1":
			return nil
		}
	}
	return fmt.Errorf("%w: use https (plain http is allowed only for localhost, 127.0.0.1 and [::1])", ErrInsecureBaseURL)
}

// WithHTTPClient sets the HTTP client, for example to add a proxy or a
// tracing transport. The default is a new http.Client.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) {
		if h != nil {
			c.httpClient = h
		}
	}
}

// WithTimeout sets the time limit of each attempt (not of all attempts
// together; use the context deadline for that). The default is 12 seconds.
// Long inputs are scored in windows and take longer; use a context deadline
// that fits your use.
func WithTimeout(d time.Duration) Option {
	return func(c *Client) {
		if d > 0 {
			c.timeout = d
		}
	}
}

// WithMaxRetries sets how many times a request is repeated after a 429,
// a 5xx answer or a network error. The default is 2; 0 turns retries off.
// zn does not deduplicate requests: every retry counts against your plan.
func WithMaxRetries(n int) Option {
	return func(c *Client) {
		if n < 0 {
			n = 0
		}
		c.maxRetries = n
	}
}

// WithMaxRetryWait sets the longest Retry-After the client waits for. If
// the API asks for more, the error is returned at once. The default is 30
// seconds. This keeps a 429 that carries the time until the monthly quota
// resets from blocking a request for days.
func WithMaxRetryWait(d time.Duration) Option {
	return func(c *Client) {
		if d >= 0 {
			c.maxRetryWait = d
		}
	}
}

// NewClient returns a client for the given API key. Read the key from your
// environment or secret store; the client never logs it.
func NewClient(apiKey string, opts ...Option) *Client {
	c := &Client{
		apiKey:       apiKey,
		baseURL:      DefaultBaseURL,
		httpClient:   &http.Client{},
		timeout:      defaultTimeout,
		maxRetries:   defaultMaxRetries,
		maxRetryWait: defaultMaxRetryWait,
		backoffBase:  defaultBackoffBase,
	}
	for _, o := range opts {
		o(c)
	}
	c.httpClient = withRedirectPolicy(c.httpClient, c.baseURL)
	return c
}

// maxRedirects is the redirect limit of net/http's default policy.
const maxRedirects = 10

// withRedirectPolicy returns a copy of h that refuses any request, the first
// one and every redirect, whose URL checkBaseURL would refuse, so the API
// key cannot be sent in clear text. The scheme rule is enforced in a
// RoundTripper that wraps the transport of h, because a CheckRedirect that
// the caller set runs after ours and may rewrite req.URL. A CheckRedirect
// that the caller set still runs after the redirect check. h and its
// transport are not changed.
func withRedirectPolicy(h *http.Client, baseURL string) *http.Client {
	cp := *h
	base := h.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	cp.Transport = &guardTransport{base: base, host: baseHost(baseURL)}
	user := h.CheckRedirect
	cp.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if err := checkBaseURL(req.URL.String()); err != nil {
			return fmt.Errorf("zn: refusing redirect: %w", err)
		}
		if user != nil {
			return user(req, via)
		}
		if len(via) >= maxRedirects {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	}
	return &cp
}

// baseHost returns the lower-case host (with port) of the base URL, or an
// empty string if it cannot be parsed.
func baseHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Host)
}

// guardTransport checks every request the client sends. It refuses a URL
// that checkBaseURL refuses, without sending, and removes the Authorization
// header from a request to any host other than the base URL's host.
type guardTransport struct {
	base http.RoundTripper
	host string
}

func (g *guardTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL == nil {
		closeBody(req)
		return nil, fmt.Errorf("zn: refusing request: %w", ErrInsecureBaseURL)
	}
	if err := checkBaseURL(req.URL.String()); err != nil {
		closeBody(req)
		return nil, fmt.Errorf("zn: refusing request: %w", err)
	}
	if req.Header.Get("Authorization") != "" && (g.host == "" || strings.ToLower(req.URL.Host) != g.host) {
		req = req.Clone(req.Context())
		req.Header.Del("Authorization")
	}
	return g.base.RoundTrip(req)
}

func closeBody(req *http.Request) {
	if req.Body != nil {
		_ = req.Body.Close()
	}
}

type analyzeRequest struct {
	Input     string   `json:"input"`
	LongInput string   `json:"long_input,omitempty"`
	Threshold *float64 `json:"threshold,omitempty"`
	Mode      string   `json:"mode,omitempty"`

	// noStore is sent as a header, not in the body.
	noStore bool
	err     error
}

// Bounds the API accepts for the threshold of a request.
const (
	MinThreshold = 0.5
	MaxThreshold = 0.999
)

// AnalyzeOption changes one Analyze call.
type AnalyzeOption func(*analyzeRequest)

// Threshold sets the score at or above which this call blocks. It must be
// a number from MinThreshold (0.5) to MaxThreshold (0.999); anything else
// makes Analyze return ErrInvalidThreshold before anything is sent. Leave
// the option out to use the detector's default, which the response reports
// in Result.Threshold. A lower threshold blocks more (and raises false
// positives); a higher one blocks less.
func Threshold(v float64) AnalyzeOption {
	return func(r *analyzeRequest) {
		if !(v >= MinThreshold && v <= MaxThreshold) { // also true for NaN
			r.err = fmt.Errorf("%w: %v, the range is %v to %v", ErrInvalidThreshold, v, MinThreshold, MaxThreshold)
			return
		}
		r.Threshold = &v
	}
}

// Monitor runs the call in monitor mode: the verdict is always "allow" and
// Result.WouldBlock says what the verdict would have been. Use it to
// measure the detector on your own traffic before you enforce it. Calls and
// billing are the same as in enforce mode.
func Monitor() AnalyzeOption {
	return func(r *analyzeRequest) { r.Mode = "monitor" }
}

// NoStore asks the API not to keep the text of this call for Contributor Mode
// (it sends the header X-Zn-No-Store: 1). The usual evidence record with the
// verdict is still written. It can only turn storage off, never on.
func NoStore() AnalyzeOption {
	return func(r *analyzeRequest) { r.noStore = true }
}

// LongInputWindows asks for an input of 2,000 characters or fewer to be
// scored in windows too. Inputs of more than 2,000 characters are always
// scored in windows.
func LongInputWindows() AnalyzeOption {
	return func(r *analyzeRequest) { r.LongInput = "windows" }
}

// Analyze checks input and returns the verdict.
//
// An input of more than MaxInputUnits UTF-16 code units is refused before
// anything is sent (the error wraps ErrInputTooLong). API errors are
// returned as *APIError. A base URL that is not https (and not loopback)
// returns ErrInsecureBaseURL, and a 200 answer without a verdict of allow or
// block returns ErrUnexpectedResponse, so a caller never reads a missing
// verdict as a pass.
func (c *Client) Analyze(ctx context.Context, input string, opts ...AnalyzeOption) (*Result, error) {
	if c.apiKey == "" {
		return nil, ErrNoAPIKey
	}
	if c.baseErr != nil {
		return nil, c.baseErr
	}
	if input == "" {
		return nil, ErrEmptyInput
	}
	if n := UTF16Len(input); n > MaxInputUnits {
		return nil, fmt.Errorf("%w: %d UTF-16 code units, the limit is %d", ErrInputTooLong, n, MaxInputUnits)
	}
	req := analyzeRequest{Input: input}
	for _, o := range opts {
		o(&req)
	}
	if req.err != nil {
		return nil, req.err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("zn: encode request: %w", err)
	}

	var lastErr error
	for attempt := 0; ; attempt++ {
		res, retryAfter, err := c.do(ctx, body, req.noStore)
		if err == nil {
			return res, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if attempt >= c.maxRetries || !c.retryable(err) {
			return nil, lastErr
		}
		wait := c.backoff(attempt)
		if retryAfter >= 0 {
			if retryAfter > c.maxRetryWait {
				return nil, lastErr
			}
			wait = retryAfter
		}
		if err := sleep(ctx, wait); err != nil {
			return nil, err
		}
	}
}

// do sends one attempt. retryAfter is -1 when the answer has no usable
// Retry-After header.
func (c *Client) do(ctx context.Context, body []byte, noStore bool) (*Result, time.Duration, error) {
	actx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(actx, http.MethodPost, c.baseURL+analyzePath, bytes.NewReader(body))
	if err != nil {
		return nil, -1, fmt.Errorf("zn: build request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("User-Agent", userAgent)
	if noStore {
		httpReq.Header.Set("X-Zn-No-Store", "1")
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		if errors.Is(err, ErrInsecureBaseURL) {
			// A refused redirect is final: do not retry it.
			return nil, -1, err
		}
		// The error text of net/http includes the URL, never the key.
		return nil, -1, &networkError{err: err}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, -1, &networkError{err: err}
	}

	if resp.StatusCode == http.StatusOK {
		var res Result
		if err := json.Unmarshal(data, &res); err != nil {
			return nil, -1, fmt.Errorf("zn: decode response: %w", err)
		}
		if res.Verdict != VerdictAllow && res.Verdict != VerdictBlock {
			return nil, -1, fmt.Errorf("%w: verdict is missing or not allow or block", ErrUnexpectedResponse)
		}
		return &res, -1, nil
	}

	ae := parseAPIError(resp.StatusCode, data)
	retryAfter := time.Duration(-1)
	if d, ok := parseRetryAfter(resp.Header.Get("Retry-After")); ok {
		ae.RetryAfter = d
		retryAfter = d
	}
	return nil, retryAfter, ae
}

// networkError marks a failure to reach the API or to read its answer.
type networkError struct{ err error }

func (e *networkError) Error() string { return "zn: request failed: " + e.err.Error() }
func (e *networkError) Unwrap() error { return e.err }

func (c *Client) retryable(err error) bool {
	var ne *networkError
	if errors.As(err, &ne) {
		return true
	}
	ae, ok := asAPIError(err)
	if !ok {
		return false
	}
	switch {
	case ae.Status == http.StatusTooManyRequests:
		// A quota answer does not clear in seconds: do not spend a retry.
		return !IsQuotaExceeded(err)
	case ae.Status >= 500:
		return true
	}
	return false
}

// backoff is exponential with full jitter: a random wait up to
// base * 2^attempt, at most maxBackoff.
func (c *Client) backoff(attempt int) time.Duration {
	if c.backoffBase <= 0 {
		return 0
	}
	top := c.backoffBase << uint(attempt)
	if top > maxBackoff || top <= 0 {
		top = maxBackoff
	}
	return time.Duration(rand.Int63n(int64(top) + 1))
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func parseRetryAfter(v string) (time.Duration, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil {
		if math.IsNaN(secs) || math.IsInf(secs, 0) || secs < 0 {
			return 0, false
		}
		if secs >= maxRetryAfter.Seconds() {
			return maxRetryAfter, true
		}
		return time.Duration(secs * float64(time.Second)), true
	}
	if t, err := http.ParseTime(v); err == nil {
		d := time.Until(t)
		if d < 0 {
			d = 0
		}
		if d > maxRetryAfter {
			d = maxRetryAfter
		}
		return d, true
	}
	return 0, false
}

func parseAPIError(status int, data []byte) *APIError {
	ae := &APIError{Status: status}
	var b struct {
		Error     string `json:"error"`
		Message   string `json:"message"`
		Code      string `json:"code"`
		Required  int    `json:"required"`
		Remaining int    `json:"remaining"`
	}
	if json.Unmarshal(data, &b) == nil {
		ae.Message = b.Error
		if ae.Message == "" {
			ae.Message = b.Message
		}
		// For a key scope error, "error" is the fixed value key_scope and
		// "message" holds the text.
		if b.Error == "key_scope" && b.Message != "" {
			ae.Code = "key_scope"
			ae.Message = b.Message
		}
		if ae.Code == "" {
			ae.Code = b.Code
		}
		ae.Required = b.Required
		ae.Remaining = b.Remaining
	}
	if ae.Message == "" {
		ae.Message = http.StatusText(status)
	}
	return ae
}
