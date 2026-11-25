# zn Go client

A small Go client for the optional zn Cloud API (`POST https://api.usezn.com/v30/analyze`). It checks text, such as a tool result, a web page or an email, for prompt-injection attempts before a model reads it. Standard library only, no dependencies.

The zn Cloud API is optional. This client is for Go backends (for example on AWS Lambda) that want to call it directly. If you only want to protect a coding agent on your own machine, use [zn-gate](../README.md) instead.

## Install

```bash
go get github.com/usezn/zn/go
```

Create an API key in the [dashboard](https://usezn.com/dashboard/) and keep it server-side, for example in an environment variable or your secret store. The client sends it only as a bearer token to the API and never logs it.

## Example: check a tool result before the model reads it

```go
import (
	"context"
	"fmt"
	"os"
	"time"

	zn "github.com/usezn/zn/go"
)

var client = zn.NewClient(os.Getenv("ZN_API_KEY"))

// safeToRead reports whether a tool result may go to the model.
func safeToRead(ctx context.Context, toolResult string) bool {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	res, err := client.Analyze(ctx, toolResult)
	if err != nil {
		fmt.Println("zn could not answer, failing closed:", err)
		return false
	}
	if !res.Allowed() {
		fmt.Println("not allowed, failing closed:", res.Verdict, res.Rule, res.EvidenceID)
		return false
	}
	return true
}
```

## Reading the result

| Field | Meaning |
| - | - |
| `Verdict` | `allow` or `block`. `res.Blocked()` is true for `block`; `res.Allowed()` is true only for `allow` when the whole input was checked: it is false for a partial, capped or truncated long input (see below). |
| `Score`, `Confidence` | Model score for the input, 0 to 1. `Score` is `nil` when no model scored the text (the rules decided). |
| `Threshold` | Score at or above which the model that decided blocks. It echoes the `Threshold` option when you set one, and is the detector default otherwise. |
| `RequestMode`, `WouldBlock` | `RequestMode` is `monitor` or `enforce` whenever the call sets a mode. `WouldBlock` is set only in [monitor mode](#threshold-monitor-mode-and-no-store): the verdict is always `allow` and `WouldBlock` says what it would have been. `res.WouldHaveBlocked()` is true if it would have blocked. |
| `Rule`, `Reason`, `DecidedBy` | What decided the verdict: `rules` or `ml`. Values such as `ml-error-rules-fallback` mean the model was unavailable and the rules decided. |
| `Model`, `ModelRequested`, `MLVersion`, `RulesVersion` | Which model and versions produced the verdict, for audits. `ModelRequested` is set only when the call was routed to a different model than the one that answered. |
| `RouterLevel`, `Mode` | How far the call went (`rules`, `advanced` or `deep`) and the server-side detector mode. |
| `EvidenceID` | The record in your dashboard evidence vault. |
| `InputChars`, `BilledCalls` | Characters counted and calls billed. |
| `LongInput` | Set for a long input. `Mode` is `windows` when it was scored in windows, or `truncate` when windows did not run (`Reason` is then `fallback` or `not_scored`); with `windows` it also has `Windows`, `Scored`, `TopWindow`, `Capped` and `Partial`. `res.WholeInputChecked()` is true only for `windows` with neither `Capped` nor `Partial`. |

`res.Partial()` is true when a long input ran out of time: the windows already scored decided the verdict and the rest were not checked. An `allow` with `Partial()` means only part of the text was checked, so `Allowed()` is false for it and the text should not be passed on. The same holds when the input needed more windows than the limit (`LongInput.Capped`) or was not scored in windows (`LongInput.Mode` is `truncate`): `res.WholeInputChecked()` tells whether every part was scored. Only the windows that were scored are billed.

The fields above are the ones `POST /v30/analyze` returns. The [API reference](https://usezn.com/docs/api/) describes the request and the main response fields.

## Options

```go
client := zn.NewClient(key,
	zn.WithTimeout(12*time.Second),   // per attempt, default 12 s
	zn.WithMaxRetries(2),             // default 2, 0 turns retries off
	zn.WithMaxRetryWait(30*time.Second),
	zn.WithHTTPClient(myHTTPClient),
	zn.WithBaseURL("https://api.usezn.com"),
)

res, err := client.Analyze(ctx, text,
	zn.LongInputWindows(), // score a short input in windows too
)
```

### Threshold, monitor mode and no-store

```go
res, err := client.Analyze(ctx, text,
	zn.Threshold(0.9), // block at a score of 0.9 or more; from 0.5 to 0.999
	zn.Monitor(),      // never block: report what would have been blocked
	zn.NoStore(),      // do not keep the text of this call (Contributor Mode)
)
if err == nil && res.WouldHaveBlocked() {
	log.Println("would block:", res.Rule, res.EvidenceID)
}
```

- `Threshold(v)` overrides the detector's default threshold for one call. A value outside 0.5 to 0.999 (or NaN) makes `Analyze` return an error that wraps `zn.ErrInvalidThreshold`, and nothing is sent. A lower threshold blocks more and raises false positives.
- `Monitor()` runs the call in monitor mode: the verdict is always `allow` and `res.WouldBlock` says what it would have been. Use it to measure the detector on your own traffic before you enforce it. Calls and billing are the same as in enforce mode.
- `NoStore()` sends the header `X-Zn-No-Store: 1`, which asks the API not to keep the text of the call for Contributor Mode. The usual evidence record with the verdict is still written. It can only turn storage off for that request.

## Timeouts and retries

- The default timeout is 12 seconds per attempt. Long inputs are scored in windows and take longer, so pass a context with a deadline that fits your use. On AWS Lambda, set the function timeout above the client timeout and pass the Lambda context to `Analyze`.
- The client retries up to 2 times on a network error, a 429 or a 5xx answer, with exponential backoff and jitter. It honours `Retry-After` and stops waiting when the context is cancelled.
- The client ignores a `Retry-After` that is not a finite number of seconds or a date, and caps a very large one.
- It does not retry 400, 401, 402 or 403, and it does not retry a quota answer (`MONTHLY_LIMIT_REACHED`, `INSUFFICIENT_QUOTA`, `TRIAL_ENDED`): those do not clear in seconds. If `Retry-After` is longer than `WithMaxRetryWait` (the monthly reset, for example), the error is returned at once.
- zn does not deduplicate requests: every retry counts against your plan. Use `WithMaxRetries(0)` if you prefer to handle retries yourself.

## Errors

Two checks fail closed. `WithBaseURL` accepts only an https URL, so the API key is never sent in clear text; plain http is allowed only for `localhost`, `127.0.0.1` and `[::1]`. Any other URL makes `Analyze` return an error that wraps `zn.ErrInsecureBaseURL`, and nothing is sent. The client also refuses a redirect to plain http (except to those loopback hosts), so a redirect cannot downgrade the connection; the error wraps the same `zn.ErrInsecureBaseURL`. A 200 answer whose verdict is missing or is not `allow` or `block` is returned as an error that wraps `zn.ErrUnexpectedResponse`, never as a result.

API answers come back as `*zn.APIError` with `Status`, `Code`, `Message` and `RetryAfter`. Branch on the status and code, not on the message text.

```go
res, err := client.Analyze(ctx, text)
switch {
case err == nil:
	// use res
case zn.IsUnauthorized(err):  // 401: key missing, invalid or revoked
case zn.IsQuotaExceeded(err): // 402 or a quota code: add credits or wait for the reset
case zn.IsRateLimited(err):   // any 429
case zn.IsAccountBanned(err): // 403 account_banned: the account is suspended
case zn.IsInvalidThreshold(err), zn.IsInvalidMode(err): // 400: fix the request
default:
	var apiErr *zn.APIError
	if errors.As(err, &apiErr) {
		log.Printf("zn answered %d %s", apiErr.Status, apiErr.Code)
	}
}
```

A monthly limit answer is both `IsRateLimited` and `IsQuotaExceeded`. See [Errors](https://usezn.com/docs/api/errors/) for every status. Decide what your code does when zn is unreachable: for high-impact tools (shell, payments, data deletion) fail closed and do not run the tool; for low-impact reads you may fail open.

## Limits and billing

- `input` is limited to 20,000 UTF-16 code units. Most characters count once; emoji and some rare characters count twice. A longer input is refused by the client before anything is sent (`errors.Is(err, zn.ErrInputTooLong)`), and the API answers 400 above the limit too. An empty input returns `zn.ErrEmptyInput`.
- One call covers up to 2,000 characters of input, and each extra 1,000 characters (or part of them) is one more call. `res.BilledCalls` says how many calls a request used. See [Plans and quotas](https://usezn.com/docs/api/quotas/).
- The API already scans an input of more than 2,000 characters in overlapping windows, so you do not need to split text yourself. For text longer than 20,000 units, or if you want to send pieces yourself, `zn.SplitForAnalyze(text, max)` splits on paragraph boundaries (then on line breaks, spaces and, last, inside a paragraph) without cutting a character. Joining the pieces gives back the original text. Each piece is a separate call.

```go
for _, piece := range zn.SplitForAnalyze(longText, 0) { // 0 means 20,000 units
	res, err := client.Analyze(ctx, piece)
	// ...
}
```

## Privacy

What the API receives and keeps is described in [What leaves your machine](https://usezn.com/docs/what-leaves-your-machine/) and in the [privacy policy](https://usezn.com/privacy/), which also covers the opt-in Contributor Mode. This client adds nothing to the request except the `input`, and the `long_input`, `threshold` and `mode` options and the `X-Zn-No-Store` header when you set them.

## Development

```bash
cd go
go vet ./...
gofmt -l .
go test ./...
```

## License

MIT, as the rest of the repository.
