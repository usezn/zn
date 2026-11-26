### Security
- A shell command that names a project `.env` and is not a read-only or metadata-only command is now refused even while that
  `.env` is a folder (for example a Python virtual environment). A program could remove the folder and write a `.env` file
  there after the check. Listing, reading, removing the folder and running the environment (`source .env/bin/activate`) still
  pass; creating or recreating the environment under that name (`python3 -m venv .env`) is refused, so use another name for it.
