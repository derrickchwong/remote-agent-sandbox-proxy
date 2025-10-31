#!/bin/bash
set -e

echo "Deploying sandbox proxy to Kubernetes..."

# Apply RBAC
echo "Applying RBAC..."
kubectl apply -f k8s/rbac.yaml

# Apply deployment and service
echo "Applying deployment and service..."
kubectl apply -f k8s/deployment.yaml

# Wait for deployment
echo "Waiting for deployment to be ready..."
kubectl wait --for=condition=available --timeout=300s deployment/sandbox-proxy

# Get LoadBalancer IP
echo ""
echo "✓ Deployment complete!"
echo ""
echo "Getting LoadBalancer IP (this may take a few minutes)..."
echo ""
kubectl get service sandbox-proxy

echo ""
echo "Once EXTERNAL-IP is assigned, test with:"
echo "  curl http://EXTERNAL-IP/health"
