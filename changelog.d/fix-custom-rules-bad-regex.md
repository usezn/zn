### Fixed
- A single invalid regular expression in `.znrules` or `zn.config.json` no longer drops the remaining custom rules and `strict`. Only the bad rule is skipped, with a warning on stderr naming the file, line and pattern; in strict mode the bad rule's text is still matched literally.
