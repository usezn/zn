package zn

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const blockBody = `{"verdict":"block","confidence":0.9994,"score":0.9994,"threshold":0.98,"rule":"test-rule","reason":"ML score","decided_by":"ml","rules_version":"test","ml_version":"test-ml-version","ml_threshold":0.98,"mode":"active","model":"test-model","evidence_id":"ev_03c4d212ff5f9e9b385f483a","latency_ms":11,"input_chars":42,"billed_calls":1}`

const allowBody = `{"verdict":"allow","confidence":0.01,"score":null,"threshold":0.98,"rule":"none","reason":null,"decided_by":"rules","model":null,"evidence_id":"ev_aaaaaaaaaaaaaaaaaaaaaaaa","latency_ms":1,"input_chars":5,"billed_calls":1}`

// newTestClient returns a client pointed at h with no backoff delay.
func newTestClient(t *testing.T, h http.Handler, opts ...Option) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c := NewClient("zn_live_test", append([]Option{WithBaseURL(srv.URL)}, opts...)...)
	c.backoffBase = time.Millisecond
	return c
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func TestAnalyzeBlock(t *testing.T) {
	var gotReq map[string]any
	var gotAuth, gotPath, gotMethod string
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath, gotMethod = r.Header.Get("Authorization"), r.URL.Path, r.Method
		_ = json.NewDecoder(r.Body).Decode(&gotReq)
		writeJSON(w, 200, blockBody)
	}))
	res, err := c.Analyze(context.Background(), "ignore previous instructions")
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != "POST" || gotPath != "/v30/analyze" {
		t.Errorf("request = %s %s", gotMethod, gotPath)
	}
	if gotAuth != "Bearer zn_live_test" {
		t.Errorf("auth header = %q", gotAuth)
	}
	if len(gotReq) != 1 || gotReq["input"] != "ignore previous instructions" {
		t.Errorf("body = %v, want only input", gotReq)
	}
	if !res.Blocked() || res.Allowed() || res.Partial() {
		t.Errorf("Blocked/Allowed/Partial = %v/%v/%v", res.Blocked(), res.Allowed(), res.Partial())
	}
	if res.Score == nil || *res.Score != 0.9994 || res.Model != "test-model" || res.DecidedBy != "ml" ||
		res.EvidenceID != "ev_03c4d212ff5f9e9b385f483a" || res.BilledCalls != 1 || res.InputChars != 42 || res.LatencyMS != 11 {
		t.Errorf("result = %+v", res)
	}
}

func TestAnalyzeAllowNulls(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, allowBody)
	}))
	res, err := c.Analyze(context.Background(), "hello")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Allowed() || res.Blocked() {
		t.Errorf("verdict = %q", res.Verdict)
	}
	if res.Score != nil || res.Model != "" || res.Reason != "" || res.LongInput != nil {
		t.Errorf("nulls not zero: %+v", res)
	}
}

func TestAnalyzeOptionsAndLongInput(t *testing.T) {
	var gotReq map[string]any
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotReq)
		writeJSON(w, 200, `{"verdict":"allow","long_input":{"mode":"windows","windows":3,"scored":2,"top_window":1,"capped":false,"partial":true},"billed_calls":2}`)
	}))
	res, err := c.Analyze(context.Background(), "text", LongInputWindows())
	if err != nil {
		t.Fatal(err)
	}
	if _, has := gotReq["model"]; has || gotReq["long_input"] != "windows" {
		t.Errorf("body = %v", gotReq)
	}
	if !res.Partial() || res.LongInput.Windows != 3 || res.LongInput.Scored != 2 || res.LongInput.TopWindow != 1 {
		t.Errorf("long_input = %+v", res.LongInput)
	}
}

