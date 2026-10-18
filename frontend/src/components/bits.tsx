import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

export const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export const Badge = ({ kind, value }: { kind: 'status' | 'priority'; value: string }) => (
  <span className={`badge ${kind}-${value}`}>{label(value)}</span>
);

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString();

export function ErrorBanner({ error, action }: { error: unknown; action?: ReactNode }) {
  if (!error) return null;
  const e = error as Error;
  const conflict = error instanceof ApiError && error.status === 409;
  return (
    <div className={`banner ${conflict ? 'warn' : 'error'}`} role="alert">
      <span>
        {conflict && error instanceof ApiError && error.code === 'VERSION_CONFLICT'
          ? 'This item changed since you opened it. Reload to see the latest version, then try again.'
          : e.message}
      </span>
      {action}
    </div>
  );
}
