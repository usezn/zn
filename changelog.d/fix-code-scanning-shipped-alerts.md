### Fixed

- Registry lookups encode every slash in a package name, not only the first one. Names that npm accepts were already handled; this closes a code-scanning finding.