func TestErrorStatuses(t *testing.T) {
	tests := []struct {
		name         string
		status       int
		body         string
		header       map[string]string
		wantCode     string
		wantMsg      string
		unauthorized bool
		quota        bool
		rateLimited  bool
		check        func(t *testing.T, ae *APIError)
	}{
		{name: "400", status: 400, body: `{"error":"Input too long (max 20000 characters)"}`, wantMsg: "Input too long (max 20000 characters)"},
		{name: "400 invalid threshold", status: 400, body: `{"error":"threshold must be a number between 0.5 and 0.999","code":"invalid_threshold"}`, wantCode: "invalid_threshold", wantMsg: "threshold must be a number between 0.5 and 0.999",
			check: func(t *testing.T, ae *APIError) {
				if !IsInvalidThreshold(ae) || IsInvalidMode(ae) || IsAccountBanned(ae) {
					t.Error("typed helpers do not match invalid_threshold")
				}
			}},
		{name: "400 invalid mode", status: 400, body: `{"error":"mode must be monitor or enforce","code":"invalid_mode"}`, wantCode: "invalid_mode", wantMsg: "mode must be monitor or enforce",
			check: func(t *testing.T, ae *APIError) {
				if !IsInvalidMode(ae) || IsInvalidThreshold(ae) {
					t.Error("typed helpers do not match invalid_mode")
				}
			}},
		{name: "403 account banned", status: 403, body: `{"error":"This account has been suspended","code":"account_banned"}`, wantCode: "account_banned", wantMsg: "This account has been suspended",
			check: func(t *testing.T, ae *APIError) {
				if !IsAccountBanned(ae) || IsUnauthorized(ae) {
					t.Error("typed helpers do not match account_banned")
				}
			}},
		{name: "401", status: 401, body: `{"error":"Invalid API key"}`, wantMsg: "Invalid API key", unauthorized: true},
		{name: "402", status: 402, body: `{"error":"Trial ended","code":"TRIAL_ENDED"}`, wantCode: "TRIAL_ENDED", wantMsg: "Trial ended", quota: true},
		{name: "403 key scope", status: 403, body: `{"error":"key_scope","message":"This key can only analyze prompts."}`, wantCode: "key_scope", wantMsg: "This key can only analyze prompts."},
		{name: "429 monthly", status: 429, body: `{"error":"Monthly call limit reached","code":"MONTHLY_LIMIT_REACHED"}`, header: map[string]string{"Retry-After": "86400"},
			wantCode: "MONTHLY_LIMIT_REACHED", wantMsg: "Monthly call limit reached", quota: true, rateLimited: true,
			check: func(t *testing.T, ae *APIError) {
				if ae.RetryAfter != 24*time.Hour {
					t.Errorf("RetryAfter = %v", ae.RetryAfter)
				}
			}},
		{name: "429 insufficient", status: 429, body: `{"error":"Not enough calls","code":"INSUFFICIENT_QUOTA","required":5,"remaining":2}`, header: map[string]string{"Retry-After": "0"},
			wantCode: "INSUFFICIENT_QUOTA", wantMsg: "Not enough calls", quota: true, rateLimited: true,
			check: func(t *testing.T, ae *APIError) {
				if ae.Required != 5 || ae.Remaining != 2 {
					t.Errorf("required/remaining = %d/%d", ae.Required, ae.Remaining)
				}
			}},
		{name: "not json", status: 502, body: `<html>bad gateway</html>`, wantMsg: "Bad Gateway"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var calls int32
			c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&calls, 1)
				for k, v := range tc.header {
					w.Header().Set(k, v)
				}
				writeJSON(w, tc.status, tc.body)
			}), WithMaxRetries(0))
			res, err := c.Analyze(context.Background(), "x")
			if res != nil || err == nil {
				t.Fatalf("res=%v err=%v", res, err)
			}
			var ae *APIError
			if !errors.As(err, &ae) {
				t.Fatalf("not an APIError: %T %v", err, err)
			}
			if ae.Status != tc.status || ae.Code != tc.wantCode || ae.Message != tc.wantMsg {
				t.Errorf("got %d %q %q, want %d %q %q", ae.Status, ae.Code, ae.Message, tc.status, tc.wantCode, tc.wantMsg)
			}
			if IsUnauthorized(err) != tc.unauthorized || IsQuotaExceeded(err) != tc.quota || IsRateLimited(err) != tc.rateLimited {
				t.Errorf("helpers unauthorized/quota/rate = %v/%v/%v",
					IsUnauthorized(err), IsQuotaExceeded(err), IsRateLimited(err))
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("Error() = %q", err.Error())
			}
			if tc.check != nil {
				tc.check(t, ae)
			}
			if calls != 1 {
				t.Errorf("calls = %d", calls)
			}
		})
	}
}

