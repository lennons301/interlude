FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# --- Build ---
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=2048"
RUN pnpm build
# Flatten pnpm symlinks for native addon deps so they can be copied to the run stage
RUN mkdir -p /native-deps/node_modules && \
    cp -rL node_modules/better-sqlite3 /native-deps/node_modules/better-sqlite3 && \
    cp -rL node_modules/.pnpm/better-sqlite3@*/node_modules/bindings /native-deps/node_modules/bindings && \
    cp -rL node_modules/.pnpm/bindings@*/node_modules/file-uri-to-path /native-deps/node_modules/file-uri-to-path

# --- Run ---
FROM base AS run
WORKDIR /app
ENV NODE_ENV=production

# Copy standalone output
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Copy native addon and its resolved dependencies
COPY --from=build /native-deps/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /native-deps/node_modules/bindings ./node_modules/bindings
COPY --from=build /native-deps/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

# Copy files needed at runtime beyond Next.js standalone
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/Dockerfile.agent ./Dockerfile.agent
COPY --from=build /app/custom-server.js ./custom-server.js

# Install the Doppler CLI so the app boots via `doppler run`, pulling orchestrator
# secrets from the Doppler `interlude/prd` config at runtime. DOPPLER_TOKEN (a prd
# service token) is supplied by the container environment (compose env_file). This
# keeps orchestrator secrets in Doppler rather than a plaintext VPS .env.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg && \
    curl -sLf --retry 3 --tlsv1.2 --proto "=https" https://cli.doppler.com/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
CMD ["doppler", "run", "--project", "interlude", "--config", "prd", "--", "node", "custom-server.js"]
