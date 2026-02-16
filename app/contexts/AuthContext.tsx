import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_KEY = 'erp_user';
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

export type UserSession = { id_usuario: string; email: string; Nombre: string; Rol?: string };

type AuthContextValue = {
  user: UserSession | null;
  permisos: string[];
  loading: boolean;
  setUser: (u: UserSession | null) => void;
  refetchPermisos: () => Promise<void>;
  hasPermiso: (codigo: string) => boolean;
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
      const res = await fetch(`${API_URL}/api/permisos?rol=${encodeURIComponent(rol)}`);
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
    if (u?.Rol) fetchPermisos(u.Rol);
    else setPermisos([]);
  }, [fetchPermisos]);

  const hasPermiso = useCallback(
    (codigo: string) => {
      if (!codigo) return true;
      if (!user?.Rol) return true;
      if (permisos.length === 0) return true;
      return permisos.includes(codigo);
    },
    [user?.Rol, permisos]
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
