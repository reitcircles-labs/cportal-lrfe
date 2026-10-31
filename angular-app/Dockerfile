# The web app: the Angular build, served by nginx, which also passes /api/... to the gateway
# (docker/nginx.conf). Built by deploy/scripts/build.sh; no settings are baked in.

# ---- build ----
# Node.js pinned to a patch version, so a rebuild cannot fall back to an unpatched one (API-812)
FROM node:22.23.4-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY src ./src
COPY public ./public
ENV NG_CLI_ANALYTICS=false
RUN npx ng build --configuration production

# ---- serve ----
# nginx as a non-root user, listening on 8080
FROM nginxinc/nginx-unprivileged:1.28.2-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
# writes /config.json from the site's settings on every start, before nginx starts (API-712)
COPY --chmod=0755 docker/site-config.sh /docker-entrypoint.d/40-lrfe-site-config.sh
COPY --from=build /app/dist/cportal-lrfe/browser /usr/share/nginx/html

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="lrfe-web" \
      org.opencontainers.image.description="Deeds registry portal: web app" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

EXPOSE 8080
