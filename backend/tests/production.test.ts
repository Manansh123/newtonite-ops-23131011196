import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { config } from '../src/config';
import { createApp } from '../src/app';
import { prisma } from './helpers';

// Production behaviour: health check, same-origin SPA serving, and CORS for split deployments.
describe('production serving and CORS', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>SPA</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');

  const saved = { serve: config.serveFrontend, dist: config.frontendDist, cors: config.corsOrigins };
  afterEach(() => {
    config.serveFrontend = saved.serve;
    config.frontendDist = saved.dist;
    config.corsOrigins = saved.cors;
  });
  afterAll(() => prisma.$disconnect());

  it('health check verifies database connectivity', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: true });
  });

  it('serves index.html for any non-API path (SPA refresh / deep links), with no-cache', async () => {
    config.serveFrontend = true;
    config.frontendDist = dist;
    const app = createApp();
    for (const p of ['/', '/login', '/items/123/edit']) {
      const res = await request(app).get(p);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<title>SPA</title>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('keeps API errors as JSON (an unknown /api route is never the SPA page) and caches hashed assets', async () => {
    config.serveFrontend = true;
    config.frontendDist = dist;
    const app = createApp();
    const api404 = await request(app).get('/api/nope');
    expect(api404.status).toBe(404);
    expect(api404.body.error.code).toBe('NOT_FOUND');
    const asset = await request(app).get('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await request(app).get('/assets/missing.js')).status).toBe(404);
  });

  it('refuses to start with SERVE_FRONTEND on but no build present (fail loudly, not blank page)', () => {
    config.serveFrontend = true;
    config.frontendDist = path.join(dist, 'does-not-exist');
    expect(() => createApp()).toThrow(/npm run build/);
  });

  it('does not serve the UI when serving is off (API-only mode)', async () => {
    config.serveFrontend = false;
    expect((await request(createApp()).get('/')).status).toBe(404);
  });

  it('CORS: an allow-listed origin gets headers and a 204 preflight; others get none; no credentials', async () => {
    config.corsOrigins = ['https://ui.example.com'];
    const app = createApp();
    const pre = await request(app)
      .options('/api/items')
      .set('Origin', 'https://ui.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://ui.example.com');
    expect(pre.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/);
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();

    const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');
    expect(evil.status).toBe(200);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends basic security headers and hides x-powered-by', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
