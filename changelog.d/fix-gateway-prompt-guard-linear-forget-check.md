### Security
- The Rust gateway's prompt-injection check no longer slows down on a long text that repeats
  a phrase like "don't forget the previous instructions": a 1 MB message took about 10 seconds
  to check and now takes milliseconds. The check gives the same results as before.
