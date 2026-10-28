### Fixed
- Guided `zn-gate init` without an internet connection now says "no internet connection: npm could not reach the registry" and what to do next, instead of blaming npm's global folder permissions. The npm install step gives up after about 30 seconds (and never waits more than 3 minutes) instead of 30 to 200 seconds. A real permission error still gets the permission advice.
