# Engineering decisions

Each decision: context, options considered, choice, trade-off. Order roughly follows how much each one matters to correctness.

---

## 1. PostgreSQL, per-team memberships, and history written with the change

**Context.** The brief needs relational data (users, teams, roles per team, items), strong consistency between an item and its history,
and fast filtered lists at tens of thousands of items.

**Options considered.**
- MongoDB / document store: flexible, but no cross-document transactions as simple as one SQL transaction, and weaker constraints.
- Event sourcing (derive current state from events): perfect audit, but far more machinery than a one-day slice, and listing/filtering items becomes a read-model problem.
- A JSON "audit" column on the item: atomic, but not queryable or truly append-only.
- **Postgres with normal tables + a separate `activity_events` table (chosen).**

**Choice.** `memberships(user, team, role)` gives a role per team. `work_items` carries a `version` integer. `activity_events` is a separate table
written **in the same `prisma.$transaction` as the item change** (every write path passes the same `tx` to `recordEvent`), and a trigger makes it
append-only at the database level. A CHECK constraint enforces the invariant "only OPEN items can be unassigned". Indexes: team + created_at keyset
index, team + status, assignee + status, a **partial index** for "unassigned urgent", and trigram GIN indexes for search. Migrations are hand-written SQL
(applied by a small runner) because partial/trigram indexes, CHECKs and triggers cannot be expressed in Prisma's schema language; Prisma is the typed query layer.

**Trade-off.** Two sources of truth for the schema (SQL migration and `schema.prisma`) that I keep in sync by hand, and no down-migrations.
The append-only guarantee holds for UPDATE/DELETE but a database owner could still drop the trigger. In exchange: history can never disagree with the item
(the test in `atomicity.test.ts` forces the event write to fail and asserts the item change rolled back), and the database itself protects the invariants.

---

## 2. Concurrency: conditional UPDATE for claims, `version` for edits

**Context.** Two people can claim the same item at the same instant; two people can edit from the same stale screen; a request can race with another between
"read" and "write".

**Options considered.**
- Read, check in application code, then write: has a time-of-check/time-of-use race. Looks right, fails under load ("fake concurrency protection").
- `SELECT ... FOR UPDATE` row locks: correct, but holds a lock across application round-trips and makes lock ordering/timeouts my problem.
- An in-process mutex: breaks the moment there are two API instances.
- **Compare-and-set in a single UPDATE (chosen).**

**Choice.**
- **Claim:** `UPDATE work_items SET assignee_id=?, status='IN_PROGRESS', version=version+1 WHERE id=? AND assignee_id IS NULL AND status='OPEN'`.
  If two requests race, Postgres serialises the two UPDATEs on the row lock; the loser re-evaluates the `WHERE` against the winner's committed row, matches
  **0 rows**, and the API returns **409** (with the latest item).
- **Edit / transition:** the client sends the `version` it saw; the UPDATE has `WHERE id=? AND version=?` and sets `version=version+1`. 0 rows -> 409 with the
  latest item. There is also a cheap early check (`item.version !== input.version`) for a fast, clear error, but **the UPDATE's condition is the real guard**.
  A deterministic test injects a rival commit between the read and the write to prove the guard works even when the early check passes.

**Trade-off.** Optimistic locking pushes conflict handling to the client (the UI shows "this item changed, reload"), and a user can lose an edit they
would have wanted to merge. Pessimistic locking would avoid that but costs throughput and complexity. Conflicts on a work item are rare, so optimistic is the right default.

---

## 3. Authorization: one policy module, scoped queries, 404 vs 403

**Context.** Permissions must be enforced on the server, per team and per resource; the UI must not be the only thing hiding buttons.

**Options considered.**
- `if (user.role === ...)` checks scattered across route handlers: easy to forget one.
- Role in the JWT: stale the moment a role changes.
- A full policy engine / RBAC library: overkill for four roles and ten actions.
- **One `policy/permissions.ts` with an action -> rule table (chosen).**

**Choice.** Roles are loaded from the database on **every request** (not baked into the token), so a demotion takes effect immediately (tested).
Every endpoint calls `assertCan(user, action, item)`: **404** if the user is not in the item's team (don't reveal that it exists), **403** if they are in the
team but their role does not allow the action. List queries are scoped in the query itself (`team_id IN (my teams)`), so a list cannot leak other teams' items even by
passing `teamId`. The approval step is the rule `transition.approve = Lead or Admin of THIS item's team`; a Lead of team B is a Member in team A, and the tests cover that case.
The workflow map (`policy/workflow.ts`) names the permission each transition needs. The item detail response includes `allowed` (edit/claim/comment/transitions), computed by the **same**
functions, so the UI renders buttons from the server's answer instead of re-implementing the rules, and the server still re-checks every action.

**Trade-off.** One extra query per request to load memberships (indexed by primary key, negligible here; a cache would reintroduce staleness). Returning 404 for
out-of-team items makes debugging slightly harder than 403 but avoids leaking which items exist.

---

## 4. Idempotency: database-backed keys inside the same transaction

**Context.** Double-clicks and client retries must not create duplicate items or comments, and a retry must get the **original** result.

**Options considered.**
- Disable the button in the UI only: does nothing for retries or other clients.
- In-memory cache of keys: lost on restart, wrong with multiple instances.
- Dedupe by content (title + user + time window): wrong guesses both ways.
- **`idempotency_keys` table with a unique `(user_id, key)` (chosen).**