func TestNoRetryOnClientErrors(t *testing.T) {
	for _, status := range []int{400, 401, 402, 403} {
		var calls int32
		c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			atomic.AddInt32(&calls, 1)
			writeJSON(w, status, `{"error":"no"}`)
		}))
		if _, err := c.Analyze(context.Background(), "x"); err == nil {
			t.Fatalf("status %d: want error", status)
		}
		if calls != 1 {
			t.Errorf("status %d: calls = %d, want 1", status, calls)
		}
	}
}

func TestRetryOn429WithRetryAfter(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, 429, `{"error":"Too many requests"}`)
			return
		}
		writeJSON(w, 200, blockBody)
	}))
	start := time.Now()
	res, err := c.Analyze(context.Background(), "x")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Blocked() || calls != 2 {
		t.Errorf("blocked=%v calls=%d", res.Blocked(), calls)
	}
	if d := time.Since(start); d < 900*time.Millisecond {
		t.Errorf("Retry-After not honoured: waited %v", d)
	}
}

func TestNoRetryWhenRetryAfterTooLong(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Retry-After", "3600")
		writeJSON(w, 429, `{"error":"slow down"}`)
	}))
	_, err := c.Analyze(context.Background(), "x")
	if !IsRateLimited(err) || calls != 1 {
		t.Errorf("err=%v calls=%d", err, calls)
	}
}

func TestNoRetryOnQuota429(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Retry-After", "0")
		writeJSON(w, 429, `{"error":"Monthly call limit reached","code":"MONTHLY_LIMIT_REACHED"}`)
	}))
	_, err := c.Analyze(context.Background(), "x")
	if !IsQuotaExceeded(err) || calls != 1 {
		t.Errorf("err=%v calls=%d", err, calls)
	}
}

func TestRetryOn5xxThenGiveUp(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 500, `{"error":"boom"}`)
	}))
	_, err := c.Analyze(context.Background(), "x")
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 500 {
		t.Fatalf("err = %v", err)
	}
	if calls != 3 { // 1 try + 2 retries
		t.Errorf("calls = %d, want 3", calls)
	}
}

func TestMaxRetriesZero(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 503, `{"error":"down"}`)
	}), WithMaxRetries(0))
	if _, err := c.Analyze(context.Background(), "x"); err == nil || calls != 1 {
		t.Errorf("err=%v calls=%d", err, calls)
	}
}

func TestRetryOnNetworkError(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			// Drop the connection without an answer.
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
			return
		}
		writeJSON(w, 200, allowBody)
	}))
	res, err := c.Analyze(context.Background(), "x")
	if err != nil || !res.Allowed() || calls != 2 {
		t.Errorf("res=%v err=%v calls=%d", res, err, calls)
	}
}

func TestContextCancelDuringRequest(t *testing.T) {
	release := make(chan struct{})
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release) })
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	_, err := c.Analyze(ctx, "x")
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
}

func TestContextCancelDuringBackoff(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Retry-After", "10")
		writeJSON(w, 429, `{"error":"slow down"}`)
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := c.Analyze(ctx, "x")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want deadline exceeded", err)
	}
	if time.Since(start) > 2*time.Second || calls != 1 {
		t.Errorf("did not stop early: %v, calls=%d", time.Since(start), calls)
	}
}

