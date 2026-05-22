/**
 * Utilidades del editor de notas de un acuerdo.
 *
 * Antes vivían inline en `app/(app)/acuerdos.tsx`. Se extraen aquí porque las
 * comparten:
 *  - `useAcuerdoNotas` (hook): handlers Ctrl+espacio (web y nativo).
 *  - `<AcuerdoNotasModal>` (componente): editor contentEditable web.
 *  - `acuerdos.tsx` (renderer del panel): muestra las notas con fechas
 *    destacadas en la vista de detalle.
 *
 * Mantienen el mismo formato que el editor para que el render del panel
 * coincida exactamente con lo que el usuario escribe (fechas dd/mm/aaaa
 * resaltadas en azul, negrita y cursiva, separador « - »).
 */

/** Tamaño de fuente común para el contenido de notas. */
export const NOTAS_CONTENIDO_FONT_SIZE = 11;

/** Línea `dd/mm/aaaa` + `:` o `-` (notas antiguas o nuevas) + resto del texto. */
export const NOTAS_LINEA_FECHA = /^(\d{1,2}\/\d{1,2}\/\d{4})\s*[-:]\s*(.*)$/;

/** Fecha local `dd/mm/aaaa` para insertar en notas (Ctrl+espacio). */
export function fechaHoyDmy(): string {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const y = d.getFullYear();
  return `${day}/${m}/${y}`;
}

/** Escapa entidades HTML básicas (sin terceras dependencias). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convierte texto plano a HTML para el editor web (fechas en azul, negrita y
 * cursiva; separador « - »). Mantiene el shape exacto que produce
 * `handleWebKeyDown` al insertar una fecha con Ctrl+espacio.
 */
export function plainNotasToHtmlForEditor(plain: string): string {
  if (!plain) return '';
  return plain
    .split('\n')
    .map((line) => {
      const m = line.match(NOTAS_LINEA_FECHA);
      if (m) {
        return `<span style="font-size:${NOTAS_CONTENIDO_FONT_SIZE}px;color:#2563eb;font-weight:700;font-style:italic">${m[1]}</span> - ${escapeHtml(m[2])}`;
      }
      return escapeHtml(line);
    })
    .join('<br>');
}
