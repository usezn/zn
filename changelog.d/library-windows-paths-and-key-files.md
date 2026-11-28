### Security
- The Node.js and Python libraries now refuse a download written to a shell startup file under the Windows spellings of its
  name (`~/.bashrc.`, `~/.bashrc::$DATA`, an 8.3 short name such as `BASH~1`) and as `$(echo ~)/.bashrc`, as the agent hooks
  already did.
- `path:sensitive_file` now covers private key files by name (`.pem`, `.key`, `.p8`, and any file under `~/.ssh` that is not a
  public one such as `*.pub`, `known_hosts` or `config`) and 8.3 short names of the protected files (`SSH~1\ID_ED~1`,
  `PRO~1\ENV~1`). Both libraries give the same verdicts.
