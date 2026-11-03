### Fixed
- The shell policy now looks through `time -p`, `time --` and `coproc` (with or without a name) when it checks curl and wget output files and loops, so `time -p for ...` and `coproc NAME { curl ...; }` are judged like the same command without the prefix.
