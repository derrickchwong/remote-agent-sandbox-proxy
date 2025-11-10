#!/bin/bash
set -e

echo "=========================================="
echo "Sandbox Proxy - Bootstrap Script"
echo "=========================================="
echo ""
echo "This script will:"
echo "  1. Generate a secure admin API key"
echo "  2. Create the first admin user in the database"
echo "  3. Generate an API key for the admin user"
echo ""

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "ERROR: kubectl not found. Please install kubectl first."
    exit 1
fi

# Check if jq is available
if ! command -v jq &> /dev/null; then
    echo "ERROR: jq not found. Please install jq first."
    exit 1
fi

# Check if postgres pod is running
echo "Checking if PostgreSQL is running..."
POD=$(kubectl get pods -l app=postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -z "$POD" ]; then
    echo "ERROR: PostgreSQL pod not found. Please deploy PostgreSQL first."
    exit 1
fi
echo "✓ PostgreSQL pod found: $POD"
echo ""

# Get database credentials from secret
echo "Getting database credentials..."
DB_USER=$(kubectl get secret postgres-credentials -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
DB_NAME=$(kubectl get secret postgres-credentials -o jsonpath='{.data.POSTGRES_DB}' | base64 -d)
echo "✓ Database credentials retrieved"
echo ""

# Generate admin API key for the proxy
echo "Generating admin API key for proxy..."
ADMIN_API_KEY=$(openssl rand -base64 32 | tr -d '/' | head -c 48)
echo "✓ Admin API key generated"
echo ""

# Update admin-credentials secret
echo "Updating admin-credentials secret..."
kubectl create secret generic admin-credentials \
  --from-literal=ADMIN_API_KEY=$ADMIN_API_KEY \
  --dry-run=client -o yaml | kubectl apply -f -
echo "✓ Admin credentials secret updated"
echo ""

# Create admin user in database
echo "Creating admin user in database..."
kubectl exec -i $POD -- psql -U $DB_USER -d $DB_NAME <<EOF
-- Check if admin user exists
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin') THEN
        INSERT INTO users (username, email, is_active)
        VALUES ('admin', 'admin@example.com', true);
        RAISE NOTICE 'Admin user created';
    ELSE
        RAISE NOTICE 'Admin user already exists';
    END IF;
END
\$\$;
EOF
echo "✓ Admin user created/verified in database"
echo ""

echo "=========================================="
echo "Bootstrap Complete!"
echo "=========================================="
echo ""
echo "Admin API Key (for proxy admin endpoints):"
echo "  $ADMIN_API_KEY"
echo ""
echo "IMPORTANT: Save this key securely!"
echo ""
echo "To restart the proxy and apply the new admin key:"
echo "  kubectl rollout restart deployment/sandbox-proxy"
echo ""
echo "Next steps:"
echo "  1. Restart the proxy deployment (see command above)"
echo "  2. Create a user: POST /api/admin/users"
echo "  3. Generate API key for user: POST /api/admin/users/:userId/apikeys"
echo ""
echo "=========================================="
