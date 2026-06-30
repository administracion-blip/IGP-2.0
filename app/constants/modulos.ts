/**
 * Módulos principales de la app (menú lateral). Fuente única usada por el
 * layout y por la pantalla de Favoritos para agrupar submódulos por módulo.
 */
export type ModuloMenu = { route: string; label: string; icon: string; permiso: string | null };

export const MODULOS: ModuloMenu[] = [
  { route: '/', label: 'Inicio', icon: 'home', permiso: null },
  { route: '/base-datos', label: 'Base de Datos', icon: 'storage', permiso: 'base_datos.ver' },
  { route: '/mantenimiento', label: 'Mantenimiento', icon: 'build', permiso: 'mantenimiento.ver' },
  { route: '/compras', label: 'Compras', icon: 'shopping-cart', permiso: 'compras.ver' },
  { route: '/cajas', label: 'Cajas', icon: 'point-of-sale', permiso: 'cajas.ver' },
  { route: '/cashflow', label: 'Cashflow', icon: 'trending-up', permiso: 'cashflow.ver' },
  { route: '/actuaciones', label: 'Actuaciones', icon: 'mic', permiso: 'actuaciones.ver' },
  { route: '/rrpp', label: 'Rrpp', icon: 'people', permiso: 'rrpp.ver' },
  { route: '/recursos-humanos', label: 'Recursos Humanos', icon: 'groups', permiso: 'recursos_humanos.ver' },
  { route: '/rrss', label: 'Marketing', icon: 'campaign', permiso: 'marketing.proponer' },
  { route: '/mystery-guest', label: 'Mystery Guest', icon: 'visibility', permiso: 'mystery_guest.ver' },
  { route: '/reservas', label: 'Reservas', icon: 'event-available', permiso: 'reservas.ver' },
  { route: '/acuerdos', label: 'Acuerdos', icon: 'handshake', permiso: 'acuerdos.ver' },
  { route: '/facturacion', label: 'Facturación', icon: 'receipt', permiso: 'facturacion.ver' },
  { route: '/planning-dia', label: 'Planning del Día', icon: 'today', permiso: 'planning_dia.ver' },
];

/** Devuelve el módulo (entrada de menú) al que pertenece una ruta de submódulo. */
export function moduloDeRuta(route: string): ModuloMenu | null {
  const seg = route.split('/').filter(Boolean)[0];
  if (!seg) return null;
  const base = `/${seg}`;
  return MODULOS.find((m) => m.route === base) ?? null;
}
