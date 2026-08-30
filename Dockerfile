FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY LICENSE ./LICENSE
RUN npm run check:boundaries && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime-files
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE

FROM runtime-files AS runtime-user
USER node

FROM runtime-user AS gateway
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const h=require('node:http');const q=h.get({host:'127.0.0.1',port:process.env.GATEWAY_PORT||8787,path:'/health/live',headers:{host:process.env.CONTROL_HOST||'control.'+(process.env.CONTENT_DOMAIN||'localhost')}},r=>process.exit(r.statusCode===200?0:1));q.on('error',()=>process.exit(1));q.setTimeout(2500,()=>q.destroy())"]
CMD ["node", "dist/apps/gateway/src/main.js"]

FROM runtime-user AS admin-cli
ENTRYPOINT ["node", "dist/apps/admin-cli/src/main.js"]

FROM runtime-user AS client
ENTRYPOINT ["node", "dist/apps/client/src/main.js"]

FROM runtime-user AS canary-check
COPY --from=build --chown=node:node /app/scripts/verify-public-path.mjs ./scripts/verify-public-path.mjs
COPY --from=build --chown=node:node /app/scripts/canary-policy.mjs ./scripts/canary-policy.mjs
ENTRYPOINT ["node", "scripts/verify-public-path.mjs"]

FROM postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3 AS postgres-tools
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-files /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=postgres:postgres /app/LICENSE ./LICENSE
COPY --from=build --chown=postgres:postgres /app/scripts/postgres-backup.mjs ./scripts/postgres-backup.mjs
COPY --from=build --chown=postgres:postgres /app/scripts/postgres-restore.mjs ./scripts/postgres-restore.mjs
COPY --from=build --chown=postgres:postgres /app/scripts/postgres-url.mjs ./scripts/postgres-url.mjs
COPY --from=build --chown=postgres:postgres /app/scripts/postgres-operations.mjs ./scripts/postgres-operations.mjs
COPY --from=build --chown=postgres:postgres /app/scripts/postgres-process.mjs ./scripts/postgres-process.mjs
USER postgres

FROM postgres-tools AS db-backup
ENTRYPOINT ["node", "scripts/postgres-backup.mjs"]

FROM postgres-tools AS db-restore
ENTRYPOINT ["node", "scripts/postgres-restore.mjs"]

FROM gateway AS default
