import { Router } from 'express';
import { currentUser, requireAuth } from '../../middleware/auth';
import { runIdempotent } from '../idempotency/idempotency';
import { prisma } from '../../lib/prisma';
import { listActivity } from '../activity/activity';
import { commentsRouter } from '../comments/routes';
import { createItemSchema, listQuerySchema, transitionSchema, updateItemSchema } from './schemas';
import { claimItem, createItem, getItem, listItems, transitionItem, updateItem } from './service';

export const itemsRouter = Router();
itemsRouter.use(requireAuth);

const send = (res: import('express').Response, out: { status: number; body: unknown; replayed: boolean }) => {
  if (out.replayed) res.set('Idempotent-Replayed', 'true');
  res.status(out.status).json(out.body);
};

itemsRouter.get('/', async (req, res) => {
  const query = listQuerySchema.parse(req.query);
  res.json(await listItems(currentUser(req), query));
});

// Idempotency-Key REQUIRED on create.
itemsRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const input = createItemSchema.parse(req.body); // validate BEFORE touching the idempotency table
  const out = await runIdempotent(req, user.id, { required: true }, async (tx) => ({
    status: 201,
    body: await createItem(tx, user, input),
  }));
  send(res, out);
});

itemsRouter.get('/:id', async (req, res) => {
  res.json(await getItem(currentUser(req), req.params.id));
});

// Optimistic locking: body must carry the `version` the client last saw.
itemsRouter.patch('/:id', async (req, res) => {
  const user = currentUser(req);
  const input = updateItemSchema.parse(req.body);
  const body = await prisma.$transaction((tx) => updateItem(tx, user, req.params.id, input));
  res.json(body);
});

// Idempotency-Key optional (honoured if sent): a retried claim returns the original 200, not 409.
itemsRouter.post('/:id/claim', async (req, res) => {
  const user = currentUser(req);
  const out = await runIdempotent(req, user.id, { required: false }, async (tx) => ({
    status: 200,
    body: await claimItem(tx, user, req.params.id),
  }));
  send(res, out);
});

itemsRouter.post('/:id/transition', async (req, res) => {
  const user = currentUser(req);
  const input = transitionSchema.parse(req.body);
  const out = await runIdempotent(req, user.id, { required: false }, async (tx) => ({
    status: 200,
    body: await transitionItem(tx, user, req.params.id, input.to, input.version),
  }));
  send(res, out);
});

itemsRouter.get('/:id/activity', async (req, res) => {
  res.json({ events: await listActivity(currentUser(req), req.params.id) });
});

itemsRouter.use('/:id/comments', commentsRouter);
