# syntax=docker/dockerfile:1.7

# This exact arm64 child digest from the reviewed Node 26.2.0 Bookworm OCI
# index is the Apple-Silicon/Colima development lane. Native x86_64 evidence
# requires its own reviewed image pin; local QEMU execution is not evidence.
# Debian package indexes and the exact-version npm/Electron downloads below
# remain mutable online build inputs. This is a bounded development smoke
# environment, not a reproducible production artifact.
FROM node:26.2.0-bookworm-slim@sha256:445b8cda0ec3563106c5a62b4663b3831314ecc81d2645a774b308f203f25cf0

ARG TIBOTATTLE_QUALIFICATION_REVISION
LABEL org.opencontainers.image.revision="${TIBOTATTLE_QUALIFICATION_REVISION}"
ENV CI=1 \
    ELECTRON_DISABLE_SANDBOX=0 \
    TIBOTATTLE_IMAGE_SOURCE_REVISION="${TIBOTATTLE_QUALIFICATION_REVISION}" \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

RUN node --input-type=module --eval \
  'if (!/^[0-9a-f]{40}$/.test(process.env.TIBOTATTLE_IMAGE_SOURCE_REVISION ?? "")) process.exit(1)'

WORKDIR /workspace

# The Electron Linux runtime needs only a virtual display and its documented
# Debian shared-library surface. Xvfb listens on no TCP socket in the test
# command; the outer `docker run --network none` is the stronger boundary.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xauth \
    xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global corepack@0.34.0 \
  && corepack disable \
  && npm install --global pnpm@11.9.0 \
  && pnpm --version

# Copy lock/manifests first so the dependency layer is cacheable. The paired
# Dockerfile.dockerignore excludes the checkout's .git, node_modules, release
# output, reports, and unrelated applications from the build context.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node patches ./patches
RUN pnpm install --frozen-lockfile
# `allowBuilds` intentionally blocks Electron's package install hook in the
# repository. Fetch the exact locked Linux Electron artifact during the image
# build instead; the test phase then has no package-manager or network work.
RUN node node_modules/electron/install.js

COPY --chown=node:node apps/electron ./apps/electron
COPY --chown=node:node apps/local ./apps/local
COPY --chown=node:node apps/web/public ./apps/web/public
COPY --chown=node:node config ./config
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node generated ./generated
COPY --chown=node:node schemas ./schemas
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/smoke-electron-linux.mjs ./scripts/smoke-electron-linux.mjs
RUN chown -R node:node /workspace \
  && chown root:root /workspace/node_modules/electron/dist/chrome-sandbox \
  && chmod 4755 /workspace/node_modules/electron/dist/chrome-sandbox

USER node

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24 -nolisten tcp", "pnpm", "smoke:electron:linux"]
