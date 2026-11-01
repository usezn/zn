### Fixed
- The PII scrubber now detects a phone number with a no-break space (U+00A0, U+202F or U+2007) or two spaces between the country code and the number or between its groups, for example `+34` followed by a no-break space and nine digits. Look-alikes such as short numbers, dates and versions stay unflagged.
