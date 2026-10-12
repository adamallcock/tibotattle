FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9

WORKDIR /app

# Install at the common ancestor of the copied Worker script so Node's ESM
# resolver cannot accidentally depend on the package's source directory.
COPY apps/worker/gcp-test/package.json ./package.json
COPY apps/worker/gcp-test/package-lock.json ./package-lock.json
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY apps/worker/scripts/postgres-migrations.mjs ./apps/worker/scripts/postgres-migrations.mjs
COPY apps/worker/cloud-run/postgres-migrations.mjs ./apps/worker/cloud-run/postgres-migrations.mjs
COPY apps/worker/cloud-run/postgres-runtime-grants.mjs ./apps/worker/cloud-run/postgres-runtime-grants.mjs
COPY apps/worker/scripts/gcp-test-database.mjs ./apps/worker/scripts/gcp-test-database.mjs
COPY apps/worker/postgres/migrations ./apps/worker/postgres/migrations
COPY apps/worker/gcp-test/source-content-digest.txt ./SOURCE_CONTENT_DIGEST

ENV NODE_ENV=production
ENV SOURCE_CONTENT_DIGEST_FILE=/app/SOURCE_CONTENT_DIGEST

ENTRYPOINT ["node", "/app/apps/worker/scripts/gcp-test-database.mjs"]
