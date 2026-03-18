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

EXPOSE 3000
CMD ["node", "custom-server.js"]
