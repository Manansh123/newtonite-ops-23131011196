// Real-browser end-to-end suite. Drives the actual UI (headless Chrome) against a RUNNING app and
// cross-checks what the UI shows against direct database counts.
//
//   E2E_BASE_URL       default http://localhost:4100   (the production server serves API + UI together)
//   E2E_DATABASE_URL   database the app is using (for count cross-checks)
//   CHROME_PATH        path to Chrome/Chromium (on Linux a bundled Chromium is used if unset)
//
// NOTE: it creates a few items/comments (titles start with "E2E "). Point it at a demo/seeded database.
import puppeteer from 'puppeteer-core';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const BASE = (process.env.E2E_BASE_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const DB_URL = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://ops:ops@localhost:5432/ops';
const PW = 'Password123!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ tiny test harness
const results = [];
const pageErrors = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \u2714 ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  \u2718 ${name}\n      ${e.message.split('\n')[0]}`);
    if (process.env.E2E_BAIL) { console.log('E2E_BAIL: stopping at first failure'); process.exit(1); }
  }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (t) => console.log(`\n== ${t}`);

// ------------------------------------------------------------------ database + api helpers
const db = new pg.Client({ connectionString: DB_URL });
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await q(sql, params))[0].count);

async function api(token, method, path, body, headers = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const loginApi = async (email) => (await api(null, 'POST', '/auth/login', { email, password: PW })).body.token;
const createViaApi = async (token, fields) =>
  (await api(token, 'POST', '/items', fields, { 'Idempotency-Key': randomUUID() })).body;

// ------------------------------------------------------------------ browser helpers
async function launch() {
  if (process.env.CHROME_PATH) return puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  if (process.platform === 'linux') {
    const chromium = (await import('@sparticuz/chromium')).default;
    // --single-process (a serverless default) cannot host several isolated browser contexts, so drop it
    const args = chromium.args.filter((a) => a !== '--single-process');
    return puppeteer.launch({ args, executablePath: await chromium.executablePath(), headless: 'shell' });
  }
  throw new Error('Set CHROME_PATH to your Chrome/Chromium executable');
}

async function session(browser, email) {
  const ctx = await browser.createBrowserContext(); // isolated storage per user
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => pageErrors.push(`${email}: ${e.message}`));
  const net = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(`${BASE}/api/`)) net.push({ method: r.request().method(), url: u.replace(BASE, ''), status: r.status(), auth: !!r.request().headers()['authorization'] });
  });
  return { ctx, page, net, email };
}

const path = (page) => new URL(page.url()).pathname;
const token = (page) => page.evaluate(() => localStorage.getItem('ops_token'));
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, re, timeout = 20000) =>
  page.waitForFunction((src) => new RegExp(src, 'i').test(document.body.innerText), { timeout }, re.source);
const waitPath = (page, re) => page.waitForFunction((src) => new RegExp(src).test(location.pathname), {}, re.source);

async function clickText(page, selector, text) {
  const ok = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t && !e.disabled);
    if (el) el.click();
    return !!el;
  }, selector, text);
  assert(ok, `no clickable <${selector}> with text "${text}"`);
}
const hasButton = (page, text) => page.evaluate((t) => [...document.querySelectorAll('button, a.btn')].some((e) => e.textContent.trim() === t), text);

async function settle(page, ms = 450) {
  await sleep(ms);
  await page.waitForFunction(() => !/Loading…/.test(document.body.innerText) && (document.querySelector('table tbody tr') || /No items match|not found|Back to dashboard|Description/i.test(document.body.innerText) || document.querySelector('.banner')), { timeout: 20000 });
}

async function rows(page) {
  return page.evaluate(() => [...document.querySelectorAll('table tbody tr')].map((tr) => {
    const td = tr.querySelectorAll('td');
    return { title: td[0].innerText.trim(), href: td[0].querySelector('a').getAttribute('href'), team: td[1].innerText.trim(), type: td[2].innerText.trim(), priority: td[3].innerText.trim(), status: td[4].innerText.trim(), assignee: td[5].innerText.trim() };
  }));
}

async function loadAll(page) {
  let n = (await rows(page)).length;
  for (;;) {
    if (!(await hasButton(page, 'Load more'))) return n;
    await clickText(page, 'button', 'Load more');
    await page.waitForFunction((prev) => document.querySelectorAll('table tbody tr').length > prev, {}, n);
    n = (await rows(page)).length;
  }
}

async function login(s, email = s.email, password = PW) {
  const { page } = s;
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type=email]', email);
  await page.type('input[type=password]', password);
  await page.click('button.primary');
}
async function loginOk(s) {
  await login(s);
  await waitPath(s.page, /^\/$/);
  await settle(s.page);
}

const detail = (page) => page.evaluate(() => {
  const out = {};
  document.querySelectorAll('section.grid > div').forEach((d) => {
    const [label, ...rest] = d.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
    out[label] = rest.join(' ');
  });
  out.title = document.querySelector('h1')?.innerText.trim();
  return out;
});
const actions = (page) => page.evaluate(() => {
  const sec = [...document.querySelectorAll('section.card')].find((s) => s.querySelector('h3')?.textContent === 'Actions');
  return sec ? [...sec.querySelectorAll('button')].map((b) => b.textContent.trim()) : null;
});
const timeline = (page) => page.evaluate(() => [...document.querySelectorAll('.timeline li')].map((li) => li.innerText.replace(/\n/g, ' ').trim()));
const commentsOnPage = (page) => page.evaluate(() => [...document.querySelectorAll('.comment p')].map((p) => p.innerText.trim()));
const itemIdFromUrl = (page) => path(page).split('/')[2];

// Wait on the Status FIELD (not on page text, which also contains history lines like "Open → In progress").
const waitStatus = (page, status) =>
  page.waitForFunction((st) => {
    const d = [...document.querySelectorAll('section.grid > div')].find((x) => x.innerText.trim().startsWith('Status'));
    return !!d && d.innerText.split('\n').map((x) => x.trim()).filter(Boolean)[1] === st;
  }, {}, status);

async function openItem(page, id) {
  await page.goto(`${BASE}/items/${id}`, { waitUntil: 'networkidle0' });
  await waitText(page, /Description|not found/i);
}
// Form <select>s each live inside their own <label>, so find them by the label text.
async function selectInForm(page, labelText, value) {
  const ok = await page.evaluate((t) => {
    const l = [...document.querySelectorAll('form label')].find((x) => x.firstChild?.textContent?.trim() === t);
    if (!l) return false;
    l.querySelector('select').setAttribute('data-e2e', t);
    return true;
  }, labelText);
  assert(ok, `no form field labelled "${labelText}"`);
  await page.select(`select[data-e2e="${labelText}"]`, value);
}
async function replaceText(page, sel, text) {
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.type(text);
}

// ================================================================== main
const browser = await launch();
await db.connect();

const teams = Object.fromEntries((await q('select id, name from teams')).map((t) => [t.name, t.id]));
const userId = async (email) => (await q('select id from users where email=$1', [email]))[0].id;
const teamsOf = async (email, minRoles = ['VIEWER', 'MEMBER', 'LEAD', 'ADMIN']) =>
  (await q('select m.team_id from memberships m join users u on u.id=m.user_id where u.email=$1 and m.role = any($2::role[])', [email, minRoles])).map((r) => r.team_id);
const FINISHED = ['RESOLVED', 'CLOSED'];

const AMAN = 'aman.member@ops.test', PRIYA = 'priya.lead@ops.test', SANA = 'sana.member@ops.test', KABIR = 'kabir.viewer@ops.test';
const amanTeams = await teamsOf(AMAN);
const priyaLeadTeams = await teamsOf(PRIYA, ['LEAD', 'ADMIN']);
const amanId = await userId(AMAN);
const stamp = Date.now();
const TITLE = `E2E Gateway outage ${stamp}`;

const aman = await session(browser, AMAN);
const priya = await session(browser, PRIYA);

// ------------------------------------------------------------------ 1. AUTH
section('1. Authentication & session');
await test('unauthenticated visit to / redirects to /login', async () => {
  const anon = await session(browser, 'anon');
  await anon.page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  eq(path(anon.page), '/login', 'path');
  await anon.page.goto(`${BASE}/items/${randomUUID()}`, { waitUntil: 'networkidle0' });
  eq(path(anon.page), '/login', 'deep link path');
  await anon.ctx.close();
});
await test('wrong password shows an error, stays on /login, stores no token', async () => {
  const s = await session(browser, 'wrong');
  await login(s, AMAN, 'not-the-password');
  await waitText(s.page, /Invalid email or password/);
  eq(path(s.page), '/login', 'path');
  eq(await token(s.page), null, 'token');
  await s.ctx.close();
});
await test('login as Member: token stored, Bearer header sent, /me = 200, redirected to dashboard', async () => {
  await loginOk(aman);
  eq(path(aman.page), '/', 'path');
  const t = await token(aman.page);
  assert(t && t.split('.').length === 3, 'JWT stored in localStorage');
  const me = aman.net.find((r) => r.url === '/api/auth/me');
  assert(me && me.status === 200 && me.auth, `/me must be 200 with Authorization header, got ${JSON.stringify(me)}`);
  assert((await bodyText(aman.page)).includes('Aman Gupta'), 'user name in header');
});
await test('browser refresh keeps the session', async () => {
  await aman.page.reload({ waitUntil: 'networkidle0' });
  await settle(aman.page);
  eq(path(aman.page), '/', 'path after refresh');
  assert((await bodyText(aman.page)).includes('Aman Gupta'), 'still signed in');
});
await test('logout clears the token and protects routes; login again works', async () => {
  await clickText(aman.page, 'button', 'Sign out');
  await waitPath(aman.page, /^\/login$/);
  eq(await token(aman.page), null, 'token after logout');
  await aman.page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  eq(path(aman.page), '/login', 'dashboard is protected after logout');
  await loginOk(aman);
  eq(path(aman.page), '/', 'path after second login');
});

// ------------------------------------------------------------------ 2. DASHBOARD (Member)
section('2. Dashboard as Member (aman): views, search, filters, pagination, team isolation');
await test('"Assigned to me": only my unfinished items; total equals database count', async () => {
  const total = await loadAll(aman.page);
  const r = await rows(aman.page);
  assert(total > 0, 'has rows');
  assert(r.every((x) => x.assignee === 'Aman Gupta'), 'all assigned to Aman');
  assert(r.every((x) => !['Resolved', 'Closed'].includes(x.status)), 'none finished');
  eq(total, await count(`select count(*) from work_items where assignee_id=$1 and status <> all($2::item_status[])`, [amanId, FINISHED]), 'row count vs DB');
});
await test('"Unassigned urgent": only unassigned Urgent open items; total equals database count', async () => {
  await clickText(aman.page, 'button.tab', 'Unassigned urgent'); await settle(aman.page);
  const total = await loadAll(aman.page);
  const r = await rows(aman.page);
  assert(total > 0 && r.every((x) => x.assignee === 'Unassigned' && x.priority === 'Urgent'), 'all unassigned + urgent');
  eq(total, await count(`select count(*) from work_items where team_id = any($1::uuid[]) and assignee_id is null and priority='URGENT' and status <> all($2::item_status[])`, [amanTeams, FINISHED]), 'row count vs DB');
});
await test('"Awaiting my approval" is empty for a Member (no Lead role anywhere)', async () => {
  await clickText(aman.page, 'button.tab', 'Awaiting my approval'); await settle(aman.page);
  assert((await bodyText(aman.page)).includes('No items match'), 'empty state');
});
await test('"All items": cursor pagination - 20 per page, no duplicates, total equals database count, only my teams', async () => {
  await clickText(aman.page, 'button.tab', 'All items'); await settle(aman.page);
  eq((await rows(aman.page)).length, 20, 'first page size');
  assert(await hasButton(aman.page, 'Load more'), 'Load more offered');
  await clickText(aman.page, 'button', 'Load more');
  await aman.page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 40);
  const total = await loadAll(aman.page);
  const r = await rows(aman.page);
  eq(new Set(r.map((x) => x.href)).size, r.length, 'unique rows (no duplicates across pages)');
  eq(total, await count('select count(*) from work_items where team_id = any($1::uuid[])', [amanTeams]), 'total vs DB');
  eq([...new Set(r.map((x) => x.team))].sort(), ['Customer Support', 'Payments Ops'], 'teams visible to aman');
  assert(!(await hasButton(aman.page, 'Load more')), 'no Load more at the end');
});
await test('search (server-side): every row matches, total equals database count', async () => {
  await aman.page.reload({ waitUntil: 'networkidle0' }); await clickText(aman.page, 'button.tab', 'All items'); await settle(aman.page);
  await aman.page.type('.filters input', 'gateway');
  await settle(aman.page, 900);
  const total = await loadAll(aman.page);
  const r = await rows(aman.page);
  assert(total > 0 && r.every((x) => /gateway/i.test(x.title)), 'all titles match');
  eq(total, await count(`select count(*) from work_items where team_id = any($1::uuid[]) and (title ilike '%gateway%' or description ilike '%gateway%')`, [amanTeams]), 'search count vs DB');
});
await test('filters: priority, status, type, team (alone and combined with search)', async () => {
  const f = (n) => `.filters select:nth-of-type(${n})`; // 1 status, 2 priority, 3 type, 4 team
  await replaceText(aman.page, '.filters input', ''); await aman.page.keyboard.press('Backspace'); await settle(aman.page, 900);
  await aman.page.select(f(2), 'URGENT'); await settle(aman.page);
  let n = await loadAll(aman.page); let r = await rows(aman.page);
  assert(r.every((x) => x.priority === 'Urgent'), 'priority filter');
  eq(n, await count(`select count(*) from work_items where team_id = any($1::uuid[]) and priority='URGENT'`, [amanTeams]), 'priority count vs DB');
  await aman.page.select(f(1), 'AWAITING_APPROVAL'); await settle(aman.page);
  n = await loadAll(aman.page); r = await rows(aman.page);
  assert(r.every((x) => x.priority === 'Urgent' && x.status === 'Awaiting approval'), 'priority + status');
  eq(n, await count(`select count(*) from work_items where team_id = any($1::uuid[]) and priority='URGENT' and status='AWAITING_APPROVAL'`, [amanTeams]), 'combo count vs DB');
  await aman.page.select(f(1), ''); await aman.page.select(f(2), ''); await aman.page.select(f(3), 'PAYMENT'); await aman.page.select(f(4), teams['Customer Support']); await settle(aman.page);
  n = await loadAll(aman.page); r = await rows(aman.page);
  assert(r.every((x) => x.type === 'Payment' && x.team === 'Customer Support'), 'type + team');
  eq(n, await count(`select count(*) from work_items where team_id = $1 and type='PAYMENT'`, [teams['Customer Support']]), 'type+team count vs DB');
});
await test('team isolation in the UI: an item from a team aman is not in shows "not found" (no data leaked)', async () => {
  const [other] = await q(`select id, title from work_items where team_id = $1 limit 1`, [teams['Compliance']]);
  await openItem(aman.page, other.id);
  await waitText(aman.page, /Work item not found/);
  assert(!(await bodyText(aman.page)).includes(other.title), 'title must not leak');
  const t = await token(aman.page);
  eq((await api(t, 'GET', `/items/${other.id}`)).status, 404, 'API GET');
  eq((await api(t, 'PATCH', `/items/${other.id}`, { version: 1, title: 'x' })).status, 404, 'API PATCH');
  eq((await api(t, 'POST', `/items/${other.id}/claim`)).status, 404, 'API claim');
});

// ------------------------------------------------------------------ 3. WORKFLOW
section('3. Item lifecycle: create -> claim -> submit -> edit -> comment -> conflict -> Lead approval');
let itemId;
await test('Member creates an item via the form (double-click Save creates exactly one)', async () => {
  const p = aman.page;
  await p.goto(`${BASE}/items/new`, { waitUntil: 'networkidle0' });
  await p.type('form input:not([type=date])', TITLE);
  await p.type('form textarea', 'Gateway is timing out for EU merchants');
  await selectInForm(p, 'Priority', 'URGENT');
  await selectInForm(p, 'Team', teams['Payments Ops']);
  await p.$eval('input[type=date]', (el) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2026-12-31'); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await Promise.all([p.click('form button.primary'), p.click('form button.primary').catch(() => {})]);
  await waitPath(p, /^\/items\/[0-9a-f-]{36}$/);
  itemId = itemIdFromUrl(p);
  await waitText(p, /Description/);
  const d = await detail(p);
  eq([d.title, d.Status, d.Priority, d.Team, d.Assignee, d['Created by'], d.Version], [TITLE, 'Open', 'Urgent', 'Payments Ops', 'Unassigned', 'Aman Gupta', '1'], 'detail');
  eq(await count('select count(*) from work_items where title=$1', [TITLE]), 1, 'exactly one row in DB after double click');
  await waitText(p, /Aman Gupta created this item/);
  assert((await timeline(p)).some((l) => l.includes('Aman Gupta created this item')), 'activity: created');
});
await test('deep link refresh on the item page works (SPA fallback + persisted session)', async () => {
  await aman.page.reload({ waitUntil: 'networkidle0' });
  await waitText(aman.page, /Description/);
  eq((await detail(aman.page)).title, TITLE, 'title after refresh');
});
await test('new Urgent item appears under "Unassigned urgent" on the dashboard', async () => {
  await aman.page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await clickText(aman.page, 'button.tab', 'Unassigned urgent'); await settle(aman.page);
  await aman.page.type('.filters input', TITLE); await settle(aman.page, 900);
  assert((await rows(aman.page)).some((r) => r.title === TITLE), 'item listed');
});
await test('Member claims it: In progress, assigned to me, version 2; history updated', async () => {
  const p = aman.page;
  await openItem(p, itemId);
  eq(await actions(p), ['Claim'], 'actions before claim');
  await clickText(p, 'button', 'Claim');
  await waitStatus(p, 'In progress');
  const d = await detail(p);
  eq([d.Status, d.Assignee, d.Version], ['In progress', 'Aman Gupta', '2'], 'detail after claim');
  await waitText(p, /assigned it to Aman Gupta/);
  const tl = (await timeline(p)).join(' | ');
  assert(/moved status Open → In progress/.test(tl), 'activity: status change');
});
await test('Member cannot approve/reject/close - not offered in UI and 403 from the server', async () => {
  const p = aman.page;
  eq(await actions(p), ['Submit for approval'], 'member actions while in progress');
  await clickText(p, 'button', 'Submit for approval');
  await waitStatus(p, 'Awaiting approval');
  const a = await actions(p);
  assert(a.length === 0, `member must have no actions while awaiting approval, got ${JSON.stringify(a)}`);
  const t = await token(p);
  const v = (await detail(p)).Version;
  eq((await api(t, 'POST', `/items/${itemId}/transition`, { to: 'RESOLVED', version: Number(v) })).status, 403, 'approve via API as Member');
  eq((await api(t, 'POST', `/items/${itemId}/transition`, { to: 'CLOSED', version: Number(v) })).status, 422, 'invalid jump via API');
});
await test('comments: post once (double-click -> one comment), shown in comments and activity', async () => {
  const p = aman.page; const body = `Escalated to on-call ${stamp}`;
  await p.type('textarea[placeholder="Add a comment…"]', body);
  await Promise.all([clickText(p, 'button', 'Post comment'), clickText(p, 'button', 'Post comment').catch(() => {})]);
  await waitText(p, new RegExp(body));
  eq((await commentsOnPage(p)).filter((c) => c === body).length, 1, 'comment shown once');
  eq(await count('select count(*) from comments where item_id=$1 and body=$2', [itemId, body]), 1, 'comment rows in DB');
  assert((await timeline(p)).some((l) => l.includes('commented') && l.includes(body)), 'activity: comment');
});
await test('edit via form: title + priority saved, version bumped, history shows both changes', async () => {
  const p = aman.page;
  await clickText(p, 'a.btn', 'Edit'); await waitPath(p, /\/edit$/);
  await p.waitForFunction(() => document.querySelector('form input:not([type=date])').value.length > 0);
  await replaceText(p, 'form input:not([type=date])', `${TITLE} (edited)`);
  await selectInForm(p, 'Priority', 'HIGH');
  await p.click('form button.primary');
  await waitPath(p, /^\/items\/[0-9a-f-]{36}$/); await waitText(p, /Description/);
  const d = await detail(p);
  eq([d.title, d.Priority, d.Version], [`${TITLE} (edited)`, 'High', '4'], 'after edit');
  await waitText(p, /changed priority Urgent → High/);
  assert((await timeline(p)).some((l) => l.includes('edited title')), 'activity: title edit');
});
await test('stale edit: concurrent change by the Lead -> conflict banner, "Reload latest", retry succeeds', async () => {
  const a = aman.page, l = priya.page;
  await clickText(a, 'a.btn', 'Edit'); await waitPath(a, /\/edit$/);
  await a.waitForFunction(() => document.querySelector('form input:not([type=date])').value.length > 0);
  // Lead edits the same item meanwhile
  await loginOk(priya);
  await l.goto(`${BASE}/items/${itemId}/edit`, { waitUntil: 'networkidle0' });
  await l.waitForFunction(() => document.querySelector('form textarea').value.length > 0);
  await l.type('form textarea', ' [lead note]');
  await l.click('form button.primary'); await waitPath(l, /^\/items\/[0-9a-f-]{36}$/); await waitText(l, /\[lead note\]/);
  // Member (stale: holds version 4) tries to save
  await replaceText(a, 'form input:not([type=date])', 'Member overwrite attempt');
  await a.click('form button.primary');
  await a.waitForSelector('.banner.warn');
  assert(/changed since you opened it/i.test(await bodyText(a)), 'conflict message');
  assert(await hasButton(a, 'Reload latest'), 'Reload latest offered');
  eq(await count(`select count(*) from work_items where id=$1 and title='Member overwrite attempt'`, [itemId]), 0, 'stale write must NOT be saved');
  await clickText(a, 'button', 'Reload latest');
  await a.waitForFunction(() => document.querySelector('form textarea').value.includes('[lead note]'));
  eq(await a.$eval('form input:not([type=date])', (e) => e.value), `${TITLE} (edited)`, 'form reset to server values');
  await replaceText(a, 'form input:not([type=date])', `${TITLE} (final)`);
  await a.click('form button.primary'); await waitPath(a, /^\/items\/[0-9a-f-]{36}$/);
  await waitText(a, /\(final\)/);
  eq((await detail(a)).Version, '6', 'version after Lead edit (5) + Member retry (6)');
});
await test('Lead: item is in "Awaiting my approval"; Approve -> Resolved; Close -> Closed', async () => {
  const l = priya.page;
  await l.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await clickText(l, 'button.tab', 'Awaiting my approval'); await settle(l);
  await l.type('.filters input', 'E2E Gateway outage'); await settle(l, 900);
  assert((await rows(l)).some((r) => r.title.includes(String(stamp))), 'item listed for the Lead');
  await openItem(l, itemId);
  eq(await actions(l), ['Approve', 'Reject (send back)'], 'lead actions');
  await clickText(l, 'button', 'Approve'); await waitStatus(l, 'Resolved');
  eq(await actions(l), ['Close'], 'actions after approval');
  await clickText(l, 'button', 'Close'); await waitStatus(l, 'Closed');
  await waitText(l, /Resolved → Closed/);
  eq((await detail(l)).Status, 'Closed', 'final status');
  const none = await actions(l);
  assert(none.length === 0, 'no actions once closed');
  const tl = (await timeline(l)).join(' | ');
  assert(/Awaiting approval → Resolved/.test(tl) && /Resolved → Closed/.test(tl), 'history has approval + close');
});
await test('Lead rejects a submission: Awaiting approval -> In progress', async () => {
  const tA = await loginApi(AMAN);
  const it = await createViaApi(tA, { title: `E2E Reject me ${stamp}`, type: 'TASK', teamId: teams['Payments Ops'] });
  await api(tA, 'POST', `/items/${it.id}/claim`);
  await api(tA, 'POST', `/items/${it.id}/transition`, { to: 'AWAITING_APPROVAL', version: 2 });
  await openItem(priya.page, it.id);
  await clickText(priya.page, 'button', 'Reject (send back)');
  await waitStatus(priya.page, 'In progress');
  eq((await detail(priya.page)).Status, 'In progress', 'status after reject');
});

// ------------------------------------------------------------------ 4. LEAD ROLE & TEAM RULES
section('4. Lead (priya): scope, team-specific roles, isolation');
await test('Lead dashboard "Awaiting my approval": only Payments Ops (where she is Lead); count equals DB', async () => {
  await priya.page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await clickText(priya.page, 'button.tab', 'Awaiting my approval'); await settle(priya.page);
  const n = await loadAll(priya.page); const r = await rows(priya.page);
  assert(n > 0 && r.every((x) => x.team === 'Payments Ops' && x.status === 'Awaiting approval'), 'only Payments Ops, awaiting');
  eq(n, await count(`select count(*) from work_items where team_id = any($1::uuid[]) and status='AWAITING_APPROVAL'`, [priyaLeadTeams]), 'count vs DB');
});
await test('roles are per team: Lead in Payments Ops but only Member in Compliance - cannot approve there', async () => {
  const [it] = await q(`select id from work_items where team_id=$1 and status='AWAITING_APPROVAL' limit 1`, [teams['Compliance']]);
  await openItem(priya.page, it.id);
  await waitText(priya.page, /Description/);
  const a = await actions(priya.page);
  assert(!a.includes('Approve') && !a.includes('Reject (send back)'), `no approve in Compliance, got ${JSON.stringify(a)}`);
  const t = await token(priya.page); const v = Number((await detail(priya.page)).Version);
  eq((await api(t, 'POST', `/items/${it.id}/transition`, { to: 'RESOLVED', version: v })).status, 403, 'API approve in Compliance as Member');
});
await test('Lead cannot see another team\'s item (Platform Incidents): not found', async () => {
  const [it] = await q(`select id from work_items where team_id=$1 limit 1`, [teams['Platform Incidents']]);
  await openItem(priya.page, it.id);
  await waitText(priya.page, /Work item not found/);
});

// ------------------------------------------------------------------ 5. CONCURRENCY IN THE BROWSER
section('5. Concurrent claim in two real browsers');
await test('two users click Claim at the same moment: exactly one wins, the other sees a conflict message', async () => {
  const tA = await loginApi(AMAN);
  const it = await createViaApi(tA, { title: `E2E Race ${stamp}`, type: 'INCIDENT', teamId: teams['Customer Support'], priority: 'HIGH' });
  const sana = await session(browser, SANA);
  await loginOk(sana);
  await Promise.all([openItem(aman.page, it.id), openItem(sana.page, it.id)]);
  assert((await hasButton(aman.page, 'Claim')) && (await hasButton(sana.page, 'Claim')), 'both see Claim');
  await Promise.all([clickText(aman.page, 'button', 'Claim'), clickText(sana.page, 'button', 'Claim')]);
  await Promise.all([waitStatus(aman.page, 'In progress'), waitStatus(sana.page, 'In progress')]);
  const [da, ds] = [await detail(aman.page), await detail(sana.page)];
  eq(da.Assignee, ds.Assignee, 'both pages agree on the winner');
  assert(['Aman Gupta', 'Sana Khan'].includes(da.Assignee), 'winner is one of the two');
  const loser = da.Assignee === 'Aman Gupta' ? sana : aman;
  assert(/already been claimed/i.test(await bodyText(loser.page)), 'loser sees "already claimed" message');
  assert(!(await hasButton(loser.page, 'Claim')), 'loser no longer offered Claim');
  eq(await count(`select count(*) from activity_events where item_id=$1 and type='ASSIGNED'`, [it.id]), 1, 'one ASSIGNED event');
  await sana.ctx.close();
});

// ------------------------------------------------------------------ 6. VIEWER + ERROR STATES
section('6. Viewer role and error states');
await test('Viewer: can read an item but has no actions, no edit, no comment box; API writes are 403', async () => {
  const k = await session(browser, KABIR);
  await loginOk(k);
  await openItem(k.page, itemId);
  await waitText(k.page, /Description/);
  const a = await actions(k.page);
  assert(a.length === 0, 'no actions');
  assert(!(await hasButton(k.page, 'Edit')), 'no Edit');
  assert(!(await k.page.$('textarea[placeholder="Add a comment…"]')), 'no comment box');
  const t = await token(k.page);
  eq((await api(t, 'POST', '/items', { title: 'x', type: 'TASK', teamId: teams['Payments Ops'] }, { 'Idempotency-Key': randomUUID() })).status, 403, 'create as Viewer');
  eq((await api(t, 'POST', `/items/${itemId}/comments`, { body: 'x' }, { 'Idempotency-Key': randomUUID() })).status, 403, 'comment as Viewer');
  await k.ctx.close();
});
await test('nonexistent / malformed item ids show a clear error with a way back', async () => {
  await openItem(aman.page, randomUUID()); await waitText(aman.page, /Work item not found/);
  assert(await aman.page.evaluate(() => [...document.querySelectorAll('a')].some((a) => a.textContent.includes('Back to dashboard'))), 'back link');
  await openItem(aman.page, 'not-a-uuid'); await waitText(aman.page, /Work item not found/);
});
await test('invalid/expired token mid-session: next request logs the user out and redirects to /login', async () => {
  await aman.page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await aman.page.evaluate(() => localStorage.setItem('ops_token', 'garbage.token.value'));
  await clickText(aman.page, 'button.tab', 'All items');
  await waitPath(aman.page, /^\/login$/);
  eq(await token(aman.page), null, 'token cleared');
});
await test('no unexpected 401s for authenticated sessions, and no uncaught browser errors', async () => {
  const bad = [...aman.net, ...priya.net].filter((r) => r.status === 401 && r.url !== '/api/auth/login' && r.auth && !/garbage/.test(r.url));
  // the single deliberate 401 above (garbage token) is the only one allowed
  assert(bad.length <= 1, `unexpected 401 responses: ${JSON.stringify(bad)}`);
  eq(pageErrors, [], 'uncaught page errors');
});
await test('login again after the forced logout works (Member and Lead)', async () => {
  await loginOk(aman); eq(path(aman.page), '/', 'aman back on dashboard');
  await priya.page.goto(`${BASE}/`, { waitUntil: 'networkidle0' }); eq(path(priya.page), '/', 'priya session intact');
});

await browser.close();
await db.end();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
process.exit(failed.length ? 1 : 0);
