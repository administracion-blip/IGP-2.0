import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

/**
 * Favorito de acceso rápido: un submódulo marcado con la estrella.
 * Guarda su propia metadata (ruta estable + etiqueta + icono + permiso) para
 * poder pintarlo en la pantalla de Favoritos sin un registro central.
 */
export type Favorito = { route: string; label: string; icon: string; permiso: string | null };

type FavState = { favoritos: Favorito[]; cargado: boolean };

/**
 * Store singleton compartido entre pantallas (estrella en hubs + pantalla de
 * favoritos + menú). Persistencia por usuario en la tabla `ajustes`
 * (PK `favoritos`, SK `id_usuario`).
 */
let estado: FavState = { favoritos: [], cargado: false };
let usuarioCargado: string | null = null;
let cargando = false;
const listeners = new Set<() => void>();

function emitir() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): FavState {
  return estado;
}

function sanear(parsed: unknown): Favorito[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (f): f is Favorito =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as Favorito).route === 'string' &&
        typeof (f as Favorito).label === 'string' &&
        typeof (f as Favorito).icon === 'string',
    )
    .map((f) => ({
      route: f.route,
      label: f.label,
      icon: f.icon,
      permiso: typeof f.permiso === 'string' ? f.permiso : null,
    }));
}

async function cargar(usuarioId: string) {
  if (cargando || usuarioCargado === usuarioId) return;
  cargando = true;
  // Al cambiar de usuario, no mostrar los favoritos del anterior.
  if (usuarioCargado !== null && usuarioCargado !== usuarioId) {
    estado = { favoritos: [], cargado: false };
    emitir();
  }
  try {
    const res = await apiFetch(`/api/ajustes/favoritos/${encodeURIComponent(usuarioId)}`);
    let favs: Favorito[] = [];
    if (res.ok) {
      const data = await res.json().catch(() => null);
      favs = sanear(data?.item?.valor);
    }
    estado = { favoritos: favs, cargado: true };
    usuarioCargado = usuarioId;
    emitir();
  } catch {
    estado = { favoritos: [], cargado: true };
    usuarioCargado = usuarioId;
    emitir();
  } finally {
    cargando = false;
  }
}

async function persistir(usuarioId: string) {
  try {
    await apiFetch(`/api/ajustes/favoritos/${encodeURIComponent(usuarioId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ valor: estado.favoritos }),
    });
  } catch {
    /* persistencia best-effort: el estado en memoria ya está actualizado */
  }
}

/** Gestiona los favoritos del usuario actual (carga, consulta y alternado). */
export function useFavoritos() {
  const { user } = useAuth();
  const usuarioId = user?.id_usuario ?? '';
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (usuarioId) cargar(usuarioId);
  }, [usuarioId]);

  const esFavorito = useCallback(
    (route: string) => snapshot.favoritos.some((f) => f.route === route),
    [snapshot],
  );

  const toggleFavorito = useCallback(
    (fav: Favorito) => {
      if (!usuarioId) return;
      const existe = estado.favoritos.some((f) => f.route === fav.route);
      const favoritos = existe
        ? estado.favoritos.filter((f) => f.route !== fav.route)
        : [...estado.favoritos, fav];
      estado = { favoritos, cargado: true };
      emitir();
      persistir(usuarioId);
    },
    [usuarioId],
  );

  return {
    favoritos: snapshot.favoritos,
    cargado: snapshot.cargado,
    esFavorito,
    toggleFavorito,
  };
}
