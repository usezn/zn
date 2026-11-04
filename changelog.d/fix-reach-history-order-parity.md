### Fixed
- `zn-gate reach --history`: when a home has more than 50,000 history files, the npm and the Python package now read the same files. Both visit the folders in the byte order of the file names. Before, the npm package took them in the order the disk lists them, so the two packages could report different files on the same machine.
- The documentation of `zn-gate reach --history` now states that the Python package is about 17 times slower than the npm package (measured on a synthetic 192 MB history), so the default 120-second limit covers much less of a large history there.
