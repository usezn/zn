### Fixed
- Python: `log_evidence` never raises. An event with a value JSON cannot write (bytes, a set, a circular object) is now written the way the Node package writes it (bytes as a Buffer object, a set as an empty object), and an event that is not a mapping (for example `None`) or cannot be written at all is refused with a warning and returns `None`, as the Node package does.
