### Fixed
- The Docker image no longer ships a vulnerable OpenSSL library: the runtime base moves to the current Debian 13 distroless image, pinned by digest.
- The Dockerfile now documents a `docker run` command for the gateway server that works (stdin kept open with `-i` and a bind address inside the container), and the Rust gateway page has a short Docker section.
