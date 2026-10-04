# syntax=docker/dockerfile:1.7
# This same-job base is built from the existing digest-pinned native amd64 lane.
# Only the two admitted AppImages run; this image never builds application bytes.
FROM tibotattle-electron-linux-amd64:test
ARG TIBOTATTLE_QUALIFICATION_REVISION
USER root
RUN node --input-type=module --eval \
  'if (!/^[0-9a-f]{40}$/.test(process.argv[1] ?? "") || process.argv[1] !== process.env.TIBOTATTLE_IMAGE_SOURCE_REVISION) process.exit(1)' \
  "${TIBOTATTLE_QUALIFICATION_REVISION}"
RUN apt-get update \
  && apt-get install --yes --no-install-recommends libfuse2 fuse openssl libnss3-tools procps \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY scripts ./scripts
COPY .release-build/linux-final-qualification/pair.json ./.release-build/linux-final-qualification/pair.json
COPY .release-build/linux-final-qualification/current.AppImage ./.release-build/linux-final-qualification/current.AppImage
COPY .release-build/linux-final-qualification/next.AppImage ./.release-build/linux-final-qualification/next.AppImage
COPY test/fixtures/linux-packaged-codex/codex /opt/tibotattle-linux-packaged-smoke/bin/codex
RUN chmod 0755 /workspace/.release-build /workspace/.release-build/linux-final-qualification \
  && chmod 0444 /workspace/.release-build/linux-final-qualification/* \
  && chmod 0555 /opt/tibotattle-linux-packaged-smoke/bin/codex
USER node
ENTRYPOINT ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24 -nolisten tcp", "dbus-run-session", "--"]
CMD ["node", "scripts/smoke-electron-linux-final-lifecycle.mjs"]
