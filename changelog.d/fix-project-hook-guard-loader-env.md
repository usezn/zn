### Security
- The project hook guard (the command `zn hooks install <agent> --project` writes, for sh and for Windows PowerShell) now
  removes the variables that load code into Node.js before it starts `zn`, like the user hook launchers do, so a project
  that sets `NODE_OPTIONS=--require` in the agent's environment cannot run code inside the hook. It also no longer runs a
  `zn` or `node` from a `node_modules` folder written in another case (`Node_Modules`), which is the same folder on macOS
  and Windows. Run `zn hooks install <agent> --project` again to update an existing project hook.
