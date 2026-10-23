### Security
- `zn team sync` refuses a second signed policy that carries the same version as the one already held but different content, and checks the version again when it saves the policy, so a policy replaced during a download is not overwritten.

### Fixed
- The Team audit upload moves forward only as far as the server confirmed. A server answer that stored fewer records than were sent no longer marks the whole batch as uploaded, and an answer that contradicts the batch is reported as a failed upload.
