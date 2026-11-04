### Fixed
- Messages that zn-gate writes to stderr (warnings and errors such as a tamper alert) are plain text when stderr is piped or redirected, even if stdout is a terminal: no emoji or box-drawing characters. Output on a terminal is unchanged.
