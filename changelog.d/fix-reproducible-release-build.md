### Added
- `scripts/repro-build.sh` builds the release binary so that it does not depend on the directory it was built in, and `scripts/check-repro-build.sh` builds the same commit twice in different directories and compares the two. Before this, two clean release builds of one commit differed because build directories and cargo registry paths were embedded in the binary.
