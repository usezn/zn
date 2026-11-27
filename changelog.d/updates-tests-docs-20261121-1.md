### Fixed
- The destructive-command check reads versioned interpreter names such as python3.11.2, pypy2 and node22, and checks every code argument of node (-e, -p, --eval), as it already did for perl and ruby.
- A ledger folder that zn creates inside a setgid folder is now exactly mode 0700 (npm and Python packages).

### Changed
- The help line of `zn-gate status` now says what it does: it shows the engine, rules version and endpoint settings, and makes no network check.
