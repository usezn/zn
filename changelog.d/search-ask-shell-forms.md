### Fixed
- In Antigravity, the question zn asks before a recursive shell search over a folder that holds a plain `.env` now also covers `bash -c` and `sh -c` strings nested up to three levels, `eval "..."`, and a folder held in a variable set earlier on the same line (`D=config; grep -r AWS $D`). A variable zn cannot resolve still asks, and searches over clean folders stay allowed.
