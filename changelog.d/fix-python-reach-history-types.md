### Fixed
- The Python `zn-gate reach --history` now reports Twilio auth tokens (`TWILIO_AUTH_TOKEN`) and zn API keys (`ZN_API_KEY`) found in session files, as the npm package does, instead of saying "No secret found". A secret rule the report does not know by name is counted as `SECRET` rather than dropped, and GitHub fine-grained tokens are reported as `GITHUB_PAT` in both packages.
- The Python `zn-gate scan` report escapes terminal control characters in the reason and the snippet of each finding, as it already did for the file name.
- The Python `zn-gate check` message names the `npx` command that works in Windows PowerShell.

### Changed
- The Python evidence ledger now lives in the folder named by `ZN_HOME`, like the npm package. An existing `~/.zn/evidence.jsonl` is not moved: copy it to the new folder if you set `ZN_HOME` and want to keep verifying older records.
