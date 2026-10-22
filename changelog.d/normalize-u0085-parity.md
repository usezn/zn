### Fixed
- The local rules rejoin a word split by a line break the same way in Node.js and Python when the break is next to a next-line character (U+0085) or a control separator (U+001C to U+001F): the text the rules match is now identical in both. `RULES_VERSION` is `2026-10-24.5`.
