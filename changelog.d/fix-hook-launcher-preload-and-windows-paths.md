### Security
- The sh hook launchers and the project hook guard now refuse to run the hook when a loader variable that loads code or changes
  what the shell does before its first line is set in the agent's environment: `LD_PRELOAD`, `LD_AUDIT`, `LD_PROFILE`,
  `LD_TRACE_LOADED_OBJECTS`, `LD_DEBUG`, `LD_PRELOAD_FDS` and the other names listed in the source, and
  `DYLD_INSERT_LIBRARIES` with the other `DYLD_` preload settings. The dynamic loader loads such a library into the shell
  before the first line of the launcher, so removing the variable there came too late: the call is now blocked with a
  message that asks to unset it and restart the agent. Library search paths (`LD_LIBRARY_PATH` and the `DYLD_*_PATH`
  variables) do not block the hook; they are removed for the hook only. Two limits remain and are written in the threat
  model: a library that is already loaded runs before the check, and with the trace or debug variables the shell can exit
  before the script runs.
- The Windows PowerShell project hook guard now resolves every PATH folder and every `zn.cmd`, `node.exe` and `node.cmd`
  with junctions and symbolic links followed, and does not run one whose real place is inside the folder the agent runs
  in or inside a `node_modules` folder. Before, it dropped PATH entries by the text `node_modules` only, so an absolute
  project folder or a junction into `node_modules\.bin` on the PATH could supply `zn.cmd` or `node.exe`. Run
  `zn hooks install <agent> --project` again to update an existing project hook.
