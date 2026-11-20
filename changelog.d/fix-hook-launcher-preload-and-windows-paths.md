### Security
- The sh hook launchers and the project hook guard now refuse to run the hook when `LD_PRELOAD`, `LD_AUDIT` or
  `DYLD_INSERT_LIBRARIES` is set in the agent's environment. The dynamic loader loads such a library into the shell
  before the first line of the launcher, so removing the variable there came too late: the call is now blocked with a
  message that asks to unset it and restart the agent. Programs the launcher starts itself still get a clean
  environment.
- The Windows PowerShell project hook guard now resolves every PATH folder and every `zn.cmd`, `node.exe` and `node.cmd`
  with junctions and symbolic links followed, and does not run one whose real place is inside the folder the agent runs
  in or inside a `node_modules` folder. Before, it dropped PATH entries by the text `node_modules` only, so an absolute
  project folder or a junction into `node_modules\.bin` on the PATH could supply `zn.cmd` or `node.exe`. Run
  `zn hooks install <agent> --project` again to update an existing project hook.
