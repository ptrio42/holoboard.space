# Nostr Promotion Board Relay

A custom Nostr relay built with [khatru](https://github.com/fiatjaf/khatru) that implements a paid promotion board for Nostr posts. Posts are ranked and served based on the total sats paid for their promotion.

## Features

- **Kind:1 Events Only**: Only accepts and stores text notes (kind:1 events)
- **Pay-to-Promote**: Posts must be paid for to be stored and served
- **Flexible Payment**: Support for both zap-based and invoice-based promotion
- **Ranked Feed**: Posts sorted by total sats paid, last payment timestamp, and creation time
- **Open Promotion**: Anyone can promote any post, not just the author
- **Persistent Storage**: JSON-based storage with automatic saves

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Nostr Relay                      │
│                                                  │
│  ┌────────────┐      ┌──────────────────┐      │
│  │   Khatru   │◄────►│  Event Handler   │      │
│  │   Server   │      │  - Accept kind:1 │      │
│  └────────────┘      │  - Check if paid │      │
│                      └──────────────────┘      │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────┐   │
│  │ Payment Monitor  │  │  Storage Layer   │   │
│  │ - Watch zaps     │◄►│  - Posts DB      │   │
│  │ - Verify payment │  │  - Payment info  │   │
│  │ - Fetch posts    │  └──────────────────┘   │
│  └──────────────────┘                          │
│                                                  │
│  ┌──────────────────┐                          │
│  │ PROMOTE Handler  │                          │
│  │ - Parse requests │                          │
│  │ - Generate invoice│                         │
│  └──────────────────┘                          │
└─────────────────────────────────────────────────┘
```

## How It Works

### Payment Flow 1: Zap (NIP-57)

1. User wants to promote a post with ID `abc123...`
2. User sends a zap to the relay's pubkey with:
   - `e` tag containing the post ID
   - Amount in sats (must be > 0)
3. Relay receives the zap receipt (kind:9735)
4. Relay validates the zap and extracts payment amount
5. If post exists locally: update total sats
6. If post doesn't exist: fetch from other relays, then store
7. Post is now promoted and visible in queries

**Example zap request (kind:9734):**
```json
{
  "kind": 9734,
  "tags": [
    ["p", "<relay_pubkey>"],
    ["e", "<post_id_to_promote>"],
    ["amount", "1000000"],
    ["relays", "wss://relay.example.com"]
  ],
  "content": "Promoting this awesome post!"
}
```

### Payment Flow 2: PROMOTE Command

1. User sends a DM (kind:4) to the relay's pubkey with content:
   ```
   PROMOTE <post_id>
   ```
2. Relay parses the command and validates the post ID
3. Relay generates a Lightning invoice
4. Relay replies with a DM containing the invoice
5. User pays the invoice
6. Relay detects payment and promotes the post

### Query Behavior

When clients query the relay (REQ):
- Only promoted (paid) posts are returned
- Posts are sorted by:
  1. `total_sats_paid` (descending)
  2. `last_payment_timestamp` (descending)
  3. `created_at` (descending)

**Example REQ:**
```json
["REQ", "sub_id", {"kinds": [1], "limit": 50}]
```

This returns the top 50 most promoted posts.

## Installation

### Prerequisites

- Go 1.22 or higher
- (Optional) Lightning node (LND/CLN) for production use

### Build

```bash
# Clone the repository
git clone <repo_url>
cd relay.holoboard.space

# Download dependencies
go mod download

# Build
go build -o promotion-relay .
```

## Configuration

### Environment Variables

- `RELAY_PRIVKEY`: Private key for the relay (hex format)
  - If not set, a new key will be generated (logged to stdout)
  - **Important**: Save this key to persist relay identity

### Default Settings

Located in [main.go](main.go):

```go
const (
    dataFile           = "relay_data.json"  // Storage file
    port               = "3334"              // WebSocket port
    defaultPaymentSats = 1000               // Default invoice amount
)

// Relays to fetch posts from
fetchRelays := []string{
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
    "wss://nostr.wine",
}
```

## Running the Relay

### Development (Mock Lightning)

```bash
# Run with mock Lightning backend
go run .
```

The relay will:
- Start on `ws://localhost:3334`
- Generate a new keypair (or use `RELAY_PRIVKEY`)
- Load existing promoted posts from `relay_data.json`
- Print the relay's pubkey for receiving zaps

### Production Deployment

Deploy to Fly.io:

**Quick Start:**
```bash
./deploy.sh
```

**Guides:**
- [FLY_QUICKSTART.md](FLY_QUICKSTART.md) - 5-minute quick start guide
- [DEPLOYMENT.md](DEPLOYMENT.md) - Complete deployment documentation

### Production (Real Lightning)

Choose your Lightning backend by setting the `LIGHTNING_BACKEND` environment variable:

#### Option 1: LNbits (Recommended for Quick Start)

LNbits is a free, open-source Lightning wallet that requires no KYC:

1. Create a wallet at [legend.lnbits.com](https://legend.lnbits.com) or host your own instance
2. Get your API keys from the wallet's API Info section
3. Configure your .env file:

```bash
LIGHTNING_BACKEND=lnbits
LNBITS_API_KEY=your_invoice_key_here
LNBITS_READ_KEY=your_read_key_here
LNBITS_BASE_URL=https://legend.lnbits.com  # Optional, defaults to legend.lnbits.com
```

#### Option 2: Zebedee

For developers wanting a managed solution:

```bash
LIGHTNING_BACKEND=zebedee
ZEBEDEE_API_KEY=your_zebedee_api_key_here
```

#### Option 3: LND (Self-Hosted Node)

For production use with your own Lightning node:

1. Set up LND with proper TLS and macaroon configuration
2. Configure connection parameters in .env
3. See commented example in [lightning.go](lightning.go)

## Usage Examples

### Promoting a Post via Zap

Using a NIP-57 compatible wallet:

1. Find the post ID you want to promote
2. Send a zap to the relay's pubkey
3. In the zap, include an `e` tag with the post ID
4. The post will be promoted after payment

### Promoting via PROMOTE Command

```bash
# Using nostr CLI or any Nostr client
# Send DM to relay pubkey:
PROMOTE abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab

# Relay responds with Lightning invoice
# Pay the invoice
# Post is promoted
```

### Querying Promoted Posts

Using any Nostr client, connect to the relay and query:

```json
["REQ", "promoted_feed", {
  "kinds": [1],
  "limit": 20
}]
```

You'll receive the top 20 promoted posts in order of payment ranking.

## Data Storage

All data is stored in `relay_data.json`:

```json
{
  "posts": {
    "<post_id>": {
      "post_id": "...",
      "event": { ... },
      "total_sats_paid": 5000,
      "last_payment_timestamp": "2024-01-01T12:00:00Z"
    }
  },
  "pending_invoices": {
    "<payment_hash>": {
      "post_id": "...",
      "invoice": "lnbc...",
      "payment_hash": "...",
      "amount_sats": 1000,
      "created_at": "2024-01-01T12:00:00Z"
    }
  }
}
```

## File Structure

- [main.go](main.go) - Entry point, relay initialization
- [relay.go](relay.go) - Khatru relay configuration and handlers
- [storage.go](storage.go) - Data structures and persistence layer
- [payment.go](payment.go) - Zap processing and post fetching
- [lightning.go](lightning.go) - Lightning backend interface and mock

## Protocol Implementation

### Supported NIPs

- **NIP-01**: Basic protocol flow
- **NIP-09**: Event deletion (rejected for promoted posts)
- **NIP-11**: Relay information document
- **NIP-57**: Lightning Zaps

### Custom Behavior

1. **Event Acceptance**:
   - Only kind:1 events accepted
   - Events must be pre-paid before submission
   - Use `RejectEvent` hook to enforce

2. **Query Filtering**:
   - Custom sort order (sats → timestamp → age)
   - Only paid posts returned
   - Standard Nostr filters apply

3. **Zap Validation**:
   - Must have `p` tag (recipient)
   - Must have `bolt11` tag (invoice)
   - Must have `description` tag (zap request)
   - Zap request must have `e` tag (post ID)
   - Amount must be > 0

## Edge Cases Handled

1. **Unknown Post ID in Zap**: Relay fetches from network relays
2. **Invalid Zap**: Logged and ignored
3. **Zero-Amount Payment**: Ignored
4. **Missing Post**: Error returned, payment not accepted
5. **Duplicate Payment**: Adds to total sats for post

## Development

### Testing

```bash
# Run tests (when implemented)
go test -v ./...
```

### Adding Features

Common extensions:

1. **Expiration**: Add time-based post expiration
2. **Categories**: Add tag-based categorization
3. **Refunds**: Implement refund mechanism for removed posts
4. **Analytics**: Track promotion statistics
5. **Admin Panel**: Web UI for relay management

## Security Considerations

1. **Zap Validation**: Always verify zap receipts against bolt11 invoice
2. **Post Validation**: Verify post signatures before storage
3. **Rate Limiting**: Add rate limits for PROMOTE requests
4. **Invoice Expiration**: Clean up expired pending invoices
5. **Storage Limits**: Implement maximum storage limits
6. **Private Key**: Keep `RELAY_PRIVKEY` secure (use env vars, not config files)

## License

MIT

## Contributing

Contributions welcome! Areas for improvement:

- Real Lightning backend integration (LND/CLN)
- Encrypted DM handling for PROMOTE flow
- Web dashboard for relay statistics
- Advanced filtering and sorting options
- Post expiration and cleanup
- Rate limiting and spam protection

## Resources

- [Khatru Documentation](https://github.com/fiatjaf/khatru)
- [Nostr NIPs](https://github.com/nostr-protocol/nips)
- [NIP-57 (Zaps)](https://github.com/nostr-protocol/nips/blob/master/57.md)
- [go-nostr Library](https://github.com/nbd-wtf/go-nostr)
