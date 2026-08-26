/**
 * Contexto de acceso del módulo de dirección listo para las pantallas.
 *
 * `permisosCargando` existe para no dejar la pantalla en blanco mientras
 * `/api/me` está en vuelo: en ese momento `hasPermiso` devuelve `false` para
 * todo y, sin distinguirlo de «no tiene permiso», la vista personal parecería
 * vacía o denegada.
 */
import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import type { AccesoTasks } from '../lib/tasksAcceso';

export type AccesoTasksUi = AccesoTasks & { permisosCargando: boolean };

export function useAccesoTasks(): AccesoTasksUi {
  const { user, hasPermiso, permisosStatus } = useAuth();

  return useMemo<AccesoTasksUi>(() => {
    const esAdmin = user?.Rol === 'Administrador';
    return {
      hasPermiso,
      usuarioId: user?.id_usuario != null ? String(user.id_usuario).trim() : '',
      esAdmin,
      permisosCargando:
        !esAdmin && (permisosStatus === 'idle' || permisosStatus === 'loading'),
    };
  }, [user, hasPermiso, permisosStatus]);
}
