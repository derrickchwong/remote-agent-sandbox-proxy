#!/bin/bash

# Setup script for GCS storage and Workload Identity for sandbox persistence
# This script will:
# 1. Create a GCS bucket for sandbox storage
# 2. Create a GCP service account
# 3. Grant storage permissions to the service account
# 4. Create a Kubernetes service account
# 5. Bind the GCP service account to the Kubernetes service account (Workload Identity)

set -e

# Configuration
PROJECT_ID="${PROJECT_ID:-agent-sandbox-476202}"
REGION="${REGION:-us-central1}"
BUCKET_NAME="${BUCKET_NAME:-agent-sandbox-storage}"
GCP_SA_NAME="${GCP_SA_NAME:-sandbox-gcs-sa}"
K8S_SA_NAME="${K8S_SA_NAME:-sandbox-gcs-ksa}"
NAMESPACE="${NAMESPACE:-default}"

echo "=== GCS Storage Setup for Sandbox Persistence ==="
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Bucket: $BUCKET_NAME"
echo "GCP Service Account: $GCP_SA_NAME"
echo "K8s Service Account: $K8S_SA_NAME"
echo ""

# Check if user is logged in
echo "Step 1: Checking GCP authentication..."
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo "Error: Not authenticated with gcloud. Please run 'gcloud auth login'"
    exit 1
fi

# Set the project
echo "Step 2: Setting GCP project to $PROJECT_ID..."
gcloud config set project $PROJECT_ID

# Create GCS bucket if it doesn't exist
echo "Step 3: Creating GCS bucket '$BUCKET_NAME'..."
if gsutil ls -b gs://$BUCKET_NAME &>/dev/null; then
    echo "Bucket gs://$BUCKET_NAME already exists."
else
    gcloud storage buckets create gs://$BUCKET_NAME \
        --location=$REGION \
        --uniform-bucket-level-access
    echo "Bucket gs://$BUCKET_NAME created successfully."
fi

# Create GCP service account if it doesn't exist
echo "Step 4: Creating GCP service account '$GCP_SA_NAME'..."
GCP_SA_EMAIL="$GCP_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
if gcloud iam service-accounts describe $GCP_SA_EMAIL &>/dev/null; then
    echo "Service account $GCP_SA_EMAIL already exists."
else
    gcloud iam service-accounts create $GCP_SA_NAME \
        --display-name="Sandbox GCS Storage Service Account" \
        --description="Service account for sandbox containers to access GCS storage"
    echo "Service account $GCP_SA_EMAIL created successfully."
fi

# Grant storage permissions to the GCP service account
echo "Step 5: Granting storage.objectAdmin role to service account..."
gcloud storage buckets add-iam-policy-binding gs://$BUCKET_NAME \
    --member="serviceAccount:$GCP_SA_EMAIL" \
    --role="roles/storage.objectAdmin"
echo "Permissions granted successfully."

# Apply Kubernetes service account manifest
echo "Step 6: Creating Kubernetes service account '$K8S_SA_NAME'..."
kubectl apply -f k8s/sandbox-gcs-sa.yaml
echo "Kubernetes service account created successfully."

# Set up Workload Identity binding
echo "Step 7: Setting up Workload Identity binding..."
gcloud iam service-accounts add-iam-policy-binding $GCP_SA_EMAIL \
    --role roles/iam.workloadIdentityUser \
    --member "serviceAccount:$PROJECT_ID.svc.id.goog[$NAMESPACE/$K8S_SA_NAME]"
echo "Workload Identity binding configured successfully."

# Annotate the Kubernetes service account (already in manifest, but ensure it's applied)
echo "Step 8: Verifying Kubernetes service account annotation..."
kubectl annotate serviceaccount $K8S_SA_NAME \
    --namespace=$NAMESPACE \
    --overwrite \
    iam.gke.io/gcp-service-account=$GCP_SA_EMAIL
echo "Annotation verified."

echo ""
echo "=== Setup Complete! ==="
echo ""
echo "Summary:"
echo "  - GCS Bucket: gs://$BUCKET_NAME"
echo "  - GCP Service Account: $GCP_SA_EMAIL"
echo "  - K8s Service Account: $K8S_SA_NAME (namespace: $NAMESPACE)"
echo "  - Workload Identity: Configured"
echo ""
echo "Next steps:"
echo "  1. Deploy/update the sandbox-proxy with environment variables:"
echo "     - GCS_BUCKET_NAME=$BUCKET_NAME"
echo "  2. Apply updated deployment: kubectl apply -f k8s/deployment.yaml"
echo ""
echo "Sandboxes will now persist data to /sandbox which is backed by GCS!"
