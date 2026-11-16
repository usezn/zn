### Fixed
- The scrubber now masks a Twilio auth token (32 hex digits) written under a `TWILIO_AUTH_TOKEN` or `auth_token` label, in env files, YAML and JSON. The account SID next to it stays visible, and an unlabelled 32-hex value (a hash or an id) is left alone.
