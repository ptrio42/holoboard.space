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

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o relay .

# Runtime stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy the binary from builder
COPY --from=builder /app/relay .

# Create data directory for persistent storage
RUN mkdir -p /root/data && chmod 755 /root/data

# Expose the port
EXPOSE 8080

# Run the relay
CMD ["./relay"]
