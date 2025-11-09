import express, { Response } from 'express';
import * as k8s from '@kubernetes/client-node';
import { Storage } from '@google-cloud/storage';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import { authorizeSandboxAccess } from '../middleware/authorize.js';
import {
  createSandbox as createSandboxDb,
  getSandboxByUserAndName,
  listSandboxesByUser,
  deleteSandboxByUserAndName,
} from '../db/queries/sandboxes.js';
import { createAuditLog } from '../db/queries/auditLogs.js';

const router = express.Router();

// Kubernetes client setup
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);

// Google Cloud Storage client setup
const storage = new Storage();

// Environment variables
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT!;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME!;
const GCS_SERVICE_ACCOUNT = process.env.GCS_SERVICE_ACCOUNT!;
const DEFAULT_SANDBOX_IMAGE = process.env.DEFAULT_SANDBOX_IMAGE!;

// Helper: Create namespace with resource quotas and network policies
async function ensureNamespaceExists(namespace: string): Promise<void> {
  try {
    await coreApi.readNamespace(namespace);
    console.log(`Namespace ${namespace} already exists`);
  } catch (error: any) {
    if (error.statusCode === 404) {
      // Namespace doesn't exist, create it
      console.log(`Creating namespace: ${namespace}`);
      await coreApi.createNamespace({
        metadata: {
          name: namespace,
          labels: {
            name: namespace,
            'managed-by': 'sandbox-proxy',
          },
        },
      });
      console.log(`Namespace ${namespace} created`);

      // Create resource quota for the namespace
      try {
        await coreApi.createNamespacedResourceQuota(namespace, {
          metadata: {
            name: 'user-quota',
          },
          spec: {
            hard: {
              'requests.cpu': '4',
              'requests.memory': '8Gi',
              'limits.cpu': '8',
              'limits.memory': '16Gi',
              persistentvolumeclaims: '5',
              'count/sandboxes.agents.x-k8s.io': '10',
            },
          },
        });
        console.log(`Resource quota created for namespace ${namespace}`);
      } catch (quotaError) {
        console.error(`Failed to create resource quota for ${namespace}:`, quotaError);
      }

      // Create network policy to isolate namespace
      try {
        await networkingApi.createNamespacedNetworkPolicy(namespace, {
          metadata: {
            name: 'allow-from-default',
          },
          spec: {
            podSelector: {},
            policyTypes: ['Ingress'],
            ingress: [
              {
                // Allow traffic from default namespace (where proxy runs)
                from: [
                  {
                    namespaceSelector: {
                      matchLabels: {
                        'kubernetes.io/metadata.name': 'default',
                      },
                    },
                  },
                  // Allow traffic within same namespace
                  {
                    podSelector: {},
                  },
                ],
              },
            ],
          },
        });
        console.log(`Network policy created for namespace ${namespace}`);
      } catch (netpolError) {
        console.error(`Failed to create network policy for ${namespace}:`, netpolError);
      }
    } else {
      throw error;
    }
  }
}

// Helper: Create GCS folder
async function createGCSFolder(folderPath: string): Promise<void> {
  try {
    const bucket = storage.bucket(GCS_BUCKET_NAME);
    const file = bucket.file(`${folderPath}/`);

    const [exists] = await file.exists();
    if (!exists) {
      await file.save('', {
        metadata: {
          contentType: 'application/x-directory',
        },
      });
      console.log(`Created GCS folder: gs://${GCS_BUCKET_NAME}/${folderPath}/`);
    }
  } catch (error) {
    console.error(`Error creating GCS folder ${folderPath}:`, error);
    throw error;
  }
}

/**
 * GET /api/sandboxes
 * List sandboxes for authenticated user
 */
