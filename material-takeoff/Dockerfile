# Material Takeoff API — zero-dependency Node service (sibling to House Intelligence).
# No `npm install` needed: the project has no runtime dependencies.
FROM node:20-alpine

WORKDIR /app
COPY . .

# Hosts inject PORT; default to 3100 for local `docker run` (House Intelligence uses 3000).
ENV PORT=3100
EXPOSE 3100

# Lightweight liveness check against the /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
