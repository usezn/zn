### Security
- `zn audit` reports a project that turns on a .NET profiler for the agent (`COR_ENABLE_PROFILING=1` or
  `CORECLR_ENABLE_PROFILING=1`) as critical: on Windows the profiler DLL is loaded into PowerShell before a zn hook runs.
  The audit now takes the variables that load code from the same list as the hook launchers, so it also reports
  `NODE_PATH`, `PYTHONPATH`, `GCONV_PATH`, `GLIBC_TUNABLES`, `OPENSSL_CONF` and the other names on that list.
