# Nostr Promotion Board - Design Document

## Overview

This document describes the design and implementation of a custom Nostr relay that operates as a paid promotion board. The relay only stores and serves posts (kind:1 events) that have received payment, with the feed ranked by the total amount of sats paid for each post.

## Design Goals

1. **Pay-to-Promote**: Only paid posts are stored and served
2. **Transparent Ranking**: Posts ranked purely by economic support (total sats)
3. **Open Participation**: Anyone can promote any post, not just authors
4. **Protocol Compliance**: Full Nostr protocol compliance (NIPs 1, 9, 11, 57)
5. **Simple Operations**: Minimal configuration and dependencies

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Layer                          │
│  (Nostr clients, wallets, Lightning nodes)                  │
└────────────────┬────────────────────────────┬────────────────┘
                 │                            │
                 │ WebSocket (NIP-01)         │ Lightning
                 │                            │
┌────────────────▼───────────────┐  ┌─────────▼──────────────┐
│      Khatru Relay Server       │  │  Lightning Backend      │
│  ┌──────────────────────────┐  │  │  ┌──────────────────┐  │
│  │  Event Handler           │  │  │  │  Invoice Gen     │  │
│  │  - RejectEvent           │  │  │  │  Payment Watch   │  │
│  │  - QueryEvents           │  │  │  └──────────────────┘  │
│  │  - StoreEvent            │  │  └────────────────────────┘
│  └──────────────────────────┘  │             │
└────────────┬───────────────────┘             │
             │                                  │
             │                                  │
┌────────────▼──────────────────────────────────▼─────────────┐
│                    Business Logic Layer                      │
│  ┌─────────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ Payment Monitor │  │Post Fetcher  │  │Invoice Manager │ │
│  │ - Process zaps  │  │- Fetch posts │  │- Generate inv  │ │
│  │ - Verify amount │  │- Multi-relay │  │- Track pending │ │
│  └─────────────────┘  └──────────────┘  └────────────────┘ │
└───────────────────────────────┬──────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────┐
│                       Storage Layer                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Storage (JSON-based)                                  │  │
│  │  - Promoted posts (event + payment metadata)          │  │
│  │  - Pending invoices (payment_hash → post_id mapping)  │  │
│  └───────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

## Data Model

### PromotedPost

Represents a post that has received payment and is stored in the relay.

```go
type PromotedPost struct {
    PostID               string       // Event ID (hex)
    Event                *nostr.Event // Full Nostr event
    TotalSatsPaid        int64        // Cumulative sats received
    LastPaymentTimestamp time.Time    // When last payment was received
}
```

**Fields:**
- `PostID`: The Nostr event ID (64-character hex string)
- `Event`: The complete kind:1 event including signature
- `TotalSatsPaid`: Sum of all payments received for this post
- `LastPaymentTimestamp`: Timestamp of most recent payment (for tie-breaking)

### PendingInvoice

Tracks invoices generated via the PROMOTE command flow.

```go
type PendingInvoice struct {
    PostID      string    // Event ID to promote
    Invoice     string    // BOLT11 payment request
    PaymentHash string    // Lightning payment hash
    AmountSats  int64     // Invoice amount
    CreatedAt   time.Time // When invoice was generated
}
```

**Fields:**
- `PostID`: The post to be promoted when invoice is paid
- `Invoice`: BOLT11-encoded Lightning invoice
- `PaymentHash`: Unique identifier for tracking payment
- `AmountSats`: Amount in satoshis
- `CreatedAt`: Invoice creation time (for expiration tracking)

## Payment Flows

### Flow 1: Zap-based Promotion (NIP-57)

This is the recommended flow as it's fully automated and doesn't require DMs.

```
┌─────────┐                                      ┌─────────┐
│  User   │                                      │  Relay  │
└────┬────┘                                      └────┬────┘
     │                                                │
     │ 1. Find post to promote                       │
     │    post_id = "abc123..."                      │
     │                                                │
     │ 2. Create zap request (kind:9734)             │
     │    - p tag: relay pubkey                      │
     │    - e tag: post_id                           │
     │    - amount: 1000000 (msats)                  │
     │                                                │
     │ 3. Send to Lightning wallet                   │
     │                                                │
┌────▼─────┐                                         │
│  Wallet  │                                         │
└────┬─────┘                                         │
     │                                                │
     │ 4. Generate invoice & user pays              │
     │                                                │
     │ 5. Publish zap receipt (kind:9735)            │
     │    - p tag: relay pubkey                      │
     │    - e tag: original note (optional)          │
     │    - bolt11: invoice with amount              │
     │    - description: zap request JSON            │
     ├───────────────────────────────────────────────►│
     │                                                │
     │                                            6. Validate zap
     │                                               - Check recipient
     │                                               - Parse description
     │                                               - Extract amount
     │                                               - Get post ID from e tag
     │                                                │
     │                                            7. Check if post exists
     │                                                │
     │                                            8a. If exists: update sats
     │                                            8b. If not: fetch from network
     │                                                │
     │                                            9. Store/update post
     │                                                │
     │ 10. Post now promoted ◄────────────────────────┤
     │                                                │
```

