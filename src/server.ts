import express, { Request, Response, NextFunction } from 'express';
import { testConnection, closePool } from './db/pool.js';
import adminRoutes from './routes/admin.js';
import userRoutes from './routes/user.js';
import sandboxRoutes from './routes/sandboxes.js';
import proxyRoutes from './routes/proxy.js';

const app = express();
const PORT = process.env.PORT || 8080;

// Validate required environment variables
const requiredEnvVars = [
  'GOOGLE_CLOUD_PROJECT',
  'GCS_BUCKET_NAME',
  'GCS_SERVICE_ACCOUNT',
  'DEFAULT_SANDBOX_IMAGE',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'ADMIN_API_KEY',
];

for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    throw new Error(`${varName} environment variable is required`);
  }
}

// Middleware to parse JSON
app.use(express.json());

// Test database connection
async function initializeDatabase() {
  try {
    await testConnection();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

// Initialize database before starting server
await initializeDatabase();

// Health check endpoint (public)
app.get('/health', async (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: 'connected',
  });
});

// Mount routes
app.use('/api/admin', adminRoutes);
app.use('/api', userRoutes);
app.use('/api/sandboxes', sandboxRoutes);
app.use('/proxy', proxyRoutes);

// Catch-all for invalid routes
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    endpoints: {
      health: 'GET /health',
      admin: {
        users: 'POST|GET /api/admin/users',
        user: 'GET|PUT|DELETE /api/admin/users/:userId',
        apiKeys: 'POST /api/admin/users/:userId/apikeys',
        listKeys: 'GET /api/admin/users/:userId/apikeys',
        revokeKey: 'DELETE /api/admin/apikeys/:keyId',
      },
      user: {
        me: 'GET /api/me',
        apiKeys: 'POST|GET /api/me/apikeys',
        revokeKey: 'DELETE /api/me/apikeys/:keyId',
      },
      sandboxes: {
        list: 'GET /api/sandboxes',
        create: 'POST /api/sandboxes',
        get: 'GET /api/sandboxes/:name',
        delete: 'DELETE /api/sandboxes/:name',
        pause: 'POST /api/sandboxes/:name/pause',
        resume: 'POST /api/sandboxes/:name/resume',
      },
      proxy: 'ALL /proxy/:sandboxname/*',
    },
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await closePool();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Sandbox proxy listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('Authentication enabled - API key required for most endpoints');
});
