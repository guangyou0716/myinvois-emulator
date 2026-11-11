# Local-only image for the offline MyInvois emulator. Build it yourself; no image is published.
# Base pinned by digest (node:20-alpine multi-arch index, resolved 2026-11-11).
ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# Zero runtime dependencies: the compiled CLI, package.json (for --version) and the fixtures are enough.
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY fixtures ./fixtures
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/_emulator/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "dist/cli.js"]
# Inside a container the emulator must bind all interfaces so `docker run -p` can reach it.
CMD ["start", "--host", "0.0.0.0", "--port", "8787"]
