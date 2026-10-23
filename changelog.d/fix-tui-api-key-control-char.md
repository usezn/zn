### Fixed
- `zn dashboard` with an API key that contains a newline, tab or other control character (from `ZN_API_KEY` or `--api-key`) now prints "the API key contains a control character; check ZN_API_KEY" and exits with an error, instead of crashing. The key is checked before the terminal is switched to the dashboard screen.
