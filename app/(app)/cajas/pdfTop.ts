/**
 * Generador de PDF para el submódulo "Top" de Cajas.
 * Vertical (portrait). Muestra:
 *   - Top ventas por local (todos los locales con registros)
 *   - Top consecución de objetivos (real / comparativa × 100)
 *   - Top 10 ventas por camarero
 *   - Top 10 ventas por cliente
 */

type jsPDF = import('jspdf').jsPDF;

export type TopLocalRowPdf = {
  rank: number;
  workplaceId: string;
  nombre: string;
  total: number;
};
export type TopObjetivoRowPdf = {
  rank: number;
  workplaceId: string;
  nombre: string;
  real: number;
  comparativa: number;
  variacionPct: number | null;
};
export type TopCamareroRowPdf = {
  rank: number;
  userId: string;
  userName: string;
  amount: number;
  tickets: number;
};
export type TopClienteRowPdf = {
  rank: number;
  customerId: string;
  customerName: string;
  amount: number;
  tickets: number;
  consumo?: boolean;
};

export type TopDataPdf = {
  dateFrom: string;
  dateTo: string;
  workplaceIds: string[];
  locales: TopLocalRowPdf[];
  objetivos: TopObjetivoRowPdf[];
  camareros: TopCamareroRowPdf[];
  clientes: TopClienteRowPdf[];
};

export type PdfTopOpts = {
  titulo?: string;
  incluirConsumo?: boolean;
  nombresLocalesSeleccionados?: string[];
};

function formatMoneda(value: number): string {
  if (!Number.isFinite(value)) return '0,00 €';
  const parts = value.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

/** Variación interanual con signo: +67,4 %, −12,9 %, 0,0 %. */
function formatVariacionPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value).toFixed(1).replace('.', ',');
  if (value > 0) return `+${abs} %`;
  if (value < 0) return `-${abs} %`;
  return `0,0 %`;
}

