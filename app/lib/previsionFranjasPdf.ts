/**
 * PDF de la Previsión de ventas por franjas (A4 horizontal):
 * portada con resumen por local y una página por local con KPIs y mapa de calor.
 */
import { Platform } from 'react-native';
import type { CellHookData, RowInput } from 'jspdf-autotable';
import {
  TEXTO_MOTIVO,
  colorEscalaRgb,
  esFondoOscuro,
  etiquetaDiaCorta,
  fechaEs,
  formatEur,
  formatPct,
  maxCeldaLocal,
  type LocalPrevision,
  type ResultadoPrevision,
} from './previsionFranjasApi';

type jsPDF = import('jspdf').jsPDF;
type RGB = [number, number, number];

const MARGIN_X = 12;
const HEAD_FILL: RGB = [14, 165, 233];
const VERDE: RGB = [22, 163, 74];
const ROJO: RGB = [220, 38, 38];
const GRIS: RGB = [100, 116, 139];
const OSCURO: RGB = [15, 23, 42];
const GRAN_TOTAL: RGB = [3, 105, 161];

export type OpcionesPdfPrevision = {
  fechaDesde: string;
  fechaHasta: string;
  objetivoEurEmpHora: number;
  diasExcluidos: number;
};

type MetaCelda = { fill: RGB; text: RGB; real?: { texto: string; color: RGB } };

function lastTableY(doc: jsPDF, fallback: number): number {
  return (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;
}

function colorDesvio(ratio: number | null): RGB {
  if (ratio == null) return GRIS;
  return ratio >= 0 ? VERDE : ROJO;
}

function textoReal(real: number | null, desvioPct: number | null): string {
  if (real == null) return '';
  return `Real ${formatEur(real)}${desvioPct != null ? ` · ${formatPct(desvioPct)}` : ''}`;
}

function metaEscala(valor: number, max: number): MetaCelda {
  const fill = colorEscalaRgb(valor, max);
  return { fill, text: esFondoOscuro(fill) ? [255, 255, 255] : OSCURO };
}

function dibujarPortada(doc: jsPDF, autoTable: typeof import('jspdf-autotable').default, r: ResultadoPrevision, o: OpcionesPdfPrevision) {
  let y = 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...OSCURO);
  doc.text('Previsión de ventas por franjas', MARGIN_X, y);
  y += 9;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  const lineas = [
    `Periodo: ${fechaEs(o.fechaDesde)} – ${fechaEs(o.fechaHasta)}${o.diasExcluidos > 0 ? ` (${o.diasExcluidos} día(s) excluidos)` : ''}`,
    `Plantilla de franjas: ${r.plantilla.nombre || r.plantilla.plantillaId}`,
    `Objetivo de productividad: ${o.objetivoEurEmpHora} €/empleado·hora`,
    `Franjas: ${r.plantilla.franjas.map((f) => f.label).join(' · ')}`,
  ];
  for (const l of lineas) {
    const partes = doc.splitTextToSize(l, 273) as string[];
    doc.text(partes, MARGIN_X, y);
    y += partes.length * 5;
  }

  if (r.avisos.length > 0) {
    y += 2;
    doc.setFontSize(9);
    doc.setTextColor(180, 83, 9);
    for (const a of r.avisos) {
      const partes = doc.splitTextToSize(`• ${a}`, 273) as string[];
      doc.text(partes, MARGIN_X, y);
      y += partes.length * 4.5;
    }
  }
  y += 4;

  const hayReal = r.locales.some((l) => l.kpis.ventaRealPasados != null);
  const head = ['Local', 'Venta prevista', 'Franja más fuerte', 'Día más fuerte', 'Pico de personal'];
  if (hayReal) head.push('Real días pasados', 'Desvío');

  const desvios: (number | null)[] = [];
  const body: RowInput[] = r.locales.map((l) => {
    const k = l.kpis;
    desvios.push(k.desvioPct);
    const fila = [
      l.nombre,
      formatEur(k.ventaPrevista),
      k.franjaMasFuerte ? `${k.franjaMasFuerte.label}\n${formatEur(k.franjaMasFuerte.importe)}` : '—',
      k.diaMasFuerte ? `${etiquetaDiaCorta(k.diaMasFuerte.fecha)}\n${formatEur(k.diaMasFuerte.importe)}` : '—',
      k.picoPersonal
        ? `${k.picoPersonal.personas} personas\n${etiquetaDiaCorta(k.picoPersonal.fecha)} · ${k.picoPersonal.label}`
        : '—',
    ];
    if (hayReal) {
      fila.push(k.ventaRealPasados != null ? formatEur(k.ventaRealPasados) : '—');
      fila.push(k.desvioPct != null ? formatPct(k.desvioPct) : '—');
    }
    return fila;
  });

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X, bottom: 16 },
    head: [head],
    body,
    styles: { fontSize: 9, cellPadding: 2.5, valign: 'middle', overflow: 'linebreak' },
    headStyles: { fillColor: HEAD_FILL, textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 50 },
      1: { halign: 'right', fontStyle: 'bold' },
      ...(hayReal ? { 5: { halign: 'right' }, 6: { halign: 'right', fontStyle: 'bold' } } : {}),
    },
    didParseCell: (data: CellHookData) => {
      if (data.section !== 'body' || !hayReal || data.column.index !== 6) return;
      data.cell.styles.textColor = colorDesvio(desvios[data.row.index] ?? null);
    },
  });
}

