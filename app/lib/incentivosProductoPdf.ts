/**
 * PDF de detalle de campaña de incentivos por producto.
 */

import type { Campana, ResultadosCampana } from '../types/incentivosProducto';
import type { DetalleVentasCampana } from '../types/ventasCampana';
import { estadoEfectivoCampana } from './campanaEstado';
import {
  etiquetaDestinatario,
  etiquetaTipoIncentivo,
  etiquetaWarning,
  formatValorIncentivoDisplay,
} from './incentivosProducto';

type jsPDF = import('jspdf').jsPDF;

const HEAD_FILL: [number, number, number] = [14, 165, 233];
const PAGE_BOTTOM = 272;
const MARGIN_X = 12;
const COLOR_INCENTIVO: [number, number, number] = [22, 101, 52];
const FILL_EMPLEADO: [number, number, number] = [254, 249, 195];
const BORDER_EMPLEADO: [number, number, number] = [148, 163, 184];
const GAP_ENTRE_EMPLEADOS = 7;
const ANCHO_BLOQUE = 186;
const PAGE_TOP = 14;

function udsCelda(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '';
  return String(n);
}

function incentivoCelda(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return '';
  return formatMonedaPdf(n);
}

/** Uds: vacío si 0, resto negrita. Incentivo: vacío si 0, resto negrita verde. */
function didParseUdsIncentivo(udsCols: number[], incentivoCols: number[]) {
  return (data: { section: string; column: { index: number }; cell: { text: string[]; styles: Record<string, unknown> } }) => {
    if (data.section !== 'body') return;
    const col = data.column.index;
    const text = String(data.cell.text?.[0] ?? '').trim();
    if (!text) return;
    if (udsCols.includes(col)) {
      data.cell.styles.fontStyle = 'bold';
    }
    if (incentivoCols.includes(col)) {
      data.cell.styles.fontStyle = 'bold';
      data.cell.styles.textColor = COLOR_INCENTIVO;
    }
  };
}

function localTieneVentas(unidades: number, incentivo: number): boolean {
  return (Number(unidades) || 0) > 0 || Math.abs(Number(incentivo) || 0) >= 0.005;
}

/** Incentivo de local: usa porLocal o suma porEmpleado (campañas individuales legacy). */
function incentivoLocalResultados(
  localId: string,
  incentivoDevengado: number,
  porEmpleado: { localId: string; incentivoDevengado: number }[],
): number {
  if (Math.abs(Number(incentivoDevengado) || 0) >= 0.005) {
    return Number(incentivoDevengado) || 0;
  }
  const sum = porEmpleado
    .filter((e) => e.localId === localId)
    .reduce((a, e) => a + (Number(e.incentivoDevengado) || 0), 0);
  return Math.round(sum * 100) / 100;
}

