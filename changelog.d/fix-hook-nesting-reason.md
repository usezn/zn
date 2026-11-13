### Fixed

- A tool call whose input is nested more than 64 levels deep is still blocked, but the hook now says that it was too deeply nested to check, instead of saying that it held text that is not valid Unicode.
