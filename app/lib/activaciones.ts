import type { Activacion } from '../types/activaciones';

/**
 * Slug de un segmento de código de activación:
 * trim → NFD sin diacríticos → mayúsculas → no alfanumérico a `_` → colapsar `_` → trim `_`.
 */
export function slugParteCodigoActivacion(texto: string | null | undefined): string {
  return String(texto ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Código virtual de activación: empresa + marca + fecha inicio (YYYYMMDD) + tipo.
 * Solo une segmentos no vacíos con `_`. Si la fecha no es `YYYY-MM-DD`, se omite.
 */
export function codigoVirtualActivacion(parts: {
  empresaNombre?: string | null;
  marca?: string | null;
  vigenciaInicio?: string | null;
  tipoActivacion?: string | null;
}): string {
  const fechaIso = String(parts.vigenciaInicio ?? '').trim();
  const fechaSeg =
    /^\d{4}-\d{2}-\d{2}$/.test(fechaIso) ? fechaIso.replace(/-/g, '') : '';

  return [
    slugParteCodigoActivacion(parts.empresaNombre),
    slugParteCodigoActivacion(parts.marca),
    fechaSeg,
    slugParteCodigoActivacion(parts.tipoActivacion),
  ]
    .filter(Boolean)
    .join('_');
}

/**
 * Normaliza un teléfono para wa.me: quita espacios, guiones y paréntesis;
 * si no empieza por prefijo internacional asume +34 (España).
 */
export function normalizarTelefonoWhatsApp(telefono: string): string {
  let t = String(telefono ?? '').replace(/[\s\-().]/g, '');
  if (!t) return '';
  if (t.startsWith('00')) t = `+${t.slice(2)}`;
  if (!t.startsWith('+')) t = `+34${t}`;
  return t.replace(/[^\d+]/g, '');
}

/** dd/mm/yyyy legible a partir de YYYY-MM-DD (si no parsea, devuelve tal cual). */
function fechaEs(iso: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}

/**
 * URL de WhatsApp con mensaje de confirmación preformateado para el promotor.
 * WhatsApp abre el chat con el texto prellenado sin enviarlo.
 */
export function buildWhatsAppUrl(activacion: Activacion): string {
  const tel = normalizarTelefonoWhatsApp(activacion.promotor_telefono);
  const lineas = [
    `Hola ${activacion.promotor_nombre || ''}, te confirmamos la activación:`,
    '',
    `📋 Código: ${activacion.codigo}`,
    `🏷️ Producto: ${activacion.marca} – ${activacion.producto}`,
    `🏢 Empresa: ${activacion.empresa_nombre}${activacion.empresa_cif ? ` (${activacion.empresa_cif})` : ''}`,
    `📅 Vigencia: ${fechaEs(activacion.vigencia_inicio)} → ${fechaEs(activacion.vigencia_fin)}`,
    `⏱️ Duración por sesión: ${activacion.duracion_horas}h`,
    `👥 Equipo: ${activacion.equipo_descripcion}`,
    '',
    '¿Podéis confirmar disponibilidad?',
  ];
  return `https://wa.me/${tel.replace('+', '')}?text=${encodeURIComponent(lineas.join('\n'))}`;
}
