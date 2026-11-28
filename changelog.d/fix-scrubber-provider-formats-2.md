### Fixed
- The scrubber and the redaction rules now read three more documented provider formats, the same way in the
  Node.js and Python packages: the Sentry organization auth token (`sntrys_`) and the single-use Sentry setup
  and agent handoff codes (`sntryc_`, `sntryh_`), the HashiCorp Vault recovery token (`hvr.`) and the Notion
  refresh token (`nrt_`).
- The Python package no longer redacts a text that only looks like an Anthropic or OpenAI key with a wrong
  prefix (`sk-ant_`, `sk-prj-`); the Node.js redaction rules never did, and the Node.js scrubber now agrees.
  Real `sk-ant-` and `sk-proj-` keys are still redacted.
