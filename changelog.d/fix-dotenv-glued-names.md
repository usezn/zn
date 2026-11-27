### Security
- A shell command that names a project `.env` glued to an option (`sort -o.env`), to a sed write command (`w.env`) or inside
  a docker or podman volume or mount spec (`-v ./.env:/app/e:rw`, `--mount source=./.env,...`) is now refused like the same
  name standing alone. Before, such a command could write `.env` with another file's content.
