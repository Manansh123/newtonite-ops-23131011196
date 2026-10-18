/**
 * Seed (see src/cli/seed.ts): 4 teams, 10 users (every role, some in several teams), ~3000 work items with
 * consistent activity history and some comments. DESTRUCTIVE: wipes all tables first.
 * Deterministic (seeded PRNG) so every run produces the same data shape.
 */
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import type { ActivityType, ItemStatus, ItemType, Prisma, Priority, Role } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';

const itemCount = () => Number(process.env.SEED_ITEMS ?? 3000);
export const DEMO_PASSWORD = 'Password123!';

// mulberry32: tiny deterministic PRNG
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const weighted = <T>(pairs: [T, number][]): T => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[pairs.length - 1]![0];
};

const TEAMS = ['Payments Ops', 'Customer Support', 'Compliance', 'Platform Incidents'];

const USERS: { email: string; name: string; memberships: [string, Role][] }[] = [
  { email: 'asha.admin@ops.test', name: 'Asha Admin', memberships: TEAMS.map((t) => [t, 'ADMIN']) },
  { email: 'priya.lead@ops.test', name: 'Priya Sharma', memberships: [['Payments Ops', 'LEAD'], ['Compliance', 'MEMBER']] },
  { email: 'rahul.lead@ops.test', name: 'Rahul Verma', memberships: [['Customer Support', 'LEAD']] },
  { email: 'neha.lead@ops.test', name: 'Neha Iyer', memberships: [['Compliance', 'LEAD']] },
  { email: 'vikram.lead@ops.test', name: 'Vikram Singh', memberships: [['Platform Incidents', 'LEAD']] },
  { email: 'aman.member@ops.test', name: 'Aman Gupta', memberships: [['Payments Ops', 'MEMBER'], ['Customer Support', 'MEMBER']] },
  { email: 'sana.member@ops.test', name: 'Sana Khan', memberships: [['Customer Support', 'MEMBER']] },
  { email: 'rohan.member@ops.test', name: 'Rohan Mehta', memberships: [['Compliance', 'MEMBER'], ['Platform Incidents', 'MEMBER']] },
  { email: 'isha.member@ops.test', name: 'Isha Patel', memberships: [['Platform Incidents', 'MEMBER']] },
  { email: 'kabir.viewer@ops.test', name: 'Kabir Das', memberships: [['Payments Ops', 'VIEWER'], ['Customer Support', 'VIEWER']] },
];

