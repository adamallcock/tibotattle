FROM node:26.2.0-bookworm-slim@sha256:e89172f5e6154ba212269866bf3fbadbca8eb7901e10c0eccf08f2147bfae505

ENV CI=1
WORKDIR /workspace

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global corepack@0.34.0 \
  && corepack enable \
  && corepack prepare pnpm@11.9.0 --activate

COPY . .
RUN git init --quiet \
  && git config user.name "TiboTattle portable test" \
  && git config user.email "portable-test@invalid.example" \
  && git add --all \
  && git commit --quiet --message "Portable container baseline"
RUN pnpm install --frozen-lockfile

CMD ["pnpm", "test:portable"]
