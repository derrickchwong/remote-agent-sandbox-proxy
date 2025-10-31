#!/bin/bash
set -e

# Check if PROJECT_ID is set
if [ -z "$PROJECT_ID" ]; then
  echo "Error: PROJECT_ID environment variable is not set"
  echo "Usage: export PROJECT_ID=your-gcp-project-id && ./scripts/build-and-push.sh"
  exit 1
fi

IMAGE_NAME="gcr.io/${PROJECT_ID}/sandbox-proxy:latest"

echo "Building Docker image: ${IMAGE_NAME}"
docker build -t ${IMAGE_NAME} .

echo "Pushing to Google Container Registry..."
docker push ${IMAGE_NAME}

echo "✓ Image pushed successfully: ${IMAGE_NAME}"
echo ""
echo "Next steps:"
echo "1. Update k8s/deployment.yaml with the image name"
echo "2. kubectl apply -f k8s/rbac.yaml"
echo "3. kubectl apply -f k8s/deployment.yaml"
