#!/bin/bash
set -e

echo "=========================================="
echo "Sandbox Proxy - Admin Key Generator"
echo "=========================================="
echo ""

# Generate a secure random admin API key
ADMIN_KEY=$(openssl rand -base64 32 | tr -d '/' | head -c 48)

echo "Generated Admin API Key:"
echo ""
echo "  $ADMIN_KEY"
echo ""
echo "=========================================="
echo ""
echo "To use this key, update the Kubernetes secret:"
echo ""
echo "kubectl create secret generic admin-credentials \\"
echo "  --from-literal=ADMIN_API_KEY=$ADMIN_KEY \\"
echo "  --dry-run=client -o yaml | kubectl apply -f -"
echo ""
echo "Or edit the secret file directly:"
echo "  k8s/base/admin-secret.yaml"
echo ""
echo "IMPORTANT: Save this key securely. It will not be shown again."
echo "=========================================="