function dibujarKpis(doc: jsPDF, local: LocalPrevision, y: number): number {
  const k = local.kpis;
  const cajas: { titulo: string; valor: string; detalle?: string; detalleColor?: RGB }[] = [
    { titulo: 'Venta prevista del periodo', valor: formatEur(k.ventaPrevista) },
    {
      titulo: 'Franja más fuerte',
      valor: k.franjaMasFuerte ? k.franjaMasFuerte.label : '—',
      detalle: k.franjaMasFuerte ? formatEur(k.franjaMasFuerte.importe) : undefined,
    },
    {
      titulo: 'Día más fuerte',
      valor: k.diaMasFuerte ? etiquetaDiaCorta(k.diaMasFuerte.fecha) : '—',
      detalle: k.diaMasFuerte ? formatEur(k.diaMasFuerte.importe) : undefined,
    },
    {
      titulo: 'Pico de personal',
      valor: k.picoPersonal ? `${k.picoPersonal.personas} personas` : '—',
      detalle: k.picoPersonal ? `${etiquetaDiaCorta(k.picoPersonal.fecha)} · ${k.picoPersonal.label}` : undefined,
    },
  ];
  if (k.ventaRealPasados != null) {
    cajas.push({
      titulo: 'Real días pasados',
      valor: formatEur(k.ventaRealPasados),
      detalle: k.desvioPct != null ? `Desvío ${formatPct(k.desvioPct)}` : undefined,
      detalleColor: colorDesvio(k.desvioPct),
    });
  }
  const gap = 4;
  const ancho = (297 - MARGIN_X * 2 - gap * (cajas.length - 1)) / cajas.length;
  const alto = 20;
  cajas.forEach((c, i) => {
    const x = MARGIN_X + i * (ancho + gap);
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(x, y, ancho, alto, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...GRIS);
    doc.text(c.titulo.toUpperCase(), x + 3, y + 5);
    doc.setFontSize(11);
    doc.setTextColor(...OSCURO);
    const valor = (doc.splitTextToSize(c.valor, ancho - 6) as string[])[0] ?? '';
    doc.text(valor, x + 3, y + 11.5);
    if (c.detalle) {
      doc.setFont('helvetica', c.detalleColor ? 'bold' : 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...(c.detalleColor ?? ([71, 85, 105] as RGB)));
      const det = (doc.splitTextToSize(c.detalle, ancho - 6) as string[])[0] ?? '';
      doc.text(det, x + 3, y + 16.5);
    }
  });
  return y + alto + 5;
}

