### Security
- The development tools of the package no longer use a `minimatch` with a denial-of-service flaw in its pattern expansion (GHSA-g3hv-75wg-m249): the coverage tool now uses `minimatch` 11.0.1 or later. It is a development dependency and never shipped in the package.
