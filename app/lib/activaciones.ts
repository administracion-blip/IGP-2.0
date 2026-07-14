import type { Activacion } from '../types/activaciones';

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