function dibujarMapa(
  doc: jsPDF,
  autoTable: typeof import('jspdf-autotable').default,
  local: LocalPrevision,
  r: ResultadoPrevision,
  y: number,
) {
  const franjas = r.plantilla.franjas;
  const nCols = franjas.length + 2;
  const max = maxCeldaLocal(local);
  const maxTotalDia = local.dias.reduce((m, d) => (d.valida && d.totalPrevisto > m ? d.totalPrevisto : m), 0);
  const totFranja = franjas.map(() => 0);
  let granTotal = 0;
  const hayPasados = local.dias.some((d) => d.pasado && d.valida && d.totalReal != null);

  const meta: (MetaCelda | null)[][] = [];
  const body: RowInput[] = [];

  for (const d of local.dias) {
    const nombreComp = !d.festivo && d.nombreFestivoComparativa ? ` (${d.nombreFestivoComparativa})` : '';
    const celdaFecha = `${etiquetaDiaCorta(d.fecha)}\ncomp. ${fechaEs(d.fechaComparativa)}${nombreComp}${d.festivo ? `\n${d.festivo.nombre || 'Festivo'}` : ''}`;
    if (!d.valida) {
      body.push([
        celdaFecha,
        {
          content: d.motivo ? TEXTO_MOTIVO[d.motivo] : 'Sin previsión',
          colSpan: nCols - 1,
          styles: { fillColor: [241, 245, 249], textColor: GRIS, fontStyle: 'italic', halign: 'left' },
        },
      ]);
      meta.push([null]);
      continue;
    }
    const filaMeta: (MetaCelda | null)[] = [null];
    const fila: string[] = [celdaFecha];
    // Línea en blanco reservada para el real (se pinta en didDrawCell con su color).
    const huecoReal = hayPasados ? '\n ' : '';
    d.celdas.forEach((c, i) => {
      totFranja[i] += c.previsto;
      const m = metaEscala(c.previsto, max);
      if (d.pasado && c.real != null) m.real = { texto: textoReal(c.real, c.desvioPct), color: colorDesvio(c.desvioPct) };
      filaMeta.push(m);
      fila.push(`${formatEur(c.previsto)}\n${c.personal} pers.${huecoReal}`);
    });
    granTotal += d.totalPrevisto;
    const mt = metaEscala(d.totalPrevisto, maxTotalDia);
    if (d.pasado && d.totalReal != null) mt.real = { texto: textoReal(d.totalReal, d.desvioPct), color: colorDesvio(d.desvioPct) };
    filaMeta.push(mt);
    fila.push(`${formatEur(d.totalPrevisto)}\n ${huecoReal}`);
    meta.push(filaMeta);
    body.push(fila);
  }

  const maxTotFranja = Math.max(0, ...totFranja);
  const filaTotalMeta: (MetaCelda | null)[] = [null, ...totFranja.map((v) => metaEscala(v, maxTotFranja)), { fill: GRAN_TOTAL, text: [255, 255, 255] }];
  meta.push(filaTotalMeta);
  body.push(['Total franja', ...totFranja.map((v) => formatEur(v)), formatEur(granTotal)]);
  const idxTotal = body.length - 1;

  const anchoFecha = 36;
  const anchoCelda = (297 - MARGIN_X * 2 - anchoFecha) / (franjas.length + 1);
  const fontSize = franjas.length > 7 ? 7 : 8.5;
  const columnStyles: Record<number, { cellWidth: number; halign?: 'center' | 'left'; fontStyle?: 'bold' }> = {
    0: { cellWidth: anchoFecha, halign: 'left' },
  };
  for (let i = 1; i < nCols; i++) columnStyles[i] = { cellWidth: anchoCelda, halign: 'center' };

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X, bottom: 16 },
    head: [['Día', ...franjas.map((f, i) => `${f.etiqueta || `Franja ${i + 1}`}\n${f.desde}–${f.hasta}`), 'Total día']],
    body,
    theme: 'grid',
    styles: {
      fontSize,
      cellPadding: 1.6,
      valign: 'middle',
      overflow: 'linebreak',
      lineColor: [255, 255, 255],
      lineWidth: 0.3,
      textColor: OSCURO,
    },
    headStyles: { fillColor: [248, 250, 252], textColor: [51, 65, 85], fontStyle: 'bold', halign: 'center' },
    columnStyles,
    didParseCell: (data: CellHookData) => {
      if (data.section !== 'body') return;
      const filaIdx = data.row.index;
      if (data.column.index === 0) {
        data.cell.styles.fillColor = [255, 255, 255];
        data.cell.styles.lineColor = [226, 232, 240];
        if (filaIdx === idxTotal) data.cell.styles.fontStyle = 'bold';
        return;
      }
      const m = meta[filaIdx]?.[data.column.index];
      if (!m) return;
      data.cell.styles.fillColor = m.fill;
      data.cell.styles.textColor = m.text;
      if (data.column.index === nCols - 1 || filaIdx === idxTotal) data.cell.styles.fontStyle = 'bold';
    },
    didDrawCell: (data: CellHookData) => {
      if (data.section !== 'body' || data.column.index === 0) return;
      const real = meta[data.row.index]?.[data.column.index]?.real;
      if (!real) return;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(fontSize - 1.5);
      const w = Math.min(doc.getTextWidth(real.texto) + 2, data.cell.width - 1);
      const cx = data.cell.x + data.cell.width / 2;
      const yBase = data.cell.y + data.cell.height - 2.2;
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(cx - w / 2, yBase - 2.6, w, 3.6, 0.8, 0.8, 'F');
      doc.setTextColor(...real.color);
      doc.text(real.texto, cx, yBase, { align: 'center', maxWidth: data.cell.width - 1 });
    },
  });
  return lastTableY(doc, y + 20);
}

