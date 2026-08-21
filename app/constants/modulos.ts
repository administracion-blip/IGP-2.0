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
  { route: '/actuaciones', label: 'Actuaciones', icon: 'mic', permiso: 'actuaciones.ver' },
  { route: '/recursos-humanos', label: 'Recursos Humanos', icon: 'groups', permiso: 'recursos_humanos.ver' },
  { route: '/rrss', label: 'Marketing', icon: 'campaign', permiso: 'marketing.proponer' },
  { route: '/mystery-guest', label: 'Mystery Guest', icon: 'visibility', permiso: 'mystery_guest.ver' },
  { route: '/reservas', label: 'Reservas', icon: 'event-available', permiso: 'reservas.ver' },
  { route: '/facturacion', label: 'Facturación', icon: 'receipt', permiso: 'facturacion.ver' },
  { route: '/banca', label: 'Banca', icon: 'account-balance', permiso: 'banca.ver' },
  { route: '/planning-dia', label: 'Planning del Día', icon: 'today', permiso: 'planning_dia.ver' },
  { route: '/informes-ia', label: 'Informes IA', icon: 'auto-awesome', permiso: 'ia.informes' },
];

/** Permisos que controlan entradas del menú lateral (derivado de MODULOS). */
export const PERMISOS_MENU_LATERAL: string[] = MODULOS.map((m) => m.permiso).filter(
  (p): p is string => Boolean(p)
);

/** Permisos del menú engranaje de cabecera (no están en MODULOS). */
export const PERMISOS_MENU_CONFIGURACION = ['permisos.ver', 'ajustes.ver'] as const;

/** Primer segmento de ruta → módulo padre (submódulos sin entrada propia en el menú). */
const RUTA_A_MODULO_PADRE: Record<string, string> = {
  cashflow: '/cajas',
  rrpp: '/recursos-humanos',
  acuerdos: '/compras',
  'acuerdos-informe-compras': '/compras',
  'acuerdos-productos-activos': '/compras',
};

/** Devuelve el módulo (entrada de menú) al que pertenece una ruta de submódulo. */
export function moduloDeRuta(route: string): ModuloMenu | null {
  const seg = route.split('/').filter(Boolean)[0];
  if (!seg) return null;
  const base = RUTA_A_MODULO_PADRE[seg] ?? `/${seg}`;
  return MODULOS.find((m) => m.route === base) ?? null;
}
