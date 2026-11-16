### Changed

- The experimental Rust gateway (not distributed): its WebSocket back-off test now uses a paused clock instead of waiting 7.5 seconds, tests that read or set the home folder variables take turns behind one lock, and more tests cover the image text scan, older audit databases, read-only audit files, unreadable policy folders, the log redactor and the card and SSN checks.
