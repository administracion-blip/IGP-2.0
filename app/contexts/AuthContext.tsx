import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_KEY = 'erp_user';
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

export type UserSession = { id_usuario: string; email: string; Nombre: string; Rol?: string; Locales?: string[] };

type AuthContextValue = {
  user: UserSession | null;
  permisos: string[];
  loading: boolean;
  setUser: (u: UserSession | null) => void;
  refetchPermisos: () => Promise<void>;
  hasPermiso: (codigo: string) => boolean;
  localPermitido: (nombre: string) => boolean;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<UserSession | null>(null);
  const [permisos, setPermisos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPermisos = useCallback(async (rol: string) => {
    if (!rol.trim()) {
      setPermisos([]);
      return;
    }
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${API_URL}/api/permisos?rol=${encodeURIComponent(rol)}`, { signal: controller.signal });
      clearTimeout(id);
      const data = res.ok ? await res.json() : {};
      if (data.permisos && Array.isArray(data.permisos)) setPermisos(data.permisos);
      else setPermisos([]);
    } catch {
      setPermisos([]);
    }
  }, []);

  const refetchPermisos = useCallback(async () => {
    if (user?.Rol) await fetchPermisos(user.Rol);
  }, [user?.Rol, fetchPermisos]);

  useEffect(() => {
    AsyncStorage.getItem(AUTH_KEY).then((stored) => {
      if (stored) {
        try {
          const u = JSON.parse(stored) as UserSession;
          setUserState(u);
          if (u.Rol) fetchPermisos(u.Rol).finally(() => setLoading(false));
          else setLoading(false);
        } catch {
          setUserState(null);
          setLoading(false);
        }
      } else {
        setUserState(null);
        setLoading(false);
      }
    });
  }, [fetchPermisos]);

  const setUser = useCallback((u: UserSession | null) => {
    setUserState(u);
    if (u) AsyncStorage.setItem(AUTH_KEY, JSON.stringify(u)).catch(() => {});
    else AsyncStorage.removeItem(AUTH_KEY).catch(() => {});
    if (u?.Rol) fetchPermisos(u.Rol);
    else setPermisos([]);
  }, [fetchPermisos]);

  const hasPermiso = useCallback(
    (codigo: string) => {
      if (!codigo) return true;
      if (!user?.Rol) return true;
      if (user.Rol === 'Administrador') return true;
      if (permisos.length === 0) return true;
      return permisos.includes(codigo);
    },
    [user?.Rol, permisos]
  );

  const localPermitido = useCallback(
    (nombre: string) => {
      if (!nombre) return false;
      if (!user) return true;
      if (user.Rol === 'Administrador') return true;
      if (!user.Locales || user.Locales.length === 0) return true;
      return user.Locales.some((l) => l.toLowerCase() === nombre.toLowerCase());
    },
    [user]
  );

  const logout = useCallback(async () => {
    await AsyncStorage.removeItem(AUTH_KEY);
    setUserState(null);
    setPermisos([]);
  }, []);

  const value: AuthContextValue = {
    user,
    permisos,
    loading,
    setUser,
    refetchPermisos,
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
