import { Router } from 'express';
import { currentUser } from '../../middleware/auth';
import { runIdempotent } from '../idempotency/idempotency';
import { commentSchema } from '../items/schemas';
import { addComment, listComments } from './service';

export const commentsRouter = Router({ mergeParams: true });

commentsRouter.get('/', async (req, res) => {
  res.json({ comments: await listComments(currentUser(req), (req.params as { id: string }).id) });
});

// Idempotency-Key REQUIRED: a double-clicked "Post" must not create two comments.
commentsRouter.post('/', async (req, res) => {
  const user = currentUser(req);
  const { body } = commentSchema.parse(req.body);
  const out = await runIdempotent(req, user.id, { required: true }, async (tx) => ({
    status: 201,
    body: await addComment(tx, user, (req.params as { id: string }).id, body),
  }));
  if (out.replayed) res.set('Idempotent-Replayed', 'true');
  res.status(out.status).json(out.body);
});
