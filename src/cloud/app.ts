import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { cloudSyncRouter } from './sync-router';
import { query } from './postgres';

export const cloudApp = express();

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

cloudApp.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Origin is not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
cloudApp.use(express.json({ limit: '5mb' }));

cloudApp.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', database: 'neon-postgres' });
  } catch (error) {
    console.error('Cloud health check failed', error);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

cloudApp.use('/api/sync', cloudSyncRouter);

cloudApp.use('/api', (_req, res) => {
  res.status(501).json({
    error: 'Cloud module migration in progress',
    available: ['/api/health', '/api/sync/devices', '/api/sync/push', '/api/sync/pull'],
  });
});

cloudApp.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Cloud API request failed', error);
  const status = error.message === 'Device is not registered' ? 403 : 400;
  res.status(status).json({ error: error.message || 'Request failed' });
});
