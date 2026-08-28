# Quick Start Guide

Get your Nostr promotion relay running in 5 minutes.

## Prerequisites

- Go 1.22+ installed
- Basic understanding of Nostr protocol
- (Optional) Lightning node for production

## Installation

### 1. Clone and Setup

```bash
cd relay.holoboard.space
go mod download
```

### 2. Run the Relay

```bash
# Simple run (generates new keypair)
go run .

# Or use make
make run
```

You'll see output like:

```
2024/01/01 12:00:00 Starting Nostr Promotion Relay
2024/01/01 12:00:00 Generated new relay private key: abc123...
2024/01/01 12:00:00 IMPORTANT: Set RELAY_PRIVKEY environment variable to persist this key
2024/01/01 12:00:00 Relay pubkey: def456...
2024/01/01 12:00:00 Storage initialized: 0 promoted posts loaded
2024/01/01 12:00:00 Payment watcher started
2024/01/01 12:00:00 Relay configured: Nostr Promotion Board
2024/01/01 12:00:00 Starting relay on port 3334
2024/01/01 12:00:00 WebSocket URL: ws://localhost:3334
2024/01/01 12:00:00
2024/01/01 12:00:00 To promote a post, send a zap to pubkey: def456...
```

**Important**: Save the `RELAY_PRIVKEY` value to persist your relay's identity!

### 3. Set Relay Private Key (Optional but Recommended)

```bash
# Create .env file
cp .env.example .env

# Edit .env and add your private key
echo "RELAY_PRIVKEY=your_private_key_here" > .env

# Run with environment
source .env
go run .
```

## Testing the Relay

### Connect with a Nostr Client

1. Open your favorite Nostr client (e.g., Damus, Amethyst, Nostter)
2. Add relay: `ws://localhost:3334`
3. Query for posts

You should see at least one info post explaining how to use the relay.

### Promote a Post (Manual Testing)

Since we're using the mock Lightning backend, here's how to simulate the flow:

#### Test Flow 1: Simulate a Zap

The simplest way is to:

1. Create a kind:1 post somewhere
2. Note its event ID
3. Manually add it to storage by sending a zap event

**Using `websocat` or similar WebSocket client:**

```bash
# Install websocat if needed: cargo install websocat

# Connect to relay
websocat ws://localhost:3334

# Send a test event (you'll need to properly sign this)
# This is just a structure example
["EVENT", {
  "id": "abc123...",
  "pubkey": "your_pubkey",
  "created_at": 1234567890,
  "kind": 9735,
  "tags": [
    ["p", "relay_pubkey"],
    ["bolt11", "lnbc1000..."],
    ["description", "{\"kind\":9734,\"tags\":[[\"e\",\"post_id\"]]}"]
  ],
  "content": "",
  "sig": "..."
}]
```

#### Test Flow 2: Use Go Test Code

Create a test file to programmatically add posts:

```go
// test_promote.go
package main

import (
    "context"
    "github.com/nbd-wtf/go-nostr"
)

func main() {
    // Create storage
    storage, _ := NewStorage("relay_data.json")

    // Create a test event
    event := &nostr.Event{
        ID:        "test123abc...",
        PubKey:    "author_pubkey",
        CreatedAt: nostr.Now(),
        Kind:      1,
        Tags:      nostr.Tags{},
        Content:   "This is a test promoted post!",
    }

    // Add with payment
    storage.AddPayment(event.ID, 1000, event)

    println("Post promoted with 1000 sats!")
}
```

### Query Posts

Using `websocat`:

```bash
websocat ws://localhost:3334

# Send REQ
["REQ", "test", {"kinds": [1], "limit": 10}]

# You'll receive events back
["EVENT", "test", {...}]
["EOSE", "test"]
```

## Production Deployment

### 1. Configure Lightning Backend

