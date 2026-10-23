### Security
- `zn team sync` refuses a second signed policy that carries the same version as the one already held but different content, and checks the version again when it saves the policy, so a policy replaced during a download is not overwritten.

### Fixed
- The Team audit upload moves forward only as far as the server confirmed. A server answer that stored fewer records than were sent no longer marks the whole batch as uploaded, and an answer that contradicts the batch is reported as a failed upload.
- `zn team join` exits `1` unless the organization's first valid policy was downloaded and applied. The machine stays registered, `zn team status` shows the join as pending, and `zn team sync` finishes it.
- `zn team sync` exits `1` when it is offline, the organization has no policy, the policy is refused or an upload fails, instead of `0`. `zn team status` shows the reason of the last sync, and the automatic sync leaves a local audit record when it keeps failing (at most one every 6 hours).