func TestPerAttemptTimeout(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			// The server only notices a closed connection after the body is read.
			_, _ = io.Copy(io.Discard, r.Body)
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
			return
		}
		writeJSON(w, 200, allowBody)
	}), WithTimeout(100*time.Millisecond))
	res, err := c.Analyze(context.Background(), "x")
	if err != nil || !res.Allowed() || calls != 2 {
		t.Errorf("res=%v err=%v calls=%d", res, err, calls)
	}
}

func TestInputLengthUTF16(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 200, allowBody)
	}))
	emoji := "\U0001F600" // 2 UTF-16 units, 1 code point
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{"exactly 20000 ASCII", strings.Repeat("a", 20000), false},
		{"20001 ASCII", strings.Repeat("a", 20001), true},
		{"10000 emoji = 20000 units", strings.Repeat(emoji, 10000), false},
		{"10001 emoji = 20002 units", strings.Repeat(emoji, 10001), true},
		{"19999 ASCII + 1 emoji = 20001 units", strings.Repeat("a", 19999) + emoji, true},
		{"19998 ASCII + 1 emoji = 20000 units", strings.Repeat("a", 19998) + emoji, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			before := atomic.LoadInt32(&calls)
			_, err := c.Analyze(context.Background(), tc.input)
			if tc.wantErr {
				if !errors.Is(err, ErrInputTooLong) {
					t.Errorf("err = %v, want ErrInputTooLong", err)
				}
				if atomic.LoadInt32(&calls) != before {
					t.Error("request was sent")
				}
			} else if err != nil {
				t.Errorf("err = %v", err)
			}
		})
	}
}

func TestUTF16Len(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"é", 1},
		{"日本", 2},
		{"\U0001F600", 2},
		{"a\U0001F600b", 4},
		{"\xff", 1},
		{"\U0001D11E clef", 7},
	}
	for _, tc := range tests {
		if got := UTF16Len(tc.in); got != tc.want {
			t.Errorf("UTF16Len(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestEmptyKeyAndInput(t *testing.T) {
	if _, err := NewClient("").Analyze(context.Background(), "x"); !errors.Is(err, ErrNoAPIKey) {
		t.Errorf("err = %v", err)
	}
	if _, err := NewClient("k").Analyze(context.Background(), ""); !errors.Is(err, ErrEmptyInput) {
		t.Errorf("err = %v", err)
	}
}

func TestKeyNeverInErrors(t *testing.T) {
	c := NewClient("zn_live_supersecret", WithBaseURL("http://127.0.0.1:1"), WithMaxRetries(0))
	_, err := c.Analyze(context.Background(), "x")
	if err == nil {
		t.Fatal("want error")
	}
	if strings.Contains(err.Error(), "supersecret") {
		t.Errorf("error leaks the key: %v", err)
	}
}

func TestOptions(t *testing.T) {
	hc := &http.Client{}
	c := NewClient("k", WithBaseURL("https://example.test/"), WithHTTPClient(hc), WithTimeout(3*time.Second), WithMaxRetries(5), WithMaxRetryWait(time.Second))
	if c.baseURL != "https://example.test" || c.httpClient == hc || c.httpClient.Transport != hc.Transport || c.timeout != 3*time.Second || c.maxRetries != 5 || c.maxRetryWait != time.Second {
		t.Errorf("client = %+v", c)
	}
	d := NewClient("k")
	if d.baseURL != DefaultBaseURL || d.timeout != 12*time.Second || d.maxRetries != 2 {
		t.Errorf("defaults = %+v", d)
	}
}

const monitorBody = `{"verdict":"allow","confidence":0.97,"score":0.97,"threshold":0.9,"request_mode":"monitor","would_block":true,"rule":"test-rule","reason":"ML score","decided_by":"ml","rules_version":"test","ml_version":"test-ml-version","ml_threshold":0.9,"router_level":"rules","mode":"active","model":"test-model","evidence_id":"ev_03c4d212ff5f9e9b385f483a","latency_ms":11,"input_chars":42,"billed_calls":1}`

func TestThresholdMonitorNoStore(t *testing.T) {
	var gotReq map[string]any
	var gotNoStore string
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotNoStore = r.Header.Get("X-Zn-No-Store")
		gotReq = nil
		_ = json.NewDecoder(r.Body).Decode(&gotReq)
		writeJSON(w, 200, monitorBody)
	}))
	res, err := c.Analyze(context.Background(), "text", Threshold(0.9), Monitor(), NoStore())
	if err != nil {
		t.Fatal(err)
	}
	if gotReq["threshold"] != 0.9 || gotReq["mode"] != "monitor" || gotNoStore != "1" {
		t.Errorf("body = %v, header = %q", gotReq, gotNoStore)
	}
	if res.Verdict != VerdictAllow || res.Blocked() || !res.WouldHaveBlocked() || res.RequestMode != "monitor" ||
		res.Threshold != 0.9 || res.RouterLevel != "rules" {
		t.Errorf("result = %+v", res)
	}

	// Without the options nothing extra is sent.
	if _, err := c.Analyze(context.Background(), "text"); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"threshold", "mode", "model"} {
		if _, has := gotReq[k]; has {
			t.Errorf("unexpected %q in default request", k)
		}
	}
	if gotNoStore != "" {
		t.Errorf("unexpected X-Zn-No-Store %q", gotNoStore)
	}
}

