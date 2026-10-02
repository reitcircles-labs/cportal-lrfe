# One image for every backend service (npm workspaces); docker-compose.yml picks the service
# with `working_dir` + `command`. Configuration comes from the environment only: .env files are
# not copied into the image (see .dockerignore).
FROM node:22-slim

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
RUN npm ci --omit=dev && npm cache clean --force

COPY packages ./packages
COPY services ./services

# Local blob storage (EDRMS_STORAGE=local / INTAKE_STORAGE=local); compose mounts volumes here
RUN mkdir -p /data/edrms /data/intake && chown -R node:node /data
USER node

CMD ["node", "--help"]
