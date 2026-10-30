### Fixed
- The Node.js scrubber no longer takes a long lower-case hyphenated slug (such as a blog post title that starts with `sk-`) for an OpenAI key. A plain key body must now hold lower case, upper case and digits, as the Python package already requires; the provider forms (Helicone, sp-, cp-, eu-, gov-, rl-, lf-, none-) are still redacted.
