# Build a static gateway binary, then ship it on a tiny image.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/gateway .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata wget && adduser -D -u 10001 app && mkdir -p /data/cache && chown app /data/cache
COPY --from=build /out/gateway /usr/local/bin/gateway
USER app
ENV PORT=8080 CACHE_DIR=/data/cache SCIENCE_URL=http://science:8091
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/gateway"]
