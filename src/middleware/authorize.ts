import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.js';
import { userOwnsSandbox } from '../db/queries/sandboxes.js';

/**
 * Authorization middleware - checks if user owns the sandbox
 * Requires authenticate middleware to run first
 */
export async function authorizeSandboxAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    // Extract sandbox name from route params
    const sandboxName = req.params.name || req.params.sandboxname;

    if (!sandboxName) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Sandbox name is required',
      });
      return;
    }

    // Check ownership
    const hasAccess = await userOwnsSandbox(req.user.id, sandboxName);

    if (!hasAccess) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have access to this sandbox',
      });
      return;
    }

    // User owns the sandbox, continue
    next();
  } catch (error) {
    console.error('Authorization error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to authorize request',
    });
  }
}
