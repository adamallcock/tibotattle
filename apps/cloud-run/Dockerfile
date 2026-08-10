# Base image pinned to an immutable digest, not just the mutable version tag, so
# a moved or compromised upstream tag cannot substitute base-image bytes into an
# authorized rebuild. Update the digest only through a reviewed dependency bump.
# Digest for node:24.14.0-bookworm-slim resolved 2026-08-09 from Docker Hub.
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 8080
CMD ["node", "./src/server.js"]
