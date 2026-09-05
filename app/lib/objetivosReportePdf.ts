type jsPDF = import('jspdf').jsPDF;

import {
  colorHexForKey,
  desvioColorKey,
  desvioEuro,
  formatEuro,
  formatPctDisplay,
  pctDesvio,
  subtotalZone,
  type ReporteObjetivosData,
  type ReporteVenue,
} from './objetivosReporteModel';

const RGB = {
  text: [42, 45, 51] as [number, number, number],
  muted: [100, 116, 139] as [number, number, number],
  accent: [14, 165, 233] as [number, number, number],
  accentLight: [240, 249, 255] as [number, number, number],
  green: [5, 150, 105] as [number, number, number],
  red: [220, 38, 38] as [number, number, number],
  grey: [148, 163, 184] as [number, number, number],
  border: [226, 232, 240] as [number, number, number],
  kpiBg: [248, 250, 252] as [number, number, number],
  barBg: [241, 245, 249] as [number, number, number],
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

type Cols = {
  nameW: number;
  factW: number;
  compW: number;
  desvW: number;
  barW: number;
  pctW: number;
};

function colsTotalW(cols: Cols): number {
  return cols.nameW + cols.factW + cols.compW + cols.desvW + cols.barW + cols.pctW;
}

function rgbForVenue(facturado: number, comparativa: number): [number, number, number] {
  return hexToRgb(colorHexForKey(desvioColorKey(facturado, comparativa)));
}

function formatDesvioEuro(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return '0 €';
  const sign = rounded > 0 ? '+' : '-';
  return `${sign}${Math.abs(rounded).toLocaleString('es-ES')} €`;
}

function ensurePage(doc: jsPDF, y: number, need: number, margin: number): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y + need > pageH - margin) {
    doc.addPage();
    return margin;
  }
  return y;
}

function drawDivergingBar(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  pct: number | null,
) {
  doc.setFillColor(...RGB.barBg);
  doc.roundedRect(x, y, w, h, 0.5, 0.5, 'F');
  const half = w / 2;
  doc.setDrawColor(...RGB.border);
  doc.setLineWidth(0.15);
  doc.line(x + half, y, x + half, y + h);
  if (pct == null || pct === 0) return;
  const magnitude = Math.min(Math.abs(pct), 100) / 100;
  const segW = magnitude * half;
  if (pct > 0) {
    doc.setFillColor(...RGB.green);
    doc.rect(x + half, y + 0.3, segW, h - 0.6, 'F');
  } else {
    doc.setFillColor(...RGB.red);
    doc.rect(x + half - segW, y + 0.3, segW, h - 0.6, 'F');
  }
}

function drawMetricCells(
  doc: jsPDF,
  x: number,
  y: number,
  cols: Cols,
  facturado: number,
  comparativa: number,
  opts?: { drawBar?: boolean; boldFacturado?: boolean },
) {
  const pct = pctDesvio(facturado, comparativa);
  const desvio = desvioEuro(facturado, comparativa);
  const rgb = rgbForVenue(facturado, comparativa);
  let cx = x;

  doc.setFont('helvetica', opts?.boldFacturado === false ? 'normal' : 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...RGB.text);
  doc.text(formatEuro(facturado), cx + cols.factW - 1, y, { align: 'right' });
  cx += cols.factW;

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...RGB.muted);
  doc.text(formatEuro(comparativa), cx + cols.compW - 1, y, { align: 'right' });
  cx += cols.compW;

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...rgb);
  doc.text(formatDesvioEuro(desvio), cx + cols.desvW - 1, y, { align: 'right' });
  cx += cols.desvW;

  if (opts?.drawBar !== false) {
    drawDivergingBar(doc, cx + 1, y - 3, cols.barW - 2, 3.5, pct);
  }
  cx += cols.barW;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...rgb);
  doc.text(formatPctDisplay(pct), cx + cols.pctW - 1, y, { align: 'right' });
}

function drawColHeaders(doc: jsPDF, x: number, y: number, cols: Cols): number {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...RGB.muted);
  let cx = x;
  doc.text('Local / agrupación', cx + 1, y);
  cx += cols.nameW;
  doc.text('Facturado', cx + cols.factW - 1, y, { align: 'right' });
  cx += cols.factW;
  doc.text('Comparativa', cx + cols.compW - 1, y, { align: 'right' });
  cx += cols.compW;
  doc.text('Desvío', cx + cols.desvW - 1, y, { align: 'right' });
  cx += cols.desvW + cols.barW;
  doc.text('%', cx + cols.pctW - 1, y, { align: 'right' });
  doc.setDrawColor(...RGB.border);
  doc.setLineWidth(0.2);
  doc.line(x, y + 2, x + colsTotalW(cols), y + 2);
  return y + 6;
}

function drawVenueRow(
  doc: jsPDF,
  venue: ReporteVenue,
  x: number,
  y: number,
  cols: Cols,
  rowH: number,
): number {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...RGB.text);
  const nameLines = doc.splitTextToSize(venue.name, cols.nameW - 2);
  doc.text(nameLines.slice(0, 2), x + 1, y + 4.5);

  drawMetricCells(doc, x + cols.nameW, y + 4.5, cols, venue.facturado, venue.comparativa);

  doc.setDrawColor(...RGB.border);
  doc.setLineWidth(0.1);
  doc.line(x, y + rowH, x + colsTotalW(cols), y + rowH);

  return y + rowH;
}

