### Fixed
- The gateway's management API rate limiter no longer keeps an entry for every client address forever: it drops the ones that are back to a full allowance every 60 seconds, so a gateway reachable from many addresses does not grow without bound.
