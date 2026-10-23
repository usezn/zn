### Changed
- The gateway's Docker image now runs as a fixed non-root user (UID and GID 65532) instead of root. A volume mounted at `/data` must be writable by that user. CI now builds the image and checks that it starts as non-root, answers its health check and exits cleanly.
