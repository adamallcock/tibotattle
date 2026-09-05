# syntax=docker/dockerfile:1.7

# This exact amd64 child digest was selected from the reviewed Node 26.2.0
# Bookworm-slim OCI index on 2026-08-27. This lane must run natively on a
# GitHub-hosted x86_64 Linux runner; QEMU or cross-architecture execution is
# not qualification evidence. Debian indexes and the exact-version
# npm/Electron downloads below remain mutable online build inputs, so this is
# a bounded development smoke rather than a reproducible release artifact.
FROM node:26.2.0-bookworm-slim@sha256:ba2f9edd0785ee291c1a5287764cb41fdb7922336f878993f9d58622613e67a8

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
    curl \
    dbus-daemon \
    fonts-liberation \
    gnome-keyring \
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
    libsecret-1-0 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    unzip \
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
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY config/patches ./config/patches
RUN pnpm install --frozen-lockfile --ignore-scripts
# `allowBuilds` intentionally blocks Electron's package install hook in the
# repository. Fetch the exact locked Linux Electron artifact with a pinned
# checksum during the image build instead; the test phase then has no package-
# manager or network work. A direct archive fetch also avoids the asynchronous
# installer path, which aborts under local QEMU amd64 emulation.
RUN curl --fail --silent --show-error --location --retry 3 \
    --output /tmp/electron-v43.2.0-linux-x64.zip \
    https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-linux-x64.zip \
  && printf '%s  %s\n' \
    f77ca6ed67bbc68702b69b56ad499bca6ae090705ade7d04f0ac545e409dec68 \
    /tmp/electron-v43.2.0-linux-x64.zip \
    | sha256sum --check --strict \
  && unzip -q /tmp/electron-v43.2.0-linux-x64.zip -d /workspace/node_modules/electron/dist \
  && printf 'electron' > /workspace/node_modules/electron/path.txt \
  && rm -f /tmp/electron-v43.2.0-linux-x64.zip

COPY apps/electron ./apps/electron
COPY apps/local ./apps/local
COPY apps/web/public ./apps/web/public
COPY config ./config
COPY contracts ./contracts
COPY generated ./generated
COPY schemas ./schemas
COPY src ./src
COPY scripts/smoke-electron-linux.mjs ./scripts/smoke-electron-linux.mjs
COPY scripts/qualify-linux-secret-service.mjs ./scripts/qualify-linux-secret-service.mjs
COPY scripts/run-linux-secret-service-qualification.mjs ./scripts/run-linux-secret-service-qualification.mjs
# Docker build steps and unqualified COPY directives run as root, so the
# reviewed keytar closure is root-owned without an expensive recursive
# metadata rewrite over the pnpm store.
RUN install --directory --owner=root --group=root --mode=0755 /usr/local/share/tibotattle \
  && printf 'tibotattle-linux-secret-service-qualification-v1\n' > /usr/local/share/tibotattle/linux-secret-service-qualification-v1 \
  && chown root:root /usr/local/share/tibotattle/linux-secret-service-qualification-v1 \
  && chmod 0444 /usr/local/share/tibotattle/linux-secret-service-qualification-v1 \
  && chown root:root /workspace/node_modules/electron/dist/chrome-sandbox \
  && chmod 4755 /workspace/node_modules/electron/dist/chrome-sandbox

USER node

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24 -nolisten tcp", "pnpm", "smoke:electron:linux"]
