### Changed
- A command that reads an example environment file (`.env.example`, `.env.sample`, `.env.template`, or one with a middle part such as `.env.local.example`) is no longer blocked, in both the Node and Python engines.

### Fixed
- A `.env` file named with a path prefix (`./.env`, `app/.env`, `../.env`, `/srv/app/.env`, or in quotes) is now blocked by the text rules like a bare `.env`. Names that only start like a template (`.env.example.bak`) stay blocked, also when chained with a template in one command.
