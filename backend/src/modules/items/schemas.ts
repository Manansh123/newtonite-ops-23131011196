import { z } from 'zod';
import { ItemStatus, ItemType, Priority } from '@prisma/client';

// "2026-11-01" or a full ISO timestamp -> Date
const dateInput = z
  .union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
  .transform((s) => new Date(s));

// .strict() everywhere: a client cannot smuggle in status / assigneeId / version etc.
export const createItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(''),
    type: z.nativeEnum(ItemType),
    priority: z.nativeEnum(Priority).default('MEDIUM'),
    teamId: z.string().uuid(),
    dueDate: dateInput.nullable().optional(),
  })
  .strict();

export const updateItemSchema = z
  .object({
    version: z.number().int().min(1), // REQUIRED: the version the client last saw
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    type: z.nativeEnum(ItemType).optional(),
    priority: z.nativeEnum(Priority).optional(),
    dueDate: dateInput.nullable().optional(),
  })
  .strict();

export const transitionSchema = z
  .object({
    to: z.nativeEnum(ItemStatus),
    version: z.number().int().min(1),
  })
  .strict();

export const listQuerySchema = z.object({
  view: z.enum(['assigned_to_me', 'unassigned_urgent', 'awaiting_my_approval']).optional(),
  status: z.nativeEnum(ItemStatus).optional(),
  priority: z.nativeEnum(Priority).optional(),
  type: z.nativeEnum(ItemType).optional(),
  teamId: z.string().uuid().optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const commentSchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
