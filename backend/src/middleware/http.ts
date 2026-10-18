import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

/** Basic hardening headers for every response. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
}

/**
 * CORS is only needed when the UI is hosted on a different origin than the API
 * (e.g. UI on Vercel, API on Render). The default deployment serves both from one origin, so
 * nothing is allowed cross-origin unless CORS_ORIGIN lists it. Auth is a bearer token (no cookies),
 * so we never send Access-Control-Allow-Credentials.
 */
export function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.header('Origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Expose-Headers', 'Idempotent-Replayed');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key');
      res.set('Access-Control-Max-Age', '600');
      return res.sendStatus(204);
    }
  }
  next();
}
