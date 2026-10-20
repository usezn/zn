### Security
- The optional destructive-command check now reads a disk device path the way the system does. Repeated slashes and `.` or `..` segments are resolved first, so a write to a disk device spelled `/dev/../dev/sda`, `//dev/sda` or `/dev/./sda` is blocked in `dd of=`, `mkfs`, `wipefs` and redirections, as `/dev/sda` already was.
- The same check compares system and home folders without regard to case, as macOS does: `rm -rf /users/bob` is treated like `/Users/bob`.

### Fixed
- The destructive-command check no longer blocks a delete only because a path steps out of the home folder: `rm -rf ~/../shared/project/build` is allowed, while `~/..` and `~/../alice` stay blocked. The Node.js and Python checks behave the same. `POLICY_RULES_VERSION` is `2026-10-20.8`.
