### Fixed
- An OpenAI project key (`sk-proj-` and the other named forms) is redacted up to the end of the token in both
  packages, so trailing dashes no longer stay in the text after the redaction mark.
- The Python package no longer leaves part of a key that is split over lines readable when the next line looks
  like the start of another key that its own checks then reject.
- The Python package redacts a JWT whose signature holds an `sk-` key whole, as the Node.js package does,
  instead of leaving its header and payload readable.
