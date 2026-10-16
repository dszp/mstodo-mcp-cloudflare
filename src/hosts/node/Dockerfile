# Node host image. Build from the repository root:
#   docker build -f src/hosts/node/Dockerfile -t mstodo-mcp .
# The root .dockerignore is an allowlist (TypeScript under src/ plus the build
# inputs), so the context never holds .dev.vars, wrangler.jsonc or the Compose
# .env beside this file. The COPYs below narrow further, to the source the Node
# bundle is built from.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/build-node.mjs ./scripts/
COPY src/core ./src/core
COPY src/hosts/shared ./src/hosts/shared
COPY src/hosts/node ./src/hosts/node
# Guard for what .dockerignore can't express: refuse anything but TypeScript.
RUN if find src -type f ! -name '*.ts' | grep .; then echo "non-source file in build context" >&2; exit 1; fi
RUN npm run build:node

FROM node:24-slim
WORKDIR /app
# Required at run time, no default: SERVICE_BASE_URL (the public https origin
# your reverse proxy serves), TIMEZONE, MS_TENANT_ID, MS_CLIENT_ID,
# MS_CLIENT_SECRET, OWNER_EMAIL.
ENV NODE_ENV=production MSTODO_DB=/data/mstodo.sqlite PORT=8787
COPY --from=build /app/package.json /app/package-lock.json ./
# Runtime dependencies only, with install scripts off: nothing at run time
# needs them, and skipping them keeps package scripts out of the image build.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.mjs"]
