'use strict';

/**
 * Exit codes of the zn-gate command line, in one place.
 *
 *   0  OK        done, or nothing to report (also a no-op such as `zn unlock` on a vault that is already unlocked)
 *   1  FAILED    the command ran and found a problem: findings, a check that failed, an error
 *   2  USAGE     the command was used wrongly: an option or command it does not know, a missing value
 *
 * Kept as they are documented, and listed here so a new command picks from the same table:
 *   2  BLOCKED   `analyze` blocked the text, and a hook blocks an action (the agents expect 2)
 *   64 BAD_USAGE usage error of the secrets commands (`secret`, `env`, `hooks`, `vault log`, `run`)
 *   77 REFUSED   zn refused on purpose (for example to print a secret value)
 *   127 NOT_FOUND `run` could not find the program to start
 */
const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  BLOCKED: 2,
  BAD_USAGE: 64,
  REFUSED: 77,
  NOT_FOUND: 127,
});

module.exports = { EXIT };
