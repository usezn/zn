### Fixed
- The Node.js scrubber no longer takes a long lower-case hyphenated slug (such as a blog post title that starts with `sk-`) for an OpenAI key. The key rule now needs lower case, upper case and digits in the body, as the Python package already did.
