### Changed
- The messages shown when a call is blocked because zn could not read a file address in it, or because its arguments are nested too deeply, now say what zn could not read (with the limits) and give one next step: ask the agent to send the call again with flatter arguments and each file as a plain path. The first no longer shows the advice for a changed agent format.
