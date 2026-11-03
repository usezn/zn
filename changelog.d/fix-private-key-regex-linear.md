### Fixed
- A prompt expansion made of many private key headers followed by long runs of spaces no longer takes almost the whole hook time to check; the private key check now runs in linear time and still catches the same keys.
