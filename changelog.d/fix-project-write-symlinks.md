### Security
- `zn hooks install --project` and `zn hooks uninstall --project` now refuse to write when a config file is a symbolic link, or when its folder or file resolves outside the project, instead of writing through the link. A link that points nowhere no longer creates a file outside the project. Installs for your own user (outside a project) are unchanged.
