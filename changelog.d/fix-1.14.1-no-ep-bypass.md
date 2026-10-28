### Changed
- Windows: zn no longer passes `-ExecutionPolicy Bypass` to the system PowerShell it starts (the hook folder's permissions, the vault keychain entry and the confirmation dialog). These run inline commands, which the execution policy does not cover, and they were tested with the `AllSigned` and `Restricted` policies.