function drawZoneHeader(
  doc: jsPDF,
  zoneName: string,
  subFacturado: number,
  subComparativa: number,
  x: number,
  y: number,
  cols: Cols,
  headerH: number,
): number {
  const totalW = colsTotalW(cols);
  doc.setFillColor(...RGB.accentLight);
  doc.rect(x, y, totalW, headerH, 'F');
  doc.setFillColor(...RGB.accent);
  doc.rect(x, y, 1.2, headerH, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...RGB.text);
  const nameLines = doc.splitTextToSize(zoneName, cols.nameW - 5);
  doc.text(nameLines.slice(0, 1), x + 4, y + 5.5);

  drawMetricCells(doc, x + cols.nameW, y + 5.5, cols, subFacturado, subComparativa, {
    drawBar: false,
  });

  return y + headerH + 1;
}

export async function generarPdfReporteObjetivos(data: ReporteObjetivosData): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const contentW = pageW - margin * 2;
  let y = margin;

  const cols: Cols = {
    nameW: contentW * 0.28,
    factW: contentW * 0.16,
    compW: contentW * 0.16,
    desvW: contentW * 0.16,
    barW: contentW * 0.12,
    pctW: contentW * 0.12,
  };
  const rowH = 8;
  const zoneHeaderH = 8;

  // Kicker
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...RGB.accent);
  doc.text(`INFORME · ${data.kickerMes}`, margin, y);
  y += 6;

  doc.setFontSize(18);
  doc.setTextColor(...RGB.text);
  doc.text('Objetivos por local', margin, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...RGB.muted);
  const subLine = `Acumulado hasta ${data.fechaHastaLabel} · ${data.generadoLabel}`;
  const subSplit = doc.splitTextToSize(subLine, contentW);
  doc.text(subSplit, margin, y);
  y += subSplit.length * 4 + 6;

  // KPI cards
  const kpiW = (contentW - 8) / 3;
  const kpiH = 22;
  const desvioGlobal = desvioEuro(data.totales.facturado, data.totales.comparativa);
  const pctGlobal = pctDesvio(data.totales.facturado, data.totales.comparativa);
  const globalRgb = rgbForVenue(data.totales.facturado, data.totales.comparativa);

  const kpis = [
    { label: 'FACTURADO', value: formatEuro(data.totales.facturado), pct: null as string | null },
    { label: 'COMPARATIVA', value: formatEuro(data.totales.comparativa), pct: null },
    { label: 'DESVÍO GLOBAL', value: formatEuro(desvioGlobal), pct: formatPctDisplay(pctGlobal) },
  ];

  kpis.forEach((kpi, i) => {
    const kx = margin + i * (kpiW + 4);
    doc.setDrawColor(...RGB.border);
    doc.setFillColor(...RGB.kpiBg);
    doc.setLineWidth(0.2);
    doc.roundedRect(kx, y, kpiW, kpiH, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...RGB.muted);
    doc.text(kpi.label, kx + 4, y + 6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...RGB.text);
    doc.text(kpi.value, kx + 4, y + 13);
    if (kpi.pct) {
      doc.setFontSize(9);
      doc.setTextColor(...globalRgb);
      doc.text(kpi.pct, kx + 4, y + 19);
    }
  });
  y += kpiH + 10;

  y = drawColHeaders(doc, margin, y, cols);

  // Zones
  for (const zone of data.zones) {
    const sub = subtotalZone(zone);
    const blockNeed = zoneHeaderH + zone.venues.length * rowH + 4;
    y = ensurePage(doc, y, Math.min(blockNeed, 40), margin);

    if (zone.hasSubtotal) {
      y = drawZoneHeader(doc, zone.name, sub.facturado, sub.comparativa, margin, y, cols, zoneHeaderH);
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...RGB.text);
      doc.text(zone.name, margin, y + 5);
      y += 7;
    }

    for (const venue of zone.venues) {
      y = ensurePage(doc, y, rowH + 2, margin);
      y = drawVenueRow(doc, venue, margin, y, cols, rowH);
    }
    y += 4;
  }

  // TOTAL
  y = ensurePage(doc, y, 14, margin);
  doc.setDrawColor(...RGB.text);
  doc.setLineWidth(0.5);
  doc.line(margin, y, margin + contentW, y);
  y += 6;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...RGB.text);
  doc.text('TOTAL', margin + 1, y);

  drawMetricCells(
    doc,
    margin + cols.nameW,
    y,
    cols,
    data.totales.facturado,
    data.totales.comparativa,
    { drawBar: false },
  );

  return doc;
}

/** Alias para el export WhatsApp (informe visual con barras divergentes). */
export async function generarPdfListadoObjetivosWhatsApp(opts: {
  tituloPeriodo: string;
  fechaHastaLabel: string;
  generadoLabel: string;
  totales: { sumRealHastaAyer: number; sumCompHastaAyer: number };
  grupos: Array<{
    nombre: string;
    orden?: number;
    locales: Array<{ nombre: string; sumRealHastaAyer: number; sumCompHastaAyer: number }>;
  }>;
  localesSueltos: Array<{ nombre: string; sumRealHastaAyer: number; sumCompHastaAyer: number }>;
}): Promise<jsPDF> {
  const { buildReporteObjetivosData } = await import('./objetivosReporteModel');
  const data = buildReporteObjetivosData(opts);
  return generarPdfReporteObjetivos(data);
}