router.get('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const username = req.user!.username;

    // Get sandboxes from database
    const sandboxes = await listSandboxesByUser(userId);

    // Get status from Kubernetes for each sandbox
    const sandboxList = await Promise.all(
      sandboxes.map(async (sb) => {
        try {
          const response = await k8sApi.getNamespacedCustomObject(
            'agents.x-k8s.io',
            'v1alpha1',
            sb.namespace,
            'sandboxes',
            sb.k8s_resource_name
          );

          const k8sSandbox = response.body as any;

          return {
            name: sb.name,
            namespace: sb.namespace,
            serviceFQDN: k8sSandbox.status?.serviceFQDN || 'pending',
            service: k8sSandbox.status?.service || 'pending',
            ready:
              k8sSandbox.status?.conditions?.find((c: any) => c.type === 'Ready')
                ?.status === 'True',
            createdAt: sb.created_at,
          };
        } catch (error) {
          // Sandbox might be deleted from K8s but still in DB
          return {
            name: sb.name,
            namespace: sb.namespace,
            serviceFQDN: 'error',
            service: 'error',
            ready: false,
            createdAt: sb.created_at,
          };
        }
      })
    );

    res.json({
      count: sandboxList.length,
      sandboxes: sandboxList,
    });
  } catch (error: any) {
    console.error('Error listing sandboxes:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/sandboxes
 * Create a new sandbox for authenticated user
 */
router.post('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const username = req.user!.username;
    const { name, image } = req.body;

    if (!name) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'name is required',
      });
      return;
    }

    // Check if user already has a sandbox with this name
    const existing = await getSandboxByUserAndName(userId, name);
    if (existing) {
      res.status(409).json({
        error: 'Conflict',
        message: `Sandbox '${name}' already exists`,
      });
      return;
    }

    const sandboxImage = image || DEFAULT_SANDBOX_IMAGE;
    const userNamespace = `user-${username}`;
    const k8sResourceName = name; // Same as sandbox name

    // Create namespace if it doesn't exist
    await ensureNamespaceExists(userNamespace);

    // Create GCS folder: username/sandboxname/
    const gcsFolderPath = `${username}/${name}`;
    await createGCSFolder(gcsFolderPath);

    // Generate Sandbox CRD
    const sandboxSpec = {
      apiVersion: 'agents.x-k8s.io/v1alpha1',
      kind: 'Sandbox',
      metadata: {
        name: k8sResourceName,
        labels: {
          user: username,
          'managed-by': 'sandbox-proxy',
        },
      },
      spec: {
        podTemplate: {
          metadata: {
            labels: {
              sandbox: name,
              'managed-by': 'sandbox-proxy',
            },
            annotations: {
              'gke-gcsfuse/volumes': 'true',
            },
          },
          spec: {
            serviceAccountName: 'sandbox-gcs-ksa',
            initContainers: [
              {
                name: 'setup-gemini-config',
                image: 'busybox:latest',
                command: ['sh', '-c'],
                args: [
                  `mkdir -p /home/gem/.gemini && cat > /home/gem/.gemini/settings.json << 'EOFJSON'
{
  "auth": {
    "provider": "vertexai",
    "projectId": "${GOOGLE_CLOUD_PROJECT}",
    "location": "global"
  },
  "mcpServers": {
    "sandbox": {
      "httpUrl": "http://localhost:8080/mcp",
      "args": []
    }
  }
}
EOFJSON
chown -R 1000:1000 /home/gem/.gemini
chmod 755 /home/gem/.gemini
chmod 644 /home/gem/.gemini/settings.json`,
                ],
                volumeMounts: [
                  {
                    name: 'gem-home',
                    mountPath: '/home/gem',
                  },
                ],
              },
            ],
            containers: [
              {
                name: 'sandbox-runtime',
                image: sandboxImage,
                imagePullPolicy: 'IfNotPresent',
                ports: [
                  { containerPort: 5900, name: 'vnc' },
                  { containerPort: 8080, name: 'public' },
                  { containerPort: 8081, name: 'auth-backend' },
                  { containerPort: 6080, name: 'websocket-proxy' },
                  { containerPort: 8088, name: 'gem-server' },
                  { containerPort: 8079, name: 'mcp-hub' },
                  { containerPort: 8091, name: 'sandbox-srv' },
                  { containerPort: 8888, name: 'jupyter-lab' },
                  { containerPort: 8200, name: 'code-server' },
                  { containerPort: 8100, name: 'mcp-browser' },
                  { containerPort: 8118, name: 'tinyproxy' },
                  { containerPort: 8101, name: 'mcp-markitdown' },
                  { containerPort: 8102, name: 'mcp-devtools' },
                  { containerPort: 9222, name: 'browser-debug' },
                ],
                env: [
                  { name: 'GOOGLE_GENAI_USE_VERTEXAI', value: 'true' },
                  { name: 'GOOGLE_CLOUD_PROJECT', value: GOOGLE_CLOUD_PROJECT },
                  { name: 'GOOGLE_CLOUD_LOCATION', value: 'global' },
                ],
                volumeMounts: [
                  {
                    name: 'gcs-storage',
                    mountPath: '/sandbox',
                  },
                  {
                    name: 'gem-home',
                    mountPath: '/home/gem',
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'gcs-storage',
                csi: {
                  driver: 'gcsfuse.csi.storage.gke.io',
                  volumeAttributes: {
                    bucketName: GCS_BUCKET_NAME,
                    mountOptions: `only-dir=${gcsFolderPath},file-mode=0666,dir-mode=0777,implicit-dirs`,
                  },
                },
              },
              {
                name: 'gem-home',
                emptyDir: {},
              },
            ],
          },
        },
      },
    };

    // Create in Kubernetes
    await k8sApi.createNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      userNamespace,
      'sandboxes',
      sandboxSpec
    );

    // Record in database
    await createSandboxDb(userId, name, userNamespace, k8sResourceName, sandboxImage);

    await createAuditLog(userId, 'create_sandbox', 'success', {
      resourceType: 'sandbox',
      resourceId: name,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      details: { name, namespace: userNamespace, image: sandboxImage },
    });

    res.status(201).json({
      success: true,
      message: `Sandbox '${name}' created successfully`,
      sandbox: {
        name,
        namespace: userNamespace,
        image: sandboxImage,
      },
    });
  } catch (error: any) {
    console.error('Error creating sandbox:', error);

    await createAuditLog(req.user!.id, 'create_sandbox', 'failed', {
      resourceType: 'sandbox',
      details: { error: error.message },
    });

    res.status(500).json({
      error: 'Internal server error',
      message: error.body?.message || error.message,
    });
  }
});