const TITLES: Record<ItemType, string[]> = {
  INCIDENT: ['Payment gateway latency spike', 'Login API returning 500 errors', 'Database replica lag', 'Checkout page timing out', 'Message queue backlog growing'],
  CUSTOMER_ISSUE: ['Customer cannot reset password', 'Order shows wrong delivery address', 'Refund not received', 'Duplicate email notifications', 'Account locked after failed login'],
  PAYMENT: ['Settlement mismatch with bank', 'Chargeback dispute needs review', 'Failed UPI payout retry', 'Merchant payout delayed', 'Card refund stuck in pending'],
  COMPLIANCE: ['KYC document expired', 'Quarterly audit evidence request', 'Suspicious transaction review', 'Data retention policy exception', 'AML report discrepancy'],
  TASK: ['Update runbook for on-call', 'Rotate API credentials', 'Clean up stale feature flags', 'Review dashboard alert thresholds', 'Document escalation process'],
};
const CONTEXT = ['Mumbai region', 'Delhi region', 'merchant batch 12', 'enterprise customer', 'mobile app', 'web checkout', 'partner bank', 'EU users'];
const TYPES = Object.keys(TITLES) as ItemType[];
const ROLE_RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, LEAD: 2, ADMIN: 3 };
const PATH: ItemStatus[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'];
const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export async function seedDatabase() {
  console.log(`Seeding ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')} ...`);
  await prisma.$executeRawUnsafe(
    'TRUNCATE comments, activity_events, idempotency_keys, work_items, memberships, users, teams RESTART IDENTITY CASCADE',
  );

  const teamIds = new Map<string, string>();
  for (const name of TEAMS) teamIds.set(name, (await prisma.team.create({ data: { name } })).id);

  const hash = await bcrypt.hash(DEMO_PASSWORD, config.bcryptRounds);
  const users: { id: string; name: string; email: string }[] = [];
  const teamWorkers = new Map<string, { id: string; name: string; role: Role }[]>(); // MEMBER+ per team
  for (const u of USERS) {
    const created = await prisma.user.create({
      data: {
        email: u.email,
        name: u.name,
        passwordHash: hash,
        memberships: { create: u.memberships.map(([t, role]) => ({ teamId: teamIds.get(t)!, role })) },
      },
    });
    users.push({ id: created.id, name: u.name, email: u.email });
    for (const [t, role] of u.memberships) {
      if (ROLE_RANK[role] < ROLE_RANK.MEMBER) continue;
      const tid = teamIds.get(t)!;
      teamWorkers.set(tid, [...(teamWorkers.get(tid) ?? []), { id: created.id, name: u.name, role }]);
    }
  }

  const now = Date.now();
  const DAY = 86_400_000;
  const items: Prisma.WorkItemCreateManyInput[] = [];
  const events: { itemId: string; actorId: string; type: ActivityType; fromValue: string | null; toValue: string | null; createdAt: Date }[] = [];
  const itemMeta: { id: string; teamId: string; lastAt: number }[] = [];

  for (let n = 1; n <= itemCount(); n++) {
    const teamId = pick([...teamIds.values()]);
    const workers = teamWorkers.get(teamId)!;
    const leads = workers.filter((w) => ROLE_RANK[w.role] >= ROLE_RANK.LEAD);
    const creator = pick(workers);
    const type = pick(TYPES);
    const status = weighted<ItemStatus>([['OPEN', 30], ['IN_PROGRESS', 30], ['AWAITING_APPROVAL', 15], ['RESOLVED', 15], ['CLOSED', 10]]);
    const priority = weighted<Priority>([['LOW', 25], ['MEDIUM', 40], ['HIGH', 22], ['URGENT', 13]]);
    const assignee = status === 'OPEN' ? null : pick(workers);
    const createdAtMs = now - DAY - Math.floor(rand() * 89 * DAY);
    const id = randomUUID();
    const title = `${pick(TITLES[type])} (${pick(CONTEXT)}) [OPS-${1000 + n}]`;

    let t = createdAtMs;
    const ev = (actorId: string, type: ActivityType, from: string | null, to: string | null) => {
      events.push({ itemId: id, actorId, type, fromValue: from, toValue: to, createdAt: new Date(t) });
      t += (5 + Math.floor(rand() * 600)) * 60_000;
    };

    ev(creator.id, 'CREATED', null, 'OPEN');
    let version = 1;
    const reached = PATH.indexOf(status);
    for (let i = 1; i <= reached; i++) {
      const from = PATH[i - 1]!;
      const to = PATH[i]!;
      if (i === 1) ev(assignee!.id, 'ASSIGNED', null, assignee!.name);
      const actor = to === 'RESOLVED' || to === 'CLOSED' ? pick(leads) : assignee!;
      ev(actor.id, 'STATUS_CHANGED', from, to);
      version++;
    }
    if (rand() < 0.1) {
      const from = pick(PRIORITIES.filter((p) => p !== priority));
      // history reads: created at `from`, later changed to `priority` (the current value)
      ev(pick(leads).id, 'PRIORITY_CHANGED', from, priority);
      version++;
    }

    items.push({
      id, title,
      description: `Reported via ${pick(['monitoring alert', 'customer call', 'internal audit', 'partner email', 'on-call handoff'])}. ${pick(CONTEXT)} affected; investigate and update status.`,
      type, priority, status, teamId, assigneeId: assignee?.id ?? null, createdById: creator.id,
      dueDate: rand() < 0.6 ? new Date(createdAtMs + (1 + Math.floor(rand() * 21)) * DAY) : null,
      version, createdAt: new Date(createdAtMs), updatedAt: new Date(t - 60_000),
    });
    itemMeta.push({ id, teamId, lastAt: t });
  }

  // A few comments (each also recorded as a COMMENT_ADDED event, like the real API does)
  const comments: { itemId: string; authorId: string; body: string; createdAt: Date }[] = [];
  for (const m of itemMeta.filter(() => rand() < 0.08)) {
    const author = pick(teamWorkers.get(m.teamId)!);
    const body = pick(['Looking into this now.', 'Waiting on the partner bank to respond.', 'Escalated to the on-call lead.', 'Customer confirmed the fix works.', 'Need more logs before I can proceed.']);
    const createdAt = new Date(m.lastAt + 60_000);
    comments.push({ itemId: m.id, authorId: author.id, body, createdAt });
    events.push({ itemId: m.id, actorId: author.id, type: 'COMMENT_ADDED', fromValue: null, toValue: body, createdAt });
  }

  const chunk = <T>(arr: T[], size: number) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * size));
  for (const c of chunk(items, 500)) await prisma.workItem.createMany({ data: c });
  for (const c of chunk(events, 1000)) await prisma.activityEvent.createMany({ data: c });
  for (const c of chunk(comments, 500)) await prisma.comment.createMany({ data: c });

  console.log(`Created ${TEAMS.length} teams, ${users.length} users, ${items.length} items, ${events.length} activity events, ${comments.length} comments.\n`);
  console.log(`Demo login (password for everyone: ${DEMO_PASSWORD})`);
  for (const u of USERS) console.log(`  ${u.email.padEnd(26)} ${u.memberships.map(([t, r]) => `${t}:${r}`).join(', ')}`);
}