func TestEnforceResultHasNoWouldBlock(t *testing.T) {
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, blockBody)
	}))
	res, err := c.Analyze(context.Background(), "text")
	if err != nil {
		t.Fatal(err)
	}
	if res.WouldBlock != nil || res.WouldHaveBlocked() || res.RequestMode != "" {
		t.Errorf("result = %+v", res)
	}
}

func TestThresholdRangeCheckedClientSide(t *testing.T) {
	var calls int32
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		writeJSON(w, 200, allowBody)
	}))
	for _, v := range []float64{0.49, 1, 0, -1, 1.5, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := c.Analyze(context.Background(), "text", Threshold(v)); !errors.Is(err, ErrInvalidThreshold) {
			t.Errorf("Threshold(%v): err = %v", v, err)
		}
	}
	for _, v := range []float64{MinThreshold, 0.9, MaxThreshold} {
		if _, err := c.Analyze(context.Background(), "text", Threshold(v)); err != nil {
			t.Errorf("Threshold(%v): err = %v", v, err)
		}
	}
	if n := atomic.LoadInt32(&calls); n != 3 {
		t.Errorf("server calls = %d, want 3 (invalid thresholds must not be sent)", n)
	}
}

func TestParseRetryAfterRejectsNonFinite(t *testing.T) {
	for _, v := range []string{"NaN", "nan", "Inf", "+Inf", "-Inf", "Infinity", "-1"} {
		if d, ok := parseRetryAfter(v); ok {
			t.Errorf("%q parsed as %v", v, d)
		}
	}
	for _, v := range []string{"1e300", "99999999999", "1e18"} {
		d, ok := parseRetryAfter(v)
		if !ok || d != maxRetryAfter {
			t.Errorf("%q = %v %v, want cap %v", v, d, ok, maxRetryAfter)
		}
	}
	if d, ok := parseRetryAfter("1.5"); !ok || d != 1500*time.Millisecond {
		t.Errorf("1.5 = %v %v", d, ok)
	}
	far := time.Now().Add(1000 * 24 * time.Hour).UTC().Format(http.TimeFormat)
	if d, ok := parseRetryAfter(far); !ok || d != maxRetryAfter {
		t.Errorf("far date = %v %v", d, ok)
	}
}

func TestParseRetryAfter(t *testing.T) {
	if d, ok := parseRetryAfter("7"); !ok || d != 7*time.Second {
		t.Errorf("seconds: %v %v", d, ok)
	}
	if _, ok := parseRetryAfter(""); ok {
		t.Error("empty should not parse")
	}
	if _, ok := parseRetryAfter("soon"); ok {
		t.Error("garbage should not parse")
	}
	date := time.Now().Add(5 * time.Second).UTC().Format(http.TimeFormat)
	if d, ok := parseRetryAfter(date); !ok || d <= 0 || d > 6*time.Second {
		t.Errorf("date: %v %v", d, ok)
	}
}

