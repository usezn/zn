### Security
- Reading a vault file or the daemon session key now tightens it to mode 600 (with a warning) when it is readable by group or others, and refuses it with a `chmod 600` hint when that fails. The run directory is also closed to mode 700 on read, not only when the daemon writes.
