### Fixed
- A file read written as an NTFS alternate data stream (`.aws\credentials::$DATA`, `.env:name`) is now treated as the protected file itself, so it is blocked like the plain name. A drive letter such as `C:` is never read as a stream.
- A cmd.exe or PowerShell redirect with an unquoted drive path glued to a word (`echo x> C:\Users\me\.claude\settings.json`, `echo x>C:\...`) is now recognised as a write to that path, so the agent configuration protection applies to it. The same glued form is also checked in bash. `POLICY_RULES_VERSION` is `2026-10-24.3`.
