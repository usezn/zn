### Changed
- A command that reads an example environment file (`.env.example`, `.env.sample`, `.env.template`, or one with a middle part such as `.env.local.example`) is no longer blocked, in both the Node and Python engines.

### Fixed
- A `.env` file named with a path prefix (`./.env`, `app/.env`, `../.env`, `/srv/app/.env`, or in quotes) is now blocked by the text rules like a bare `.env`. Names that only start like a template (`.env.example.bak`) stay blocked, also when chained with a template in one command.
- A PowerShell list read such as `cat .env.example,.env`, `gc '.env.example','.env'` or `type @('.env.example','.env')` is now blocked when any path in the list is a real `.env`, in the agent hook and in the text rules. Each path of the list is judged like a single read; in bash, `a,b` stays one file name.
