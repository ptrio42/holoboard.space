# Build stage
FROM golang:1.23-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates

WORKDIR /app

# The in-tree copy of khatru has to be in place before `go mod download`,
# because go.mod replaces the dependency with this directory. See
# third_party/khatru/WHY.md.
COPY third_party/ ./third_party/

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY *.go ./
COPY cmd/keygen/ ./cmd/keygen/

# Build the application
RUN CGO_ENABLED=0 go build -trimpath -o /app/relay . \
    && CGO_ENABLED=0 go build -trimpath -o /app/keygen ./cmd/keygen

# Runtime stage
FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS runtime

RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /app/relay /app/keygen ./

# Create data directory for persistent storage
RUN addgroup -S -g 10001 relay \
    && adduser -S -D -H -u 10001 -G relay relay \
    && mkdir -p /data /root/data \
    && chown relay:relay /data

ENV PORT=8080 DATA_FILE=/data/relay_data.json

# Expose the port
EXPOSE 8080

# Run the relay
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/board" || exit 1

CMD ["/app/relay"]

# Compose uses this target with a volume owned by the relay user.
FROM runtime AS standalone
USER relay

# Keep the existing Fly volume path and permissions compatible. Fly builds
# the last stage by default; its existing volume contains root-owned data.
FROM runtime AS fly
WORKDIR /root
ENV DATA_FILE=/root/data/relay_data.json
