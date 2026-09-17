# syntax=docker/dockerfile:1
#
# Phase 4A — local container packaging experiment (Option A from the roadmap).
#
# This container runs the EXISTING `vite preview` server plus its existing
# configurePreviewServer proxy middleware from vite.config.js, unmodified.
# There is no standalone production server here yet, and none of the proxy
# logic has been touched. See CLAUDE.md / docs/CURRENT-STATE.md for the
# architecture this preserves.

# ---------------------------------------------------------------------------
# Build stage: install full dependency set (dependencies + devDependencies —
# `vite`, `vite-plugin-cesium`, and `ws` are devDependencies but are required
# at RUNTIME under Option A, since the "server" is `vite preview` itself) and
# produce the static build in dist/.
# ---------------------------------------------------------------------------
FROM node:24.21.0-slim AS build
WORKDIR /app

# Install deps first so this layer only re-runs when the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

# Bring in the rest of the source needed to build (public/, index.html, and
# style.css are consumed by `vite build` and are NOT copied into the runtime
# stage below — their output is already baked into dist/ after this step).
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage: everything `vite preview` and its proxy middleware need to
# run, and nothing else. No .git, no .env, no dev-only local files.
# ---------------------------------------------------------------------------
FROM node:24.21.0-slim AS runtime
WORKDIR /app

# node_modules is copied whole (not pruned to --omit=dev) because the runtime
# process is `vite preview` itself, a devDependency, and the AISStream proxy
# requires the `ws` devDependency at runtime too. See CLAUDE.md's deployment
# notes on why the usual "prod-only install" pattern does not apply here.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# vite.config.js is required for `vite preview` to know its plugins/outDir.
# It directly imports plain source modules under src/ and scripts/ at
# Node-runtime (not bundled), so those directories must exist alongside it.
# config/ holds the CCTV source-pack JSON the CCTV proxy reads from disk.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/vite.config.js ./vite.config.js
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/config ./config

# HOST=0.0.0.0 is required here, not merely the --host CLI flag below:
# vite.config.js's own allowedHosts check (inherited by `vite preview`, which
# has no dedicated `preview:` override) only relaxes host validation when the
# HOST env var itself is '0.0.0.0' or '::'. Without it, Cloud Run's proxied
# requests (arriving with a non-localhost Host header) would be rejected by
# Vite's own preview server. This is scoped to this container image only —
# it does not change the local `npm run dev` default, which remains
# localhost-only per CLAUDE.md.
ENV HOST=0.0.0.0
ENV PORT=8080

# .gev-cache/ and .gev-logs/ are created on demand under the working
# directory by the app itself (path.join(process.cwd(), ...) /
# path.join(__dirname, ...)); no directories are pre-created here, and no
# attempt is made to persist them across container restarts at this phase.

EXPOSE 8080

# Exec-form CMD explicitly invokes `sh -c` so ${PORT} expands; Cloud Run
# injects PORT at runtime, and `docker run -e PORT=8080 ...` (or the default
# above) covers local testing.
CMD ["sh", "-c", "npm run preview -- --host 0.0.0.0 --port ${PORT:-8080}"]
