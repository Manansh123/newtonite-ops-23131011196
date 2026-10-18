import { Link, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './auth/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ItemDetailPage from './pages/ItemDetail';
import ItemForm from './pages/ItemForm';

function Protected({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <p className="muted pad">Loading…</p>;
  if (!me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">Ops Work Items</Link>
        <span className="spacer" />
        <span className="muted">{me?.name}</span>
        <button className="link" onClick={logout}>Sign out</button>
      </header>
      <main className="page">{children}</main>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected><Shell><Dashboard /></Shell></Protected>} />
      <Route path="/items/new" element={<Protected><Shell><ItemForm /></Shell></Protected>} />
      <Route path="/items/:id" element={<Protected><Shell><ItemDetailPage /></Shell></Protected>} />
      <Route path="/items/:id/edit" element={<Protected><Shell><ItemForm /></Shell></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