**Choice.** Inside the request's transaction: `INSERT ... ON CONFLICT DO NOTHING`. Inserted -> do the work, store status + body on the key row, commit (key, item and activity event
commit together). Not inserted -> the original already committed, so return its stored response. If a *concurrent* duplicate is still in flight, Postgres makes the second INSERT wait on
the unique index until the first commits or rolls back, so duplicates can never both run (tested with 5 parallel requests). Key reuse with a different body/endpoint -> **422**
(request hash mismatch). Keys are scoped per user. Failed requests roll back everything including the key, so they can be retried. Required on create item and add comment; honoured
if sent on claim/transition (a retried claim then returns the original 200 instead of 409).

**Trade-off.** Keys are never expired (no cleanup job yet), the table grows, and a duplicate that arrives during a slow first request waits instead of failing fast. Storing the response means
replays are byte-identical, at the cost of storing response bodies.

---

## 5. Pagination and search: keyset cursors + trigram indexes

**Context.** Tens of thousands of items now, more later; the dashboard needs filters and search. Everything must be server-side.

**Options considered.**
- `OFFSET/LIMIT`: simple, but cost grows with depth and pages shift when rows are inserted.
- A search engine (Elasticsearch/Meilisearch): better relevance, but another moving part to run and keep in sync.
- Postgres full-text search: good for word search, poor for the substring matching people expect on IDs like "OPS-1234".
- **Keyset (cursor) pagination on `(created_at, id)`, `ILIKE` search backed by `pg_trgm` GIN indexes (chosen).**

**Choice.** The cursor is the last row's `(created_at, id)`; the next page is `WHERE (created_at, id) < cursor ORDER BY created_at DESC, id DESC LIMIT n+1` (the extra row says whether more exist).
`id` breaks ties between identical timestamps (tested). Dashboard views are just pre-set server-side filters, with a partial index for "unassigned urgent".
I checked the plans on a **50,000-item** dataset: the first page and a page 5,000 rows deep both take about 0.2 ms through `idx_items_team_created`; a rare search term uses the trigram index (about 3 ms);
"unassigned urgent" uses its partial index. A very common search term is served by scanning the date index in order and filtering, which is fast because matches are dense.

**Trade-off.** Forward-only paging: no "jump to page 37" and no total count (a count over a filtered large table is expensive). Search is substring, not ranked. Sort order is fixed (newest first).

---

## 6. What I intentionally did not build

**Context.** The brief says a smaller system with well-considered behaviour beats a large half-finished one, and expects about one working day.

**Choice.** Not built: **transactional outbox/worker**, **optimistic-UI reconciliation** (the UI shows server results and a "reload" message on 409 instead),
email, attachments, SSO, websockets (refetch on window focus is enough), mobile app, reassignment, delete, team transfer, rate limiting, key expiry. I chose depth on five behaviours
(claim race, stale update, idempotency, workflow, authorization), each with a test I can explain, over breadth.

**Trade-off.** No async notifications and no instant optimistic feel. The outbox would be the next thing to add: a job row written in the same transaction as the change, a worker with
retries/backoff and an idempotent handler. The schema and transactional pattern already support that cleanly.

---

## 7. Deployment: one Node service serving the API and the built UI

**Context.** The app must work in production with the UI and API together, a real database, working JWT auth, correct SPA routing on refresh, no localhost URLs and no committed secrets.

**Options considered.**
- UI on a static host (Vercel/Netlify) + API elsewhere: needs CORS, a build-time API URL, and two deployments that must stay in sync.
- Docker image: portable, but one more artefact to build and maintain for a one-service app.
- **One Node service that serves the API under `/api` and the built React app for everything else (chosen).**

**Choice.** In production Express serves `frontend/dist` (hashed assets cached as immutable, `index.html` never cached, SPA fallback for non-`/api` GETs). The UI calls the relative path `/api`, so there is no
API base URL, no CORS and nothing pointing at localhost. A split deployment is still supported (`VITE_API_URL` at build time, `CORS_ORIGIN` allow-list on the API). The server fails loudly at boot on a short `JWT_SECRET`
or a missing build instead of running half-configured. `npm start` runs migrations, seeds demo data only when `SEED_DEMO_DATA=true` **and** the database has no users (so a restart can never wipe data), then starts the server.
`render.yaml` describes the service + database; secrets are generated by the host, never committed.

**Trade-off.** UI and API scale and deploy together, and static assets are served by Node rather than a CDN. For an internal tool of this size that is the simpler, more robust choice. The JWT lives in `localStorage` (XSS-exposed)
because a bearer token keeps CORS and CSRF out of the picture; httpOnly cookies would be the hardening step.

---

## Failure modes (for the live discussion)

- **Database down:** requests fail with 500 (no partial writes: every write is one transaction).
- **Crash mid-request:** the transaction rolls back, so the item, history and idempotency key all disappear together; the client retries safely with the same key.
- **Network retry / double click:** same Idempotency-Key -> the original response is returned.
- **Two users collide:** claim -> one 200, one 409; edit -> one succeeds, the other gets 409 with the latest item.
- **Stale or expired token:** any 401 clears the stored token and sends the user to the login page.
- **Old asset after a redeploy:** a missing hashed file returns a clean 404, and `index.html` is never cached, so a refresh picks up the new build.
