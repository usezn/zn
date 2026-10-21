### Changed
- The Python source distribution (sdist) no longer includes the `tests/` folder, whose fake secret fixtures made secret scanners flag the archive; the wheel is unchanged. The test suite is available from the git tag. CI and the release build now check the contents of the wheel and the sdist and fail on unexpected files, keys, env files or files over 200 KB.
