# API quickstart

Send text to the zn analysis API from curl, Python or Node.js. This page covers one request: you send a piece of text and read back a verdict. The examples use benign text and an API key from an environment variable. The Node.js and Python functions that wrap this call are described in the [API reference](api-reference.md).

## 1. Get an API key

Create an analysis-only API key on the [connect page](https://usezn.com/connect). An analysis-only key can only analyze text. It cannot read your usage or manage other keys.

Keep the key out of your code, out of files you commit and out of shared documents. Store it in an environment variable named `ZN_API_KEY`:

```sh
export ZN_API_KEY="paste-your-key-here"
```

In Windows PowerShell, use `$env:ZN_API_KEY = "paste-your-key-here"` instead.

## 2. The request

Send a `POST` request to:

```text
https://api.usezn.com/v30/analyze
```

The request has:

- the header `Content-Type: application/json`;
- the header `Authorization: Bearer <your key>`;
- a JSON body with one field, `input`, which holds the text to check.

## 3. The response

A successful request returns a JSON object. These fields are part of the response:

| Field | Type | Meaning |
|---|---|---|
| `verdict` | string | `allow` or `block`. |
| `confidence` | number | How sure the check is. |
| `rule` | string | The rule or decision that produced the verdict. |
| `reason` | string or null | A short explanation, when there is one. |
| `rules_version` | string | The version of the rules that were applied. |

The service may return more fields. Read only the ones you need.

## 4. curl

```sh
curl -sS https://api.usezn.com/v30/analyze -H "Content-Type: application/json" -H "Authorization: Bearer $ZN_API_KEY" -d '{"input": "Please summarize this page."}'
```

This command does not retry and does not stop on an error status. Add `-i` to see the HTTP status line and headers. For the errors you may see, see [Errors you may see](#errors-you-may-see).

## 5. Python

This script uses only the standard library. Save it as `analyze.py`, set `ZN_API_KEY` and run `python3 analyze.py`.

```python
import json
import os
import urllib.error
import urllib.request

API_URL = "https://api.usezn.com/v30/analyze"


def explain_error(error):
    """Print what an HTTP error from the API means, then stop."""
    try:
        detail = json.loads(error.read().decode("utf-8")).get("error", "")
    except (ValueError, AttributeError):
        detail = ""
    if error.code == 401:
        raise SystemExit("The API did not accept ZN_API_KEY. Check that the key is current.")
    if error.code == 402:
        raise SystemExit(f"No plan quota or credits are left. Check your plan or quota at https://usezn.com/pricing/. {detail}")
    if error.code == 429:
        reset = error.headers.get("Retry-After")
        wait = f" The quota resets in {reset} seconds." if reset else ""
        raise SystemExit(f"{detail}{wait} Waiting and retrying the same request will not help.")
    raise SystemExit(f"The API answered with HTTP {error.code}. {detail}")


def analyze(text):
    api_key = os.environ.get("ZN_API_KEY")
    if not api_key:
        raise SystemExit("Set ZN_API_KEY first.")
    body = json.dumps({"input": text}).encode("utf-8")
    request = urllib.request.Request(
        API_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        explain_error(error)


if __name__ == "__main__":
    result = analyze("Please summarize this page.")
    print(result["verdict"], result.get("rule"))
```

## 6. Node.js

This script uses the built-in `fetch` function of Node.js 18 or later and needs no packages. Save it as `analyze.mjs`, set `ZN_API_KEY` and run `node analyze.mjs`.

```javascript
const API_URL = 'https://api.usezn.com/v30/analyze';

async function explainError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body.error ?? '';
  } catch {
    detail = '';
  }
  if (response.status === 401) {
    throw new Error('The API did not accept ZN_API_KEY. Check that the key is current.');
  }
  if (response.status === 402) {
    throw new Error(`No plan quota or credits are left. Check your plan or quota at https://usezn.com/pricing/. ${detail}`);
  }
  if (response.status === 429) {
    const reset = response.headers.get('Retry-After');
    const wait = reset ? ` The quota resets in ${reset} seconds.` : '';
    throw new Error(`${detail}${wait} Waiting and retrying the same request will not help.`);
  }
  throw new Error(`The API answered with HTTP ${response.status}. ${detail}`);
}

async function analyze(text) {
  const apiKey = process.env.ZN_API_KEY;
  if (!apiKey) {
    throw new Error('Set ZN_API_KEY first.');
  }
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await explainError(response);
  }
  return response.json();
}

analyze('Please summarize this page.')
  .then((result) => console.log(result.verdict, result.rule))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
```

## Errors you may see

For a live check of the API and any published incident notes, see the [status page](https://usezn.com/status/), or call `https://api.usezn.com/health` from your own monitoring.

A failed request returns a JSON body with two fields: `error`, a sentence you can show to a person, and `code`, a stable value you can match in your code.

| Status | `code` | What it means | What to do |
|---|---|---|---|
| 400 | `missing_input` | The body has no `input` field, or `input` is empty or not a string. | Send `input` as a non-empty string. |
| 400 | `input_too_long` | `input` is longer than 20,000 characters. | Split the text into shorter parts and send each part. |
| 401 | `invalid_api_key` | The key is missing, wrong or revoked. | Check `ZN_API_KEY`. If the key was revoked, create a new one on the [connect page](https://usezn.com/connect). |
| 402 | `TRIAL_ENDED` | The account has no plan quota and no prepaid credits left to use. | Check your plan, or add credits, on the [pricing page](https://usezn.com/pricing/). Retrying will not help until then. |
| 403 | none | This endpoint does not return 403. | If you get a 403, check that the URL matches the one in this guide. |
| 429 | `MONTHLY_LIMIT_REACHED` or `INSUFFICIENT_QUOTA` | The monthly quota is used up. `INSUFFICIENT_QUOTA` means this input needs more calls than are left this month. | Retrying the same request will not help. The `Retry-After` header gives the seconds until the quota resets at the start of next month. Wait for the reset or check your plan. With `INSUFFICIENT_QUOTA`, a shorter input may still pass. |
| 500 | `analysis_failed` | The service could not complete the analysis. A body that is not valid JSON also gets this response. | Send valid JSON. If the body is valid, try again later. |

The Python and Node.js examples above stop on 401, 402 and 429 with a message that says what to do. They do not retry: `Retry-After` on a 429 is the time until the monthly quota resets, so waiting for it and retrying once would not succeed.

## Next steps

- [API reference](api-reference.md): the Node.js and Python functions, their options and their return values.
- [Example: using zn-gate from Node.js](examples/node-api.md): one short example per call of the Node.js package.
