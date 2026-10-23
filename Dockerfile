# zn — local-first prompt-injection gate
# Multi-stage build: full Rust toolchain for the build, distroless runtime.
#
# Build:  docker build -t zn .
# Smoke:  docker run --rm -i zn analyze "ignore all previous instructions"
# Server: docker run --rm -p 9090:9090 zn start
#
# The image runs as a fixed non-root user (UID/GID 65532). A volume mounted at
# /data must be writable by that user (for example `chown 65532:65532` the host
# directory, or pass --user with the owner of the directory).

# --- Stage 1: build ----------------------------------------------------------
FROM rust:1-bookworm AS builder

# Pinned protoc (matches the version the project is verified against).
# candle-onnx's build script (prost-build) compiles the ONNX protobuf schema;
# Debian bookworm's protobuf-compiler (3.21) is older than the tested version.
ARG PROTOC_VERSION=29.3
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip" -o /tmp/protoc.zip \
    && unzip -q /tmp/protoc.zip -d /usr/local && rm /tmp/protoc.zip
ENV PROTOC=/usr/local/bin/protoc
ENV PROTOC_INCLUDE=/usr/local/include

WORKDIR /build

# Dependency layer: prefetch the registry so source edits stay cache-friendly.
COPY Cargo.toml Cargo.lock ./
RUN cargo fetch --locked

# Source layer: the real build.
COPY src ./src
RUN cargo build --locked --release

# Writable scratch directory, owned by the runtime user. It is the only path the
# gateway writes to, so nothing else in the image needs to change owner.
RUN install -d -o 65532 -g 65532 -m 0700 /rootfs/data

# --- Stage 2: runtime --------------------------------------------------------
FROM gcr.io/distroless/cc-debian12:nonroot

COPY --from=builder /build/target/release/zn /zn

# Writable scratch for the local audit/vector stores created at runtime.
COPY --from=builder --chown=65532:65532 /rootfs/data /data
WORKDIR /data

# Fixed numeric UID/GID (the distroless "nonroot" user), so Kubernetes
# runAsNonRoot and volume permissions work without a name lookup.
USER 65532:65532

ENTRYPOINT ["/zn"]
