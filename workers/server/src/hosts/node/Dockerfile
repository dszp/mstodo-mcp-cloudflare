# Node host image. Build from the repository root:
#   docker build -f workers/server/src/hosts/node/Dockerfile -t mstodo-mcp .
# The root .dockerignore is an allowlist (TypeScript under workers/server/src/ plus the build
# inputs), so the context never holds .dev.vars, deployments/ or the Compose
# .env beside this file. The COPYs below narrow further, to the source the Node
# bundle is built from.

FROM node:24-slim AS build
# corepack installs the pnpm version package.json's packageManager names.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY workers/server/scripts/build-node.mjs ./workers/server/scripts/
COPY packages/core ./packages/core
COPY workers/server/src/hosts/shared ./workers/server/src/hosts/shared
COPY workers/server/src/hosts/node ./workers/server/src/hosts/node
# Guard for what .dockerignore can't express: refuse anything but TypeScript.
RUN if find workers/server/src packages -type f ! -name '*.ts' | grep .; then echo "non-source file in build context" >&2; exit 1; fi
RUN pnpm run build:node

# Runtime dependencies, installed in their own stage so pnpm stays out of the
# final image. Install scripts are off: nothing at run time needs them, and
# skipping them keeps package scripts out of the image build.
# pnpm-workspace.yaml is left out on purpose. Without its hoisted setting pnpm
# uses its default isolated layout, the only one where --no-optional works
# with this lockfile. --no-optional drops the optional peers `agents` and
# `partysocket` declare (vite, react), which pnpm resolves from the root
# devDependencies and keeps under --prod. The bundle never imports `agents`.
# In the isolated layout every package sits under node_modules/.pnpm, so the
# guard looks there.
FROM node:24-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --no-optional --frozen-lockfile --ignore-scripts \
 && if ls node_modules/.pnpm | grep -E '^(react|vite)@'; then echo "react or vite installed in the runtime image" >&2; exit 1; fi

FROM node:24-slim
WORKDIR /app
# Required at run time, no default: SERVICE_BASE_URL (the public https origin
# your reverse proxy serves), MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET,
# OWNER_EMAIL. Optional: TIMEZONE (an IANA name; defaults to UTC).
# HOST=0.0.0.0 so the published port reaches the process inside the container;
# outside a container the server binds 127.0.0.1 unless HOST says otherwise.
ENV NODE_ENV=production MSTODO_DB=/data/mstodo.sqlite PORT=8787 HOST=0.0.0.0
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.mjs"]