Edit [main.go](main.go#L42):

```go
// Replace MockLightningBackend with LNDBackend
lnBackend := NewLNDBackend(
    "localhost:10009",
    "/path/to/tls.cert",
    "/path/to/admin.macaroon",
)
```

### 2. Set Environment Variables

```bash
export RELAY_PRIVKEY="your_relay_private_key"
export LND_ADDRESS="localhost:10009"
export LND_TLS_CERT="/path/to/tls.cert"
export LND_MACAROON="/path/to/admin.macaroon"
```

### 3. Build and Run

```bash
# Build production binary
make build

# Run
./promotion-relay
```

### 4. Configure Reverse Proxy

Use nginx or caddy for TLS and domain:

**Nginx example:**

```nginx
server {
    listen 443 ssl;
    server_name relay.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3334;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

**Caddy example:**

```
relay.yourdomain.com {
    reverse_proxy localhost:3334
}
```

### 5. Run as Service

**Systemd unit file** (`/etc/systemd/system/promotion-relay.service`):

```ini
[Unit]
Description=Nostr Promotion Relay
After=network.target

[Service]
Type=simple
User=nostr
WorkingDirectory=/home/nostr/promotion-relay
Environment="RELAY_PRIVKEY=your_key_here"
ExecStart=/home/nostr/promotion-relay/promotion-relay
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable promotion-relay
sudo systemctl start promotion-relay
sudo systemctl status promotion-relay
```

## Usage Examples

### For Relay Operators

#### Monitor the relay

```bash
# Check logs
tail -f /var/log/promotion-relay.log

# Check storage
cat relay_data.json | jq '.posts | length'

# Check stats
curl http://localhost:3334 | jq .
```

#### Backup data

```bash
# Backup storage
cp relay_data.json relay_data.backup.json

# Restore
cp relay_data.backup.json relay_data.json
```

### For Users (Promoting Posts)

#### Method 1: Using a Zap-Enabled Wallet

1. Find a post you want to promote
2. Copy its note ID (event ID)
3. Send a zap to the relay's pubkey
4. In your wallet, add an 'e' tag with the note ID
5. Send the payment

**Note**: Not all wallets support custom zap tags yet.

#### Method 2: Via PROMOTE Command

1. Send a DM to the relay's pubkey
2. Content: `PROMOTE <note_id>`
3. Wait for invoice reply
4. Pay the invoice
5. Post is promoted!

### For Developers (Integrating)

#### Add the relay to your app

```javascript
// JavaScript example
const relay = new Relay("wss://relay.yourdomain.com");
await relay.connect();

// Query top promoted posts
const posts = await relay.list([{
  kinds: [1],
  limit: 20
}]);

console.log("Top promoted posts:", posts);
```

#### Build a promotion UI

```javascript
// Promote a post via zap
async function promotePost(noteId, amountSats) {
  const zapRequest = {
    kind: 9734,
    tags: [
      ["p", RELAY_PUBKEY],
      ["e", noteId],
      ["amount", String(amountSats * 1000)],
      ["relays", "wss://relay.yourdomain.com"]
    ],
    content: `Promoting ${noteId}`
  };

  // Sign and send to Lightning wallet
  // ...
}
```

## Troubleshooting

### Relay won't start

- **Check port**: Make sure port 3334 isn't in use
- **Check logs**: Look for error messages
- **Check permissions**: Ensure write access to data file

### Posts not appearing

- **Verify payment**: Check if zap was actually sent
- **Check post ID**: Make sure event ID is correct
- **Check logs**: Look for fetch errors

### Zaps not processing

- **Validate zap format**: Must have all required tags
- **Check recipient**: Must be relay's pubkey
- **Check amount**: Must be > 0 sats
- **Check description**: Must contain valid zap request

### Can't fetch posts

- **Check relays**: Make sure fetch relays are accessible
- **Network issues**: Verify internet connection
- **Post exists**: Verify the post is actually published

## Next Steps

1. **Read the full [README.md](README.md)** for detailed documentation
2. **Study the [DESIGN.md](DESIGN.md)** to understand the architecture
3. **Customize** the relay for your use case
4. **Deploy** to production with real Lightning
5. **Share** your relay URL with the community!

## Getting Help

- Check the logs: most errors are logged with context
- Review the design doc: understand how it should work
- Test with mock backend: isolate Lightning issues
- Open an issue: if you find bugs
- Read the code: it's well-commented!

## Quick Reference

### Important Files

- `main.go` - Entry point and configuration
- `relay.go` - Khatru setup and event handlers
- `payment.go` - Zap processing and validation
- `storage.go` - Data persistence
- `lightning.go` - Invoice generation

### Environment Variables

- `RELAY_PRIVKEY` - Your relay's private key (required for persistence)
- `PORT` - WebSocket port (default: 3334)
- `DEFAULT_PAYMENT_SATS` - Default invoice amount (default: 1000)

### Useful Commands

```bash
make build        # Build binary
make run          # Run development
make clean        # Clean build artifacts
make test         # Run tests
make help         # Show all commands
```

### Default Configuration

- Port: `3334`
- Storage: `relay_data.json`
- Default payment: `1000 sats`
- Fetch relays: Damus, nos.lol, relay.nostr.band, nostr.wine

---

**You're ready to go! Start the relay and begin promoting Nostr content!** 🚀
