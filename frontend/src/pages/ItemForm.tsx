import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newKey } from '../api/client';
import { ITEM_TYPES, PRIORITIES, type ItemDetail, type ItemType, type Priority } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, label } from '../components/bits';

interface FormState { title: string; description: string; type: ItemType; priority: Priority; teamId: string; dueDate: string }

const fromItem = (i: ItemDetail): FormState => ({
  title: i.title, description: i.description, type: i.type, priority: i.priority, teamId: i.team.id,
  dueDate: i.dueDate ? i.dueDate.slice(0, 10) : '',
});

export default function ItemForm() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();

  // Only teams where the user can create (MEMBER+) are offered. The server re-checks regardless.
  const writableTeams = me?.memberships.filter((m) => m.role !== 'VIEWER') ?? [];
  const [form, setForm] = useState<FormState>({
    title: '', description: '', type: 'TASK', priority: 'MEDIUM', teamId: writableTeams[0]?.teamId ?? '', dueDate: '',
  });
  const [version, setVersion] = useState<number>(0); // the version we based our edit on
  const loaded = useRef(false);

  const existing = useQuery({ queryKey: ['item', id], queryFn: () => api.getItem(id!), enabled: editing });
  useEffect(() => {
    if (existing.data && !loaded.current) {
      loaded.current = true;
      setForm(fromItem(existing.data));
      setVersion(existing.data.version);
    }
  }, [existing.data]);

  // Create: ONE key per form instance. Double-clicking Save re-sends the same key -> the server creates one item.
  const createKey = useRef(newKey());

  const save = useMutation({
    mutationFn: async () => {
      const dueDate = form.dueDate || null;
      if (editing) {
        return api.updateItem(id!, { version, title: form.title, description: form.description, type: form.type, priority: form.priority, dueDate });
      }
      return api.createItem({ title: form.title, description: form.description, type: form.type, priority: form.priority, teamId: form.teamId, dueDate }, createKey.current);
    },
    onSuccess: (item) => {
      qc.setQueryData(['item', item.id], item);
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['activity', item.id] });
      nav(`/items/${item.id}`);
    },
  });

  // 409: someone else changed the item. Reload = adopt the server's latest values and version (my edits are discarded).
  const latest = save.error instanceof ApiError ? save.error.latest : undefined;
  const reload = () => {
    const fresh = latest ?? existing.data;
    if (fresh) { setForm(fromItem(fresh)); setVersion(fresh.version); }
    save.reset();
  };

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  if (editing && existing.isLoading) return <p className="muted">Loading…</p>;
  if (editing && existing.error) return <ErrorBanner error={existing.error} />;

  return (
    <>
      <p><Link to={editing ? `/items/${id}` : '/'}>← Back</Link></p>
      <h1>{editing ? 'Edit work item' : 'New work item'}</h1>
      <form className="card form" onSubmit={submit}>
        <ErrorBanner error={save.error} action={save.error instanceof ApiError && save.error.status === 409 ? <button type="button" onClick={reload}>Reload latest</button> : undefined} />

        <label>Title<input value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={200} required /></label>
        <label>Description<textarea rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={5000} /></label>
        <div className="row gap">
          <label>Type
            <select value={form.type} onChange={(e) => set('type', e.target.value as ItemType)}>
              {ITEM_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
            </select>
          </label>
          <label>Priority
            <select value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{label(p)}</option>)}
            </select>
          </label>
          {!editing && (
            <label>Team
              <select value={form.teamId} onChange={(e) => set('teamId', e.target.value)} required>
                {writableTeams.map((m) => <option key={m.teamId} value={m.teamId}>{m.teamName}</option>)}
              </select>
            </label>
          )}
          <label>Due date<input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></label>
        </div>
        <div className="row gap">
          <button className="primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
          {editing && <span className="muted small">Editing version {version}</span>}
        </div>
      </form>
    </>
  );
}
