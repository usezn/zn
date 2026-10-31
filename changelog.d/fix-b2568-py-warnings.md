### Fixed
- Python: when the cloud check answers with an HTTP error (401, 429, 5xx), the response is closed at once instead of staying open until garbage collection; Python 3.14 no longer prints a ResourceWarning for it.
