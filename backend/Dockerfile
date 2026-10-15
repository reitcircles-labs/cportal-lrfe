# One image for every backend service (npm workspaces); deploy/docker-compose.yml picks the
# service with `working_dir` + `command`. Configuration comes from the environment only: .env
# files are not copied into the image (see .dockerignore). Built by deploy/scripts/build.sh.
FROM node:22.22-slim

ENV NODE_ENV=production
WORKDIR /app

# Manifests first, so dependency installs are cached until a package.json changes
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY packages/storage/package.json packages/storage/
COPY services/gateway/package.json services/gateway/
COPY services/identity/package.json services/identity/
COPY services/edrms/package.json services/edrms/
COPY services/bpm/package.json services/bpm/
COPY services/intake/package.json services/intake/
COPY services/land-records/package.json services/land-records/
COPY services/audit/package.json services/audit/
RUN npm ci --omit=dev && npm cache clean --force

COPY packages ./packages
COPY services ./services
# the one-shot database setup the services wait for (deploy/docker-compose.yml: db-setup)
COPY scripts/db-setup.js ./scripts/
# the API docs (Swagger UI), the optional docs container (deploy/docker-compose.yml, profile docs)
COPY scripts/docs-server.js ./scripts/

# Local blob storage (EDRMS_STORAGE=local / INTAKE_STORAGE=local); compose mounts volumes here
RUN mkdir -p /data/edrms /data/intake && chown -R node:node /data
USER node

# The version the image was built from, so a site can see what it runs (docker image inspect)
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="lrfe-backend" \
      org.opencontainers.image.description="Deeds registry portal: backend services" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

CMD ["node", "--help"]
