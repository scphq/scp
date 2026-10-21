# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run --filter @scp-dev/dashboard build

FROM gcr.io/distroless/nodejs24-debian12:nonroot
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/scphq/scp" \
    org.opencontainers.image.licenses="Apache-2.0" \
    org.opencontainers.image.title="SCP dashboard" \
    org.opencontainers.image.description="Optional dashboard for the SCP relay" \
    org.opencontainers.image.version="$VERSION" \
    org.opencontainers.image.revision="$REVISION"
WORKDIR /app
COPY --from=build /src/packages/dashboard/dist ./dist
ENV SCP_DASHBOARD_LISTEN=0.0.0.0:8788
EXPOSE 8788
USER 65532:65532
HEALTHCHECK --interval=5s --timeout=4s --start-period=5s --retries=5 CMD ["/nodejs/bin/node", "/app/dist/server.js", "--health"]
CMD ["dist/server.js"]
