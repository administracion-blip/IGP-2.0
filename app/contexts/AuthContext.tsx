import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getToken, removeToken } from '../utils/authToken';
import { authEvents } from '../utils/authEvents';
import { apiFetch } from '../utils/api';
import { permisoConcedido } from '../lib/permisoAliases';

const AUTH_KEY = 'erp_user';

export type UserSession = { id_usuario: string; email: string; Nombre: string; Rol?: string; Locales?: string[] };
export type PermisosStatus = 'idle' | 'loading' | 'loaded' | 'error';

type AuthContextValue = {
  user: UserSession | null;
  permisos: string[];
  permisosStatus: PermisosStatus;
  loading: boolean;
  setUser: (u: UserSession | null) => void;
  refetchSession: () => Promise<void>;
  hasPermiso: (codigo: string) => boolean;
  localPermitido: (nombre: string) => boolean;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<UserSession | null>(null);
  const [permisos, setPermisos] = useState<string[]>([]);
  const [permisosStatus, setPermisosStatus] = useState<PermisosStatus>('idle');
  const [loading, setLoading] = useState(true);

  const fetchSession = useCallback(async (): Promise<UserSession | null> => {
    const token = await getToken();
    if (!token) return null;
    setPermisosStatus('loading');
    try {
      // El 401 en /api/me se trata explícitamente aquí (limpieza inmediata del estado);
      // el listener global de `unauthorized` no ejecutará logout durante el bootstrap
      // porque `userRef.current` aún es null en ese momento.
      const res = await apiFetch('/api/me', { timeoutMs: 10000 });
      if (!res.ok) {
        setPermisosStatus('error');
        if (res.status === 401) {
          await AsyncStorage.removeItem(AUTH_KEY);
          await removeToken();
          setUserState(null);
          setPermisos([]);
        }
        return null;
      }
      const data = await res.json();
      const u = data.user as UserSession;
      setUserState(u);
      setPermisos(Array.isArray(data.permisos) ? data.permisos : []);
      setPermisosStatus('loaded');
      await AsyncStorage.setItem(AUTH_KEY, JSON.stringify(u));
      return u;
    } catch {
      setPermisosStatus('error');
      const stored = await AsyncStorage.getItem(AUTH_KEY).catch(() => null);
      if (stored) {
        try {
          setUserState(JSON.parse(stored) as UserSession);
        } catch { /* ignore */ }
      }
      return null;
    }
  }, []);

  const refetchSession = useCallback(async () => {
    await fetchSession();
  }, [fetchSession]);

  useEffect(() => {
    let cancelled = false;
    const safetyId = setTimeout(() => { if (!cancelled) setLoading(false); }, 15000);
    fetchSession().finally(() => {
      if (!cancelled) {
        clearTimeout(safetyId);
        setLoading(false);
      }
    });
    return () => { cancelled = true; clearTimeout(safetyId); };
  }, [fetchSession]);

  const setUser = useCallback((u: UserSession | null) => {
    setUserState(u);
    if (u) {
      AsyncStorage.setItem(AUTH_KEY, JSON.stringify(u)).catch(() => {});
      fetchSession();
    } else {
      AsyncStorage.removeItem(AUTH_KEY).catch(() => {});
      setPermisos([]);
      setPermisosStatus('idle');
    }
  }, [fetchSession]);

  const hasPermiso = useCallback(
    (codigo: string) => {
      if (!codigo) return true;
      if (!user) return false;
      if (user.Rol === 'Administrador') return true;
      if (permisosStatus !== 'loaded') return false;
      return permisoConcedido(permisos, codigo);
    },
    [user, permisos, permisosStatus]
  );

  const localPermitido = useCallback(
    (nombre: string) => {
      if (!nombre) return false;
      if (!user) return false;
      if (user.Rol === 'Administrador') return true;
      if (!user.Locales || user.Locales.length === 0) return true;
      return user.Locales.some((l) => l.toLowerCase() === nombre.toLowerCase());
    },
    [user]
  );

  const logout = useCallback(async () => {
    await AsyncStorage.removeItem(AUTH_KEY);
    await removeToken();
    setUserState(null);
    setPermisos([]);
    setPermisosStatus('idle');
  }, []);

  // Coordina el logout cuando apiFetch detecta un 401 del backend.
  // Ignora 401 si todavía no hay sesión cargada (evita bucles durante el bootstrap).
  const userRef = useRef(user);
  userRef.current = user;
  useEffect(() => {
    return authEvents.onUnauthorized(() => {
      if (userRef.current) {
        logout();
      }
    });
  }, [logout]);

  const value: AuthContextValue = {
    user,
    permisos,
    permisosStatus,
    loading,
    setUser,
    refetchSession,
    hasPermiso,
    localPermitido,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
}

export { AUTH_KEY };
