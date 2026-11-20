### Security
- The hook guard that project installs write (the `sh -c` command, its PowerShell twin and the OpenCode project plugin) no
  longer runs a `zn` or `node` that sits in a `node_modules` folder. A package can plant a `zn` in `node_modules/.bin`, and
  `npm run` or direnv put that folder on the PATH, so the planted program could answer for the hook and allow a blocked
  call. The guard now blocks with its usual message instead. Run `zn hooks install <agent> --project` again to update an
  existing project hook.
