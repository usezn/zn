### Security
- Programs zn starts by name (`node`, `git`, `sh`, your agent) are now also never taken from a `PATH` folder in the project of a folder without git (the project your agent names, or the nearest folder with a project file, also when your home folder is a dotfiles repository), or from a repository that surrounds the one you are in.
