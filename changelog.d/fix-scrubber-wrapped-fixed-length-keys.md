### Fixed
- A secret key wrapped across two lines was not redacted when another wrapped key or a long plain line came right
  after it, for keys of a fixed length such as GitHub, Hugging Face and npm tokens. The Node.js and Python
  scrubbers now read each wrapped key on its own, so every part of every key is redacted and the lines around it
  are left as they were.
