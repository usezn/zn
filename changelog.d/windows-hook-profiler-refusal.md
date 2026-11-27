### Security
- On Windows, the hook launcher and the project guard refuse to start the hook while `COR_ENABLE_PROFILING=1` is set,
  and answer with the agent's block (or its warning for an event it cannot block): .NET then loads a DLL into PowerShell
  before the hook script runs. The Windows hook scripts hold their answer text and their paths once, so they still fit
  the 8191-character command line.
