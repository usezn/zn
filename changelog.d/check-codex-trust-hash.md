### Fixed
- `zn-gate check` now recognises Codex's own approval of zn's hooks. After you approved them in `/hooks` it kept saying the hooks had changed, because zn computed Codex's approval hash from a field Codex leaves out. zn-gate now computes the same hash as Codex 0.163.0, including on Windows.
