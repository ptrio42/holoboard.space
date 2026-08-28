# Fly.io Quick Start Guide

Deploy your Nostr Promotion Relay to Fly.io in 5 minutes.

## Prerequisites

1. **Install Fly.io CLI:**
   ```bash
   # macOS
   brew install flyctl

   # Linux
   curl -L https://fly.io/install.sh | sh

   # Windows (PowerShell)
   iwr https://fly.io/install.ps1 -useb | iex
   ```

2. **Sign up / Login:**
   ```bash
   fly auth signup
   # or if you already have an account
   fly auth login
   ```

## Option 1: Automated Deployment (Recommended)

Use the deployment script:

```bash
./deploy.sh
```

The script will:
- ✅ Check if flyctl is installed
- ✅ Create the app and volume
- ✅ Prompt for secrets (API keys)
- ✅ Deploy automatically

## Option 2: Manual Deployment

### Step 1: Customize App Name

Edit `fly.toml` and change the app name:
```toml
app = "my-nostr-relay"  # Choose your unique name
```

### Step 2: Launch App

```bash
# This creates the app but doesn't deploy yet
fly launch --no-deploy
```

### Step 3: Create Storage Volume

```bash
fly volumes create relay_data --size 1
```

### Step 4: Set Secrets

#### For LNbits (Free, No-KYC):

Get your keys from [legend.lnbits.com](https://legend.lnbits.com):
1. Create a wallet
2. Go to API Info
3. Copy Invoice/Write key and Read key

```bash
# Generate relay private key
fly secrets set RELAY_PRIVKEY=$(openssl rand -hex 32)

# Set LNbits keys
fly secrets set LNBITS_API_KEY=your_invoice_key_here
fly secrets set LNBITS_READ_KEY=your_read_key_here

# Optional: Use your own LNbits instance
fly secrets set LNBITS_BASE_URL=https://your-instance.com
```

#### For Zebedee:

```bash
fly secrets set RELAY_PRIVKEY=$(openssl rand -hex 32)
fly secrets set ZEBEDEE_API_KEY=your_key_here
```

Then update `fly.toml`:
```toml
[env]
  LIGHTNING_BACKEND = "zebedee"
```

### Step 5: Deploy

```bash
fly deploy
```

### Step 6: Verify

```bash
# Check logs
fly logs

# Get app info
fly info
```

Look for your relay pubkey in the logs:
```bash
fly logs | grep "Relay pubkey"
```

## Your Relay is Live! 🎉

Access your relay at:
```
wss://your-app-name.fly.dev
```

## Testing Your Relay

### Connect with a Nostr Client

Add this relay to any Nostr client:
```
wss://your-app-name.fly.dev
```

### Promote a Post via DM

1. Send a DM to your relay's pubkey (check logs for the npub)
2. Message content:
   ```
   PROMOTE note1abc123...
   ```
   or with custom amount:
   ```
   PROMOTE 2100 note1abc123...
   ```
3. You'll receive an invoice
4. Pay it to promote the post

### Promote via Zap

Send a zap to your relay's pubkey and include the post ID in the zap comment.

## Common Commands

```bash
# View logs
fly logs

# Real-time logs
fly logs -f

# Check app status
fly status

# Scale resources
fly scale vm shared-cpu-1x --memory 512

# Scale instances
fly scale count 2

# SSH into container
fly ssh console

# Update secrets
fly secrets set KEY=value

# List secrets
fly secrets list

# Restart app
fly apps restart

# Delete app
fly apps destroy your-app-name
```

## Troubleshooting

### App won't start?

Check secrets are set:
```bash
fly secrets list
```

You should see:
- RELAY_PRIVKEY
- LNBITS_API_KEY (or ZEBEDEE_API_KEY)
- LNBITS_READ_KEY (for LNbits)

### Can't connect via WebSocket?

1. Check app is running:
   ```bash
   fly status
   ```

2. Test connection:
   ```bash
   # Install websocat: brew install websocat
   websocat wss://your-app-name.fly.dev
   ```

3. Check logs:
   ```bash
   fly logs
   ```

### Memory issues?

Increase memory:
```bash
fly scale vm shared-cpu-1x --memory 512
```

### Volume issues?

Check volume:
```bash
fly volumes list
```

Extend volume:
```bash
fly volumes extend <vol_id> --size 5
```

## Configuration

### Environment Variables in fly.toml

```toml
[env]
  PORT = "8080"
  DATA_FILE = "/root/data/relay_data.json"
  DEFAULT_PAYMENT_SATS = "1000"
  FETCH_RELAYS = "wss://relay.damus.io,wss://nos.lol"
  LIGHTNING_BACKEND = "lnbits"
```

### Secrets (set via CLI)

Never put these in fly.toml:
- RELAY_PRIVKEY
- LNBITS_API_KEY
- LNBITS_READ_KEY
- ZEBEDEE_API_KEY

## Costs

Fly.io free tier includes:
- 3 shared-cpu-1x VMs (256MB RAM)
- 3GB persistent storage
- 160GB outbound transfer

Your relay should fit comfortably in the free tier.

Volume costs: ~$0.15/GB/month

See: https://fly.io/docs/about/pricing/

## Next Steps

1. **Share your relay**: Give users your relay URL and pubkey
2. **Monitor usage**: Watch logs for promotions
3. **Backup data**: Periodically backup relay_data.json
4. **Set up alerts**: Configure Fly.io health checks
5. **Custom domain**: Add your own domain with `fly certs add`

## Need Help?

- Full guide: [DEPLOYMENT.md](DEPLOYMENT.md)
- Fly.io docs: https://fly.io/docs/
- Check logs: `fly logs`
- Community: https://community.fly.io/

## Example Complete Session

```bash
# Install and login
brew install flyctl
fly auth login

# Deploy
./deploy.sh

# Or manually:
fly launch --no-deploy
fly volumes create relay_data --size 1
fly secrets set RELAY_PRIVKEY=$(openssl rand -hex 32)
fly secrets set LNBITS_API_KEY=abc123
fly secrets set LNBITS_READ_KEY=xyz789
fly deploy

# Check it's running
fly logs
fly info

# Done! Your relay: wss://my-nostr-relay.fly.dev
```

Enjoy your Nostr Promotion Relay! ⚡️
