### Changed
- The Python rules look for an exfiltration verb and a credential word once per scanned text instead of again for every window of a large input, so scanning a very large text is faster; verdicts do not change. The rules version is now 2026-11-05.1 (Node.js and Python).
