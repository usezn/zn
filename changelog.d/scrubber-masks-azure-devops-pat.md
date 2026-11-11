### Fixed

- The scrubber now masks the value of an Azure DevOps personal access token on an `AZURE_DEVOPS_EXT_PAT=<value>` line, and of any variable whose name ends in the word `PAT` (`GH_PAT`, `ADO_PAT`), in both the Node.js and the Python packages. Names that only contain the letters, such as `PATH` or `COMPAT`, and short values are not affected.
