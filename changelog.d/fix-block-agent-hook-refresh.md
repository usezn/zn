### Security
- An agent can no longer make the hook launchers trust changed zn-gate files. The launchers run the hook only while the
  installed package matches the digest they recorded, but the launcher refresh (`lib/agents/refresh.js`, which the
  package runs after an install) and a reinstall or rebuild record the files as they are now, so an agent that had
  edited a file of the package could run one of them and have its change trusted. Like `zn hooks install`, these are now
  refused to the agent with a message that asks you to run them in your own terminal: running the refresh or the
  launcher writer with Node.js, Bun or Deno, and `npm`, `pnpm`, `yarn`, `bun` or `volta` commands that install, update,
  rebuild or link zn-gate (also `npm run postinstall` in an installed zn-gate folder). Removing zn-gate, reading its files
  and other package commands are not affected.
