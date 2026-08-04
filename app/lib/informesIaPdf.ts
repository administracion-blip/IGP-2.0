/**
 * PDF de un informe IA (todas las fuentes; tablas completas para día a día).
 */

import type { jsPDF } from 'jspdf';

export type InformeIaParaPdf = {
  informeId: string;
  fuente: string;
  resumen: string | null;
  datosJson?: unknown;
  generadoEn?: string;
  promptNombre?: string;
  modelo?: string | null;
};

const MARGIN = 14;
const PAGE_BOTTOM = 278;
const LINE_H = 4.5;
const HEAD_FILL: [number, number, number] = [14, 165, 233];
const AMBER: [number, number, number] = [146, 64, 14];
const SLATE: [number, number, number] = [51, 65, 85];
const MUTED: [number, number, number] = [148, 163, 184];

const FUENTE_LABELS: Record<string, string> = {
  dia_a_dia: 'Día a día',
  objetivos_mes: 'Objetivos del mes',
  ventas_hora: 'Ventas por hora',
  compras_variaciones: 'Variaciones de compras',
};

function formatPctSigned(n: unknown): string {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

function formatMonedaSigned(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${formatMoneda(v)}`;
}

function shortDiferenciaLabel(item: {
  diferenciaLabel?: string | null;
  delta?: number;
  real?: number;
  comparativa?: number;
  sinDatos?: boolean;
}): string {
  if (item.sinDatos) return '—';
  if (item.diferenciaLabel) return String(item.diferenciaLabel).replace(/^Diferencia:\s*/i, '');
  const delta = item.delta != null ? Number(item.delta) : Number(item.real || 0) - Number(item.comparativa || 0);
  return formatMonedaSigned(delta);
}

function shortVariacionLabel(item: {
  variacionPctLabel?: string | null;
  variacionPct?: number | null;
  pctVsComp?: number | null;
  real?: number;
  comparativa?: number;
  sinDatos?: boolean;
}): string {
  if (item.sinDatos) return '—';
  if (item.variacionPctLabel) {
    return String(item.variacionPctLabel).replace(/\s*respecto al día comparable$/i, '');
  }
  if (item.variacionPct != null) return formatPctSigned(item.variacionPct);
  const comp = Number(item.comparativa || 0);
  if (comp > 0) {
    return formatPctSigned((Number(item.real || 0) / comp) * 100 - 100);
  }
  return '—';
}

function labelComparativaPdf(datos: Record<string, unknown>): string {
  if (typeof datos.comparativaLabel === 'string' && datos.comparativaLabel) {
    return datos.comparativaLabel;
  }
  const f = formatFechaEs(datos.fechaComparativa as string | undefined);
  if (datos.origenComparativa === 'festivo') {
    return `Comparado con ${f} (día mapeado en festivos)`;
  }
  if (datos.fechaComparativa) {
    return `Comparado con ${f} (mismo día año anterior)`;
  }
  return '';
}

type AutoTable = typeof import('jspdf-autotable').default;

function etiquetaFuente(clave: string): string {
  return FUENTE_LABELS[clave] || clave.replace(/_/g, ' ');
}

function formatFechaEs(iso?: string | null): string {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  try {
    return new Date(iso).toLocaleDateString('es-ES');
  } catch {
    return String(iso);
  }
}

function formatFechaHoraEs(iso?: string | null): string {
  if (!iso) return new Date().toLocaleString('es-ES');
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

function formatMoneda(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const parts = v.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

function formatPct(n: unknown): string {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${v.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;
}

function ensureY(doc: jsPDF, y: number, needMm = 20): number {
  if (y + needMm > PAGE_BOTTOM) {
    doc.addPage();
    return 16;
  }
  return y;
}

function sectionTitle(doc: jsPDF, title: string, y: number): number {
  y = ensureY(doc, y, 14);
  doc.setDrawColor(...HEAD_FILL);
  doc.setFillColor(224, 242, 254);
  doc.roundedRect(MARGIN, y - 4, doc.internal.pageSize.getWidth() - MARGIN * 2, 8, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...AMBER);
  doc.text(title, MARGIN + 3, y + 1.5);
  return y + 10;
}

/** Dibuja una línea con segmentos **negrita** (sin wrap interno). */
function drawInlineBold(doc: jsPDF, text: string, x: number, y: number, fontSize: number): void {
  doc.setFontSize(fontSize);
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  let cursor = x;
  for (const part of parts) {
    const bold = part.startsWith('**') && part.endsWith('**');
    const plain = bold ? part.slice(2, -2) : part;
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.text(plain, cursor, y);
    cursor += doc.getTextWidth(plain);
  }
}

/**
 * Texto con markdown ligero: ## títulos, - listas, **negrita**.
 * Devuelve la Y final.
 */
function renderResumenMarkdown(doc: jsPDF, resumen: string | null, y: number): number {
  const pageW = doc.internal.pageSize.getWidth();
  const maxW = pageW - MARGIN * 2;

  if (!resumen || !String(resumen).trim()) {
    y = ensureY(doc, y, 10);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text('Sin redacción IA', MARGIN, y);
    return y + 8;
  }

  const lines = String(resumen).replace(/\r\n/g, '\n').split('\n');

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      y += 3;
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      y = ensureY(doc, y, 12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(...SLATE);
      const title = h2[1].replace(/\*\*/g, '').trim();
      const wrapped = doc.splitTextToSize(title, maxW) as string[];
      for (const wl of wrapped) {
        y = ensureY(doc, y, 8);
        doc.text(wl, MARGIN, y);
        y += 5.5;
      }
      y += 1;
      continue;
    }

    const li = trimmed.match(/^[-*]\s+(.+)$/);
    const content = li ? li[1] : trimmed;
    const bullet = li ? '• ' : '';
    const fontSize = 9.5;
    doc.setFontSize(fontSize);

    // Wrap sobre texto plano (sin **) y luego dibujar cada línea con negrita
    const plainForWrap = `${bullet}${content.replace(/\*\*/g, '')}`;
    const wrappedPlain = doc.splitTextToSize(plainForWrap, maxW) as string[];

    // Reconstruir segmentos con ** para la primera línea (aprox.);
    // estrategia: wrap del contenido con marcadores sustituidos por placeholders
    const tokens = `${bullet}${content}`.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
    let lineBuf = '';
    const outLines: string[] = [];
    doc.setFont('helvetica', 'normal');
    for (const tok of tokens) {
      const bold = tok.startsWith('**') && tok.endsWith('**');
      const plain = bold ? tok.slice(2, -2) : tok;
      const trial = lineBuf.replace(/\*\*/g, '') + plain;
      if (doc.getTextWidth(trial) > maxW && lineBuf) {
        outLines.push(lineBuf);
        lineBuf = bold ? `**${plain}**` : plain;
      } else {
        lineBuf += bold ? `**${plain}**` : plain;
      }
    }
    if (lineBuf) outLines.push(lineBuf);

    const toDraw = outLines.length ? outLines : wrappedPlain;
    for (const line of toDraw) {
      y = ensureY(doc, y, 7);
      doc.setTextColor(30, 41, 59);
      drawInlineBold(doc, line, MARGIN, y, fontSize);
      y += LINE_H;
    }
    if (li) y += 0.5;
  }

  return y + 4;
}

function addPageFooters(doc: jsPDF): void {
  const total = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, pageH - 12, pageW - MARGIN, pageH - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('IGP · Informes IA', MARGIN, pageH - 7);
    doc.text(`Página ${i} de ${total}`, pageW - MARGIN, pageH - 7, { align: 'right' });
  }
}

function tableOpts(startY: number) {
  return {
    startY,
    margin: { left: MARGIN, right: MARGIN },
    styles: {
      fontSize: 8,
      cellPadding: 2.2,
      textColor: SLATE as [number, number, number],
      lineColor: [226, 232, 240] as [number, number, number],
      lineWidth: 0.2,
      overflow: 'linebreak' as const,
      valign: 'middle' as const,
    },
    headStyles: {
      fillColor: HEAD_FILL,
      textColor: 255 as const,
      fontStyle: 'bold' as const,
      fontSize: 8,
    },
    alternateRowStyles: { fillColor: [248, 250, 252] as [number, number, number] },
  };
}

function desvObjPdf(l: {
  pctDesviacion?: number | null;
  pctConsecucion?: number | null;
  pctDesviacionLabel?: string | null;
  sinDatos?: boolean;
}): string {
  if (l.sinDatos) return '—';
  if (l.pctDesviacionLabel) return String(l.pctDesviacionLabel);
  const d = l.pctDesviacion != null
    ? Number(l.pctDesviacion)
    : l.pctConsecucion != null
      ? Number(l.pctConsecucion) - 100
      : null;
  return d == null ? '—' : `${formatPctSigned(d)} vs objetivo`;
}

type PuntoHoraPdf = { hora: number; real: number; comparativa: number };

function formatImporteHoraCompactPdf(n: number): string {
  if (!(n > 0)) return '—';
  if (n >= 10000) {
    return `${(n / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })}k`;
  }
  return `${Math.round(n).toLocaleString('es-ES')}€`;
}

function fillColorDeltaHora(real: number, comparativa: number): [number, number, number] | null {
  if (!(real > 0) && !(comparativa > 0)) return null;
  const delta = real - comparativa;
  if (delta > 100) return [220, 252, 231]; // #dcfce7
  if (delta < -100) return [254, 226, 226]; // #fee2e2
  return [254, 243, 199]; // #fef3c7
}

/** Fallback tabular: matriz GRUPO + locales × horas (color por delta). */
function renderVentasHoraComparativaTabla(
  doc: jsPDF,
  autoTable: AutoTable,
  datos: Record<string, unknown>,
  y: number,
): number {
  const ventas = (datos.ventasHoraComparativa || {}) as {
    grupo?: {
      porHora?: PuntoHoraPdf[];
      totalReal?: number;
      totalComparativa?: number;
    };
    locales?: {
      localId?: string;
      nombre?: string;
      porHora?: PuntoHoraPdf[];
      totalReal?: number;
      totalComparativa?: number;
    }[];
  };
  const grupoPorHora = Array.isArray(ventas.grupo?.porHora) ? ventas.grupo!.porHora! : [];
  const locales = Array.isArray(ventas.locales) ? ventas.locales! : [];
  if (!grupoPorHora.length && !locales.some((l) => (l.porHora || []).length)) return y;

  const conVenta = new Set<number>();
  const mark = (arr: PuntoHoraPdf[]) => {
    for (const p of arr) {
      if ((Number(p.real) || 0) > 0 || (Number(p.comparativa) || 0) > 0) {
        conVenta.add(Number(p.hora));
      }
    }
  };
  mark(grupoPorHora);
  for (const loc of locales) mark(loc.porHora || []);

  let horas: number[];
  if (grupoPorHora.length) {
    const ordered: number[] = [];
    const seen = new Set<number>();
    for (const p of grupoPorHora) {
      const h = Number(p.hora);
      if (conVenta.has(h) && !seen.has(h)) {
        ordered.push(h);
        seen.add(h);
      }
    }
    horas = [...ordered, ...[...conVenta].filter((h) => !seen.has(h)).sort((a, b) => a - b)];
  } else {
    horas = [...conVenta].sort((a, b) => a - b);
  }
  if (!horas.length) return y;

  type Fila = {
    label: string;
    byHora: Map<number, PuntoHoraPdf>;
    totalReal: number;
    totalComparativa: number;
  };
  const toMap = (arr: PuntoHoraPdf[]) => {
    const m = new Map<number, PuntoHoraPdf>();
    for (const p of arr) {
      m.set(Number(p.hora), {
        hora: Number(p.hora),
        real: Number(p.real) || 0,
        comparativa: Number(p.comparativa) || 0,
      });
    }
    return m;
  };
  const filas: Fila[] = [];
  if (grupoPorHora.length || ventas.grupo?.totalReal != null) {
    const byHora = toMap(grupoPorHora);
    filas.push({
      label: 'GRUPO',
      byHora,
      totalReal:
        ventas.grupo?.totalReal != null
          ? Number(ventas.grupo.totalReal) || 0
          : [...byHora.values()].reduce((s, p) => s + p.real, 0),
      totalComparativa:
        ventas.grupo?.totalComparativa != null
          ? Number(ventas.grupo.totalComparativa) || 0
          : [...byHora.values()].reduce((s, p) => s + p.comparativa, 0),
    });
  }
  for (const loc of locales) {
    const byHora = toMap(loc.porHora || []);
    filas.push({
      label: String(loc.nombre || loc.localId || '—'),
      byHora,
      totalReal:
        loc.totalReal != null
          ? Number(loc.totalReal) || 0
          : [...byHora.values()].reduce((s, p) => s + p.real, 0),
      totalComparativa:
        loc.totalComparativa != null
          ? Number(loc.totalComparativa) || 0
          : [...byHora.values()].reduce((s, p) => s + p.comparativa, 0),
    });
  }
  if (!filas.length) return y;

  const MAX_HORAS = 13;
  const chunks =
    horas.length > MAX_HORAS
      ? [horas.slice(0, Math.ceil(horas.length / 2)), horas.slice(Math.ceil(horas.length / 2))]
      : [horas];

  y = sectionTitle(doc, 'Ventas por hora (real vs comparativa)', y);
  y = ensureY(doc, y, 8);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text('Color = real − comparativa · verde >+100 · ámbar ±100 · rojo <−100', MARGIN, y);
  y += 5;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const conTotal = ci === chunks.length - 1;
    const head = [
      'Local',
      ...chunk.map((h) => String(h).padStart(2, '0')),
      ...(conTotal ? ['Total'] : []),
    ];
    const body = filas.map((fila) => [
      fila.label,
      ...chunk.map((h) => formatImporteHoraCompactPdf(fila.byHora.get(h)?.real ?? 0)),
      ...(conTotal ? [formatImporteHoraCompactPdf(fila.totalReal)] : []),
    ]);
    const metaPorFila = filas.map((fila) => ({
      horas: chunk.map((h) => ({
        real: fila.byHora.get(h)?.real ?? 0,
        comparativa: fila.byHora.get(h)?.comparativa ?? 0,
      })),
      totalReal: fila.totalReal,
      totalComparativa: fila.totalComparativa,
    }));

    y = ensureY(doc, y, 28);
    autoTable(doc, {
      ...tableOpts(y),
      styles: {
        ...tableOpts(y).styles,
        fontSize: 6.5,
        cellPadding: 1.2,
        halign: 'center',
        overflow: 'ellipsize' as const,
      },
      headStyles: {
        ...tableOpts(y).headStyles,
        fontSize: 6.5,
        cellPadding: 1.2,
        halign: 'center',
      },
      alternateRowStyles: undefined,
      head: [head],
      body,
      columnStyles: {
        0: { halign: 'left', cellWidth: 22, fontStyle: 'bold' },
        ...(conTotal
          ? { [head.length - 1]: { fontStyle: 'bold' as const, cellWidth: 14 } }
          : {}),
      },
      didParseCell: (data) => {
        if (data.section !== 'body' || data.column.index === 0) return;
        const rowMeta = metaPorFila[data.row.index];
        if (!rowMeta) return;
        const isTotalCol = conTotal && data.column.index === head.length - 1;
        const real = isTotalCol
          ? rowMeta.totalReal
          : rowMeta.horas[data.column.index - 1]?.real ?? 0;
        const comparativa = isTotalCol
          ? rowMeta.totalComparativa
          : rowMeta.horas[data.column.index - 1]?.comparativa ?? 0;
        const fill = fillColorDeltaHora(real, comparativa);
        if (fill) data.cell.styles.fillColor = fill;
        if (!(real > 0) && !(comparativa > 0)) {
          data.cell.styles.textColor = MUTED;
        }
      },
    });
    y = lastTableY(doc, y) + 6;
  }
  return y;
}

function renderDiaADia(doc: jsPDF, autoTable: AutoTable, datos: Record<string, unknown>, y: number): number {
  const fecha = datos.fecha as string | undefined;
  const comparativaLabel = labelComparativaPdf(datos);

  y = sectionTitle(doc, 'Fechas del briefing', y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...SLATE);
  doc.text(`Día analizado: ${formatFechaEs(fecha)}`, MARGIN, y);
  y += 5;
  if (comparativaLabel) {
    const lines = doc.splitTextToSize(comparativaLabel, doc.internal.pageSize.getWidth() - MARGIN * 2) as string[];
    doc.text(lines, MARGIN, y);
    y += lines.length * LINE_H + 4;
  } else {
    y += 4;
  }

  type FactItem = {
    nombre?: string;
    real?: number;
    comparativa?: number;
    delta?: number;
    pctVsComp?: number | null;
    diferenciaLabel?: string | null;
    variacionPct?: number | null;
    variacionPctLabel?: string | null;
    sinDatos?: boolean;
  };
  const fact = (datos.facturacion || {}) as { locales?: FactItem[]; total?: FactItem };
  const factLocales = Array.isArray(fact.locales) ? fact.locales : [];

  if (fact.total) {
    y = sectionTitle(doc, 'KPI — Facturación del grupo', y);
    y = ensureY(doc, y, 28);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...SLATE);
    doc.text(`Facturado real: ${formatMoneda(fact.total.real)}`, MARGIN, y);
    y += 6.5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.text(`Día comparable: ${formatMoneda(fact.total.comparativa)}`, MARGIN, y);
    y += 5.5;
    if (comparativaLabel) {
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      const cl = doc.splitTextToSize(comparativaLabel, doc.internal.pageSize.getWidth() - MARGIN * 2) as string[];
      doc.text(cl, MARGIN, y);
      y += cl.length * LINE_H + 2;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...HEAD_FILL);
    const difTxt = fact.total.diferenciaLabel || `Diferencia: ${shortDiferenciaLabel(fact.total)}`;
    const varTxt = fact.total.variacionPctLabel || `${shortVariacionLabel(fact.total)} respecto al día comparable`;
    doc.text(`${difTxt}  ·  ${varTxt}`, MARGIN, y);
    y += 9;
  }

  if (factLocales.length || fact.total) {
    y = sectionTitle(doc, 'Facturación por local', y);
    y = ensureY(doc, y, 30);
    const body = factLocales.map((l) => [
      String(l.nombre || '—'),
      l.sinDatos ? '—' : formatMoneda(l.real),
      l.sinDatos ? '—' : formatMoneda(l.comparativa),
      shortDiferenciaLabel(l),
      shortVariacionLabel(l),
    ]);
    if (fact.total) {
      body.push([
        'Total grupo',
        formatMoneda(fact.total.real),
        formatMoneda(fact.total.comparativa),
        shortDiferenciaLabel(fact.total),
        shortVariacionLabel(fact.total),
      ]);
    }
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Local', 'Real', 'Comparable', 'Diferencia', '% vs comparable']],
      body,
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index === body.length - 1 && fact.total) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [224, 242, 254];
        }
      },
    });
    y = lastTableY(doc, y) + 8;
  }

  type ObjItem = {
    localId?: string;
    nombre?: string;
    pctConsecucion?: number | null;
    pctDesviacion?: number | null;
    pctDesviacionLabel?: string | null;
    importeRealHastaAyer?: number;
    importeCompHastaAyer?: number;
    realLabel?: string | null;
    objetivoLabel?: string | null;
    sinDatos?: boolean;
  };
  type AgrupItem = {
    id?: string;
    nombre?: string;
    pctDesviacion?: number | null;
    pctConsecucion?: number | null;
    pctDesviacionLabel?: string | null;
    importeRealHastaAyer?: number;
    importeCompHastaAyer?: number;
    realLabel?: string | null;
    objetivoLabel?: string | null;
    localesIncluidos?: number;
  };
  const obj = (datos.objetivos || {}) as {
    mes?: string;
    hastaFecha?: string;
    locales?: ObjItem[];
    total?: ObjItem;
    peoresPorCaida?: ObjItem[];
    agrupaciones?: AgrupItem[];
  };
  const objLocales = Array.isArray(obj.locales) ? obj.locales : [];
  if (objLocales.length || obj.total) {
    const tit = ['Consecución del mes', obj.mes || null, obj.hastaFecha ? `hasta ${formatFechaEs(obj.hastaFecha)}` : null]
      .filter(Boolean)
      .join(' · ');
    y = sectionTitle(doc, tit, y);
    y = ensureY(doc, y, 30);
    const body = objLocales.map((l) => [
      String(l.nombre || '—'),
      desvObjPdf(l),
      l.sinDatos || l.importeRealHastaAyer == null
        ? '—'
        : (l.realLabel || formatMoneda(l.importeRealHastaAyer)),
      l.sinDatos || l.importeCompHastaAyer == null
        ? '—'
        : (l.objetivoLabel || formatMoneda(l.importeCompHastaAyer)),
    ]);
    if (obj.total) {
      body.push([
        'Total grupo',
        desvObjPdf(obj.total),
        obj.total.importeRealHastaAyer == null
          ? '—'
          : (obj.total.realLabel || formatMoneda(obj.total.importeRealHastaAyer)),
        obj.total.importeCompHastaAyer == null
          ? '—'
          : (obj.total.objetivoLabel || formatMoneda(obj.total.importeCompHastaAyer)),
      ]);
    }
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Local', 'Desviación', 'Real', 'Objetivo']],
      body,
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index === body.length - 1 && obj.total) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [224, 242, 254];
        }
      },
    });
    y = lastTableY(doc, y) + 8;

    const peores = Array.isArray(obj.peoresPorCaida) && obj.peoresPorCaida.length
      ? obj.peoresPorCaida
      : [...objLocales]
        .filter((l) => {
          if (l.sinDatos) return false;
          const d = l.pctDesviacion != null
            ? Number(l.pctDesviacion)
            : l.pctConsecucion != null
              ? Number(l.pctConsecucion) - 100
              : null;
          return d != null && d < 0;
        })
        .sort((a, b) => {
          const da = a.pctDesviacion ?? ((a.pctConsecucion ?? 100) - 100);
          const db = b.pctDesviacion ?? ((b.pctConsecucion ?? 100) - 100);
          return da - db;
        })
        .slice(0, 5);
    if (peores.length) {
      y = sectionTitle(doc, 'Peores por caída vs objetivo', y);
      y = ensureY(doc, y, 24);
      autoTable(doc, {
        ...tableOpts(y),
        head: [['Local', 'Desviación']],
        body: peores.map((l) => [String(l.nombre || '—'), desvObjPdf(l)]),
        columnStyles: { 1: { halign: 'right' } },
      });
      y = lastTableY(doc, y) + 8;
    }

    const agrupaciones = Array.isArray(obj.agrupaciones) ? obj.agrupaciones : [];
    if (agrupaciones.length) {
      y = sectionTitle(doc, 'Agrupaciones', y);
      y = ensureY(doc, y, 30);
      autoTable(doc, {
        ...tableOpts(y),
        head: [['Agrupación', 'Desviación', 'Real', 'Objetivo']],
        body: agrupaciones.map((ag) => [
          String(ag.nombre || '—'),
          desvObjPdf(ag),
          ag.realLabel || (ag.importeRealHastaAyer == null ? '—' : formatMoneda(ag.importeRealHastaAyer)),
          ag.objetivoLabel || (ag.importeCompHastaAyer == null ? '—' : formatMoneda(ag.importeCompHastaAyer)),
        ]),
        columnStyles: {
          1: { halign: 'right' },
          2: { halign: 'right' },
          3: { halign: 'right' },
        },
        didParseCell: (data) => {
          if (data.section === 'body') {
            data.cell.styles.fillColor = [219, 234, 254];
          }
        },
      });
      y = lastTableY(doc, y) + 8;
    }
  }

  type RatioItem = {
    nombre?: string;
    ratioPersonal?: number | null;
    ratioMercaderia?: number | null;
    ratioMusicos?: number | null;
    gastoPersonal?: number | null;
    gastoMercaderia?: number | null;
    gastoMusicos?: number | null;
    sinFacturacion?: boolean;
    avisos?: string[];
  };
  const ratios = Array.isArray(datos.ratiosPorLocal) ? (datos.ratiosPorLocal as RatioItem[]) : [];
  if (ratios.length) {
    y = sectionTitle(doc, 'Ratios por local', y);
    y = ensureY(doc, y, 30);
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Local', 'Personal %', 'Mercadería %', 'Músicos %']],
      body: ratios.map((r) => [
        String(r.nombre || '—'),
        r.sinFacturacion || r.ratioPersonal == null ? '—' : formatPct(r.ratioPersonal),
        r.sinFacturacion ? '—' : formatPct(r.ratioMercaderia),
        r.sinFacturacion ? '—' : formatPct(r.ratioMusicos),
      ]),
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
      },
    });
    y = lastTableY(doc, y) + 4;
    const avisos = ratios.flatMap((r) =>
      (r.avisos || []).map((a) => `${r.nombre || 'Local'}: ${a}`),
    );
    if (avisos.length) {
      y = ensureY(doc, y, 8 + avisos.length * LINE_H);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(180, 83, 9);
      for (const a of avisos) {
        y = ensureY(doc, y, 6);
        const lines = doc.splitTextToSize(a, doc.internal.pageSize.getWidth() - MARGIN * 2) as string[];
        doc.text(lines, MARGIN, y);
        y += lines.length * LINE_H;
      }
      y += 4;
    } else {
      y += 4;
    }
  }

  // Ventas/hora: matriz densa grupo + locales (misma idea que modoPdf en VistaDiaADia)
  y = renderVentasHoraComparativaTabla(doc, autoTable, datos, y);

  const exc = (datos.excepcionesSospechosas || {}) as {
    items?: {
      tipo?: string;
      quien?: string | null;
      localNombre?: string;
      importe?: number;
    }[];
    resumen?: {
      total?: number;
      porTipo?: { invitacion?: { count?: number }; descuento?: { count?: number } };
    };
    error?: string;
  };
  const items = Array.isArray(exc.items) ? exc.items : [];
  const invitaciones = items.filter((it) => it.tipo === 'invitacion');
  const descuentos = items.filter((it) => it.tipo === 'descuento');

  const renderExcBloque = (titulo: string, rows: typeof items, vacio: string, countHint?: number) => {
    y = sectionTitle(doc, titulo, y);
    if (exc.error) {
      y = ensureY(doc, y, 10);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(185, 28, 28);
      const errLines = doc.splitTextToSize(String(exc.error), doc.internal.pageSize.getWidth() - MARGIN * 2) as string[];
      doc.text(errLines, MARGIN, y);
      y += errLines.length * LINE_H + 4;
    }
    if (countHint != null) {
      y = ensureY(doc, y, 8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...AMBER);
      doc.text(`${countHint} registro${countHint === 1 ? '' : 's'}`, MARGIN, y);
      y += 6;
    }
    if (rows.length === 0) {
      y = ensureY(doc, y, 8);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      doc.text(vacio, MARGIN, y);
      y += 8;
      return;
    }
    y = ensureY(doc, y, 30);
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Quién', 'Local', 'Importe']],
      body: rows.map((it) => [
        String(it.quien || '—'),
        String(it.localNombre || '—'),
        formatMoneda(it.importe),
      ]),
      columnStyles: {
        0: { cellWidth: 55 },
        1: { cellWidth: 50 },
        2: { halign: 'right' },
      },
    });
    y = lastTableY(doc, y) + 8;
  };

  renderExcBloque(
    'Invitaciones',
    invitaciones,
    'Sin invitaciones relevantes (>2 €) en el día',
    exc.resumen?.porTipo?.invitacion?.count ?? invitaciones.length,
  );
  renderExcBloque(
    'Descuentos',
    descuentos,
    'Sin descuentos relevantes (>2 €) en el día',
    exc.resumen?.porTipo?.descuento?.count ?? descuentos.length,
  );

  const topVentas = (datos.topVentasPorLocal || {}) as {
    locales?: {
      nombre?: string;
      sinDatos?: boolean;
      top?: { rank?: number; userName?: string; amount?: number }[];
    }[];
  };
  const topLocales = Array.isArray(topVentas.locales) ? topVentas.locales : [];
  y = sectionTitle(doc, 'Top 3 ventas por local', y);
  if (!topLocales.length) {
    y = ensureY(doc, y, 8);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text('Sin ranking de ventas por local', MARGIN, y);
    y += 8;
  } else {
    y = ensureY(doc, y, 30);
    const body: string[][] = [];
    for (const loc of topLocales) {
      const tops = Array.isArray(loc.top) ? loc.top.slice(0, 3) : [];
      if (loc.sinDatos || !tops.length) {
        body.push([String(loc.nombre || '—'), '—', 'Sin datos']);
        continue;
      }
      for (const t of tops) {
        body.push([
          String(loc.nombre || '—'),
          String(t.userName || '—'),
          formatMoneda(t.amount),
        ]);
      }
    }
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Local', 'Nombre', 'Importe']],
      body,
      columnStyles: {
        2: { halign: 'right' },
      },
    });
    y = lastTableY(doc, y) + 8;
  }

  const mant = (datos.mantenimientoDia || {}) as {
    resumen?: { incidencias?: number; recurrentes?: number; limpiezas?: number; valoradas?: number };
    partes?: { titulo?: string; localNombre?: string; origen?: string; valoracionTotal?: number | null }[];
    limpiezas?: { objetoNombre?: string | null; tareaNombre?: string | null; localNombre?: string; realizadoPorNombre?: string | null }[];
  };
  const partes = Array.isArray(mant.partes) ? mant.partes : [];
  const limpiezas = Array.isArray(mant.limpiezas) ? mant.limpiezas : [];
  y = sectionTitle(doc, 'Mantenimiento del día', y);
  y = ensureY(doc, y, 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...SLATE);
  doc.text(
    `Partes: ${mant.resumen?.incidencias ?? partes.length} · Recurrentes: ${mant.resumen?.recurrentes ?? 0} · Limpiezas: ${mant.resumen?.limpiezas ?? limpiezas.length} · Valoradas: ${mant.resumen?.valoradas ?? 0}`,
    MARGIN,
    y,
  );
  y += 8;
  if (partes.length) {
    y = ensureY(doc, y, 30);
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Parte', 'Local', 'Origen', 'Valoración']],
      body: partes.map((p) => [
        String(p.titulo || '—'),
        String(p.localNombre || '—'),
        p.origen === 'recurrente' ? 'Recurrente' : 'Incidencia',
        p.valoracionTotal == null ? '—' : String(p.valoracionTotal),
      ]),
    });
    y = lastTableY(doc, y) + 6;
  }
  if (limpiezas.length) {
    y = ensureY(doc, y, 30);
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Limpieza', 'Local', 'Realizado por']],
      body: limpiezas.map((l) => [
        String(l.objetoNombre || l.tareaNombre || '—'),
        String(l.localNombre || '—'),
        String(l.realizadoPorNombre || '—'),
      ]),
    });
    y = lastTableY(doc, y) + 8;
  }
  if (!partes.length && !limpiezas.length) {
    y = ensureY(doc, y, 8);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text('Sin partes ni limpiezas en el día', MARGIN, y);
    y += 8;
  }

  return y;
}

function renderObjetivosMes(doc: jsPDF, autoTable: AutoTable, datos: Record<string, unknown>, y: number): number {
  const locales = Array.isArray(datos.locales) ? (datos.locales as Record<string, unknown>[]) : [];
  const total = (datos.total || {}) as Record<string, unknown>;
  if (!locales.length && total.pctConsecucion == null) return y;

  const tit = ['Consecución del mes', datos.mes ? String(datos.mes) : null, datos.hastaFecha ? `hasta ${formatFechaEs(String(datos.hastaFecha))}` : null]
    .filter(Boolean)
    .join(' · ');
  y = sectionTitle(doc, tit, y);
  y = ensureY(doc, y, 30);
  const body = locales.map((l) => [
    String(l.nombre || '—'),
    l.sinDatos ? '—' : formatPct(l.pctConsecucion),
    l.sinDatos || l.importeRealHastaAyer == null ? '—' : formatMoneda(l.importeRealHastaAyer),
    l.sinDatos || l.importeCompHastaAyer == null ? '—' : formatMoneda(l.importeCompHastaAyer),
  ]);
  if (total.pctConsecucion != null || total.importeRealHastaAyer != null) {
    body.push([
      'Total grupo',
      formatPct(total.pctConsecucion),
      total.importeRealHastaAyer == null ? '—' : formatMoneda(total.importeRealHastaAyer),
      total.importeCompHastaAyer == null ? '—' : formatMoneda(total.importeCompHastaAyer),
    ]);
  }
  autoTable(doc, {
    ...tableOpts(y),
    head: [['Local', '% consecución', 'Real del mes', 'Comp. del mes']],
    body,
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
  });
  return lastTableY(doc, y) + 8;
}

function renderVentasHora(doc: jsPDF, autoTable: AutoTable, datos: Record<string, unknown>, y: number): number {
  const total = (datos.total || {}) as {
    importe?: number;
    porHora?: Record<string, number> | { hora: number; real?: number; importe?: number }[];
  };
  const fecha = datos.fecha ? formatFechaEs(String(datos.fecha)) : null;
  y = sectionTitle(doc, fecha ? `Ventas por hora · ${fecha}` : 'Ventas por hora', y);

  if (total.importe != null) {
    y = ensureY(doc, y, 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...SLATE);
    doc.text(`Total grupo: ${formatMoneda(total.importe)}`, MARGIN, y);
    y += 7;
  }

  // porHora puede ser objeto { "0": n, ... } o array
  let horas: { hora: number; importe: number }[] = [];
  if (Array.isArray(total.porHora)) {
    horas = total.porHora.map((h) => ({
      hora: Number((h as { hora: number }).hora),
      importe: Number((h as { real?: number; importe?: number }).real ?? (h as { importe?: number }).importe) || 0,
    }));
  } else if (total.porHora && typeof total.porHora === 'object') {
    horas = Object.entries(total.porHora as Record<string, number>).map(([k, v]) => ({
      hora: Number(k),
      importe: Number(v) || 0,
    }));
  }

  const top = [...horas]
    .filter((h) => h.importe > 0)
    .sort((a, b) => b.importe - a.importe)
    .slice(0, 8);

  if (top.length) {
    y = ensureY(doc, y, 30);
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Hora', 'Importe']],
      body: top.map((h) => [`${String(h.hora).padStart(2, '0')}:00`, formatMoneda(h.importe)]),
      columnStyles: { 1: { halign: 'right' } },
    });
    y = lastTableY(doc, y) + 8;
  }

  const locales = Array.isArray(datos.locales) ? (datos.locales as Record<string, unknown>[]) : [];
  if (locales.length) {
    y = sectionTitle(doc, 'Totales por local', y);
    y = ensureY(doc, y, 30);
    autoTable(doc, {
      ...tableOpts(y),
      head: [['Local', 'Total']],
      body: locales.map((l) => [String(l.nombre || '—'), l.sinDatos ? '—' : formatMoneda(l.total)]),
      columnStyles: { 1: { halign: 'right' } },
    });
    y = lastTableY(doc, y) + 8;
  }

  return y;
}

export function pdfInformeIaFileSlug(informe: InformeIaParaPdf): string {
  const fuente = String(informe.fuente || 'informe')
    .replace(/\s+/g, '_')
    .replace(/[^\w\-]/g, '')
    .slice(0, 24);
  const id = String(informe.informeId || '').slice(0, 8) || 'sinid';
  let fecha = '';
  const dj = informe.datosJson as { fecha?: string } | undefined;
  if (dj?.fecha && /^\d{4}-\d{2}-\d{2}/.test(dj.fecha)) {
    fecha = `_${dj.fecha.slice(0, 10)}`;
  } else if (informe.generadoEn) {
    const d = new Date(informe.generadoEn);
    if (!Number.isNaN(d.getTime())) {
      fecha = `_${d.toISOString().slice(0, 10)}`;
    }
  }
  return `informe_ia_${fuente}${fecha}_${id}`;
}

export async function generarPdfInformeIa(informe: InformeIaParaPdf): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  let y = 16;

  // Cabecera
  doc.setFillColor(...HEAD_FILL);
  doc.rect(0, 0, pageW, 22, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text('Informes IA', MARGIN, 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(etiquetaFuente(informe.fuente), MARGIN, 17);
  doc.setFontSize(8);
  doc.text(`Generado: ${formatFechaHoraEs(informe.generadoEn)}`, pageW - MARGIN, 10, { align: 'right' });
  if (informe.promptNombre) {
    doc.text(String(informe.promptNombre).slice(0, 42), pageW - MARGIN, 17, { align: 'right' });
  }

  y = 30;

  y = sectionTitle(doc, 'Resumen', y);
  y = renderResumenMarkdown(doc, informe.resumen, y);

  const datos =
    informe.datosJson && typeof informe.datosJson === 'object'
      ? (informe.datosJson as Record<string, unknown>)
      : null;

  if (datos) {
    if (informe.fuente === 'dia_a_dia') {
      y = renderDiaADia(doc, autoTable, datos, y);
    } else if (informe.fuente === 'objetivos_mes') {
      y = renderObjetivosMes(doc, autoTable, datos, y);
    } else if (informe.fuente === 'ventas_hora') {
      y = renderVentasHora(doc, autoTable, datos, y);
    } else {
      y = ensureY(doc, y, 12);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      doc.text('Datos adjuntos en la app (tablas y detalle visual).', MARGIN, y);
      y += 8;
    }
  }

  addPageFooters(doc);
  return doc;
}

export async function descargarPdfInformeIa(informe: InformeIaParaPdf): Promise<void> {
  const doc = await generarPdfInformeIa(informe);
  doc.save(`${pdfInformeIaFileSlug(informe)}.pdf`);
}
