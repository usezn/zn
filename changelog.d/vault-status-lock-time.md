### Fixed
- The vault messages now agree on when it locks: `zn unlock` and `zn vault status` both say it locks after the idle time you set (30 minutes by default), or at the end of the session at the latest. Before, `zn vault status` only showed the end of the 8-hour session, which looked like a contradiction.
