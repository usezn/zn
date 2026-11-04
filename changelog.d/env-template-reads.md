### Changed
- A command that reads an example environment file (`.env.example`, `.env.sample`, `.env.template`, or one with a middle part such as `.env.local.example`) is no longer blocked, in both the Node and Python engines.

### Fixed
- A `.env` file named with a path prefix (`./.env`, `app/.env`, `../.env`, `/srv/app/.env`, or in quotes) is now blocked by the text rules like a bare `.env`. Names that only start like a template (`.env.example.bak`) stay blocked, also when chained with a template in one command.
- A PowerShell list read such as `cat .env.example,.env`, `gc '.env.example','.env'` or `type @('.env.example','.env')` is now blocked when any path in the list is a real `.env`, in the agent hook and in the text rules. Each path of the list is judged like a single read; in bash, `a,b` stays one file name.
- A template name followed by a shell expansion or glob character (`.env.example$IFS.env`, `.env.example*`, `.env.example?`, `.env.example[.]local`, `.env.example{,.local}`, `.env.example%`, `.env.example~`) is no longer treated as a template, because the shell may expand it to the real `.env`. The same applies to a `.pub` name. Node.js and Python.
- A PowerShell list written with a space before the comma (`gc .env.example ,.env`) or inside plain brackets (`gc (".env.example",".env")`, also with single quotes or `-Path`) is now blocked when any path in it is a real `.env`. A path written with a backslash (`gc .\.env`) is also judged with a forward slash, so it is blocked on a Linux or macOS host where the file name `.\.env` does not exist.
- The agent hook no longer treats `.env.dist`, `.env.defaults` and `.env.schema` as templates; they are blocked like the text rules already did.
