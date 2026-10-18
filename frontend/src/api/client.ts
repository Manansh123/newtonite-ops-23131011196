import type { Comment, ActivityEvent, Item, ItemDetail, ListFilters, Me, Status } from './types';

// Same-origin by default (/api). For a split deployment set VITE_API_URL at BUILD time,
// e.g. VITE_API_URL=https://my-api.onrender.com  (and set CORS_ORIGIN on the API).
const API_BASE = `${((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '')}/api`;

const TOKEN_KEY = 'ops_token';
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Error shape from the API: { error: { code, message }, latest? } */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public latest?: ItemDetail) {
    super(message);
  }
}

// crypto.randomUUID needs a secure context (https or localhost); fall back otherwise.
export const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn; // returns nothing on purpose: it is used inside useEffect, where a returned function is a cleanup
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status})`, data?.latest);
  }
  return data as T;
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string }>('POST', '/auth/login', { email, password }),
  me: () => request<Me>('GET', '/auth/me'),

  listItems: (f: ListFilters, cursor?: string) =>
    request<{ items: Item[]; nextCursor: string | null }>('GET', `/items${qs({ ...f, cursor, limit: 20 })}`),
  getItem: (id: string) => request<ItemDetail>('GET', `/items/${id}`),
  activity: (id: string) => request<{ events: ActivityEvent[] }>('GET', `/items/${id}/activity`),
  comments: (id: string) => request<{ comments: Comment[] }>('GET', `/items/${id}/comments`),

  createItem: (body: Record<string, unknown>, key: string) =>
    request<ItemDetail>('POST', '/items', body, { 'Idempotency-Key': key }),
  updateItem: (id: string, body: Record<string, unknown>) => request<ItemDetail>('PATCH', `/items/${id}`, body),
  claim: (id: string) => request<ItemDetail>('POST', `/items/${id}/claim`, undefined, { 'Idempotency-Key': newKey() }),
  transition: (id: string, to: Status, version: number) =>
    request<ItemDetail>('POST', `/items/${id}/transition`, { to, version }, { 'Idempotency-Key': newKey() }),
  addComment: (id: string, body: string, key: string) =>
    request<Comment>('POST', `/items/${id}/comments`, { body }, { 'Idempotency-Key': key }),
};
