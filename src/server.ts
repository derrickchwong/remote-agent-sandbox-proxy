import express, { Request, Response, NextFunction } from 'express';
import * as k8s from '@kubernetes/client-node';

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware to parse JSON
app.use(express.json());

// Kubernetes client setup
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

// Cache for sandbox to service mapping
interface SandboxInfo {
  serviceName: string;
  serviceFQDN: string;
  namespace: string;
  port: number;
  ready: boolean;
}

const sandboxCache = new Map<string, SandboxInfo>();

// Discover sandboxes from Kubernetes
async function discoverSandboxes(): Promise<void> {
  try {
    const response = await k8sApi.listClusterCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      'sandboxes'
    );

    const sandboxes = (response.body as any).items;

    for (const sandbox of sandboxes) {
      const name = sandbox.metadata.name;
      const namespace = sandbox.metadata.namespace || 'default';
      const serviceName = sandbox.status?.service;
      const serviceFQDN = sandbox.status?.serviceFQDN;
      const ready = sandbox.status?.conditions?.find(
        (c: any) => c.type === 'Ready'
      )?.status === 'True';

      if (serviceName) {
        // Use labels to find username (if set)
        const username = sandbox.metadata.labels?.['user'] || 'default';
        const key = `${username}/${name}`;

        sandboxCache.set(key, {
          serviceName,
          serviceFQDN: serviceFQDN || `${serviceName}.${namespace}.svc.cluster.local`,
          namespace,
          port: 8080, // Default port for sandbox runtime
          ready,
        });

        console.log(`Discovered sandbox: ${key} -> ${serviceName} (ready: ${ready})`);
      }
    }
  } catch (error) {
    console.error('Error discovering sandboxes:', error);
  }
}

// Refresh sandbox cache periodically
setInterval(discoverSandboxes, 30000); // Every 30 seconds
discoverSandboxes(); // Initial discovery

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    sandboxes: sandboxCache.size,
    timestamp: new Date().toISOString(),
  });
});

// List available sandboxes (legacy endpoint)
app.get('/sandboxes', (req: Request, res: Response) => {
  const sandboxes: any[] = [];
  sandboxCache.forEach((info, key) => {
    sandboxes.push({
      path: key,
      service: info.serviceName,
      namespace: info.namespace,
      ready: info.ready,
    });
  });

  res.json({
    count: sandboxes.length,
    sandboxes,
  });
});

// API: List all sandboxes with detailed info
app.get('/api/sandboxes', async (req: Request, res: Response) => {
  try {
    const response = await k8sApi.listClusterCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      'sandboxes'
    );

    const sandboxes = (response.body as any).items;

    const sandboxList = sandboxes.map((sb: any) => ({
      name: sb.metadata.name,
      namespace: sb.metadata.namespace || 'default',
      username: sb.metadata.labels?.['user'] || 'default',
      serviceFQDN: sb.status?.serviceFQDN || 'pending',
      service: sb.status?.service || 'pending',
      ready: sb.status?.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True',
      createdAt: sb.metadata.creationTimestamp,
    }));

    res.json({
      count: sandboxList.length,
      sandboxes: sandboxList,
    });
  } catch (error: any) {
    console.error('Error listing sandboxes:', error);
    res.status(500).json({
      error: 'Failed to list sandboxes',
      message: error.message,
    });
  }
});

// API: Get specific sandbox status
app.get('/api/sandboxes/:username/:name', async (req: Request, res: Response) => {
  const { username, name } = req.params;

  try {
    // Get sandbox details
    const response = await k8sApi.getNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      'default', // assuming default namespace, could be parameterized
      'sandboxes',
      name
    );

    const sandbox = response.body as any;

    // Get pod status
    const podSelector = sandbox.status?.selector || `sandbox=${name}`;
    let podStatus = 'unknown';
    let podName = 'unknown';

    try {
      const podResponse = await coreApi.listNamespacedPod(
        'default',
        undefined,
        undefined,
        undefined,
        undefined,
        podSelector
      );

      if (podResponse.body.items && podResponse.body.items.length > 0) {
        const pod = podResponse.body.items[0];
        podName = pod.metadata?.name || 'unknown';
        podStatus = pod.status?.phase || 'unknown';
      }
    } catch (e) {
      console.error('Error getting pod status:', e);
    }

    const ready = sandbox.status?.conditions?.find((c: any) => c.type === 'Ready');

    res.json({
      name: sandbox.metadata.name,
      namespace: sandbox.metadata.namespace,
      username: sandbox.metadata.labels?.['user'] || 'default',
      serviceFQDN: sandbox.status?.serviceFQDN || 'pending',
      service: sandbox.status?.service || 'pending',
      replicas: sandbox.status?.replicas || 0,
      ready: ready?.status === 'True',
      readyReason: ready?.reason,
      readyMessage: ready?.message,
      podName,
      podStatus,
      createdAt: sandbox.metadata.creationTimestamp,
    });
  } catch (error: any) {
    console.error(`Error getting sandbox ${username}/${name}:`, error);
    if (error.statusCode === 404) {
      res.status(404).json({
        error: 'Sandbox not found',
        username,
        name,
      });
    } else {
      res.status(500).json({
        error: 'Failed to get sandbox status',
        message: error.message,
      });
    }
  }
});

