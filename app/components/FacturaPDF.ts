import { calcularLinea, formatMoneda, labelEstado, labelFormaPago, type LineaFactura } from '../utils/facturacion';
type jsPDF = import('jspdf').jsPDF;

type DatosEmisor = {
  nombre: string;
  cif: string;
  direccion: string;
  cp: string;
  municipio: string;
  provincia: string;
  email: string;
  telefono?: string;
};

type DatosFactura = {
  id_factura: string;
  tipo: 'OUT' | 'IN';
  serie: string;
  numero: number;
  estado: string;
  fecha_emision: string;
  fecha_operacion?: string;
  fecha_vencimiento?: string;
  condiciones_pago?: string;
  forma_pago?: string;
  observaciones?: string;
  es_rectificativa?: boolean;
  factura_rectificada_id?: string;
  motivo_rectificacion?: string;
  numero_factura_proveedor?: string;
  base_imponible: number;
  total_iva: number;
  total_retencion: number;
  total_factura: number;
  total_cobrado?: number;
  saldo_pendiente?: number;
  verifactu_hash?: string;
};

type DatosCliente = {
  nombre: string;
  cif: string;
  direccion: string;
  cp: string;
  municipio: string;
  provincia: string;
  email?: string;
};

const COLORS = {
  primary: [14, 165, 233] as [number, number, number],
  dark: [51, 65, 85] as [number, number, number],
  medium: [100, 116, 139] as [number, number, number],
  light: [226, 232, 240] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
  bg: [248, 250, 252] as [number, number, number],
  success: [5, 150, 105] as [number, number, number],
  warn: [180, 83, 9] as [number, number, number],
};

