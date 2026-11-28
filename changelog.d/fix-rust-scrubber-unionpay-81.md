### Fixed
- The gateway scrubber now masks 16 to 19 digit UnionPay 81 range bank cards (810000 to 817199) that have a valid check digit,
  as the Node.js scrubber and the Python preview do.