**Validation Steps:**

1. **Zap Receipt Validation**:
   - Event kind must be 9735
   - Must have `p` tag with relay's pubkey
   - Must have `bolt11` tag with invoice
   - Must have `description` tag with zap request

2. **Zap Request Validation**:
   - Parse JSON from description tag
   - Extract `e` tag containing post_id
   - Verify zap request is kind 9734

3. **Amount Extraction**:
   - Decode BOLT11 invoice
   - Extract amount in millisats
   - Convert to sats (divide by 1000)
   - Reject if amount is 0

4. **Post Handling**:
   - If post exists: add to total_sats_paid
   - If post missing: fetch from configured relays
   - Verify fetched event is kind:1
   - Store with payment information

### Flow 2: PROMOTE Command

Manual flow using DMs and invoice generation.

```
┌─────────┐                                      ┌─────────┐
│  User   │                                      │  Relay  │
└────┬────┘                                      └────┬────┘
     │                                                │
     │ 1. Send DM to relay (kind:4)                  │
     │    Content: "PROMOTE abc123..."               │
     ├───────────────────────────────────────────────►│
     │                                                │
     │                                            2. Parse command
     │                                               - Validate format
     │                                               - Extract post_id
     │                                                │
     │                                            3. Generate invoice
     │                                               - Create BOLT11
     │                                               - Store pending
     │                                                │
     │ 4. Receive DM reply with invoice              │
     │◄───────────────────────────────────────────────┤
     │                                                │
     │ 5. Pay invoice via wallet                     │
     │                                                │
┌────▼─────┐                                         │
│Lightning │ 6. Payment settles                      │
│  Node    ├───────────────────────────────────────►│
└──────────┘                                         │
     │                                            7. Detect payment
     │                                               - Match payment_hash
     │                                               - Get post_id
     │                                                │
     │                                            8. Fetch post if needed
     │                                                │
     │                                            9. Store/update post
     │                                                │
     │                                            10. Remove pending invoice
     │                                                │
```

**Command Format:**
```
PROMOTE <post_id>
```

Where:
- `post_id` is a 64-character hex string (Nostr event ID)
- Command is case-insensitive
- Extra whitespace is trimmed

**Response Format (DM):**
```
Invoice for promoting post abc123...:

lnbc100n1...invoice_here...

Amount: 1000 sats
Expires: 1 hour

Pay this invoice to promote the post.
```

## Query Behavior

### Sorting Algorithm

Posts are returned in this order:

```go
sort.Slice(posts, func(i, j int) bool {
    // 1. Primary: Total sats paid (descending)
    if posts[i].TotalSatsPaid != posts[j].TotalSatsPaid {
        return posts[i].TotalSatsPaid > posts[j].TotalSatsPaid
    }

    // 2. Secondary: Last payment timestamp (descending)
    if !posts[i].LastPaymentTimestamp.Equal(posts[j].LastPaymentTimestamp) {
        return posts[i].LastPaymentTimestamp.After(posts[j].LastPaymentTimestamp)
    }

    // 3. Tertiary: Creation time (descending)
    return posts[i].Event.CreatedAt > posts[j].Event.CreatedAt
})
```

**Rationale:**
- Posts with more economic support appear first
- Recent payments boost ranking (encourages ongoing promotion)
- Creation time as final tie-breaker

### Filter Handling

The relay applies standard Nostr filters after sorting:

```json
{
  "kinds": [1],
  "authors": ["pubkey1", "pubkey2"],
  "since": 1234567890,
  "until": 1234567890,
  "limit": 50,
  "#e": ["event_id"],
  "#p": ["pubkey"]
}
```

**Process:**
1. Sort all promoted posts by payment ranking
2. Filter by kind (always 1 for this relay)
3. Filter by authors if specified
4. Filter by time range (since/until)
5. Filter by tags (e, p, etc.)
6. Apply limit

### Example Query

**Request:**
```json
["REQ", "top_posts", {
  "kinds": [1],
  "limit": 20
}]
```

**Response:**
```json
["EVENT", "top_posts", {
  "id": "abc123...",
  "pubkey": "def456...",
  "created_at": 1234567890,
  "kind": 1,
  "tags": [],
  "content": "This is the top promoted post!",
  "sig": "..."
}]
...
["EOSE", "top_posts"]
```

## Event Handling

### RejectEvent Hook

Validates events before acceptance:

```go
relay.RejectEvent = func(ctx context.Context, event *nostr.Event) (bool, string) {
    // Only accept kind:1
    if event.Kind != 1 {
        return true, "relay only accepts kind:1 events"
    }

    // Must be pre-paid
    if !storage.HasPost(event.ID) {
        return true, "event must be paid for before submission"
    }

    return false, ""
}
```

**Rejection Reasons:**
1. Event is not kind:1
2. Event has not been paid for
3. Event fails signature validation (handled by khatru)

### StoreEvent Hook

Called after event passes validation:

```go
relay.StoreEvent = func(ctx context.Context, event *nostr.Event) error {
    // Event is already in storage (from payment flow)
    // Just log acceptance
    log.Printf("Event %s accepted", event.ID)
    return nil
}
```

### OnEventSaved Hook

Handles special events after storage:

```go
relay.OnEventSaved = func(ctx context.Context, event *nostr.Event) {
    switch event.Kind {
    case 9735: // Zap receipt
        monitor.ProcessZap(ctx, event)
    case 4:    // Encrypted DM
        handlePromoteCommand(ctx, event)
    }
}
```

### QueryEvents Hook

Returns sorted, filtered posts:

```go
relay.QueryEvents = func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
    events := storage.QueryPosts(ctx, filter)

    ch := make(chan *nostr.Event)
    go func() {
        defer close(ch)
        for _, event := range events {
            select {
            case <-ctx.Done():
                return
            case ch <- event:
            }
        }
    }()

    return ch, nil
}
```

## Post Fetching

When a zap references an unknown post, the relay fetches it from the network.

### Fetch Algorithm

```
1. Receive zap for post_id "abc123..."
2. Check local storage
3. If not found:
   a. Create filter: {ids: ["abc123..."], kinds: [1], limit: 1}
   b. Connect to each configured relay sequentially
   c. Query for the event
   d. If found: validate and return
   e. If not found: try next relay
4. If found on any relay: store with payment
5. If not found on any relay: return error
```

### Configured Relays

Default fetch relays (configurable):
```go
fetchRelays := []string{
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
    "wss://nostr.wine",
}
```

### Validation

Fetched events must:
- Match the requested event ID
- Be kind:1 (text note)
- Have valid signature
- Be complete (have all required fields)

## Storage Implementation

### JSON Format

```json
{
  "posts": {
    "abc123...": {
      "post_id": "abc123...",
      "event": {
        "id": "abc123...",
        "pubkey": "def456...",
        "created_at": 1234567890,
        "kind": 1,
        "tags": [],
        "content": "Post content",
        "sig": "..."
      },
      "total_sats_paid": 5000,
      "last_payment_timestamp": "2024-01-01T12:00:00Z"
    }
  },
  "pending_invoices": {
    "payment_hash_123": {
      "post_id": "abc123...",
      "invoice": "lnbc...",
      "payment_hash": "payment_hash_123",
      "amount_sats": 1000,
      "created_at": "2024-01-01T11:00:00Z"
    }
  }
}
```

### Thread Safety

- `sync.RWMutex` for concurrent access
- Write lock for modifications
- Read lock for queries
- Automatic save after each modification

### Persistence

- Save on every modification
- Load on startup
- Pretty-printed JSON for readability
- Atomic writes (write to temp, then rename)

## Lightning Integration

### Interface

```go
type LightningBackend interface {
    GenerateInvoice(ctx context.Context, amountSats int64, memo string) (*Invoice, error)
    WatchInvoices(ctx context.Context) (<-chan PaidInvoice, error)
    CheckInvoice(ctx context.Context, paymentHash string) (bool, int64, error)
}
```

### Mock Implementation

For development and testing:
- Generates fake invoices
- Doesn't actually process payments
- Allows manual payment simulation
- No external dependencies

### Production Implementation

For LND integration:
1. Connect via gRPC
2. Load TLS certificate
3. Load admin macaroon
4. Use `AddInvoice` RPC
5. Use `SubscribeInvoices` for watching
6. Handle reconnection logic

## Security Considerations

### Zap Validation

1. **Verify recipient**: Ensure `p` tag matches relay pubkey
2. **Validate structure**: All required tags present
3. **Parse description**: Valid JSON, kind:9734
4. **Extract amount**: Valid BOLT11, amount > 0
5. **Verify post**: Event ID in `e` tag is valid hex

### Post Validation

1. **Signature**: Verify event signature
2. **Kind**: Must be kind:1
3. **Content**: No size limits (client responsibility)
4. **Author**: Any author allowed (no restrictions)

### Rate Limiting

Recommended limits:
- Max 10 PROMOTE commands per pubkey per hour
- Max 100 zap events processed per minute
- Max 1000 events returned per query

### Spam Prevention

