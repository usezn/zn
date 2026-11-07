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

## 5. Python

This script uses only the standard library. Save it as `analyze.py`, set `ZN_API_KEY` and run `python3 analyze.py`.

```python
import json
import os
import urllib.error
import urllib.request

API_URL = "https://api.usezn.com/v30/analyze"


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
        if error.code in (401, 403):
            raise SystemExit("The API did not accept ZN_API_KEY. Check the key.") from error
        raise


if __name__ == "__main__":
    result = analyze("Please summarize this page.")
    print(result["verdict"], result.get("rule"))
```

## 6. Node.js

This script uses the built-in `fetch` function of Node.js 18 or later and needs no packages. Save it as `analyze.mjs`, set `ZN_API_KEY` and run `node analyze.mjs`.

```javascript
const API_URL = 'https://api.usezn.com/v30/analyze';

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
  if (response.status === 401 || response.status === 403) {
    throw new Error('The API did not accept ZN_API_KEY. Check the key.');
  }
  if (!response.ok) {
    throw new Error(`The API answered with HTTP ${response.status}.`);
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

## Errors

If the API does not accept the key, it answers with HTTP 401 or 403. The Python and Node.js examples above stop with a message that names `ZN_API_KEY`. Check that the variable holds the current key. If the key was revoked or replaced, create a new one on the [connect page](https://usezn.com/connect) and set `ZN_API_KEY` again.

## Next steps

- [API reference](api-reference.md): the Node.js and Python functions, their options and their return values.
- [Example: using zn-gate from Node.js](examples/node-api.md): one short example per call of the Node.js package.
