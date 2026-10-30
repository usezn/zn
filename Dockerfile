# zn — local-first prompt-injection gate
# Multi-stage build: full Rust toolchain for the build, distroless runtime.
#
# Build:  docker build -t zn .
# Smoke:  docker run --rm -i zn analyze "ignore all previous instructions"
# Server: the gateway listens on 127.0.0.1 by default, which a published port cannot
#         reach, and `start` needs a terminal (-t) or it exits at once. Set the bind
#         address in a config file and choose an API key:
#           echo '{"server":{"bind_address":"0.0.0.0"}}' > zn.json
#           docker run --rm -it -p 127.0.0.1:9090:9090 -e ZN_API_KEY=<your-key> #             -v "$PWD/zn.json:/data/zn.json:ro" zn start
#         0.0.0.0 is the address inside the container; -p 127.0.0.1:9090:9090 keeps
#         the port reachable from this machine only.

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
# Debian 13 (trixie) distroless: the Debian 12 images are no longer rebuilt, so they keep
# an unpatched libssl3. The binary is built on bookworm (older glibc) and runs unchanged here.
FROM gcr.io/distroless/cc-debian13@sha256:d74d144baa124dd9defd01d71872bb56c49d4441dba6153ccf790364f97e64b1

COPY --from=builder /build/target/release/zn /zn

# Writable scratch for the local audit/vector stores created at runtime.
WORKDIR /data

ENTRYPOINT ["/zn"]
