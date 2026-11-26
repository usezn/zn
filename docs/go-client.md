# Go client

A small Go client for the optional zn Cloud API (`POST https://api.usezn.com/v30/analyze`). It checks text, such as a tool result, a web page or an email, for prompt-injection attempts before a model reads it. It uses only the Go standard library.

The zn Cloud API is optional. This client is for Go backends (for example on AWS Lambda) that want to call the API directly. To protect a coding agent on your own machine, use [zn-gate](../README.md) instead. For the HTTP request itself, see the [API quickstart](api-quickstart.md).

The full reference, with every option and result field, is the [README of the Go client](https://github.com/usezn/zn/blob/main/go/README.md). This page covers what you need to start and the points that matter for safety.

## 1. Install

```sh
go get github.com/usezn/zn/go
```

Create an analysis-only API key on the [connect page](https://usezn.com/connect/) and keep it on the server, for example in an environment variable named `ZN_API_KEY` or in your secret store. The client sends the key only as a bearer token to the API and never logs it.

## 2. Check a text

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

`NewClient(key)` creates a client. `Analyze(ctx, text)` sends the text and returns a result. `res.Verdict` is `allow` or `block`.

## 3. Read the verdict

- `res.Blocked()` is true when the verdict is `block`.
- `res.Allowed()` is true only when the verdict is `allow` and the whole input was checked. It is false when only part of a long input was checked: the result is partial, capped or truncated.
- `res.WholeInputChecked()` tells directly whether every part of the input was scored. A short input always is. A long input is only when it was scored in windows, did not need more windows than the limit and was not cut short by time.
- `res.EvidenceID` is the record of the check in your dashboard evidence vault.

If you test `Blocked()` only, an `allow` that covers part of the text passes. Use `Allowed()` when you decide whether a text may go on to a model.

## 4. Handle errors

The API answers with an error as `*zn.APIError`, which has `Status`, `Code`, `Message` and `RetryAfter`. Branch on the status and the code, not on the message text. These helpers cover the common cases:

| Helper | When it is true |
|---|---|
| `zn.IsUnauthorized(err)` | The API answered 401: the key is missing, invalid or revoked. |
| `zn.IsQuotaExceeded(err)` | A 402 answer or a quota code (`MONTHLY_LIMIT_REACHED`, `INSUFFICIENT_QUOTA`, `TRIAL_ENDED`): add credits or wait for the reset. |
| `zn.IsRateLimited(err)` | Any 429 answer. A monthly limit answer is both rate limited and quota exceeded. |

Other helpers are `zn.IsAccountBanned`, `zn.IsInvalidThreshold` and `zn.IsInvalidMode`. The client does not retry a 400, 401, 402 or 403 answer or a quota answer. It retries a network error, a 429 or a 5xx answer up to 2 times, and honours `Retry-After`. Every retry counts against your plan.

```go
res, err := client.Analyze(ctx, text)
switch {
case err == nil:
    // use res
case zn.IsUnauthorized(err):
    // check ZN_API_KEY
case zn.IsQuotaExceeded(err):
    // add credits or wait for the monthly reset
case zn.IsRateLimited(err):
    // slow down
}
```

Decide in advance what your code does when zn cannot answer. For tools with a high impact, such as a shell, payments or deleting data, fail closed: do not run the tool. For low-impact reads you may fail open.

## 5. Input size and long text

- The input is limited to 20,000 UTF-16 code units. Most characters count once. Emoji and some rare characters count twice.
- A longer input is refused by the client before anything is sent: `errors.Is(err, zn.ErrInputTooLong)` is true. An empty input returns `zn.ErrEmptyInput`.
- The API already scans an input of more than 2,000 characters in overlapping windows, so you do not have to split text yourself. For text longer than 20,000 units, or to send the pieces yourself, `zn.SplitForAnalyze(text, max)` splits on paragraph boundaries (then on line breaks, spaces and, last, inside a paragraph) without cutting a character. Joining the pieces gives back the original text. A `max` of 0 means 20,000 units. Each piece is a separate call.

```go
for _, piece := range zn.SplitForAnalyze(longText, 0) {
    res, err := client.Analyze(ctx, piece)
    // handle err and check res.Allowed() for every piece
}
```

One call covers up to 2,000 characters of input, and each further 1,000 characters (or part of them) is one more call. `res.BilledCalls` says how many calls a request used.

## 6. Base URL: https only

`WithBaseURL` accepts an https URL. Plain http is accepted only for `localhost`, `127.0.0.1` and `[::1]`, which is useful for a local test server. For any other URL, `Analyze` returns an error that wraps `zn.ErrInsecureBaseURL`, and nothing is sent, so the API key never travels in clear text.

```go
client := zn.NewClient(key, zn.WithBaseURL("https://api.usezn.com"))
```

The client also refuses a redirect to plain http (except to those local hosts) with the same error, and it does not send the `Authorization` header to a host other than the base URL host.

A 200 answer whose verdict is missing, or is neither `allow` nor `block`, is returned as an error that wraps `zn.ErrUnexpectedResponse`, never as a result. Treat it as a stop.

## What leaves your computer

The client sends the input text, plus the `long_input`, `threshold` and `mode` options and the `X-Zn-No-Store` header when you set them. Nothing else is added. See [what leaves your machine](https://usezn.com/docs/what-leaves-your-machine/).

## Next steps

- [API quickstart](api-quickstart.md): the same request from curl, Python or Node.js.
- [API reference](api-reference.md): the Node.js and Python functions.
- [README of the Go client](https://github.com/usezn/zn/blob/main/go/README.md): options such as `Threshold`, `Monitor` and `NoStore`, timeouts and every result field.
