### Fixed
- Passwords in some database connection URLs (for example mssql://, sqlserver://, oracle://, clickhouse://) are now redacted by the Node library API as in the Python package, also when the URL directly follows non-ASCII letters (for example CJK text or accented letters).