func TestBackoffBounds(t *testing.T) {
	c := NewClient("k")
	for attempt := 0; attempt < 10; attempt++ {
		for i := 0; i < 50; i++ {
			if d := c.backoff(attempt); d < 0 || d > maxBackoff {
				t.Fatalf("attempt %d: backoff %v out of range", attempt, d)
			}
		}
	}
}

func TestBaseURLPolicy(t *testing.T) {
	ok := []string{"https://api.usezn.com", "https://example.test/", "http://localhost", "http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]", "http://[::1]:9000/"}
	for _, u := range ok {
		if err := checkBaseURL(strings.TrimRight(u, "/")); err != nil {
			t.Errorf("%s refused: %v", u, err)
		}
	}
	bad := []string{"http://api.example.com", "http://localhost.example.com", "http://127.0.0.1.nip.io", "http://localhost@evil.example.com", "http://127.0.0.1:80@evil.example.com", "http://evil.example.com#@localhost", "ftp://localhost", "localhost:8080", "http://", ""}
	for _, u := range bad {
		if err := checkBaseURL(u); !errors.Is(err, ErrInsecureBaseURL) {
			t.Errorf("%q: want ErrInsecureBaseURL, got %v", u, err)
		}
	}
}

func TestInsecureBaseURLSendsNothing(t *testing.T) {
	c := NewClient("zn_live_test", WithBaseURL("http://api.example.com"))
	c.httpClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("request was sent")
		return nil, errors.New("sent")
	})}
	_, err := c.Analyze(context.Background(), "hello")
	if !errors.Is(err, ErrInsecureBaseURL) {
		t.Fatalf("got %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestUnknownVerdictFailsClosed(t *testing.T) {
	for name, body := range map[string]string{
		"unknown": `{"verdict":"maybe"}`,
		"empty":   `{"verdict":""}`,
		"missing": `{"confidence":0.1}`,
		"null":    `{"verdict":null}`,
		"case":    `{"verdict":"ALLOW"}`,
	} {
		body := body
		t.Run(name, func(t *testing.T) {
			c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, body)
			}), WithMaxRetries(0))
			res, err := c.Analyze(context.Background(), "hello")
			if !errors.Is(err, ErrUnexpectedResponse) || res != nil {
				t.Fatalf("res=%v err=%v", res, err)
			}
		})
	}
}

// redirectRig maps the test host names plain.example.test and
// other.example.test to local listeners, so a redirect can leave the
// loopback addresses without any real network.
type redirectRig struct {
	tr       *http.Transport
	plainHit atomic.Int32
}

func newRedirectRig(t *testing.T, other http.Handler) (*redirectRig, string, string) {
	t.Helper()
	rig := &redirectRig{}
	plainSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rig.plainHit.Add(1)
		writeJSON(w, 200, allowBody)
	}))
	t.Cleanup(plainSrv.Close)
	otherSrv := httptest.NewTLSServer(other)
	t.Cleanup(otherSrv.Close)
	plainAddr := strings.TrimPrefix(plainSrv.URL, "http://")
	otherAddr := strings.TrimPrefix(otherSrv.URL, "https://")
	rig.tr = &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, _ := net.SplitHostPort(addr)
			d := &net.Dialer{}
			switch host {
			case "plain.example.test":
				return d.DialContext(ctx, network, plainAddr)
			case "other.example.test":
				return d.DialContext(ctx, network, otherAddr)
			}
			return d.DialContext(ctx, network, addr)
		},
	}
	t.Cleanup(rig.tr.CloseIdleConnections)
	_, plainPort, _ := net.SplitHostPort(plainAddr)
	_, otherPort, _ := net.SplitHostPort(otherAddr)
	return rig, plainPort, otherPort
}

