/** Comprueba si el usuario tiene al menos uno de los permisos indicados. */
export type HasPermisoFn = (codigo: string) => boolean;

export function tieneAlguno(hasPermiso: HasPermisoFn, ...codigos: string[]): boolean {
  return codigos.some((c) => hasPermiso(c));
}

/** Tarjeta / pantalla «Actuaciones del día» en Planning. */
export function puedeVerActuacionesPlanning(hasPermiso: HasPermisoFn): boolean {
  return tieneAlguno(hasPermiso, 'planning_dia.actuaciones', 'actuaciones.ver');
}

/** Tarjeta / pantalla «Activaciones del día» en Planning. */
export function puedeVerActivacionesPlanning(hasPermiso: HasPermisoFn): boolean {
  return tieneAlguno(hasPermiso, 'planning_dia.activaciones', 'activaciones.ver');
}

/** Tarjeta / pantalla «Arqueo de caja» desde Planning o módulo Cajas. */
export function puedeVerArqueoCaja(hasPermiso: HasPermisoFn): boolean {
  return tieneAlguno(hasPermiso, 'planning_dia.arqueo', 'cierres.ver');
}

/** Pantalla de programación del módulo Actuaciones. */
export function puedeProgramacionActuaciones(hasPermiso: HasPermisoFn): boolean {
  return hasPermiso('actuaciones.programacion');
}

export function puedeCrearActuacion(hasPermiso: HasPermisoFn): boolean {
  return hasPermiso('actuaciones.crear');
}

export function puedeEditarActuacion(hasPermiso: HasPermisoFn): boolean {
  return hasPermiso('actuaciones.editar');
}

/** Observaciones y valoración en Planning del día (o edición completa). */
export function puedeEditarSeguimientoActuacion(hasPermiso: HasPermisoFn): boolean {
  return tieneAlguno(hasPermiso, 'actuaciones.editar', 'planning_dia.actuaciones');
}

export function puedeFirmarActuacion(hasPermiso: HasPermisoFn): boolean {
  return tieneAlguno(hasPermiso, 'actuaciones.firma', 'planning_dia.actuaciones');
}

export function puedeBorrarActuacion(hasPermiso: HasPermisoFn): boolean {
  return hasPermiso('actuaciones.borrar');
}

export function puedeFacturacionActuaciones(hasPermiso: HasPermisoFn): boolean {
  return hasPermiso('actuaciones.facturacion');
}

/** Fichas de artistas (CRUD en módulo Actuaciones). */
export function puedeGestionarArtistas(hasPermiso: HasPermisoFn): boolean {
  return tieneAlguno(hasPermiso, 'actuaciones.programacion');
}
