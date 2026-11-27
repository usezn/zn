### Fixed
- The Node.js and Python secret scrubbers give the same output on keys split over lines: a redacted key that
  was wrapped no longer takes the first lower-case word of the next line with it, the trailing dashes of an
  OpenAI project key are redacted with the key in both packages, and a JWT whose signature holds an `sk-` run
  is redacted whole by the Python package too.
