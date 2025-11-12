# Multi-stage build for Hooky server running under Deno
FROM denoland/deno:alpine-2.5.6 AS base

WORKDIR /app
# Copy only manifests first for better layer caching
COPY deno.json deno.lock ./
# Pre-cache dependencies for faster startup
RUN deno cache server/index.ts || true
# Cache vendor deps (optional - can be skipped if import map only)
# Deno will download modules at build

# Copy source
COPY . .

# Expose default port
EXPOSE 3000

# Environment (override at runtime as needed)
ENV PORT=3000
ENV DENO_NODE_MODULES_DIR=true
# Optionally set REDIS_URL externally for persistence

# Run the server (index spins up Express)
CMD ["deno", "run", "-A", "--node-modules-dir", "server/index.ts"]