function formatFecha(iso: string | undefined): string {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export async function generarPDFFactura(
  emisor: DatosEmisor,
  cliente: DatosCliente,
  factura: DatosFactura,
  lineas: LineaFactura[],
): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  // ── HEADER BAR ──
  doc.setFillColor(...COLORS.primary);
  doc.rect(0, 0, pageWidth, 28, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...COLORS.white);
  const titulo = factura.tipo === 'OUT' ? 'FACTURA' : 'FACTURA RECIBIDA';
  doc.text(titulo, margin, 17);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(factura.id_factura, pageWidth - margin, 12, { align: 'right' });

  doc.setFontSize(9);
  doc.text(`Estado: ${labelEstado(factura.estado)}`, pageWidth - margin, 19, { align: 'right' });

  if (factura.es_rectificativa) {
    doc.setFontSize(8);
    doc.setTextColor(255, 200, 50);
    doc.text(`Rectificativa de: ${factura.factura_rectificada_id}`, pageWidth - margin, 25, { align: 'right' });
  }

  y = 36;

  // ── EMISOR / CLIENTE BOXES ──
  const colW = contentWidth / 2 - 4;

  // Emisor
  doc.setFillColor(...COLORS.bg);
  doc.roundedRect(margin, y, colW, 38, 2, 2, 'F');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.medium);
  doc.text('EMISOR', margin + 4, y + 6);
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.dark);
  doc.setFont('helvetica', 'bold');
  doc.text(emisor.nombre, margin + 4, y + 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.medium);
  doc.text(`CIF: ${emisor.cif}`, margin + 4, y + 19);
  const dirEmisor = [emisor.direccion, emisor.cp, emisor.municipio, emisor.provincia].filter(Boolean).join(', ');
  if (dirEmisor) doc.text(dirEmisor, margin + 4, y + 24, { maxWidth: colW - 8 });
  if (emisor.email) doc.text(emisor.email, margin + 4, y + 29);
  if (emisor.telefono) doc.text(`Tel: ${emisor.telefono}`, margin + 4, y + 34);

  // Cliente / Proveedor
  const colX2 = margin + colW + 8;
  doc.setFillColor(...COLORS.bg);
  doc.roundedRect(colX2, y, colW, 38, 2, 2, 'F');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.medium);
  doc.text(factura.tipo === 'OUT' ? 'CLIENTE' : 'PROVEEDOR', colX2 + 4, y + 6);
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.dark);
  doc.setFont('helvetica', 'bold');
  doc.text(cliente.nombre || '—', colX2 + 4, y + 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.medium);
  doc.text(`CIF: ${cliente.cif || '—'}`, colX2 + 4, y + 19);
  const dirCliente = [cliente.direccion, cliente.cp, cliente.municipio, cliente.provincia].filter(Boolean).join(', ');
  if (dirCliente) doc.text(dirCliente, colX2 + 4, y + 24, { maxWidth: colW - 8 });
  if (cliente.email) doc.text(cliente.email, colX2 + 4, y + 29);

  y += 44;

  // ── DATOS DE FACTURA ──
  doc.setFillColor(...COLORS.primary);
  doc.rect(margin, y, contentWidth, 7, 'F');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.white);
  doc.setFont('helvetica', 'bold');

  const dataCols = ['Fecha emisión', 'Fecha vencimiento', 'Forma de pago', 'Condiciones'];
  const dataW = contentWidth / dataCols.length;
  dataCols.forEach((h, i) => {
    doc.text(h, margin + dataW * i + 3, y + 5);
  });

  y += 7;
  doc.setFillColor(...COLORS.bg);
  doc.rect(margin, y, contentWidth, 7, 'F');
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.dark);
  doc.setFont('helvetica', 'normal');

  const dataVals = [
    formatFecha(factura.fecha_emision),
    formatFecha(factura.fecha_vencimiento),
    factura.forma_pago ? labelFormaPago(factura.forma_pago) : '—',
    factura.condiciones_pago || '—',
  ];
  dataVals.forEach((v, i) => {
    doc.text(v, margin + dataW * i + 3, y + 5);
  });

  if (factura.numero_factura_proveedor) {
    y += 7;
    doc.setFillColor(...COLORS.bg);
    doc.rect(margin, y, contentWidth, 7, 'F');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.medium);
    doc.text(`Nº factura proveedor: ${factura.numero_factura_proveedor}`, margin + 3, y + 5);
  }

  y += 12;

  // ── LÍNEAS TABLE ──
  const tableHeaders = ['Descripción', 'Cant.', 'Precio', 'Dto%', 'IVA%', 'Ret%', 'Base', 'Total'];
  const colWidths = [contentWidth * 0.30, 14, 20, 14, 14, 14, 24, 24];

  // Normalize so sum fits
  const totalColW = colWidths.reduce((a, b) => a + b, 0);
  const scale = contentWidth / totalColW;
  const scaledW = colWidths.map((w) => w * scale);

  const tableBody = lineas.map((l) => {
    const calc = calcularLinea(l);
    return [
      l.descripcion || '—',
      String(l.cantidad),
      formatMoneda(l.precio_unitario),
      l.descuento_pct > 0 ? `${l.descuento_pct}%` : '—',
      `${l.tipo_iva}%`,
      l.retencion_pct > 0 ? `${l.retencion_pct}%` : '—',
      formatMoneda(calc.base_linea),
      formatMoneda(calc.total_linea),
    ];
  });

  autoTable(doc, {
    startY: y,
    head: [tableHeaders],
    body: tableBody,
    margin: { left: margin, right: margin },
    styles: {
      fontSize: 8,
      cellPadding: 2,
      textColor: COLORS.dark,
      lineColor: COLORS.light,
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: COLORS.primary,
      textColor: COLORS.white,
      fontStyle: 'bold',
      fontSize: 7.5,
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: scaledW[0] },
      1: { cellWidth: scaledW[1], halign: 'center' },
      2: { cellWidth: scaledW[2], halign: 'right' },
      3: { cellWidth: scaledW[3], halign: 'center' },
      4: { cellWidth: scaledW[4], halign: 'center' },
      5: { cellWidth: scaledW[5], halign: 'center' },
      6: { cellWidth: scaledW[6], halign: 'right' },
      7: { cellWidth: scaledW[7], halign: 'right' },
    },
  });

  y = (doc as any).lastAutoTable?.finalY ?? y + 40;
  y += 6;

  // ── DESGLOSE IVA ──
  const desgloseIva: Record<number, { base: number; iva: number }> = {};
  for (const l of lineas) {
    const calc = calcularLinea(l);
    if (!desgloseIva[l.tipo_iva]) desgloseIva[l.tipo_iva] = { base: 0, iva: 0 };
    desgloseIva[l.tipo_iva].base += calc.base_linea;
    desgloseIva[l.tipo_iva].iva += calc.iva_linea;
  }

  const ivaEntries = Object.entries(desgloseIva).map(([tipo, vals]) => ({
    tipo: Number(tipo),
    base: vals.base,
    iva: vals.iva,
  }));

  if (ivaEntries.length > 0) {
    const ivaTableBody = ivaEntries.map((e) => [
      `${e.tipo}%`,
      formatMoneda(e.base),
      formatMoneda(e.iva),
    ]);
    ivaTableBody.push(['TOTAL', formatMoneda(factura.base_imponible), formatMoneda(factura.total_iva)]);

    autoTable(doc, {
      startY: y,
      head: [['Tipo IVA', 'Base', 'Cuota']],
      body: ivaTableBody,
      margin: { left: pageWidth - margin - 80, right: margin },
      tableWidth: 80,
      styles: { fontSize: 7.5, cellPadding: 1.5, textColor: COLORS.dark, lineColor: COLORS.light, lineWidth: 0.2 },
      headStyles: { fillColor: COLORS.bg, textColor: COLORS.dark, fontStyle: 'bold', fontSize: 7 },
      columnStyles: { 0: { halign: 'left' }, 1: { halign: 'right' }, 2: { halign: 'right' } },
    });
    y = (doc as any).lastAutoTable?.finalY ?? y + 20;
    y += 4;
  }

  // ── TOTALES BOX ──
  const totalesX = pageWidth - margin - 80;
  const totalesW = 80;

  doc.setFillColor(...COLORS.bg);
  doc.roundedRect(totalesX, y, totalesW, factura.total_retencion > 0 ? 34 : 26, 2, 2, 'F');

  doc.setFontSize(8);
  doc.setTextColor(...COLORS.medium);
  doc.text('Base imponible:', totalesX + 3, y + 6);
  doc.setTextColor(...COLORS.dark);
  doc.text(formatMoneda(factura.base_imponible), totalesX + totalesW - 3, y + 6, { align: 'right' });

  doc.setTextColor(...COLORS.medium);
  doc.text('IVA:', totalesX + 3, y + 12);
  doc.setTextColor(...COLORS.dark);
  doc.text(formatMoneda(factura.total_iva), totalesX + totalesW - 3, y + 12, { align: 'right' });

  let lineY = 18;
  if (factura.total_retencion > 0) {
    doc.setTextColor(...COLORS.medium);
    doc.text('Retención:', totalesX + 3, y + lineY);
    doc.setTextColor(220, 38, 38);
    doc.text(`-${formatMoneda(factura.total_retencion)}`, totalesX + totalesW - 3, y + lineY, { align: 'right' });
    lineY += 6;
  }

  doc.setDrawColor(...COLORS.light);
  doc.line(totalesX + 3, y + lineY - 1, totalesX + totalesW - 3, y + lineY - 1);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...COLORS.primary);
  doc.text('TOTAL:', totalesX + 3, y + lineY + 5);
  doc.text(formatMoneda(factura.total_factura), totalesX + totalesW - 3, y + lineY + 5, { align: 'right' });

  y += lineY + 14;

  // ── COBRADO / PENDIENTE ──
  if (factura.total_cobrado != null && factura.total_cobrado > 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.success);
    doc.text(`Cobrado: ${formatMoneda(factura.total_cobrado)}`, totalesX + 3, y);
    if (factura.saldo_pendiente != null && factura.saldo_pendiente > 0) {
      doc.setTextColor(...COLORS.warn);
      doc.text(`Pendiente: ${formatMoneda(factura.saldo_pendiente)}`, totalesX + 3, y + 5);
    }
    y += 12;
  }

  // ── OBSERVACIONES ──
  if (factura.observaciones) {
    if (y > 250) { doc.addPage(); y = margin; }
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.medium);
    doc.setFont('helvetica', 'bold');
    doc.text('Observaciones:', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.dark);
    const splitObs = doc.splitTextToSize(factura.observaciones, contentWidth);
    doc.text(splitObs, margin, y + 5);
    y += 5 + splitObs.length * 3.5;
  }

  // ── RECTIFICATIVA INFO ──
  if (factura.es_rectificativa && factura.motivo_rectificacion) {
    y += 4;
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.warn);
    doc.setFont('helvetica', 'bold');
    doc.text('Factura rectificativa', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`Rectifica a: ${factura.factura_rectificada_id || '—'}`, margin, y + 5);
    doc.text(`Motivo: ${factura.motivo_rectificacion}`, margin, y + 10);
    y += 16;
  }

  // ── QR PLACEHOLDER (VERI*FACTU) ──
  if (factura.verifactu_hash) {
    if (y > 260) { doc.addPage(); y = margin; }
    doc.setFillColor(...COLORS.bg);
    doc.roundedRect(margin, y, 30, 30, 2, 2, 'F');
    doc.setFontSize(6);
    doc.setTextColor(...COLORS.medium);
    doc.text('QR VERI*FACTU', margin + 2, y + 16);
    doc.setFontSize(5);
    doc.text(factura.verifactu_hash.slice(0, 20) + '...', margin + 2, y + 20);
    y += 36;
  }

  // ── FOOTER ──
  const pageH = doc.internal.pageSize.getHeight();
  doc.setDrawColor(...COLORS.light);
  doc.line(margin, pageH - 15, pageWidth - margin, pageH - 15);
  doc.setFontSize(7);
  doc.setTextColor(...COLORS.medium);
  doc.text(`${emisor.nombre} · CIF ${emisor.cif}`, margin, pageH - 10);
  doc.text(`Generado: ${new Date().toLocaleDateString('es-ES')}`, pageWidth - margin, pageH - 10, { align: 'right' });

  return doc;
}

export async function descargarPDFFactura(
  emisor: DatosEmisor,
  cliente: DatosCliente,
  factura: DatosFactura,
  lineas: LineaFactura[],
) {
  const doc = await generarPDFFactura(emisor, cliente, factura, lineas);
  doc.save(`${factura.id_factura}.pdf`);
}
