/**
 * Envoltorios legibles sobre los permisos globales del módulo de dirección,
 * siguiendo el patrón de `app/lib/permisosModulos.ts`.
 *
 * **Esto es todo lo que debe haber aquí.** Cada función es un alias de
 * `hasPermiso('modulo.accion')`, sin lógica propia. Lo que este fichero **no**
 * vuelve a ser es un espejo de `api/lib/tasks/acceso.js`: lo fue, y divergió el
 * primer día —exigía `proyectos.editar` al responsable del proyecto, que en el
 * servidor puede editar sin ese permiso, así que el dueño de un proyecto no veía
 * sus propios botones—.
 *
 * La regla, para que no vuelva a pasar: **el frontend oculta, el backend decide,
 * y quien dice qué se puede hacer con una fila es la respuesta del servidor.**
 * Toda decisión de fila se lee de `permisos_fila`, que sale de las mismas
 * funciones que autorizan la petición. Dos implementaciones de la misma decisión
 * divergen, y el síntoma es un botón escondido a quien sí puede pulsarlo.
 *
 * Los permisos aún no cargados hacen que `hasPermiso` devuelva `false`, así que
 * el estado por defecto de todo lo de aquí es denegar.
 */
import { PERMISOS } from '../types/tasks';
import type { HasPermisoFn } from './permisosModulos';

/** Contexto de sesión que consumen las pantallas del módulo. */
export type AccesoTasks = {
  hasPermiso: HasPermisoFn;
  usuarioId: string;
  esAdmin: boolean;
};

export function puedeVerProyectos(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.proyectosVer);
}

export function puedeCrearProyectos(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.proyectosCrear);
}

/** `proyectos.editar` habilita además crear y editar tareas y gestionar miembros. */
export function puedeEditarProyectos(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.proyectosEditar);
}

export function puedeBorrarProyectos(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.proyectosBorrar);
}

export function puedeVerTodasLasTareas(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.tareasVerTodas);
}

export function puedeEditarTodasLasTareas(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.tareasEditarTodas);
}

export function puedeVerPresupuesto(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.presupuestoVer);
}

export function puedeVerCuadroMando(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.cuadroMando);
}

export function puedeVerReuniones(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.reunionesVer);
}

export function puedeGestionarReuniones(a: AccesoTasks): boolean {
  return a.hasPermiso(PERMISOS.reunionesGestionar);
}
