### Security
- Gemini CLI: `read_many_files` include patterns that reach a `.env` file are now blocked, and a search checks the whole folder tree (within limits) instead of only its first level. A search over a tree zn cannot fully check (too many entries, too deep, or a folder it cannot read) is blocked, with the reason, instead of allowed. The same search check applies to Antigravity.
