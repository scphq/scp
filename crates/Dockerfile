# syntax=docker/dockerfile:1
FROM rust:1.98.0-alpine AS build
RUN apk add --no-cache musl-dev build-base perl pkgconf
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY scp-relay-store ./scp-relay-store
COPY scp-relay ./scp-relay
COPY scp-hook ./scp-hook
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin scp-relay && \
    cp target/release/scp-relay /scp-relay && \
    mkdir /data && chown 65532:65532 /data

FROM gcr.io/distroless/static-debian12:nonroot
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/scphq/scp" \
    org.opencontainers.image.licenses="Apache-2.0" \
    org.opencontainers.image.title="SCP relay" \
    org.opencontainers.image.description="Self-hosted SCP relay with SQLite and PostgreSQL storage" \
    org.opencontainers.image.version="$VERSION" \
    org.opencontainers.image.revision="$REVISION"
COPY --from=build /scp-relay /usr/local/bin/scp-relay
COPY --from=build --chown=65532:65532 /data /data
ENV SCP_RELAY_LISTEN=0.0.0.0:8787 \
    SCP_RELAY_STORE=sqlite:///data/relay.db
VOLUME ["/data"]
EXPOSE 8787
USER 65532:65532
HEALTHCHECK --interval=5s --timeout=4s --start-period=5s --retries=5 CMD ["/usr/local/bin/scp-relay", "health"]
ENTRYPOINT ["/usr/local/bin/scp-relay"]
CMD ["serve"]