func TestRedirectToPlainHTTPIsRefused(t *testing.T) {
	for _, code := range []int{302, 307, 308} {
		rig, plainPort, _ := newRedirectRig(t, http.NotFoundHandler())
		target := "http://plain.example.test:" + plainPort + "/v30/analyze"
		first := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target, code)
		}))
		c := NewClient("zn_live_test", WithBaseURL(first.URL), WithHTTPClient(&http.Client{Transport: rig.tr}), WithMaxRetries(2))
		c.backoffBase = time.Millisecond
		_, err := c.Analyze(context.Background(), "hello")
		first.Close()
		if !errors.Is(err, ErrInsecureBaseURL) {
			t.Fatalf("%d: want ErrInsecureBaseURL, got %v", code, err)
		}
		if n := rig.plainHit.Load(); n != 0 {
			t.Fatalf("%d: the plain-http server got %d requests", code, n)
		}
		if strings.Contains(err.Error(), "zn_live_test") {
			t.Fatalf("%d: key in error", code)
		}
	}
}

func TestRedirectKeepsAuthorizationOnSameHostAndDropsItOnOtherHost(t *testing.T) {
	var sameAuth, otherAuth atomic.Value
	rig, _, otherPort := newRedirectRig(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherAuth.Store(r.Header.Get("Authorization"))
		writeJSON(w, 200, allowBody)
	}))
	hc := &http.Client{Transport: rig.tr}

	same := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v30/analyze" {
			http.Redirect(w, r, "/moved", 307)
			return
		}
		sameAuth.Store(r.Header.Get("Authorization"))
		writeJSON(w, 200, allowBody)
	}))
	t.Cleanup(same.Close)
	c := NewClient("zn_live_test", WithBaseURL(same.URL), WithHTTPClient(hc))
	if _, err := c.Analyze(context.Background(), "hello"); err != nil {
		t.Fatalf("same-host https redirect: %v", err)
	}
	if got, _ := sameAuth.Load().(string); got != "Bearer zn_live_test" {
		t.Fatalf("same host Authorization = %q", got)
	}

	// https to https on another host is allowed, but net/http drops the key.
	otherTarget := "https://other.example.test:" + otherPort + "/v30/analyze"
	cross := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, otherTarget, 307)
	}))
	t.Cleanup(cross.Close)
	c2 := NewClient("zn_live_test", WithBaseURL(cross.URL), WithHTTPClient(hc))
	if _, err := c2.Analyze(context.Background(), "hello"); err != nil {
		t.Fatalf("cross-host https redirect: %v", err)
	}
	if got, _ := otherAuth.Load().(string); got != "" {
		t.Fatalf("other host received Authorization %q", got)
	}
}

func TestRedirectPolicyDoesNotMutateUserClientAndKeepsItsCheck(t *testing.T) {
	var userCalls atomic.Int32
	user := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		userCalls.Add(1)
		return nil
	}}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v30/analyze" {
			http.Redirect(w, r, "/moved", 307)
			return
		}
		writeJSON(w, 200, allowBody)
	}))
	t.Cleanup(srv.Close)
	user.Transport = srv.Client().Transport
	before := reflect.ValueOf(user.CheckRedirect).Pointer()
	c := NewClient("zn_live_test", WithBaseURL(srv.URL), WithHTTPClient(user))
	if c.httpClient == user {
		t.Fatal("the user client was not copied")
	}
	if reflect.ValueOf(user.CheckRedirect).Pointer() != before {
		t.Fatal("the user client was changed")
	}
	if _, err := c.Analyze(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	if userCalls.Load() != 1 {
		t.Fatalf("user CheckRedirect calls = %d", userCalls.Load())
	}
}

func TestRedirectLimitStillApplies(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/v30/analyze", 307)
	}))
	t.Cleanup(srv.Close)
	c := NewClient("zn_live_test", WithBaseURL(srv.URL), WithHTTPClient(&http.Client{Transport: srv.Client().Transport}), WithMaxRetries(0))
	_, err := c.Analyze(context.Background(), "hello")
	if err == nil || !strings.Contains(err.Error(), "10 redirects") {
		t.Fatalf("got %v", err)
	}
}
