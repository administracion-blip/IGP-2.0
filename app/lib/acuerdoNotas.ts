/**
 * Utilidades de notas de un acuerdo (formato líneas `dd/mm/aaaa - texto`).
 * Comparten timeline, modal y vista resumida en la ficha.
 */

/** Tamaño de fuente común para el contenido de notas. */
export const NOTAS_CONTENIDO_FONT_SIZE = 11;

/** Línea `dd/mm/aaaa` + `:` o `-` (notas antiguas o nuevas) + resto del texto. */
export const NOTAS_LINEA_FECHA = /^(\d{1,2}\/\d{1,2}\/\d{4})\s*[-:]\s*(.*)$/;

export type NotaLinea = {
  id: string;
  fecha: string | null;
  texto: string;
  raw: string;
  fechaSort: number;
  ordenOriginal: number;
};

/** Fecha local `dd/mm/aaaa` para nuevas notas. */
export function fechaHoyDmy(): string {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const y = d.getFullYear();
  return `${day}/${m}/${y}`;
}

function dmyToSort(dmy: string): number {
  const parts = dmy.split('/');
  if (parts.length !== 3) return 0;
  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const year = Number(parts[2]);
  if (!day || !month || !year) return 0;
  return year * 10000 + month * 100 + day;
}

/**
 * Parsea el campo `Notas` en bloques de nota.
 * Una nota empieza en línea con fecha `dd/mm/aaaa - …`; las líneas siguientes
 * sin fecha se concatenan a esa nota (evita trocear un mismo texto en tarjetas).
 * Líneas iniciales sin fecha forman un bloque «Sin fecha».
 */
export function parseNotas(plain: string): NotaLinea[] {
  if (!plain?.trim()) return [];
  const lines = plain.split('\n');
  const out: NotaLinea[] = [];
  let idx = 0;

  const pushNueva = (fecha: string | null, primeraLineaTexto: string, rawLine: string) => {
    out.push({
      id: `n-${idx}`,
      fecha,
      texto: primeraLineaTexto,
      raw: rawLine,
      fechaSort: fecha ? dmyToSort(fecha) : 0,
      ordenOriginal: idx,
    });
    idx += 1;
  };

  const appendAUltima = (rawLine: string) => {
    const last = out[out.length - 1];
    if (!last) {
      pushNueva(null, rawLine, rawLine);
      return;
    }
    last.texto = last.texto ? `${last.texto}\n${rawLine}` : rawLine;
    last.raw = last.raw ? `${last.raw}\n${rawLine}` : rawLine;
  };

  for (const line of lines) {
    // Conservamos líneas en blanco dentro de un bloque ya abierto (separadores).
    if (!line.trim()) {
      if (out.length > 0) appendAUltima('');
      continue;
    }
    const trimmed = line.trimEnd();
    const m = trimmed.trim().match(NOTAS_LINEA_FECHA);
    if (m) {
      pushNueva(m[1], (m[2] || '').trim(), trimmed.trim());
    } else {
      appendAUltima(trimmed.trim());
    }
  }

  // Quitar saltos finales vacíos acumulados
  for (const n of out) {
    n.texto = n.texto.replace(/\n+$/g, '').trimEnd();
    n.raw = n.raw.replace(/\n+$/g, '').trimEnd();
  }
  return out.filter((n) => n.texto.trim() || n.fecha);
}

/** Orden timeline: más reciente arriba; mismo día respeta prepend (índice menor = más nuevo). */
export function notasTimelineOrdenadas(plain: string): NotaLinea[] {
  return [...parseNotas(plain)].sort((a, b) => {
    if (a.fechaSort !== b.fechaSort) return b.fechaSort - a.fechaSort;
    return a.ordenOriginal - b.ordenOriginal;
  });
}

/** Añade una nota al inicio con la fecha de hoy. */
export function prependNota(existentes: string, texto: string): string {
  const t = texto.trim();
  if (!t) return existentes.trim();
  const line = `${fechaHoyDmy()} - ${t}`;
  const base = existentes.trim();
  return base ? `${line}\n${base}` : line;
}

/**
 * Elimina una nota por su `ordenOriginal` (índice de bloque tras el parseo).
 * Reconstruye el campo plano con el resto de bloques (`raw` puede ser multilínea).
 */
export function eliminarNotaPorOrden(existentes: string, ordenOriginal: number): string {
  const kept = parseNotas(existentes).filter((n) => n.ordenOriginal !== ordenOriginal);
  return kept.map((n) => n.raw).join('\n');
}

export function resumenNotas(plain: string): {
  total: number;
  ultimaFecha: string | null;
  ultimaTexto: string | null;
} {
  const ordenadas = notasTimelineOrdenadas(plain);
  if (ordenadas.length === 0) {
    return { total: 0, ultimaFecha: null, ultimaTexto: null };
  }
  const u = ordenadas[0];
  return {
    total: ordenadas.length,
    ultimaFecha: u.fecha,
    ultimaTexto: u.texto || u.raw,
  };
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
 * @deprecated Editor monolítico sustituido por timeline; se mantiene por compatibilidad.
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
