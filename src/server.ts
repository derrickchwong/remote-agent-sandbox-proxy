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

// List available sandboxes
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
