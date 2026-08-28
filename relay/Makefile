.PHONY: build run clean test deps help

# Build the relay
build:
	@echo "Building promotion relay..."
	@go build -o promotion-relay .
	@echo "Build complete: ./promotion-relay"

# Run the relay
run:
	@echo "Starting relay..."
	@go run .

# Run with environment file
run-env:
	@echo "Starting relay with .env configuration..."
	@export $$(cat .env | xargs) && go run .

# Download dependencies
deps:
	@echo "Downloading dependencies..."
	@go mod download
	@echo "Dependencies downloaded"

# Tidy dependencies
tidy:
	@echo "Tidying dependencies..."
	@go mod tidy
	@echo "Dependencies tidied"

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -f promotion-relay
	@echo "Clean complete"

# Run tests
test:
	@echo "Running tests..."
	@go test -v ./...

# Format code
fmt:
	@echo "Formatting code..."
	@go fmt ./...

# Run linter
lint:
	@echo "Running linter..."
	@golangci-lint run

# Install the relay
install: build
	@echo "Installing relay to $$GOPATH/bin..."
	@cp promotion-relay $$GOPATH/bin/
	@echo "Installed: $$GOPATH/bin/promotion-relay"

# Show help
help:
	@echo "Nostr Promotion Relay - Makefile commands:"
	@echo ""
	@echo "  make build      - Build the relay binary"
	@echo "  make run        - Run the relay in development mode"
	@echo "  make run-env    - Run with .env configuration"
	@echo "  make deps       - Download dependencies"
	@echo "  make tidy       - Tidy dependencies"
	@echo "  make clean      - Remove build artifacts"
	@echo "  make test       - Run tests"
	@echo "  make fmt        - Format code"
	@echo "  make lint       - Run linter"
	@echo "  make install    - Install relay to GOPATH/bin"
	@echo "  make help       - Show this help message"
	@echo ""
