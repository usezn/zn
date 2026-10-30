# zn — local-first prompt-injection gate
# Multi-stage build: full Rust toolchain for the build, distroless runtime.
#
# Build:  docker build -t zn .
# Smoke:  docker run --rm -i zn analyze "ignore all previous instructions"
# Server: docker run --rm -p 9090:9090 zn start

# --- Stage 1: build ----------------------------------------------------------
# Base images are pinned by multi-arch index digest; Dependabot (docker) updates the digests.
FROM rust:1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS builder

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

# --- Stage 2: runtime --------------------------------------------------------
FROM gcr.io/distroless/cc-debian12@sha256:e5d81ddde149641e2a9ba55be4545bc125c67de07508b03ba4c22e6eb0ded5aa

COPY --from=builder /build/target/release/zn /zn

# Writable scratch for the local audit/vector stores created at runtime.
WORKDIR /data

ENTRYPOINT ["/zn"]
