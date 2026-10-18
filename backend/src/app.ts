import fs from 'fs';
import path from 'path';
import express from 'express';
import { config } from './config';
import { prisma } from './lib/prisma';
import { authRouter } from './modules/auth/routes';
import { itemsRouter } from './modules/items/routes';
import { errorHandler } from './middleware/errorHandler';
import { cors, securityHeaders } from './middleware/http';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(cors);
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  // Liveness + database connectivity (used by the hosting platform's health check).
  api.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });
  api.use('/auth', authRouter);
  api.use('/items', itemsRouter);
  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  // Production: serve the built React app from the same origin as the API, with SPA fallback
  // so a browser refresh on /items/<id> returns index.html instead of a 404.
  const indexHtml = path.join(config.frontendDist, 'index.html');
  if (config.serveFrontend) {
    if (!fs.existsSync(indexHtml)) {
      throw new Error(`SERVE_FRONTEND is on but ${indexHtml} does not exist. Run "npm run build" first.`);
    }
    app.use(
      '/assets',
      express.static(path.join(config.frontendDist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }),
    );
    app.use(express.static(config.frontendDist, { index: false }));
    app.get(/.*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}
