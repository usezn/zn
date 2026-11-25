### Security
- `zn audit` reports a project that turns on a .NET profiler for the agent (`COR_ENABLE_PROFILING=1`,
  `CORECLR_ENABLE_PROFILING=1` or the .NET 11 name `DOTNET_ENABLE_PROFILING=1`) as critical, and the profiler DLL settings
  (`COR_PROFILER`, `CORECLR_PROFILER`, `DOTNET_PROFILER` and their `_PATH`, `_32`, `_64`, `_ARM32` and `_ARM64` forms) as loading code: on Windows the profiler DLL is loaded into PowerShell before a zn hook runs.
  The audit now takes the variables that load code from the same list as the hook launchers, so it also reports
  `NODE_PATH`, `PYTHONPATH`, `GCONV_PATH`, `GLIBC_TUNABLES`, `OPENSSL_CONF` and the other names on that list.
