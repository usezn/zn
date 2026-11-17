### Fixed
- The gateway no longer loses its management API when `security.allowed_origins` or `ZN_ALLOWED_ORIGINS` contains `*`: the entry is ignored with a warning, so list each origin you want to allow.
