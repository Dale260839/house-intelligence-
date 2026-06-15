# House Intelligence API — zero-dependency Node service.
# No `npm install` needed: the project has no runtime dependencies.
FROM node:20-alpine

WORKDIR /app
COPY . .

# Hosts inject PORT; default to 3000 for local `docker run`.
ENV PORT=3000
EXPOSE 3000

# Lightweight liveness check against the /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
