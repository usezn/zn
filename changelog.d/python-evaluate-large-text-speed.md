### Changed

- The Python package checks large inputs (16 KB and up) against the plain words each rule needs before it runs the rule's regular expression, so an evaluate of a 256 KB text is about two to three times faster. Verdicts do not change.
