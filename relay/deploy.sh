#!/bin/bash

# Deployment script for Fly.io
# This script helps you deploy the Nostr Promotion Relay to Fly.io

set -e

echo "🚀 Nostr Promotion Relay - Fly.io Deployment"
echo ""

# Check if flyctl is installed
if ! command -v flyctl &> /dev/null; then
    echo "❌ flyctl is not installed"
    echo "Install it with: brew install flyctl"
    echo "Or visit: https://fly.io/docs/hands-on/install-flyctl/"
    exit 1
fi

# Check if user is logged in
if ! flyctl auth whoami &> /dev/null; then
    echo "❌ Not logged in to Fly.io"
    echo "Please run: flyctl auth login"
    exit 1
fi

echo "✅ flyctl is installed and you're logged in"
echo ""

# Check if app exists
APP_NAME=$(grep "^app = " fly.toml | sed 's/app = "\(.*\)"/\1/')
echo "📦 App name: $APP_NAME"
echo ""

if ! flyctl apps list | grep -q "$APP_NAME"; then
    echo "⚠️  App doesn't exist yet. Let's create it!"
    echo ""

    # Launch app
    echo "Creating app (this won't deploy yet)..."
    flyctl launch --no-deploy

    # Create volume
    echo ""
    echo "Creating persistent volume for relay data..."
    flyctl volumes create relay_data --size 1

    # Prompt for secrets
    echo ""
    echo "🔐 Now let's set up your secrets..."
    echo ""

    # Check if RELAY_PRIVKEY exists
    if flyctl secrets list | grep -q "RELAY_PRIVKEY"; then
        echo "✅ RELAY_PRIVKEY already set"
    else
        echo "Generate a new relay private key? (y/n)"
        read -r GENERATE_KEY
        if [ "$GENERATE_KEY" = "y" ]; then
            PRIVKEY=$(openssl rand -hex 32)
            flyctl secrets set RELAY_PRIVKEY="$PRIVKEY"
            echo "✅ Generated and set RELAY_PRIVKEY"
        else
            echo "Enter your RELAY_PRIVKEY (hex format):"
            read -r PRIVKEY
            flyctl secrets set RELAY_PRIVKEY="$PRIVKEY"
        fi
    fi

    echo ""
    echo "Which Lightning backend? (lnbits/zebedee/mock)"
    read -r BACKEND

    if [ "$BACKEND" = "lnbits" ]; then
        echo "Enter your LNBITS_API_KEY (Invoice/Write key):"
        read -r LNBITS_API_KEY
        flyctl secrets set LNBITS_API_KEY="$LNBITS_API_KEY"

        echo "Enter your LNBITS_READ_KEY:"
        read -r LNBITS_READ_KEY
        flyctl secrets set LNBITS_READ_KEY="$LNBITS_READ_KEY"

        echo "Enter LNBITS_BASE_URL (press Enter for default: https://legend.lnbits.com):"
        read -r LNBITS_URL
        if [ -n "$LNBITS_URL" ]; then
            flyctl secrets set LNBITS_BASE_URL="$LNBITS_URL"
        fi

        # Update fly.toml
        sed -i.bak 's/LIGHTNING_BACKEND = ".*"/LIGHTNING_BACKEND = "lnbits"/' fly.toml
        rm fly.toml.bak

    elif [ "$BACKEND" = "zebedee" ]; then
        echo "Enter your ZEBEDEE_API_KEY:"
        read -r ZEBEDEE_KEY
        flyctl secrets set ZEBEDEE_API_KEY="$ZEBEDEE_KEY"

        # Update fly.toml
        sed -i.bak 's/LIGHTNING_BACKEND = ".*"/LIGHTNING_BACKEND = "zebedee"/' fly.toml
        rm fly.toml.bak
    fi

    echo ""
    echo "✅ Secrets configured!"
else
    echo "✅ App already exists"

    # Check if volume exists
    if ! flyctl volumes list | grep -q "relay_data"; then
        echo "⚠️  Volume 'relay_data' doesn't exist. Creating it now..."
        flyctl volumes create relay_data --size 1 --region iad
        echo "✅ Volume created"
    else
        echo "✅ Volume already exists"
    fi
fi

echo ""
echo "🚢 Deploying to Fly.io..."
flyctl deploy

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 View logs: flyctl logs"
echo "🔍 Check status: flyctl status"
echo "🌐 App info: flyctl info"
echo ""
echo "Your relay is available at: wss://$APP_NAME.fly.dev"
echo ""
echo "Get your relay pubkey from the logs:"
echo "flyctl logs | grep 'Relay pubkey'"
