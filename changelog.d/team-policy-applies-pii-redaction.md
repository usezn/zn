### Security
- A Team policy with `redaction.pii` now takes effect in every agent that uses the zn hooks: personal data stays scrubbed
  and the egress check cannot be turned off locally while the policy requires it (`redaction.ner` still has no effect:
  no local model ships yet).