1. **Minimum payment**: Configure minimum sats required
2. **Invoice expiration**: Expire unpaid invoices after 1 hour
3. **Duplicate prevention**: Check payment hash uniqueness

## Edge Cases

### Case 1: Unknown Post in Zap

**Scenario**: Zap references post not in local storage

**Handling**:
1. Attempt to fetch from network relays
2. If found: validate and store with payment
3. If not found: log error, don't process payment
4. Could send DM to payer explaining issue

### Case 2: Multiple Payments to Same Post

**Scenario**: Post receives multiple zaps over time

**Handling**:
- Add to `TotalSatsPaid`
- Update `LastPaymentTimestamp`
- Post ranking improves
- All payments tracked cumulatively

### Case 3: Zero-Amount Zap

**Scenario**: Zap with 0 sats amount

**Handling**:
- Ignore payment
- Log warning
- Don't update post ranking

### Case 4: Invalid Post ID in PROMOTE

**Scenario**: User sends "PROMOTE invalid_id"

**Handling**:
- Validate post ID format (64 hex chars)
- Reject with error message
- Don't generate invoice

### Case 5: Payment Before Post Exists

**Scenario**: Zap sent before post is published

**Handling**:
- Try to fetch post immediately
- If not found: return error
- Could implement retry logic
- Could queue for later retry

### Case 6: Relay Restart

**Scenario**: Relay restarts with pending invoices

**Handling**:
- Load pending invoices from storage
- Check payment status for each
- Process paid invoices
- Expire old invoices (> 1 hour)

## Configuration

### Environment Variables

```bash
RELAY_PRIVKEY=<hex_private_key>      # Relay identity
LND_ADDRESS=localhost:10009           # LND gRPC address
LND_TLS_CERT=/path/to/tls.cert       # TLS certificate
LND_MACAROON=/path/to/admin.macaroon # Admin macaroon
PORT=3334                             # WebSocket port
DEFAULT_PAYMENT_SATS=1000            # Default invoice amount
DATA_FILE=relay_data.json            # Storage file path
```

### Code Configuration

Located in `main.go`:

```go
const (
    dataFile           = "relay_data.json"
    port               = "3334"
    defaultPaymentSats = 1000
)

fetchRelays := []string{
    "wss://relay.damus.io",
    "wss://nos.lol",
}
```

## Performance Considerations

### Sorting Performance

- All posts sorted on every query
- O(n log n) complexity
- Consider caching for large datasets
- Could maintain sorted index

### Storage Performance

- JSON serialization on every write
- Consider switching to SQLite for scale
- Could batch writes
- Could use async writes

### Memory Usage

- All posts kept in memory
- Could implement LRU cache
- Could page results
- Estimate: ~2KB per post

### Network Performance

- Post fetching is synchronous
- Could parallelize relay queries
- Could cache common posts
- Could implement request batching

## Future Enhancements

### 1. Post Expiration

Remove posts that haven't received payments recently:
- Configurable expiration time (e.g., 30 days)
- Periodic cleanup job
- Notify authors before removal

### 2. Categories/Tags

Allow categorized promotion boards:
- Multiple relay instances per category
- Tag-based filtering
- Category-specific minimums

### 3. Refunds

Allow post authors to request removal:
- Verify author signature
- Calculate refund amount
- Process Lightning payment
- Remove from storage

### 4. Analytics

Track promotion statistics:
- Total sats collected
- Posts promoted per day
- Top promoters (pubkeys)
- Average payment amount

### 5. Web Dashboard

Admin interface showing:
- Current post rankings
- Payment history
- Relay statistics
- Configuration management

### 6. Boost Multipliers

Allow time-limited boosts:
- "2x boost for next 24 hours"
- Temporary ranking enhancement
- Premium pricing

## Testing Strategy

### Unit Tests

- Payment parsing logic
- Zap validation
- PROMOTE command parsing
- Sorting algorithm
- Filter application

### Integration Tests

- Full payment flows
- Post fetching
- Storage persistence
- Event handling

### Load Tests

- Concurrent queries
- High payment volume
- Large dataset queries
- Memory usage under load

## Deployment

### Development

```bash
go run .
```

### Production

```bash
# Build
go build -o promotion-relay .

# Run with systemd
sudo systemctl start promotion-relay

# Or with Docker
docker build -t promotion-relay .
docker run -p 3334:3334 -v ./data:/data promotion-relay
```

### Monitoring

Recommended metrics:
- Total posts stored
- Payments processed per hour
- Query latency (p50, p95, p99)
- Storage size
- Memory usage
- Active connections

## Conclusion

This design provides a complete, protocol-compliant Nostr relay that implements a paid promotion board. The architecture is modular, allowing easy extension and modification. The payment flows are robust and handle edge cases appropriately. The implementation is production-ready with proper error handling, validation, and persistence.
