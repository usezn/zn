# Reading the API score and picking a threshold

The zn Cloud API decides each input with two layers: a set of deterministic rules and a neural classifier (Galvanize). Every response tells you the verdict, the model score and the threshold that score was compared with. This guide explains each field, how a verdict is reached, and how to choose what your app does with it.

For authentication, request format and errors, see the [API reference](https://usezn.com/docs/api/) and [Errors and rate limits](https://usezn.com/docs/api/errors/). For the SDK functions that call the API, see [api-reference.md](api-reference.md).

The values on this page are the ones served at the time of writing (7 November 2026). Read `threshold` from each response instead of hard-coding it: it can change when zn updates the model.

## The response

`POST https://api.usezn.com/v30/analyze` returns a JSON body like this (the values are illustrative):

```json
{
  "verdict": "allow",
  "confidence": 0.0412,
  "score": 0.0412,
  "threshold": 0.980226,
  "rule": null,
  "reason": null,
  "decided_by": "rules",
  "rules_version": "2026-10-01.1",
  "ml_version": "example-model",
  "ml_threshold": 0.980226,
  "router_level": "rules",
  "mode": "active",
  "tier": "example",
  "evidence_id": "ev_0123456789abcdef01234567",
  "latency_ms": 42
}
```

| Field | What it tells you |
| - | - |
| `verdict` | `allow` or `block`. This is the field your app acts on. |
| `score` | The model's score for the input, from 0 to 1. `null` when the model did not score the input. |
| `threshold` | The score at or above which the model blocks. The same value as `ml_threshold`. |
| `confidence` | The number behind the verdict. When the model decides or allows, it equals `score`. When a rule blocks, it is that rule's confidence, not the model's score. |
| `rule` | The rule that matched, or the model's label when the model blocks. Use it for logs and dashboards, not as a switch in your code. |
| `reason` | A short text explanation. It can change wording, so do not parse it. |
| `decided_by` | `rules` or `ml`. It is `ml-error-rules-fallback` when the model failed and the rules decided alone. Note that an allowed input also reports `rules`, because the rules layer is the one that lets it through. |
| `ml_version` | Which model scored the input. `null` when no model scored it. |
| `router_level` | How far the request went: `rules`, `advanced` or `deep`. The same value as the `X-ZN-Router-Level` header. |
| `mode` | `active` when the model's verdict counts. In `shadow` mode the verdict comes from the rules only and the model result is for observation. |
| `deep_score` | Present only when the deep layer ran on the request. |
| `evidence_id` | The record of this request in your dashboard evidence vault. Store it with your own logs to find the request later. |
| `latency_ms` | Server-side processing time in milliseconds. |

The response headers `X-ZN-Model-Score` and `X-ZN-Model-Verdict` carry the same model result. `X-ZN-Model-Score` is `n/a` when the model did not run, and `X-ZN-Model-Verdict` is `off` or `error` in that case (other values also mean the model did not score the input).

## How a verdict is reached

1. The rules check the input. A rule match blocks the input.
2. If the model scored the input, its score is compared with the threshold. A score equal to or above the threshold blocks. The comparison uses `>=`, so a score exactly at the threshold blocks.
3. The verdict is `block` if either step blocked. Otherwise it is `allow`.
4. If the model could not score the input, the rules decide alone and `decided_by` is `ml-error-rules-fallback`.

If the primary model is unavailable, a second model scores the input with its own threshold. The `threshold` field in the response shows which threshold applied, so you can tell the two apart.

## Current default thresholds

| Model | Default threshold | Where to read it |
| - | - | - |
| Primary model (Galvanize) | 0.980 | `threshold` and `ml_threshold` in each response |
| Fallback model, used when the primary model is unavailable | 0.95 | `threshold` in the responses it scored |

You cannot set the threshold for a request. The request has one field, `input`, and the threshold is not part of it. The threshold is set by zn, so the only control you have over what your app blocks is what you do with `verdict` and `score`.

## Choosing how your app uses the score

Most apps should use `verdict` as returned. The default threshold was set for general use, and blocking on `verdict` is the simplest policy.

If the default does not fit your traffic, change what your app does around it:

- **Review band.** Keep the API verdict, and treat allowed inputs with a score above a lower cut-off you choose (for example, 0.5) as items for a person to look at. Use the `score` field for this. A lower cut-off only adds review work; it never changes the verdict.
- **Log everything you act on.** Store `verdict`, `score`, `threshold`, `decided_by` and `evidence_id` for each decision. That is enough to measure how often the policy blocks and to review disagreements in the evidence vault.
- **Fail closed for high-impact tools.** When the API cannot be reached, the choice between blocking and allowing is yours. See [Fail open or fail closed?](https://usezn.com/docs/api/errors/#fail-open-or-fail-closed).

## Steps to check the default on your own data

1. Collect a sample of real inputs from your app, both ordinary ones and ones you would expect to be blocked. Label them yourself.
2. Send each input to the API and record `verdict`, `score`, `threshold` and `decided_by`.
3. Compare the scores of your ordinary inputs with the threshold. Look at how many sit close to it, and at which blocked inputs you would have allowed.
4. Decide: keep the verdict as returned, add a review band, or both.
5. Measure again after the threshold or `ml_version` changes.

This page does not list accuracy figures for the current model, so measure on your own traffic. Long documents deserve their own sample, because a score on a long input can differ from a score on a short one.

## Things a score does not tell you

- A `block` from a rule can happen at a low score. Check `decided_by` and `rule` to see which layer blocked.
- An `allow` does not prove an input is safe. It means the rules did not match and the model scored the input below the threshold.
- `score` is `null` when the model did not run. Do not treat `null` as zero.
- An input over the API's length limit is rejected with an error, not scored. See [Errors and rate limits](https://usezn.com/docs/api/errors/).
