import express, { Response } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import { userOwnsSandbox } from '../db/queries/sandboxes.js';
import { getSandboxByUserAndName } from '../db/queries/sandboxes.js';
import * as k8s from '@kubernetes/client-node';

const router = express.Router();

// Kubernetes client setup
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);

/**
 * ALL /:sandboxname/*
 * Proxy requests to sandbox
 */
router.all('/:sandboxname/*', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const username = req.user!.username;
    const { sandboxname } = req.params;
    const pathSuffix = req.params[0]; // Everything after /:sandboxname/

    console.log(`Proxy request: ${req.method} /${username}/${sandboxname}/${pathSuffix}`);

    // Check ownership
    const hasAccess = await userOwnsSandbox(userId, sandboxname);

    if (!hasAccess) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have access to this sandbox',
      });
      return;
    }

    // Get sandbox details from DB
    const sandbox = await getSandboxByUserAndName(userId, sandboxname);

    if (!sandbox) {
      res.status(404).json({
        error: 'Sandbox not found',
      });
      return;
    }

    // Get K8s status to find service FQDN
    const response = await k8sApi.getNamespacedCustomObject(
      'agents.x-k8s.io',
      'v1alpha1',
      sandbox.namespace,
      'sandboxes',
      sandbox.k8s_resource_name
    );

    const k8sSandbox = response.body as any;
    const serviceFQDN = k8sSandbox.status?.serviceFQDN;
    const ready =
      k8sSandbox.status?.conditions?.find((c: any) => c.type === 'Ready')?.status ===
      'True';

    if (!serviceFQDN) {
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Sandbox service not ready',
      });
      return;
    }

    if (!ready) {
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Sandbox not ready',
      });
      return;
    }

    // Forward request to sandbox service
    const targetUrl = `http://${serviceFQDN}:8080/${pathSuffix}`;
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

    const proxyResponse = await fetch(targetUrl, fetchOptions);
    const data = await proxyResponse.json();

    res.status(proxyResponse.status).json(data);
  } catch (error: any) {
    console.error('Error proxying request:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
