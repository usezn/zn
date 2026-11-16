# API data handling

This page says what the zn analysis API keeps for each request, how long it is kept, and how you delete it. It covers the API at `api.usezn.com`, the MCP tool that calls it and the dashboard that shows your usage. It does not cover what zn-gate checks on your own computer, which never leaves your machine unless you turn on the cloud check. The full privacy policy is at [usezn.com/privacy](https://usezn.com/privacy/).

## Summary

| Data | Kept for | How it goes away |
|---|---|---|
| Input text you analyze | Not kept, except in Contributor Mode | Contributor excerpts: after 90 days, or with your account |
| Evidence records (one per analyzed request) | 90 days | Automatically after 90 days, with your account, or on email request |
| Usage counts (dashboard) | Until your account is deleted | With your account |
| Application logs | 14 to 90 days | Automatically |
| Gateway access logs (include IP address) | 14 to 30 days (30 days for the analysis endpoint) | Automatically |
| API keys | Until you delete the key or your account | Delete the key in the dashboard |
| Anonymous statistics (only if you turn them on) | 400 days | Not linked to an account (the upload request is still in the gateway access log) |

## What the API stores

### Input text

The API analyzes the text you send in memory. It does not write the text to its database or to its logs.

The one exception is Contributor Mode. If your account is in Contributor Mode, the API also keeps a scrubbed excerpt: the first 1,000 characters of the input, with email addresses, bearer tokens, common API key formats and hexadecimal strings of 32 characters or more replaced before storage. The excerpt is kept with the evidence record for up to 90 days and is used to improve zn's detection models. Scrubbing is automatic and does not catch every kind of personal data in free text, so do not send sensitive personal data in Contributor Mode.

### Evidence records

Each analyzed request creates one evidence record. It holds:

- a random evidence ID;
- the verdict, the confidence, the rule that decided and the rules version;
- the response time and the time of the request;
- a SHA-256 hash of the input and its size in bytes and characters (a hash of a short or guessable input can be recovered by guessing, so treat it as pseudonymous, not anonymous);
- the first 12 characters of the API key and a one-way identifier of the key;
- the endpoint used, the Origin host of the request, and the client name and version;
- your account, as the owner of the record, and the model score and version when a model ran.

It does not hold the input text (except the Contributor excerpt above), the raw User-Agent header, the IP address or the API key itself.

Records written by the current API expire 90 days after they are written. The record stays in the evidence list of the dashboard until then. You can look up a record by its evidence ID.

### Usage counts

For each request the API keeps a usage row: your account, the date and time, the evidence ID, the number of calls, whether the request was allowed or blocked and which layer decided a block, your plan tier and the response time. These rows have no expiry. They are removed when your account is deleted. The dashboard uses them to show your monthly totals.

### Logs

- **Application logs** record the request status (all errors and a sample of successful calls), the first 8 characters of the API key, the response time and, for analysis calls, the length of the input. They never contain input text. They are kept for 14 days for the analysis endpoints and for 90 days for the MCP and key-management endpoints.
- **Gateway access logs** record the time, route, status, response time and the source IP address of each request. They are kept for 30 days for the analysis endpoint, the MCP endpoint and the usage-statistics endpoint, and for 14 days for the other routes.

### API keys and account

Your account keeps your email address, your plan and billing status, your notification settings and any organization membership. It is kept while the account exists.

An API key is stored encrypted, so the dashboard can show it again after you pass a sign-in check. Its record also holds its name, status, creation time and last-use time.

### Anonymous statistics (opt-in)

zn-gate can send a daily count report to the API, but only if you turn that on. It is off by default. The report holds counts only, a random installation ID that is not linked to any account, the day, and version and agent information. It is kept for 400 days. Like every request, the report's source IP address appears in the gateway access log for 30 days; the stored report itself holds no IP address.

### Teams

Teams features are described in the [privacy policy](https://usezn.com/privacy/).

## How to delete your data

**One API key.** Open the API keys page of the dashboard and delete the key. The key stops working at once and cannot be restored. You can also revoke a key yourself by calling the self-revoke route with that key.

**Your account.** Open the Settings page of the dashboard and request account deletion. You may be asked to sign in again first. When you request it:

- all your API keys are disabled straight away;
- you have 30 days to cancel from the same page, which turns the keys back on;
- after 30 days, the scheduled deletion removes your API keys, evidence records, usage counts, waitlist entry, membership of any organization, and your sign-in account.

Accounts with an active subscription, or that own an organization, are held and not deleted until that is resolved, so cancel your subscription first. Organization audit records belong to the organization and are kept. Billing records at our payment provider are handled separately; ask us about them by email.

**Anything else, by email.** Write to [hello@usezn.com](mailto:hello@usezn.com) for a copy of your data, for the deletion of specific evidence records (include their evidence IDs), or for questions about this page. There is no self-service button for single evidence records.
