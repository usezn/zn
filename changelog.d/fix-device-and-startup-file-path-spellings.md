### Security

- The destructive-command check now reads a disk device or a shell startup file written with repeated slashes or `.` and `..` segments (for example `//dev/sda`, `/tmp/../dev/sda` or `~//.bashrc`) as the same file, in the npm and Python packages. Before, only the plain spelling was blocked.
