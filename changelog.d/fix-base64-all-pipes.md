### Fixed
- A command with several `echo ... | base64 -d` pipes is now checked pipe by pipe, so a harmless first one no longer hides a blocked command in a later one; more than 16 pipes, or too much Base64 data, is blocked.
