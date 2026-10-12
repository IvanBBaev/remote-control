#!/bin/sh
# Runs the relay over HTTPS on the LAN so a phone can open the PWA (Web Push and service
# workers need a secure context). Requires mkcert (https://github.com/FiloSottile/mkcert):
#   brew install mkcert && mkcert -install
# Then install the mkcert root CA on the phone once (see apps/relay/README.md).
set -eu

cd "$(dirname "$0")/.."

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is not installed. Install it first: brew install mkcert && mkcert -install" >&2
  exit 1
fi

CERT_DIR=.certs
CERT_FILE="$CERT_DIR/dev-cert.pem"
KEY_FILE="$CERT_DIR/dev-key.pem"

# First non-loopback IPv4 address of this machine (macOS en0/en1, else Linux hostname -I).
LAN_IP="${RC_LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | cut -d' ' -f1 || true)}"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ] || [ "${RC_REGENERATE_CERT:-}" = "1" ]; then
  mkdir -p "$CERT_DIR"
  # shellcheck disable=SC2086
  mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" localhost 127.0.0.1 ::1 $LAN_IP
fi

PORT_VALUE="${RC_PORT:-3443}"
echo "Relay over HTTPS: https://localhost:$PORT_VALUE${LAN_IP:+ and https://$LAN_IP:$PORT_VALUE}"

RC_HOST="${RC_HOST:-0.0.0.0}" \
RC_PORT="$PORT_VALUE" \
RC_TLS_CERT_FILE="$CERT_FILE" \
RC_TLS_KEY_FILE="$KEY_FILE" \
  exec tsx watch src/server.ts
