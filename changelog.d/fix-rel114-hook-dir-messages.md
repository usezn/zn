### Changed
- When `ZN_HOOK_DIR` is refused, the message now names the folder that fails and why, says in plain words when a folder is missing or cannot be used, gives `chmod g-w,o-w <folder>` (no `sudo`) for a folder you own, and suggests a folder that works on your machine (not `/opt` where it is a link, as on Fedora Silverblue).
