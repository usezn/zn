### Fixed
- The Rust scrubber now masks AWS access key ids (AKIA, ASIA, ABIA and ACCA prefixes), GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_ and github_pat_) and Stripe secret keys (sk_ and rk_ with live, test or prod), matching the Node and Python scrubbers. Edge cases (end of text, mid-line, inside a longer word, long single-line text) are covered by tests.
