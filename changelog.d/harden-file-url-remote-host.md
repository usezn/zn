### Security
- The Gemini, Antigravity and Copilot hooks now refuse a file: address that names a remote host (for example file://host/share/file) on every platform. On Windows such an address would otherwise have become a network path. A localhost host is still read as a local path.
