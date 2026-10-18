import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler, tokenStore } from '../api/client';
import type { Me } from '../api/types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [hasToken, setHasToken] = useState(!!tokenStore.get());

  const meQuery = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: hasToken, retry: false });

  const logout = useCallback(() => {
    tokenStore.clear();
    setHasToken(false);
    qc.clear();
  }, [qc]);

  // Any 401 from the API logs the user out. NOTE: the effect body must not return anything
  // (returning a function here would make React call it as a cleanup on every re-render).
  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  const login = async (email: string, password: string) => {
    const { token } = await api.login(email, password);
    tokenStore.set(token);
    setHasToken(true);
    await qc.invalidateQueries({ queryKey: ['me'] });
  };

  return (
    <Ctx.Provider value={{ me: hasToken ? meQuery.data ?? null : null, loading: hasToken && meQuery.isLoading, login, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
};
