### Security
- The destructive-command check (on by default in the agent hooks) now also recognizes a protected folder or home
  folder written in four more ways: a system or home folder name in another letter case (macOS and Windows file systems
  do not tell cases apart), a Windows drive path with trailing dots or spaces, a home variable with a parameter-expansion
  operator, and another user's home written as a tilde and a name. The recursive-permission check reads the same forms.
  The Node and Python engines give the same verdicts.
