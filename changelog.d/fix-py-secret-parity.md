### Fixed
- The Python package now redacts the same secret shapes as the Node.js scrubber: an OpenAI key with hyphens or underscores in its body, GitHub tokens up to 255 characters, a zn API key, a JWT with short parts, an AWS secret access key named in the words before it, and a private key whose END line was cut off.
