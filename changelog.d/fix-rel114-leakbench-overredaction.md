### Fixed

- The scrubber no longer reads a quoted value of a secret key across a line break, so source code such as `print("token=" + x)` is not redacted by mistake.
