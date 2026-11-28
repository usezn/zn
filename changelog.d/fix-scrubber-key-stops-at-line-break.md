### Fixed
- The trailing dashes of an OpenAI project key are redacted with the key in the Node.js package too, as in the
  Python package.
- The Python package no longer leaves part of a key that is split over lines readable when the next line looks
  like the start of another key that its own checks then reject.
