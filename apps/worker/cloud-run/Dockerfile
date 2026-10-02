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
COPY apps/worker/vendor /app/apps/worker/vendor
RUN npm run build && test -s dist/server.mjs && test -s dist/oauth-gateway.mjs && test -s dist/synthetic-v12-smoke.mjs && test -s dist/test-migrations.mjs && test -s dist/test-activation.mjs && test -s dist/synthetic-v12-cleanup.mjs && test -s dist/synthetic-v12-discovery.mjs && test -s dist/ledger-reconciliation-diagnostic.mjs && test -s dist/ledger-preflight-reconcile.mjs && test -s dist/postgres-community-graph-benchmark.mjs && test -s dist/postgres-community-graph-readback-diagnostic.mjs && test -s dist/postgres-community-daily-publish-test.mjs && test -s dist/postgres-community-daily-live-smoke.mjs && test -s dist/postgres-community-daily-prepare-test.mjs && test -s dist/postgres-community-daily-restore-test.mjs && test -s dist/analytics-refresh.mjs && test -s dist/production-migrations.mjs && test -s dist/postgres-maintenance-job.mjs && node dist/postgres-community-graph-benchmark.mjs --check-source

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
