### Changed
- The Rust gateway now judges shell commands with the same rules as the Node.js and Python packages: it blocks a command by what it does to its target (the home folder, the filesystem root, a disk device, a shell startup file) and no longer by the word it starts with. `rm -rf ./build`, `chmod +x run.sh` and `cargo build -- --release` pass, while `rm -rf ~`, a download piped into a shell, a fork bomb and a download written over `.bashrc` are blocked. On the shared test corpus it blocks all 652 risky commands and none of the 1136 ordinary ones (before: 286 and 593).

### Removed
- The Rust gateway no longer blocks a call because its arguments contain the word `rm`, `dd`, `chmod`, `chown`, `mkfs`, `format`, `shutdown` or `reboot`. A tool whose own name is one of those words is still blocked.