function dibujarPies(doc: jsPDF) {
  const total = doc.getNumberOfPages();
  const hoy = new Date();
  const generado = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(
      `Método: venta real de la fecha comparativa (tabla de festivos o mismo día del año anterior). Generado el ${generado} · Página ${i} de ${total}`,
      pageW / 2,
      pageH - 7,
      { align: 'center' },
    );
  }
}

export async function generarPdfPrevisionFranjas(r: ResultadoPrevision, o: OpcionesPdfPrevision): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  dibujarPortada(doc, autoTable, r, o);

  for (const local of r.locales) {
    doc.addPage();
    let y = 16;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...OSCURO);
    doc.text(local.nombre, MARGIN_X, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...GRIS);
    doc.text(
      `${fechaEs(o.fechaDesde)} – ${fechaEs(o.fechaHasta)} · ${r.plantilla.nombre} · ${o.objetivoEurEmpHora} €/emp·h`,
      297 - MARGIN_X,
      y,
      { align: 'right' },
    );
    y += 5;
    y = dibujarKpis(doc, local, y);
    dibujarMapa(doc, autoTable, local, r, y);
  }

  dibujarPies(doc);
  return doc;
}

/** Web: descarga el fichero. Nativo: lo guarda en caché y abre el diálogo de compartir. */
export async function guardarPdfPrevision(doc: jsPDF, fechaDesde: string, fechaHasta: string): Promise<void> {
  const fname = `prevision_franjas_${fechaDesde}_${fechaHasta}.pdf`;
  if (Platform.OS === 'web') {
    doc.save(fname);
    return;
  }
  const FileSystemLegacy = await import('expo-file-system/legacy');
  const Sharing = await import('expo-sharing');
  const base64 = doc.output('datauristring').split(',')[1] || '';
  const fileUri = `${FileSystemLegacy.cacheDirectory ?? ''}${fname}`;
  await FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 });
  await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fname });
}
