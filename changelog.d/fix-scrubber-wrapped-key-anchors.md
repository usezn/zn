### Fixed
- A secret key wrapped across several lines was left readable when its pieces were all lowercase, when its first piece ended
  inside the key prefix, or when a longer line came right after its last piece. The Node.js and Python scrubbers now read
  these keys whole and redact them the same way.
