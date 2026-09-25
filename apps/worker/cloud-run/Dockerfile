FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /app/apps/worker/cloud-run
COPY apps/worker/cloud-run/package.json apps/worker/cloud-run/package-lock.json ./
COPY packages/accounting /app/packages/accounting
COPY packages/quota-analysis /app/packages/quota-analysis
COPY packages/telemetry-contract /app/packages/telemetry-contract
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/worker/cloud-run ./
RUN mkdir -p assets
RUN ln -s /app/apps/worker/cloud-run/node_modules /app/node_modules
COPY apps/worker/src /app/apps/worker/src
COPY apps/worker/postgres/migrations /app/apps/worker/postgres/migrations
COPY apps/worker/scripts/postgres-migrations.mjs /app/apps/worker/scripts/postgres-migrations.mjs
RUN npm run build && test -s dist/server.mjs && test -s dist/synthetic-v12-smoke.mjs && test -s dist/test-migrations.mjs && test -s dist/test-activation.mjs && test -s dist/synthetic-v12-cleanup.mjs && test -s dist/synthetic-v12-discovery.mjs && test -s dist/ledger-reconciliation-diagnostic.mjs

FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
WORKDIR /app/apps/worker/cloud-run
COPY apps/worker/cloud-run/package.json apps/worker/cloud-run/package-lock.json ./
COPY packages/accounting /app/packages/accounting
COPY packages/quota-analysis /app/packages/quota-analysis
COPY packages/telemetry-contract /app/packages/telemetry-contract
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/apps/worker/cloud-run/dist ./dist
COPY --from=build /app/apps/worker/cloud-run/assets ./assets
COPY --from=build /app/apps/worker/postgres/migrations /app/apps/worker/postgres/migrations
CMD ["node", "dist/server.mjs"]
