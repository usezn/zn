### Fixed
- `zn audit` no longer reports a high prompt-injection finding (ZNA012) for documentation inside a `SKILL.md` or a docs page: a chat token shown in code, a `<system-or-project>` placeholder, `system:anonymous`, a badge image from a known badge host, or a quoted warning about injection. A real override phrase, a system role token or a role marker on its own line is still high.
- `zn audit` no longer reports setup steps as exfiltration (ZNA014): `git clone <url>`, `cp .env.example .env` and "create a key at [Console](url)". Sending a secret to a URL is still reported.
