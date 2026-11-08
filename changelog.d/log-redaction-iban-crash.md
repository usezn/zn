### Fixed
- A crafted tool name or agent id containing look-alike letters (such as the Kelvin sign) could crash the log redactor while it checked for bank account numbers. Account number matching is now ASCII-only and rejects anything else before slicing.
