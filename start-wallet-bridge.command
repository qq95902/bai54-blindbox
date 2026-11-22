#!/bin/zsh
set -e
cd "$(dirname "$0")"

# Use the macOS CA bundle for Binance Agentic Wallet HTTPS requests.
# This keeps normal TLS verification enabled; it does not bypass certificates.
export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem
exec node wallet-bridge.mjs
