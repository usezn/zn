### Fixed
- The Node.js and Python secret scrubbers agree more often on keys split over lines, without leaving key text
  behind: a complete key no longer takes part of a plain word on the next line with it, the trailing dashes
  of an OpenAI project key are redacted with the key in both packages, and a JWT whose signature holds an
  `sk-` run is redacted whole by the Python package too.