// API: Create a new sandbox
app.post('/api/sandboxes', async (req: Request, res: Response) => {
  const { name, username, image, port, namespace } = req.body;

  if (!name) {
    return res.status(400).json({
      error: 'Missing required field: name',
    });
  }

  const sandboxUsername = username || 'default';
  const sandboxImage = image || 'us-central1-docker.pkg.dev/agent-sandbox-476202/agent-sandbox/sandbox-runtime:latest';
  const sandboxNamespace = namespace || 'default';

  // Generate Sandbox CRD
  const sandboxSpec = {
    apiVersion: 'agents.x-k8s.io/v1alpha1',
    kind: 'Sandbox',
    metadata: {
      name: name,
      labels: {
        user: sandboxUsername,
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
        },
        spec: {
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
                { name: 'GOOGLE_CLOUD_PROJECT', value: 'agent-sandbox-476202' },
                { name: 'GOOGLE_CLOUD_LOCATION', value: 'global' },
              ],
            },
          ],
        },
      },
    },
  };

  try {
    const response = await k8sApi.createNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      sandboxNamespace,
      'sandboxes',
      sandboxSpec
    );

    const createdSandbox = response.body as any;

    // Trigger immediate discovery
    await discoverSandboxes();

    res.status(201).json({
      success: true,
      message: `Sandbox '${name}' created successfully`,
      sandbox: {
        name: createdSandbox.metadata.name,
        namespace: createdSandbox.metadata.namespace,
        username: sandboxUsername,
      },
    });
  } catch (error: any) {
    console.error('Error creating sandbox:', error);
    res.status(500).json({
      error: 'Failed to create sandbox',
      message: error.body?.message || error.message,
    });
  }
});

// API: Delete a sandbox
app.delete('/api/sandboxes/:username/:name', async (req: Request, res: Response) => {
  const { username, name } = req.params;
  const namespace = req.query.namespace as string || 'default';

  try {
    await k8sApi.deleteNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      namespace,
      'sandboxes',
      name
    );

    // Remove from cache
    const key = `${username}/${name}`;
    sandboxCache.delete(key);

    res.json({
      success: true,
      message: `Sandbox '${name}' deleted successfully`,
    });
  } catch (error: any) {
    console.error(`Error deleting sandbox ${username}/${name}:`, error);
    if (error.statusCode === 404) {
      res.status(404).json({
        error: 'Sandbox not found',
        username,
        name,
      });
    } else {
      res.status(500).json({
        error: 'Failed to delete sandbox',
        message: error.body?.message || error.message,
      });
    }
  }
});

// Proxy requests to sandboxes
// Route: /{username}/{sandboxname}/*
app.all('/:username/:sandboxname/*', async (req: Request, res: Response) => {
  const { username, sandboxname } = req.params;
  const pathSuffix = req.params[0]; // Everything after /{username}/{sandboxname}/
  const key = `${username}/${sandboxname}`;

  console.log(`Request: ${req.method} /${key}/${pathSuffix}`);

  // Check if sandbox exists
  const sandboxInfo = sandboxCache.get(key);

  if (!sandboxInfo) {
    return res.status(404).json({
      error: 'Sandbox not found',
      path: key,
      available: Array.from(sandboxCache.keys()),
    });
  }

  if (!sandboxInfo.ready) {
    return res.status(503).json({
      error: 'Sandbox not ready',
      path: key,
      service: sandboxInfo.serviceName,
    });
  }

  try {
    // Forward request to sandbox service
    const targetUrl = `http://${sandboxInfo.serviceFQDN}:${sandboxInfo.port}/${pathSuffix}`;

    console.log(`Forwarding to: ${targetUrl}`);

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error: any) {
    console.error(`Error forwarding to sandbox ${key}:`, error);
    res.status(500).json({
      error: 'Failed to communicate with sandbox',
      message: error.message,
      path: key,
    });
  }
});

// Catch-all for invalid routes
app.use((req: Request, res: Response) => {
  res.status(400).json({
    error: 'Invalid path',
    message: 'Expected format: /{username}/{sandboxname}/{endpoint}',
    example: '/alice/my-sandbox/execute',
  });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Sandbox proxy listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
