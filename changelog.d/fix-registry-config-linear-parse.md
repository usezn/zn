### Security
- The package install check reads a project's settings files (.npmrc, pyproject.toml, uv.toml and similar) in linear time. A hostile repository could previously hold the hook for minutes with a crafted file; the same files now take milliseconds and the answer for real settings is unchanged.
