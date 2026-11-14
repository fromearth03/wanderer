# Build stage: compile the Vite app
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY . .
RUN npm run build

# Serve stage: Caddy serves the static app and proxies /api and /ws to the gateway.
# With SITE_ADDRESS set to a hostname it also obtains HTTPS certificates itself.
FROM caddy:2.8-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
ENV SITE_ADDRESS=:80
EXPOSE 80 443
HEALTHCHECK --interval=30s --timeout=3s CMD pgrep caddy >/dev/null || exit 1
