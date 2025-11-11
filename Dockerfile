# syntax=docker/dockerfile:1
# Multi-stage build for Hooky server running under Deno
FROM denoland/deno:alpine-1.43.6 AS base

WORKDIR /app
# Copy only manifests first for better layer caching
COPY deno.json deno.lock ./
# Cache vendor deps (optional - can be skipped if import map only)
# Deno will download modules at build

# Copy source
COPY . .

# Expose default port
EXPOSE 3000

# Environment (override at runtime as needed)
ENV PORT=3000
# Optionally set REDIS_URL externally for persistence

# Run the server (index spins up Express)
CMD ["deno", "run", "-A", "server/index.ts"]
