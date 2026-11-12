'use strict';

// Tests only, loaded with `node -r` in a child process: makes stats.userHome() (the operating-system account's home,
// where the hook settings that relax a check are read) report the folder in ZN_TEST_ACCOUNT_HOME. The library never
// reads this variable; only a process started with this file preloaded does.
if (process.env.ZN_TEST_ACCOUNT_HOME) {
  const home = process.env.ZN_TEST_ACCOUNT_HOME;
  require('../../lib/stats')._useRealHome(() => home);
}