/**
 * GET /api/sandboxes/:name
 * Get sandbox status
 */
router.get('/:name', authenticate, authorizeSandboxAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.params;

    const sandbox = await getSandboxByUserAndName(userId, name);

    if (!sandbox) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Sandbox not found',
      });
      return;
    }

    // Get K8s status
    const response = await k8sApi.getNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      sandbox.namespace,
      'sandboxes',
      sandbox.k8s_resource_name
    );

    const k8sSandbox = response.body as any;
    const ready = k8sSandbox.status?.conditions?.find((c: any) => c.type === 'Ready');

    res.json({
      name: sandbox.name,
      namespace: sandbox.namespace,
      serviceFQDN: k8sSandbox.status?.serviceFQDN || 'pending',
      service: k8sSandbox.status?.service || 'pending',
      replicas: k8sSandbox.status?.replicas || 0,
      ready: ready?.status === 'True',
      readyReason: ready?.reason,
      readyMessage: ready?.message,
      createdAt: sandbox.created_at,
    });
  } catch (error: any) {
    console.error('Error getting sandbox:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/sandboxes/:name
 * Delete sandbox
 */
router.delete('/:name', authenticate, authorizeSandboxAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.params;

    const sandbox = await getSandboxByUserAndName(userId, name);

    if (!sandbox) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Sandbox not found',
      });
      return;
    }

    // Delete from Kubernetes
    await k8sApi.deleteNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      sandbox.namespace,
      'sandboxes',
      sandbox.k8s_resource_name
    );

    // Delete from database
    await deleteSandboxByUserAndName(userId, name);

    await createAuditLog(userId, 'delete_sandbox', 'success', {
      resourceType: 'sandbox',
      resourceId: name,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      message: `Sandbox '${name}' deleted successfully`,
    });
  } catch (error: any) {
    console.error('Error deleting sandbox:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.body?.message || error.message,
    });
  }
});

/**
 * POST /api/sandboxes/:name/pause
 * Pause sandbox (set replicas to 0)
 */
router.post('/:name/pause', authenticate, authorizeSandboxAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.params;

    const sandbox = await getSandboxByUserAndName(userId, name);

    if (!sandbox) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Sandbox not found',
      });
      return;
    }

    // Get current sandbox
    const response = await k8sApi.getNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      sandbox.namespace,
      'sandboxes',
      sandbox.k8s_resource_name
    );

    const k8sSandbox = response.body as any;

    // Update spec to set replicas to 0
    const updatedSandbox = {
      ...k8sSandbox,
      spec: {
        ...k8sSandbox.spec,
        replicas: 0,
      },
    };

    await k8sApi.replaceNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      sandbox.namespace,
      'sandboxes',
      sandbox.k8s_resource_name,
      updatedSandbox
    );

    await createAuditLog(userId, 'pause_sandbox', 'success', {
      resourceType: 'sandbox',
      resourceId: name,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      message: `Sandbox '${name}' paused successfully`,
      replicas: 0,
    });
  } catch (error: any) {
    console.error('Error pausing sandbox:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.body?.message || error.message,
    });
  }
});

/**
 * POST /api/sandboxes/:name/resume
 * Resume sandbox (set replicas to 1)
 */
router.post('/:name/resume', authenticate, authorizeSandboxAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.params;

    const sandbox = await getSandboxByUserAndName(userId, name);

    if (!sandbox) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Sandbox not found',
      });
      return;
    }

    // Get current sandbox
    const response = await k8sApi.getNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      sandbox.namespace,
      'sandboxes',
      sandbox.k8s_resource_name
    );

    const k8sSandbox = response.body as any;

    // Update spec to set replicas to 1
    const updatedSandbox = {
      ...k8sSandbox,
      spec: {
        ...k8sSandbox.spec,
        replicas: 1,
      },
    };

    await k8sApi.replaceNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      sandbox.namespace,
      'sandboxes',
      sandbox.k8s_resource_name,
      updatedSandbox
    );

    await createAuditLog(userId, 'resume_sandbox', 'success', {
      resourceType: 'sandbox',
      resourceId: name,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      message: `Sandbox '${name}' resumed successfully`,
      replicas: 1,
    });
  } catch (error: any) {
    console.error('Error resuming sandbox:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.body?.message || error.message,
    });
  }
});

export default router;
