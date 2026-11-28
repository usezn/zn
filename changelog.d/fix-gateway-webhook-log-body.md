### Security
- Experimental Rust gateway (not distributed): when a webhook endpoint answers with an error, the gateway now writes at most the first 512 bytes of the reply to its
  log, with a note of how much was left out, and shows control characters (escape sequences, line breaks, NUL) as
  visible `\u{..}` codes. Before, the whole reply was logged as it came, so a server could add fake log lines or
  terminal sequences. The gateway also stops reading a large reply after 64 KiB.
