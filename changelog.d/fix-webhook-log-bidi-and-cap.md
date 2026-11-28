### Security
- The gateway webhook dispatcher now also escapes Unicode bidirectional override, embedding and isolate characters in a non-success response body before it writes the log line, so a hostile endpoint cannot reorder log text. The 64 KiB read limit is now counted with saturating arithmetic and the read stops exactly at the limit.
