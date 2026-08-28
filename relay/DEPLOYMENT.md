# Deploying to Fly.io

This guide will help you deploy the Nostr Promotion Relay to Fly.io.

## Prerequisites

1. Install the Fly CLI:
   ```bash
   # macOS
   brew install flyctl

   # Linux
   curl -L https://fly.io/install.sh | sh

   # Windows
   iwr https://fly.io/install.ps1 -useb | iex
   ```

2. Sign up and login:
   ```bash
   fly auth signup
   # or
   fly auth login
   ```

## Initial Setup

### 1. Create the App

First, customize the app name in `fly.toml`:
```toml
app = "your-unique-relay-name"  # Change this to your preferred name
```

Then launch the app:
```bash
fly launch --no-deploy
```

This will create the app without deploying yet.

### 2. Create Persistent Storage

Create a volume for storing relay data:
```bash
fly volumes create relay_data --size 1
```

### 3. Set Secrets

Set your sensitive environment variables as secrets:

#### For LNbits (Recommended):
```bash
# Generate a relay private key if you don't have one
# You can use: openssl rand -hex 32

fly secrets set RELAY_PRIVKEY=your_relay_private_key_hex
fly secrets set LNBITS_API_KEY=your_lnbits_invoice_key
fly secrets set LNBITS_READ_KEY=your_lnbits_read_key
```

Optional LNbits base URL (if using your own instance):
```bash
fly secrets set LNBITS_BASE_URL=https://your-lnbits-instance.com
```

#### For Zebedee:
```bash
fly secrets set RELAY_PRIVKEY=your_relay_private_key_hex
fly secrets set ZEBEDEE_API_KEY=your_zebedee_api_key
```

Then update the `LIGHTNING_BACKEND` in `fly.toml`:
```toml
[env]
  LIGHTNING_BACKEND = "zebedee"  # Change from "lnbits"
```

### 4. Deploy

Deploy your relay:
```bash
fly deploy
```

### 5. Verify Deployment

Check the logs:
```bash
fly logs
```

You should see output like:
```
Starting Nostr Promotion Relay
Relay pubkey: npub1...
Using LNbits Lightning backend at https://legend.lnbits.com
Starting relay on port 8080
WebSocket URL: ws://localhost:8080
```

## Accessing Your Relay

Your relay will be available at:
- WebSocket: `wss://your-app-name.fly.dev`
- HTTPS: `https://your-app-name.fly.dev`

Get your app URL:
```bash
fly info
```

## Getting Your Relay Pubkey

View the logs to see your relay's public key:
```bash
fly logs
```

Look for the line:
```
Relay pubkey: npub1...
```

Share this pubkey with users who want to promote posts via zaps.

## Configuration

### Update Environment Variables

To update non-sensitive environment variables, edit `fly.toml` and redeploy:
```bash
fly deploy
```

### Update Secrets

To update secrets:
```bash
fly secrets set KEY=new_value
```

This will automatically restart your app.

### List Current Secrets

```bash
fly secrets list
```

## Monitoring

### View Logs
```bash
# Tail logs
fly logs

# Last 200 lines
fly logs --lines 200
```

### Check Status
```bash
fly status
```

### SSH into Container
```bash
fly ssh console
```

## Scaling

### Horizontal Scaling (Multiple Instances)
```bash
# Scale to 2 instances
fly scale count 2

# Scale to specific regions
fly scale count 2 --region iad,lhr
```

### Vertical Scaling (More Resources)
```bash
# List available VM sizes
fly platform vm-sizes

# Scale to larger VM
fly scale vm shared-cpu-2x --memory 1024
```

## Storage Management

### Check Volume Status
```bash
fly volumes list
```

### Extend Volume Size
```bash
fly volumes extend <volume-id> --size 5
```

### Backup Data

SSH into the container and copy the data file:
```bash
fly ssh console
cat /root/data/relay_data.json
```

Or use sftp:
```bash
fly ssh sftp get /root/data/relay_data.json ./backup-relay-data.json
```

## Troubleshooting

### App Won't Start

1. Check logs:
   ```bash
   fly logs
   ```

2. Verify secrets are set:
   ```bash
   fly secrets list
   ```

3. Check if volume is mounted:
   ```bash
   fly ssh console
   ls -la /root/data
   ```

### WebSocket Connection Issues

1. Verify the app is running:
   ```bash
   fly status
   ```

2. Test WebSocket connection:
   ```bash
   # Using websocat (install: brew install websocat)
   websocat wss://your-app-name.fly.dev
   ```

3. Check if port 8080 is exposed in Dockerfile

### Out of Memory

Increase memory allocation:
```bash
fly scale vm shared-cpu-1x --memory 512
```

### Checking Invoice Generation

View logs when a user sends a PROMOTE command:
```bash
fly logs -a your-app-name
```

Look for:
```
Generated invoice for post abc123...: xyz789... (1000 sats)
```

## Security Best Practices

1. **Never commit secrets**: Use `fly secrets set` for sensitive data
2. **Rotate keys regularly**: Update RELAY_PRIVKEY and API keys periodically
3. **Monitor logs**: Watch for suspicious activity
4. **Backup data**: Regularly backup relay_data.json
5. **Use HTTPS**: Fly.io provides automatic TLS certificates

## Costs

Fly.io pricing (as of 2024):
- Free tier includes: 3 shared-cpu-1x VMs with 256MB RAM
- Volumes: ~$0.15/GB/month
- Additional resources billed per hour

Check current pricing: https://fly.io/docs/about/pricing/

## Custom Domain

To use your own domain:

1. Add the certificate:
   ```bash
   fly certs add relay.yourdomain.com
   ```

2. Add DNS records as instructed by Fly.io

3. Verify:
   ```bash
   fly certs show relay.yourdomain.com
   ```

## Updating the Relay

To deploy updates:

1. Pull the latest code
2. Deploy:
   ```bash
   fly deploy
   ```

Fly.io will perform a rolling restart with zero downtime.

## Destroying the App

To completely remove the app:

```bash
# Delete the app
fly apps destroy your-app-name

# Delete volumes manually if needed
fly volumes list
fly volumes delete <volume-id>
```

## Getting Help

- Fly.io Docs: https://fly.io/docs/
- Community Forum: https://community.fly.io/
- Check relay logs: `fly logs`

## Example: Complete Deployment

```bash
# 1. Install flyctl
brew install flyctl

# 2. Login
fly auth login

# 3. Edit fly.toml - change app name
# app = "my-nostr-relay"

# 4. Launch (don't deploy yet)
fly launch --no-deploy

# 5. Create volume
fly volumes create relay_data --size 1

# 6. Set secrets
fly secrets set RELAY_PRIVKEY=$(openssl rand -hex 32)
fly secrets set LNBITS_API_KEY=your_lnbits_invoice_key
fly secrets set LNBITS_READ_KEY=your_lnbits_read_key

# 7. Deploy
fly deploy

# 8. Check logs
fly logs

# 9. Get your relay URL
fly info

# Your relay is now live at wss://my-nostr-relay.fly.dev
```
