### Security
- `zn audit` reports a project settings file that sets `ZN_NPM_REGISTRY` for the agent (new rule ZNA025, critical; medium in your own user file). `zn-gate scan --package` would otherwise download the package and its checksum from a registry the project chose. The variable is also recorded by `zn audit --approve`.
