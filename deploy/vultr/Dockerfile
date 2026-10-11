# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS web-source
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY shared /app/shared
COPY web /app/web

FROM web-source AS frontend
RUN npm run build

FROM web-source AS export-player
RUN npm run build:export

FROM web-source AS starter
# Generated dist files are git-ignored; clean checkouts must build their own seeds.
RUN npm run starter:build

FROM python:3.12-slim-bookworm AS api
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=web-source /usr/local/bin/node /usr/local/bin/node
WORKDIR /app/vision
COPY vision /app/vision
COPY --from=starter /app/shared /app/shared
# Source and built export player preserve the app's existing export feature.
COPY --from=export-player /app/web /app/web
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN uv sync --locked --no-dev \
    && useradd --create-home --uid 10001 drawplay \
    && mkdir /data && chown drawplay:drawplay /data /app/web/dist-export
ENV PATH="/app/vision/.venv/bin:$PATH" DAL_DATA_DIR=/data DAL_NODE=/usr/local/bin/node PYTHONUNBUFFERED=1
ARG DEPLOY_BRANCH=unknown
ARG DEPLOY_REVISION=unknown
LABEL org.opencontainers.image.ref.name=$DEPLOY_BRANCH org.opencontainers.image.revision=$DEPLOY_REVISION
USER drawplay
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log"]

FROM node:24-bookworm-slim AS messaging
WORKDIR /app/messaging
COPY messaging/package.json messaging/package-lock.json ./
RUN npm ci --omit=dev
COPY messaging/src ./src
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production DAL_SPECTRUM_DATA_DIR=/data
ARG DEPLOY_BRANCH=unknown
ARG DEPLOY_REVISION=unknown
LABEL org.opencontainers.image.ref.name=$DEPLOY_BRANCH org.opencontainers.image.revision=$DEPLOY_REVISION
USER node
CMD ["node", "src/index.ts"]

FROM caddy:2-alpine AS web
COPY --from=frontend /app/web/dist /srv
COPY deploy/vultr/Caddyfile /etc/caddy/Caddyfile
ARG DEPLOY_BRANCH=unknown
ARG DEPLOY_REVISION=unknown
LABEL org.opencontainers.image.ref.name=$DEPLOY_BRANCH org.opencontainers.image.revision=$DEPLOY_REVISION
