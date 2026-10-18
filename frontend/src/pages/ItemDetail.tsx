import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newKey } from '../api/client';
import type { ItemDetail, Status } from '../api/types';
import { Badge, ErrorBanner, fmtDate, fmtDateTime, label } from '../components/bits';

const ACTION_LABEL: Record<string, string> = {
  'OPEN>IN_PROGRESS': 'Start',
  'IN_PROGRESS>AWAITING_APPROVAL': 'Submit for approval',
  'AWAITING_APPROVAL>RESOLVED': 'Approve',
  'AWAITING_APPROVAL>IN_PROGRESS': 'Reject (send back)',
  'RESOLVED>CLOSED': 'Close',
};

export default function ItemDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();

  const item = useQuery({ queryKey: ['item', id], queryFn: () => api.getItem(id) });
  const activity = useQuery({ queryKey: ['activity', id], queryFn: () => api.activity(id), enabled: item.isSuccess });
  const comments = useQuery({ queryKey: ['comments', id], queryFn: () => api.comments(id), enabled: item.isSuccess });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['item', id] });
    qc.invalidateQueries({ queryKey: ['activity', id] });
    qc.invalidateQueries({ queryKey: ['comments', id] });
    qc.invalidateQueries({ queryKey: ['items'] });
  };
  // On success, show the server's response immediately (no optimistic guessing), then refresh history.
  const onApplied = (updated: ItemDetail) => {
    qc.setQueryData(['item', id], updated);
    qc.invalidateQueries({ queryKey: ['activity', id] });
    qc.invalidateQueries({ queryKey: ['items'] });
  };
  // On a 409 the response carries the latest item: adopt it so buttons/state are correct again.
  const onFailed = (err: unknown) => {
    if (err instanceof ApiError && err.status === 409 && err.latest) qc.setQueryData(['item', id], err.latest);
    qc.invalidateQueries({ queryKey: ['activity', id] });
  };

  const claim = useMutation({ mutationFn: () => api.claim(id), onSuccess: onApplied, onError: onFailed });
  const move = useMutation({
    mutationFn: (to: Status) => api.transition(id, to, item.data!.version),
    onSuccess: onApplied,
    onError: onFailed,
  });

  // One Idempotency-Key per "comment draft": a double-click re-sends the SAME key, so the server stores one comment.
  const [body, setBody] = useState('');
  const commentKey = useRef(newKey());
  const post = useMutation({
    mutationFn: () => api.addComment(id, body.trim(), commentKey.current),
    onSuccess: () => {
      setBody('');
      commentKey.current = newKey();
      qc.invalidateQueries({ queryKey: ['comments', id] });
      qc.invalidateQueries({ queryKey: ['activity', id] });
    },
  });

  if (item.isLoading) return <p className="muted">Loading…</p>;
  if (item.error) return <ErrorBanner error={item.error} action={<Link to="/">Back to dashboard</Link>} />;
  const it = item.data!;

  const actionError = claim.error ?? move.error;
  const reload = <button onClick={() => { claim.reset(); move.reset(); refreshAll(); }}>Reload</button>;

  return (
    <>
      <p><Link to="/">← Dashboard</Link></p>
      <div className="row">
        <h1>{it.title}</h1>
        <span className="spacer" />
        {it.allowed.edit && <Link to={`/items/${it.id}/edit`} className="btn">Edit</Link>}
      </div>

      <ErrorBanner error={actionError} action={reload} />

      <section className="card grid">
        <div><span className="muted">Status</span><br /><Badge kind="status" value={it.status} /></div>
        <div><span className="muted">Priority</span><br /><Badge kind="priority" value={it.priority} /></div>
        <div><span className="muted">Type</span><br />{label(it.type)}</div>
        <div><span className="muted">Team</span><br />{it.team.name}</div>
        <div><span className="muted">Assignee</span><br />{it.assignee?.name ?? 'Unassigned'}</div>
        <div><span className="muted">Created by</span><br />{it.createdBy.name}</div>
        <div><span className="muted">Due</span><br />{fmtDate(it.dueDate)}</div>
        <div><span className="muted">Version</span><br />{it.version}</div>
      </section>

      <section className="card">
        <h3>Description</h3>
        <p className="pre">{it.description || <span className="muted">No description.</span>}</p>
      </section>

      <section className="card">
        <h3>Actions</h3>
        <div className="row gap">
          {it.allowed.claim && (
            <button className="primary" disabled={claim.isPending} onClick={() => claim.mutate()}>
              {claim.isPending ? 'Claiming…' : 'Claim'}
            </button>
          )}
          {it.allowed.transitions.map((to) => (
            <button key={to} disabled={move.isPending} onClick={() => move.mutate(to)}>
              {ACTION_LABEL[`${it.status}>${to}`] ?? `Move to ${label(to)}`}
            </button>
          ))}
          {!it.allowed.claim && it.allowed.transitions.length === 0 && <span className="muted">No actions available to you right now.</span>}
        </div>
      </section>

      <div className="two-col">
        <section className="card">
          <h3>Activity</h3>
          {activity.data?.events.length === 0 && <p className="muted">No activity.</p>}
          <ol className="timeline">
            {activity.data?.events.map((e) => (
              <li key={e.id}>
                <strong>{e.actor.name}</strong> {describe(e)}
                <div className="muted small">{fmtDateTime(e.createdAt)}</div>
              </li>
            ))}
          </ol>
        </section>

        <section className="card">
          <h3>Comments</h3>
          {comments.data?.comments.length === 0 && <p className="muted">No comments yet.</p>}
          {comments.data?.comments.map((c) => (
            <div key={c.id} className="comment">
              <strong>{c.author.name}</strong> <span className="muted small">{fmtDateTime(c.createdAt)}</span>
              <p className="pre">{c.body}</p>
            </div>
          ))}
          {it.allowed.comment && (
            <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (body.trim()) post.mutate(); }}>
              <ErrorBanner error={post.error} />
              <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment…" />
              <button className="primary" disabled={post.isPending || !body.trim()}>{post.isPending ? 'Posting…' : 'Post comment'}</button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}

function describe(e: { type: string; from: string | null; to: string | null }) {
  switch (e.type) {
    case 'CREATED': return 'created this item';
    case 'ASSIGNED': return `assigned it to ${e.to}`;
    case 'STATUS_CHANGED': return `moved status ${label(e.from ?? '')} → ${label(e.to ?? '')}`;
    case 'PRIORITY_CHANGED': return `changed priority ${label(e.from ?? '')} → ${label(e.to ?? '')}`;
    case 'FIELDS_UPDATED': return `edited ${e.to}`;
    case 'COMMENT_ADDED': return `commented: “${e.to}”`;
    default: return e.type;
  }
}
