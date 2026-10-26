### Security
- `zn-gate check` does not run the Claude Code or ZCode plugin hook when a `PATH` entry is inside a folder above the project (a project with no git repository checked from a subfolder, or a repository inside another one whose `bin` folder is on the `PATH`): the hook could start a program from there. The line names the entry and the fix is to take it off the `PATH`.
