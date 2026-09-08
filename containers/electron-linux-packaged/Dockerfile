# syntax=docker/dockerfile:1.7

# Built locally in this same job by build-electron-linux-container.mjs, which
# checks the embedded source revision. This is never a registry image lookup.
FROM tibotattle-electron-linux-amd64:test

ARG TIBOTATTLE_QUALIFICATION_REVISION
USER root
WORKDIR /workspace
RUN node --input-type=module --eval \
  'if (!/^[0-9a-f]{40}$/.test(process.argv[1] ?? "") || process.argv[1] !== process.env.TIBOTATTLE_IMAGE_SOURCE_REVISION) process.exit(1)' \
  "${TIBOTATTLE_QUALIFICATION_REVISION}"

# The runner and its independent verifier use the same checked-out source as
# the base image. Only the selected generated app and staging closure enter
# this image; installer payloads, private profiles and signing files do not.
COPY scripts ./scripts
COPY .release-build/electron-dev/linux-x64/app ./.release-build/electron-dev/linux-x64/app
# These exact native tests run in separate fresh disposable containers against
# a copy of the staged native bytes. Keep test files outside the app inventory.
COPY test/linux-credential-mutex-native.test.js ./test/linux-credential-mutex-native.test.js
COPY test/linux-account-observation-credential-native.test.js ./test/linux-account-observation-credential-native.test.js
COPY .release-build/electron-dev/linux-x64/app/native/linux-credential-mutex/build/qualification ./native/linux-credential-mutex/build/qualification
COPY .release-build/electron-candidates/${TIBOTATTLE_QUALIFICATION_REVISION}/linux-x64/distribution/linux-unpacked ./.release-build/electron-candidates/${TIBOTATTLE_QUALIFICATION_REVISION}/linux-x64/distribution/linux-unpacked
COPY .release-build/electron-candidates/${TIBOTATTLE_QUALIFICATION_REVISION}/linux-x64/distribution/development-package.json ./.release-build/electron-candidates/${TIBOTATTLE_QUALIFICATION_REVISION}/linux-x64/distribution/development-package.json

# Preserve byte identity and executable intent while allowing USER node to
# traverse the normally private generated directories. Native provenance
# requires these copied artifact paths to remain root-owned and immutable.
RUN find /workspace/native/linux-credential-mutex -type d -exec chmod 0755 {} + \
  && find /workspace/native/linux-credential-mutex -type f -exec chmod 0444 {} + \
  && find /workspace/.release-build -type d -exec chmod 0755 {} + \
  && find /workspace/.release-build -type f -perm /111 -exec chmod 0555 {} + \
  && find /workspace/.release-build -type f ! -perm /111 -exec chmod 0444 {} +

USER node
ENTRYPOINT ["node", "/workspace/scripts/smoke-electron-linux-secret-service.mjs"]
