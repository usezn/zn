### Changed
- A command that reads an example environment file (`.env.example`, `.env.sample`, `.env.template`, or one with a middle part such as `.env.local.example`) is no longer blocked as a sensitive file, in both the Node and Python engines. Real `.env` files, and names that only start like a template (`.env.example.bak`), stay blocked, also when they appear in the same command.
