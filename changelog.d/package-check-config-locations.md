### Security
- The private-registry check for package installs now also reads the project settings above the working folder (up to the git root), the global npm settings, pnpm settings and the system pip and uv configs, so an internal package name is not sent to the public registry.
