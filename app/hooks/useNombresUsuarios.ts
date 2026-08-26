/**
 * Resuelve nombres de usuario para el módulo de dirección.
 *
 * `GET /api/usuarios` exige `usuarios.ver`, así que puede fallar por permisos.
 * Cuando falla, `noDisponibles` queda a `true` y `nombrePorId` devuelve un texto
 * legible: en la interfaz **nunca** se pinta el identificador en bruto. Es el
 * mismo trato que da `app/(app)/departamentos.tsx` al responsable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../utils/api';
import type { OpcionDesplegable } from '../components/SelectorDesplegable';

type UsuarioApi = {
  id_usuario?: string | number;
  Nombre?: string;
  Apellidos?: string;
  Email?: string;
};

export type UsuarioTasks = { id: string; nombre: string; email?: string };

export type NombresUsuarios = {
  usuarios: UsuarioTasks[];
  /** Opciones listas para `SelectorDesplegable`, ordenadas por nombre. */
  opciones: OpcionDesplegable[];
  /** Nombre legible del usuario. Nunca devuelve el identificador. */
  nombrePorId: (id?: string | null) => string;
  /** El listado no se pudo leer (habitualmente, falta `usuarios.ver`). */
  noDisponibles: boolean;
  cargando: boolean;
};

function nombreCompleto(u: UsuarioApi): string {
  const nombre = `${u.Nombre ?? ''} ${u.Apellidos ?? ''}`.trim();
  return nombre || (u.Email ?? '').trim();
}

export function useNombresUsuarios(): NombresUsuarios {
  const [usuarios, setUsuarios] = useState<UsuarioTasks[]>([]);
  const [noDisponibles, setNoDisponibles] = useState(false);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    apiFetch('/api/usuarios')
      .then((r) => r.json())
      .then((data: { usuarios?: UsuarioApi[]; error?: string }) => {
        if (cancelado) return;
        if (data.error || !Array.isArray(data.usuarios)) {
          setUsuarios([]);
          setNoDisponibles(true);
          return;
        }
        setUsuarios(
          data.usuarios
            .map((u) => ({
              id: u.id_usuario != null ? String(u.id_usuario).trim() : '',
              nombre: nombreCompleto(u),
              email: (u.Email ?? '').trim() || undefined,
            }))
            .filter((u) => u.id !== '' && u.nombre !== ''),
        );
        setNoDisponibles(false);
      })
      .catch((e) => {
        if (cancelado) return;
        console.error('[tasks] no se pudo leer el listado de usuarios', e);
        setUsuarios([]);
        setNoDisponibles(true);
      })
      .finally(() => {
        if (!cancelado) setCargando(false);
      });
    return () => {
      cancelado = true;
    };
  }, []);

  const porId = useMemo(() => {
    const mapa = new Map<string, UsuarioTasks>();
    for (const u of usuarios) mapa.set(u.id, u);
    return mapa;
  }, [usuarios]);

  const nombrePorId = useCallback(
    (id?: string | null): string => {
      const clave = (id ?? '').trim();
      if (!clave) return '—';
      if (clave === 'sistema') return 'Sistema';
      const encontrado = porId.get(clave);
      if (encontrado) return encontrado.nombre;
      if (noDisponibles || cargando) return 'Usuario no disponible';
      return 'Usuario eliminado';
    },
    [porId, noDisponibles, cargando],
  );

  const opciones = useMemo<OpcionDesplegable[]>(
    () =>
      usuarios
        .map((u) => ({
          id: u.id,
          titulo: u.nombre,
          subtitulo: u.email,
          icono: 'person' as const,
        }))
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    [usuarios],
  );

  return { usuarios, opciones, nombrePorId, noDisponibles, cargando };
}
