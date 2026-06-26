import { useEffect, useCallback, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Grupo de familias guardado por el usuario: un nombre + las familias que agrupa.
 * Se guardan los `FamilyId` (estables); el nombre visible se resuelve desde los
 * datos actuales al pintar los chips.
 */
export type GrupoFamilias = { id: string; nombre: string; familiaIds: string[] };

const STORAGE_KEY = 'compras:gruposFamilias:v1';

/**
 * Store singleton (a nivel de módulo) para los grupos de familias.
 *
 * Antes el estado vivía dentro del hook, así que cada pantalla que lo usaba
 * tenía su propia copia y persistían el array completo por separado: al volver
 * a una pantalla con la copia desfasada, sobrescribía el almacenamiento y los
 * grupos "desaparecían". Con una única fuente de verdad compartida esto ya no
 * ocurre y los cambios se ven en vivo en todas las pantallas.
 */
let grupos: GrupoFamilias[] = [];
let cargado = false;
let cargando = false;
const listeners = new Set<() => void>();

function emitir() {
  for (const l of listeners) l();
}

function persistir() {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(grupos)).catch(() => {
    /* ignore */
  });
}

function sanear(parsed: unknown): GrupoFamilias[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (g): g is GrupoFamilias =>
      g &&
      typeof g === 'object' &&
      typeof (g as GrupoFamilias).id === 'string' &&
      typeof (g as GrupoFamilias).nombre === 'string' &&
      Array.isArray((g as GrupoFamilias).familiaIds)
  );
}

async function cargarUnaVez() {
  if (cargado || cargando) return;
  cargando = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saneados = sanear(JSON.parse(raw));
      if (saneados.length > 0 || grupos.length === 0) {
        grupos = saneados;
        emitir();
      }
    }
  } catch {
    /* ignore */
  } finally {
    cargado = true;
    cargando = false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): GrupoFamilias[] {
  return grupos;
}

/**
 * Gestiona los grupos de familias personalizados, persistidos localmente en
 * AsyncStorage y compartidos entre todas las pantallas (store singleton).
 */
export function useGruposFamilias() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    cargarUnaVez();
  }, []);

  const crearGrupo = useCallback((nombre: string, familiaIds: string[]) => {
    const n = nombre.trim();
    const ids = Array.from(new Set(familiaIds));
    if (!n || ids.length === 0) return;
    grupos = [
      ...grupos,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, nombre: n, familiaIds: ids },
    ];
    emitir();
    persistir();
  }, []);

  const borrarGrupo = useCallback((id: string) => {
    grupos = grupos.filter((g) => g.id !== id);
    emitir();
    persistir();
  }, []);

  return { grupos: snapshot, crearGrupo, borrarGrupo };
}
