### Changed

- The Python package checks large inputs (16,384 characters or more) against the plain words each rule needs before it runs the rule's regular expression, so an evaluate of a 256 KB text is faster. Verdicts do not change.