function formatBusinessDayLabel(iso: string): string {
  if (!iso || typeof iso !== 'string') return '—';
  const parts = iso.trim().split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function pdfTopFileSlug(fechaDesde: string, fechaHasta: string, _localesNombres: string[] = []): string {
  const f = (s: string) => String(s || '').replace(/-/g, '');
  return `top-cajas-${f(fechaDesde)}-${f(fechaHasta)}`;
}

export async function generarPdfTop(
  data: TopDataPdf,
  opts: PdfTopOpts = {},
): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 12;
  const innerW = pageW - marginX * 2;

  let y = 12;

  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.text('Top — Cajas', marginX, y);
  y += 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  doc.text(String(opts.titulo ?? 'Rankings por rango de fechas'), marginX, y);
  y += 5;
  doc.text(
    `Periodo: ${formatBusinessDayLabel(data.dateFrom)} → ${formatBusinessDayLabel(data.dateTo)}`,
    marginX,
    y,
  );
  y += 4;
  const localesTxt = data.workplaceIds.length === 0
    ? 'Locales: todos'
    : `Locales: ${data.workplaceIds.length} seleccionado${data.workplaceIds.length === 1 ? '' : 's'}`;
  doc.text(localesTxt, marginX, y);
  y += 4;
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, marginX, y);
  y += 4;
  if (opts.incluirConsumo != null) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(3, 105, 161);
    doc.text(
      opts.incluirConsumo
        ? 'Cliente CONSUMO: incluido en Top clientes'
        : 'Cliente CONSUMO: excluido de Top clientes',
      marginX,
      y,
    );
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0);
  }

  const headColor: [number, number, number] = [14, 165, 233];
  const totalFillColor: [number, number, number] = [241, 245, 249];

  const ensureSpace = (need: number) => {
    if (y + need > pageH - 14) {
      doc.addPage();
      y = 14;
    }
  };

  // -----------------------------------------------------------------------
  // 1) Top ventas por local
  // -----------------------------------------------------------------------
  ensureSpace(40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text(`Top ventas por local  ·  ${data.locales.length} locales`, marginX, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  const totalLocales = data.locales.reduce((s, r) => s + (r.total || 0), 0);
  const bodyLocales = data.locales.map((r) => [
    String(r.rank),
    r.nombre,
    formatMoneda(r.total),
  ]);
  bodyLocales.push(['', 'TOTAL', formatMoneda(totalLocales)]);

  autoTable(doc, {
    startY: y,
    head: [['#', 'Local', 'Importe']],
    body: bodyLocales,
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: headColor, textColor: 255, fontStyle: 'bold' },
    margin: { left: marginX, right: marginX },
    tableWidth: innerW,
    columnStyles: {
      0: { cellWidth: 12, halign: 'right' },
      1: { cellWidth: innerW - 12 - 38 },
      2: { cellWidth: 38, halign: 'right' },
    },
    didParseCell: (cell) => {
      if (cell.section === 'body' && cell.row.index === bodyLocales.length - 1) {
        cell.cell.styles.fillColor = totalFillColor;
        cell.cell.styles.fontStyle = 'bold';
      }
    },
  });
  const tableLocales = doc as unknown as { lastAutoTable?: { finalY: number } };
  y = (tableLocales.lastAutoTable?.finalY ?? y) + 6;

  // -----------------------------------------------------------------------
  // 2) Top consecución de objetivos
  // -----------------------------------------------------------------------
  ensureSpace(40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Top consecución de objetivos  ·  ${data.objetivos.length} locales`, marginX, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text('Ranking por variación interanual = (real / comparativa - 1) × 100', marginX, y);
  y += 4;
  doc.setTextColor(0);

  const bodyObj = data.objetivos.map((r) => [
    String(r.rank),
    r.nombre,
    formatMoneda(r.real),
    formatMoneda(r.comparativa),
    formatVariacionPct(r.variacionPct),
  ]);

  const colorOk: [number, number, number] = [21, 128, 61];
  const colorWarn: [number, number, number] = [146, 64, 14];
  const colorBad: [number, number, number] = [185, 28, 28];

  autoTable(doc, {
    startY: y,
    head: [['#', 'Local', 'Real', 'Comparativa', 'Variación']],
    body: bodyObj,
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: headColor, textColor: 255, fontStyle: 'bold' },
    margin: { left: marginX, right: marginX },
    tableWidth: innerW,
    columnStyles: {
      0: { cellWidth: 12, halign: 'right' },
      1: { cellWidth: innerW - 12 - 32 - 36 - 28 },
      2: { cellWidth: 32, halign: 'right' },
      3: { cellWidth: 36, halign: 'right' },
      4: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
    },
    didParseCell: (cell) => {
      if (cell.section === 'body' && cell.column.index === 4) {
        const pct = data.objetivos[cell.row.index]?.variacionPct;
        if (pct != null) {
          if (pct > 0) cell.cell.styles.textColor = colorOk;
          else if (pct < 0) cell.cell.styles.textColor = colorBad;
          else cell.cell.styles.textColor = colorWarn;
        }
      }
    },
  });
  const tableObj = doc as unknown as { lastAutoTable?: { finalY: number } };
  y = (tableObj.lastAutoTable?.finalY ?? y) + 6;

  // -----------------------------------------------------------------------
  // 3) Top 10 camareros
  // -----------------------------------------------------------------------
  ensureSpace(40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Top 10 ventas por camarero  ·  ${data.camareros.length}`, marginX, y);
  y += 4;
  doc.setFont('helvetica', 'normal');

  const totalCam = data.camareros.reduce((s, r) => s + (r.amount || 0), 0);
  const bodyCam = data.camareros.map((r) => [
    String(r.rank),
    r.userName,
    String(r.tickets),
    formatMoneda(r.amount),
  ]);
  bodyCam.push(['', 'TOTAL TOP 10', '', formatMoneda(totalCam)]);

  autoTable(doc, {
    startY: y,
    head: [['#', 'Camarero', 'Tickets', 'Importe']],
    body: bodyCam,
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: headColor, textColor: 255, fontStyle: 'bold' },
    margin: { left: marginX, right: marginX },
    tableWidth: innerW,
    columnStyles: {
      0: { cellWidth: 12, halign: 'right' },
      1: { cellWidth: innerW - 12 - 24 - 38 },
      2: { cellWidth: 24, halign: 'right' },
      3: { cellWidth: 38, halign: 'right' },
    },
    didParseCell: (cell) => {
      if (cell.section === 'body' && cell.row.index === bodyCam.length - 1) {
        cell.cell.styles.fillColor = totalFillColor;
        cell.cell.styles.fontStyle = 'bold';
      }
    },
  });
  const tableCam = doc as unknown as { lastAutoTable?: { finalY: number } };
  y = (tableCam.lastAutoTable?.finalY ?? y) + 6;

  // -----------------------------------------------------------------------
  // 4) Top 10 clientes
  // -----------------------------------------------------------------------
  ensureSpace(40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Top 10 ventas por cliente  ·  ${data.clientes.length}`, marginX, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text(
    opts.incluirConsumo
      ? 'CONSUMO incluido en el ranking.'
      : 'CONSUMO excluido del ranking.',
    marginX,
    y,
  );
  y += 4;
  doc.setTextColor(0);

  const totalCli = data.clientes.reduce((s, r) => s + (r.amount || 0), 0);
  const bodyCli = data.clientes.map((r) => [
    String(r.rank),
    r.consumo ? `${r.customerName} · CONSUMO` : r.customerName,
    String(r.tickets),
    formatMoneda(r.amount),
  ]);
  bodyCli.push(['', 'TOTAL TOP 10', '', formatMoneda(totalCli)]);

  autoTable(doc, {
    startY: y,
    head: [['#', 'Cliente', 'Tickets', 'Importe']],
    body: bodyCli,
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: headColor, textColor: 255, fontStyle: 'bold' },
    margin: { left: marginX, right: marginX },
    tableWidth: innerW,
    columnStyles: {
      0: { cellWidth: 12, halign: 'right' },
      1: { cellWidth: innerW - 12 - 24 - 38 },
      2: { cellWidth: 24, halign: 'right' },
      3: { cellWidth: 38, halign: 'right' },
    },
    didParseCell: (cell) => {
      if (cell.section === 'body' && cell.row.index === bodyCli.length - 1) {
        cell.cell.styles.fillColor = totalFillColor;
        cell.cell.styles.fontStyle = 'bold';
      }
      if (cell.section === 'body' && cell.column.index === 1) {
        const row = data.clientes[cell.row.index];
        if (row?.consumo) {
          cell.cell.styles.textColor = [3, 105, 161];
        }
      }
    },
  });

  return doc;
}
