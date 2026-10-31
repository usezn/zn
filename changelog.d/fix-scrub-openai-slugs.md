### Fixed
- The Node.js scrubber no longer takes a long lower-case hyphenated slug (such as a blog post title that starts with `sk-`) for an OpenAI key. A key body must hold a digit and look random; keys in lower case or hex (OpenRouter `sk-or-v1-`, `sk-` and `sk-proj-`) and the provider forms are still redacted.
