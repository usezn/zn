### Security
- On Windows, a file under a protected folder (such as `.claude`, `.ssh` or `.aws`) is now protected even when it is written with a hash-style 8.3 short name like `SE1A2B~1.JSO`, which Windows uses when many files share a prefix. Short names elsewhere, such as in your project, are unaffected.
