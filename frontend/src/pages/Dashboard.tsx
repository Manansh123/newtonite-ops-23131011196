import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ITEM_TYPES, PRIORITIES, STATUSES, type ListFilters } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, ErrorBanner, fmtDate, label } from '../components/bits';

const TABS: { key: string; title: string; view?: ListFilters['view'] }[] = [
  { key: 'mine', title: 'Assigned to me', view: 'assigned_to_me' },
  { key: 'urgent', title: 'Unassigned urgent', view: 'unassigned_urgent' },
  { key: 'approve', title: 'Awaiting my approval', view: 'awaiting_my_approval' },
  { key: 'all', title: 'All items' },
];

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Dashboard() {
  const { me } = useAuth();
  const [tab, setTab] = useState(TABS[0]!.key);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ListFilters['status']>('');
  const [priority, setPriority] = useState<ListFilters['priority']>('');
  const [type, setType] = useState<ListFilters['type']>('');
  const [teamId, setTeamId] = useState('');
  const q = useDebounced(search);

  const filters: ListFilters = {
    view: TABS.find((t) => t.key === tab)?.view,
    q: q || undefined,
    status: status || undefined,
    priority: priority || undefined,
    type: type || undefined,
    teamId: teamId || undefined,
  };

  // Everything below (filtering, search, paging) happens on the SERVER; the browser only holds loaded pages.
  const list = useInfiniteQuery({
    queryKey: ['items', filters],
    queryFn: ({ pageParam }) => api.listItems(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <div className="row">
        <h1>Dashboard</h1>
        <span className="spacer" />
        <Link to="/items/new" className="btn primary">+ New item</Link>
      </div>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={t.key === tab ? 'tab active' : 'tab'} onClick={() => setTab(t.key)}>{t.title}</button>
        ))}
      </nav>

      <div className="filters">
        <input placeholder="Search title or description…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value as ListFilters['status'])}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as ListFilters['priority'])}>
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value as ListFilters['type'])}>
          <option value="">All types</option>
          {ITEM_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
        </select>
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">All my teams</option>
          {me?.memberships.map((m) => <option key={m.teamId} value={m.teamId}>{m.teamName}</option>)}
        </select>
      </div>

      <ErrorBanner error={list.error} />
      {list.isLoading ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No items match.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Title</th><th>Team</th><th>Type</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Due</th></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td><Link to={`/items/${i.id}`}>{i.title}</Link></td>
                <td>{i.team.name}</td>
                <td>{label(i.type)}</td>
                <td><Badge kind="priority" value={i.priority} /></td>
                <td><Badge kind="status" value={i.status} /></td>
                <td>{i.assignee?.name ?? <span className="muted">Unassigned</span>}</td>
                <td>{fmtDate(i.dueDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row pad-top">
        <span className="muted small">{items.length} loaded{list.hasNextPage ? ' · more available' : ''}</span>
        <span className="spacer" />
        {list.hasNextPage && (
          <button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </>
  );
}
