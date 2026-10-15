# No package installation or application source enters the extraction image.
# Same reviewed native amd64 base as the Linux qualification environment.
FROM node:26.2.0-bookworm-slim@sha256:ba2f9edd0785ee291c1a5287764cb41fdb7922336f878993f9d58622613e67a8
ARG TIBOTATTLE_QUALIFICATION_REVISION
LABEL org.opencontainers.image.revision="${TIBOTATTLE_QUALIFICATION_REVISION}"
COPY containers/electron-linux-extraction/extract.mjs /extract.mjs
ENTRYPOINT ["/usr/local/bin/node", "/extract.mjs"]
