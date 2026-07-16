FROM node:22-alpine

WORKDIR /app

# Runtime port the Express server listens on.
# Dokploy injects its own PORT env at run time; EXPOSE is purely informational
# and defaults to 3000 (the app's own default). Override with `--build-arg` or
# by setting PORT in the container environment.
ARG PORT=3000
ENV PORT=${PORT}
EXPOSE ${PORT}

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

USER appuser

# Healthcheck honors the runtime PORT so Dokploy can probe the real listener.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider "http://localhost:${PORT}/api/" || exit 1

CMD ["npm", "start"]