function formatMonedaPdf(value: number): string {
  if (!Number.isFinite(value)) return '0,00 €';
  const parts = value.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

function formatFechaPdf(iso: string): string {
  if (!iso || typeof iso !== 'string') return '—';
  const p = iso.trim().split('-');
  if (p.length !== 3) return iso;
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;
}

function ensureY(doc: jsPDF, y: number, needMm = 24): number {
  if (y + needMm > PAGE_BOTTOM) {
    doc.addPage();
    return 14;
  }
  return y;
}

function sectionTitle(doc: jsPDF, title: string, y: number): number {
  y = ensureY(doc, y, 18);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text(title, MARGIN_X, y);
  return y + 7;
}

function nombresLocales(campana: Campana, localesMap: Map<string, string>): string {
  const ids = campana.locales ?? [];
  if (ids.length === 0) return 'Sin locales';
  return ids.map((id) => localesMap.get(id) || id).join(', ');
}

function textoProductos(campana: Campana): string {
  const productos = campana.productos ?? [];
  if (productos.length === 0) return '—';
  const nombres = productos.map((p) => p.productName || p.productId).filter(Boolean);
  if (nombres.length <= 8) return nombres.join(', ');
  const preview = nombres.slice(0, 6).join(', ');
  return `${nombres.length} productos: ${preview}…`;
}

function warningsNoTriviales(warnings: string[] | undefined): string[] {
  return (warnings ?? []).filter((w) => !String(w).startsWith('coste_desconocido'));
}

function drawBarAt(
  doc: jsPDF,
  y: number,
  left: string,
  right: string,
  fill: [number, number, number],
  opts: { boldRight?: boolean } = {},
): { endY: number; topY: number } {
  const barH = 7;
  const topY = y - 4.5;
  doc.setFillColor(...fill);
  doc.rect(MARGIN_X, topY, ANCHO_BLOQUE, barH, 'F');
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text(left, MARGIN_X + 2, y);
  if (right) {
    doc.setFont('helvetica', opts.boldRight ? 'bold' : 'normal');
    doc.setTextColor(...COLOR_INCENTIVO);
    doc.text(right, MARGIN_X + 184, y, { align: 'right' });
  }
  return { endY: y + barH - 1, topY };
}

function drawBar(
  doc: jsPDF,
  y: number,
  left: string,
  right: string,
  fill: [number, number, number],
  opts: { boldRight?: boolean } = {},
): number {
  y = ensureY(doc, y, 10);
  return drawBarAt(doc, y, left, right, fill, opts).endY;
}

/** Borde gris alrededor del bloque empleado (cabecera + tabla). Soporta varias páginas. */
function drawEmpleadoPerimetro(
  doc: jsPDF,
  top: number,
  bottom: number,
  pageStart: number,
  pageEnd: number,
): void {
  const left = MARGIN_X;
  const right = MARGIN_X + ANCHO_BLOQUE;
  doc.setDrawColor(...BORDER_EMPLEADO);
  doc.setLineWidth(0.55);

  if (pageStart === pageEnd) {
    if (bottom <= top) return;
    doc.setPage(pageStart);
    doc.rect(left, top, ANCHO_BLOQUE, bottom - top, 'S');
    return;
  }

  doc.setPage(pageStart);
  doc.line(left, top, right, top);
  doc.line(left, top, left, PAGE_BOTTOM);
  doc.line(right, top, right, PAGE_BOTTOM);

  for (let p = pageStart + 1; p < pageEnd; p++) {
    doc.setPage(p);
    doc.line(left, PAGE_TOP, left, PAGE_BOTTOM);
    doc.line(right, PAGE_TOP, right, PAGE_BOTTOM);
  }

  doc.setPage(pageEnd);
  doc.line(left, PAGE_TOP, left, bottom);
  doc.line(right, PAGE_TOP, right, bottom);
  doc.line(left, bottom, right, bottom);
}

function totalesVentasDetalle(ventas: DetalleVentasCampana): { uds: number; incentivo: number } {
  const locales = ventas.porLocal.filter((l) =>
    localTieneVentas(l.totalUnidades, l.totalIncentivo),
  );
  const uds = locales.reduce((a, l) => a + l.totalUnidades, 0);
  const incentivo = Math.round(locales.reduce((a, l) => a + l.totalIncentivo, 0) * 100) / 100;
  return { uds, incentivo };
}

function renderDetalleVentas(
  doc: jsPDF,
  autoTable: typeof import('jspdf-autotable').default,
  y: number,
  ventas: DetalleVentasCampana,
  localesMap: Map<string, string>,
): number {
  const { uds, incentivo } = totalesVentasDetalle(ventas);
  y = sectionTitle(doc, 'Detalle de ventas', y);
  y += 2; // drawBar pinta la barra 4,5 mm por encima de y
  y = drawBar(
    doc,
    y,
    'Ventas · Todas',
    `${uds.toLocaleString('es-ES')} uds · Incentivo ${formatMonedaPdf(incentivo)}`,
    [241, 245, 249],
    { boldRight: true },
  );
  y += 2;

  const localesVentas = ventas.porLocal.filter(
    (l) => localTieneVentas(l.totalUnidades, l.totalIncentivo) && l.porUsuario.length > 0,
  );

  for (const local of localesVentas) {
    const nombreLocal = localesMap.get(local.localId) || local.localId;
    y = drawBar(
      doc,
      y,
      nombreLocal.toUpperCase(),
      `${local.totalUnidades.toLocaleString('es-ES')} uds · ${formatMonedaPdf(local.totalIncentivo)}`,
      [224, 242, 254],
      { boldRight: true },
    );
    y += 1;

    let firstEmpleado = true;
    for (const usuario of local.porUsuario) {
      if (usuario.lineas.length === 0) continue;

      if (!firstEmpleado) {
        y += GAP_ENTRE_EMPLEADOS;
      }
      firstEmpleado = false;

      // Reservar cabecera + cabecera tabla + al menos una fila en la misma página cuando sea posible.
      y = ensureY(doc, y, 42);
      const paginaInicio = doc.getNumberOfPages();
      const { endY: barEndY, topY: blockTop } = drawBarAt(
        doc,
        y,
        (usuario.userName || `Usuario ${usuario.agoraUserId}`).toUpperCase(),
        `${usuario.totalUnidades.toLocaleString('es-ES')} uds · ${formatMonedaPdf(usuario.totalIncentivo)}`,
        FILL_EMPLEADO,
        { boldRight: true },
      );
      y = barEndY + 1.5;

      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN_X, right: MARGIN_X, bottom: 22 },
        head: [['Fecha', 'Producto', 'Uds', 'Incentivo']],
        body: usuario.lineas.map((l) => [
          formatFechaPdf(l.fecha),
          l.productName,
          udsCelda(l.unidades),
          incentivoCelda(l.incentivo),
        ]),
        styles: { fontSize: 7.5, cellPadding: 1.8, overflow: 'linebreak' },
        headStyles: { fillColor: [248, 250, 252], textColor: [100, 116, 139], fontStyle: 'bold' },
        columnStyles: {
          0: { cellWidth: 22 },
          1: { cellWidth: 'auto' },
          2: { halign: 'right', cellWidth: 14 },
          3: { halign: 'right', cellWidth: 24 },
        },
        didParseCell: didParseUdsIncentivo([2], [3]),
      });

      const tableEnd = lastTableY(doc, y + 12);
      const paginaFin = doc.getNumberOfPages();
      drawEmpleadoPerimetro(doc, blockTop, tableEnd + 2, paginaInicio, paginaFin);
      doc.setPage(paginaFin);

      y = tableEnd + GAP_ENTRE_EMPLEADOS;
    }
    y += 2;
  }

  return y;
}

