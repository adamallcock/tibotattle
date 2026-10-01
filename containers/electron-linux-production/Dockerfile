# syntax=docker/dockerfile:1.7

# Built by the existing pinned amd64 base builder in this same job. No registry
# lookup or replacement application build occurs in this image layer.
FROM tibotattle-electron-linux-amd64:test
ARG TIBOTATTLE_QUALIFICATION_REVISION
USER root
WORKDIR /workspace
RUN node --input-type=module --eval \
  'if (!/^[0-9a-f]{40}$/.test(process.argv[1] ?? "") || process.argv[1] !== process.env.TIBOTATTLE_IMAGE_SOURCE_REVISION) process.exit(1)' \
  "${TIBOTATTLE_QUALIFICATION_REVISION}"

COPY scripts ./scripts
COPY .release-build/electron-production/linux-x64/app ./.release-build/electron-production/linux-x64/app
COPY .release-build/electron-production/linux-x64/production-source-candidate.json ./.release-build/electron-production/linux-x64/production-source-candidate.json
# This tree was extracted from the hash-verified final AppImage, not rebuilt.
COPY .release-build/electron-production/linux-x64/final-runtime/extracted/squashfs-root ./.release-build/electron-production/linux-x64/final-runtime/extracted/squashfs-root
COPY test/fixtures/linux-packaged-codex/codex /opt/tibotattle-linux-packaged-smoke/bin/codex

# Preserve payload bytes while making the copied test application traversable
# by the disposable user; retain the existing Electron sandbox arrangement.
RUN find /workspace/.release-build -type d -exec chmod 0755 {} + \
  && find /workspace/.release-build -type f -perm /111 -exec chmod 0555 {} + \
  && find /workspace/.release-build -type f ! -perm /111 -exec chmod 0444 {} + \
  && chmod 0555 /opt/tibotattle-linux-packaged-smoke/bin/codex \
  && chown root:root /workspace/.release-build/electron-production/linux-x64/final-runtime/extracted/squashfs-root/chrome-sandbox \
  && chmod 4755 /workspace/.release-build/electron-production/linux-x64/final-runtime/extracted/squashfs-root/chrome-sandbox
USER node
ENTRYPOINT ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24 -nolisten tcp"]
