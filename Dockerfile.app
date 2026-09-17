# Node app container image — one image, two commands (tRPC API + fetch workers),
# architecture §9 (apps/server "one image, two commands").
#
# I1 owns the container-level half of ADR 0004's runtime-ownership table for the
# fetch-worker image (Dockerfile.fetch-worker); this image wraps the shipped workspace
# build of @seatfirst/server — the application entrypoint is the server package's
# `dist/index.js`, which the server-lane tasks (S8/S9/S10/S12) fill in.
#
# Build context: repo root (monorepo — workspace dependencies are built via turbo, and
# the runtime layout preserves pnpm's relative node_modules symlinks).
#
# Layer caching: `pruner` runs `turbo prune --docker`, which splits the workspace into
# manifest-only files (out/json/ — package.json + lockfile, no source) and full pruned
# source (out/full/, scoped to @seatfirst/server and its deps). `build` installs from
# out/json/ first, so the `pnpm install` layer only invalidates when a package.json or
# the lockfile changes — not on every source edit. See
# https://turborepo.com/docs/guides/tools/docker.

ARG BASE_IMAGE=seatfirst-base:latest
FROM ${BASE_IMAGE} AS base

FROM base AS pruner
WORKDIR /repo
COPY . .
# Pin to the repo's turbo devDependency version (package.json) so the pruned output
# matches what `turbo run build` below expects.
RUN pnpm dlx turbo@2.10.7 prune @seatfirst/server --docker

FROM base AS build
# pnpm settings for the image build only (pnpm reads npm_config_* env): the repo's
# fresh-install state marks esbuild's optional install script as ignored (pnpm 11
# strictness) and every `pnpm run` would otherwise auto-trigger a deps re-install that
# fails the same way. Neither affects what gets built — workspace packages compile with
# tsc; esbuild's postinstall is a binary self-optimization only.
ENV npm_config_strict_dep_builds=false
ENV npm_config_verify_deps_before_run=false
WORKDIR /repo
COPY --from=pruner /repo/out/json/ .
# pnpm 11 requires install-script approval via `allowBuilds` (the repo's
# onlyBuiltDependencies entry is no longer honored); approve esbuild image-locally so
# the fresh install has no "ignored builds" state and turbo's nested `pnpm run` calls
# never auto-trigger a failing deps re-install. This edits the copy inside the image —
# the repo file is untouched. Re-run after the out/full/ copy below: that copy
# overwrites pnpm-workspace.yaml with the unpatched original.
COPY docker/patch-workspace.mjs /tmp/patch-workspace.mjs
RUN node /tmp/patch-workspace.mjs
RUN pnpm install --frozen-lockfile --config.strict-dep-builds=false
COPY --from=pruner /repo/out/full/ .
RUN node /tmp/patch-workspace.mjs
RUN node_modules/.bin/turbo run build --filter=@seatfirst/server...
# NOTE: no `pnpm prune --prod` — prune removes the @seatfirst/* workspace symlinks the
# runtime imports resolve through; the home-machine images carry devDeps instead
# (correctness over image size, single-operator deployment).

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# node_modules (full — unpruned, see note above) + the workspace package dirs keep the
# same relative layout, so pnpm's `@seatfirst/*` symlinks resolve unchanged.
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/apps /app/apps
COPY --from=build /repo/packages /app/packages
USER node
WORKDIR /app/apps/server
CMD ["node", "dist/index.js"]