function addPageFooters(doc: jsPDF): void {
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    const pageW = doc.internal.pageSize.getWidth();
    doc.text(`Página ${i} de ${total} · IGP-2.0`, pageW / 2, 290, { align: 'center' });
  }
}

export function pdfIncentivosCampanaFileSlug(campana: Campana): string {
  const slug = String(campana.nombre || 'campana')
    .replace(/\s+/g, '_')
    .replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]/g, '')
    .slice(0, 30);
  return `incentivos_${slug}_${String(campana.campanaId).slice(0, 8)}`;
}

export async function generarPdfIncentivosCampana(
  campana: Campana,
  resultados: ResultadosCampana,
  opts: { localesMap?: Map<string, string>; ventasDetalle?: DetalleVentasCampana | null } = {},
): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const localesMap = opts.localesMap ?? new Map<string, string>();
  const estado = estadoEfectivoCampana(campana);
  const tipoValorDest = `${etiquetaTipoIncentivo(campana.tipoIncentivo)} · ${formatValorIncentivoDisplay(campana.tipoIncentivo, campana.valorIncentivo)} · ${etiquetaDestinatario(campana.destinatario)}`;

  let y = 14;

  // —— Cabecera ——
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text('Detalle de campaña de incentivos', MARGIN_X, y);
  y += 7;

  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(40);
  const nombreLines = doc.splitTextToSize(String(campana.nombre || 'Campaña'), 186);
  doc.text(nombreLines, MARGIN_X, y);
  y += nombreLines.length * 5;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(71, 85, 105);
  doc.text(`Estado: ${estado}`, MARGIN_X, y);
  y += 4.5;
  doc.text(
    `Periodo: ${formatFechaPdf(campana.fechaInicio)} — ${formatFechaPdf(campana.fechaFin)}`,
    MARGIN_X,
    y,
  );
  y += 4.5;
  const tipoLines = doc.splitTextToSize(tipoValorDest, 186);
  doc.text(tipoLines, MARGIN_X, y);
  y += tipoLines.length * 4.5;
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, MARGIN_X, y);
  y += 4;
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text('IGP-2.0 · Uso interno', MARGIN_X, y);
  y += 8;

  // —— KPIs / Resumen ——
  y = sectionTitle(doc, 'Resumen', y);
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X },
    head: [['Concepto', 'Valor']],
    body: [
      ['Unidades campaña', String(resultados.totales.unidadesCampana)],
      ['Coste incentivo', formatMonedaPdf(resultados.totales.costeIncentivo)],
    ],
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: HEAD_FILL, textColor: 255 },
  });
  y = lastTableY(doc, y + 20) + 8;

  // —— Configuración ——
  const configBody: string[][] = [
    ['Locales', nombresLocales(campana, localesMap)],
    ['Productos', textoProductos(campana)],
    [
      'Tipo incentivo',
      `${etiquetaTipoIncentivo(campana.tipoIncentivo)} · ${formatValorIncentivoDisplay(campana.tipoIncentivo, campana.valorIncentivo)}`,
    ],
    ['Destinatario', etiquetaDestinatario(campana.destinatario)],
  ];
  const notas = String(campana.notas || '').trim();
  if (notas) configBody.push(['Notas', notas]);

  y = sectionTitle(doc, 'Configuración', y);
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X },
    head: [['Concepto', 'Valor']],
    body: configBody,
    styles: { fontSize: 8, cellPadding: 2.5, overflow: 'linebreak' },
    headStyles: { fillColor: HEAD_FILL, textColor: 255 },
    columnStyles: {
      0: { cellWidth: 38, fontStyle: 'bold' },
      1: { cellWidth: 'auto' },
    },
  });
  y = lastTableY(doc, y + 20) + 8;

  // —— Por producto ——
  y = sectionTitle(doc, 'Por producto', y);
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X },
    head: [['Producto', 'Uds.', 'Pr. compra', 'Bonif. €/ud', 'Incentivo']],
    body: resultados.porProducto.map((p) => [
      p.productName,
      udsCelda(p.udsCampanaTotal),
      p.precioCoste != null ? formatMonedaPdf(p.precioCoste) : '—',
      p.bonificacionUnitaria != null ? formatMonedaPdf(p.bonificacionUnitaria) : '—',
      incentivoCelda(p.costeIncentivo),
    ]),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: HEAD_FILL, textColor: 255 },
    columnStyles: {
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
    },
    didParseCell: didParseUdsIncentivo([1], [4]),
  });
  y = lastTableY(doc, y + 20);

  // —— Por empleado ——
  if (resultados.porEmpleado.length > 0) {
    y += 8;
    y = sectionTitle(doc, 'Por empleado', y);
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN_X, right: MARGIN_X },
      head: [['Empleado', 'Local', 'Uds.', 'Importe', 'Incentivo']],
      body: resultados.porEmpleado.map((e) => [
        e.userName || e.agoraUserId,
        localesMap.get(e.localId) || e.localId,
        udsCelda(e.unidades),
        formatMonedaPdf(e.importe),
        incentivoCelda(e.incentivoDevengado),
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: HEAD_FILL, textColor: 255 },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
      didParseCell: didParseUdsIncentivo([2], [4]),
    });
    y = lastTableY(doc, y + 20);
  }

  // —— Por local (solo locales con ventas) ——
  const porLocalConVentas = resultados.porLocal.filter((l) =>
    localTieneVentas(
      l.unidades,
      incentivoLocalResultados(l.localId, l.incentivoDevengado, resultados.porEmpleado),
    ),
  );
  if (porLocalConVentas.length > 0) {
    y += 8;
    y = sectionTitle(doc, 'Por local', y);
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN_X, right: MARGIN_X },
      head: [['Local', 'Uds.', 'Incentivo']],
      body: porLocalConVentas.map((l) => [
        localesMap.get(l.localId) || l.localId,
        udsCelda(l.unidades),
        incentivoCelda(
          incentivoLocalResultados(l.localId, l.incentivoDevengado, resultados.porEmpleado),
        ),
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: HEAD_FILL, textColor: 255 },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      didParseCell: didParseUdsIncentivo([1], [2]),
    });
    y = lastTableY(doc, y + 20);
  }

  // —— Detalle de ventas (local → empleado → líneas) ——
  const ventas = opts.ventasDetalle;
  const localesVentasPdf = ventas?.porLocal?.filter(
    (l) => localTieneVentas(l.totalUnidades, l.totalIncentivo) && l.porUsuario.length > 0,
  ) ?? [];
  if (localesVentasPdf.length > 0 && ventas) {
    y += 8;
    y = renderDetalleVentas(doc, autoTable, y, { ...ventas, porLocal: localesVentasPdf }, localesMap);
  }

  // —— Warnings ——
  const avisos = warningsNoTriviales(resultados.warnings);
  if (avisos.length > 0) {
    y += 8;
    y = sectionTitle(doc, 'Avisos', y);
    y += 3;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(146, 64, 14);
    for (const w of avisos) {
      y = ensureY(doc, y, 8);
      const lineas = doc.splitTextToSize(`• ${etiquetaWarning(w)}`, 186);
      doc.text(lineas, MARGIN_X, y);
      y += lineas.length * 4 + 1;
    }
  }

  addPageFooters(doc);
  return doc;
}
