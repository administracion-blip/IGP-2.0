/**
 * Generación del PDF del informe diario en el backend con jsPDF + autotable
 * (mismo motor que los informes del frontend, p. ej. cajas/pdfTop.ts).
 * Devuelve un Buffer listo para adjuntar al email.
 */

const HEAD_COLOR = [14, 165, 233];
const TOTAL_FILL = [241, 245, 249];
const COLOR_OK = [21, 128, 61];
const COLOR_BAD = [185, 28, 28];

function formatMoneda(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function formatPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return '—';
  const v = Number(p);
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function formatFechaLarga(iso) {
  try {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('es-ES', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

const ETIQUETA_TIPO = {
  invitacion: 'Invitaciones',
  descuento: 'Descuentos',
  anulacion: 'Anulaciones',
  promocion: 'Promociones',
  consumo: 'Consumo personal',
};

/**
 * @param {object} datos - salida de obtenerDatosInforme()
 * @param {object} meta - { destinatarioNombre, localesNombres }
 * @returns {Promise<Buffer>}
 */
export async function generarPdfInformeDiario(datos, meta = {}) {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 12;
  const innerW = pageW - marginX * 2;
  let y = 14;

  const ensureSpace = (need) => {
    if (y + need > pageH - 14) {
      doc.addPage();
      y = 14;
    }
  };
  const finalY = () => (doc.lastAutoTable?.finalY ?? y);

  // ---- Cabecera ----
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text('Informe diario de jornadas', marginX, y);
  y += 7;
  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  doc.text(`Jornada: ${formatFechaLarga(datos.businessDay)}`, marginX, y);
  y += 5;
  if (meta.destinatarioNombre) {
    doc.text(`Destinatario: ${meta.destinatarioNombre}`, marginX, y);
    y += 5;
  }
  const localesTxt = (meta.localesNombres || []).join(', ');
  if (localesTxt) {
    doc.text(`Locales: ${localesTxt}`, marginX, y, { maxWidth: innerW });
    y += 5;
  }
  doc.setFontSize(8.5);
  doc.setTextColor(120);
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, marginX, y);
  y += 7;
  doc.setTextColor(0);

  // ---- Resumen global (KPIs) ----
  ensureSpace(24);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Resumen', marginX, y);
  y += 3;
  autoTable(doc, {
    startY: y,
    head: [['Facturación', 'Comparativa', 'Desvío', 'Variación']],
    body: [[
      formatMoneda(datos.totalReal),
      formatMoneda(datos.totalComp),
      formatMoneda(datos.totalReal - datos.totalComp),
      formatPct(datos.variacionPctTotal),
    ]],
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 2.4, halign: 'center' },
    headStyles: { fillColor: HEAD_COLOR, textColor: 255, fontStyle: 'bold', halign: 'center' },
    margin: { left: marginX, right: marginX },
    tableWidth: innerW,
    didParseCell: (cell) => {
      if (cell.section === 'body' && (cell.column.index === 2 || cell.column.index === 3)) {
        const positivo = datos.variacionPctTotal != null && datos.variacionPctTotal >= 0;
        cell.cell.styles.textColor = positivo ? COLOR_OK : COLOR_BAD;
        cell.cell.styles.fontStyle = 'bold';
      }
    },
  });
  y = finalY() + 8;

  // ---- Facturación y cumplimiento por local ----
  ensureSpace(30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text(`Facturación por local  ·  ${datos.porLocal.length}`, marginX, y);
  y += 3;
  doc.setTextColor(0);

  const bodyLocal = datos.porLocal.map((l) => [
    l.nombre,
    formatMoneda(l.real),
    formatMoneda(l.comparativa),
    formatMoneda(l.real - l.comparativa),
    formatPct(l.variacionPct),
  ]);
  bodyLocal.push([
    'TOTAL',
    formatMoneda(datos.totalReal),
    formatMoneda(datos.totalComp),
    formatMoneda(datos.totalReal - datos.totalComp),
    formatPct(datos.variacionPctTotal),
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Local', 'Real', 'Comparativa', 'Desvío', 'Var.']],
    body: bodyLocal,
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: HEAD_COLOR, textColor: 255, fontStyle: 'bold' },
    margin: { left: marginX, right: marginX },
    tableWidth: innerW,
    columnStyles: {
      0: { cellWidth: innerW - 32 - 36 - 30 - 22 },
      1: { cellWidth: 32, halign: 'right' },
      2: { cellWidth: 36, halign: 'right' },
      3: { cellWidth: 30, halign: 'right' },
      4: { cellWidth: 22, halign: 'right', fontStyle: 'bold' },
    },
    didParseCell: (cell) => {
      const esTotal = cell.section === 'body' && cell.row.index === bodyLocal.length - 1;
      if (esTotal) {
        cell.cell.styles.fillColor = TOTAL_FILL;
        cell.cell.styles.fontStyle = 'bold';
      }
      if (cell.section === 'body' && cell.column.index === 4) {
        const pct = esTotal ? datos.variacionPctTotal : datos.porLocal[cell.row.index]?.variacionPct;
        if (pct != null) cell.cell.styles.textColor = pct >= 0 ? COLOR_OK : COLOR_BAD;
      }
    },
  });
  y = finalY() + 8;

  // ---- Invitaciones / descuentos / anulaciones ----
  ensureSpace(28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Invitaciones, descuentos y anulaciones', marginX, y);
  y += 3;
  doc.setFont('helvetica', 'normal');

  if (datos.excepciones.length > 0) {
    const bodyExc = datos.excepciones.map((e) => [
      ETIQUETA_TIPO[e.tipo] || e.tipo,
      String(e.count),
      formatMoneda(e.importe),
    ]);
    autoTable(doc, {
      startY: y,
      head: [['Concepto', 'Nº', 'Importe']],
      body: bodyExc,
      theme: 'striped',
      styles: { fontSize: 8.5, cellPadding: 1.6 },
      headStyles: { fillColor: HEAD_COLOR, textColor: 255, fontStyle: 'bold' },
      margin: { left: marginX, right: marginX },
      tableWidth: innerW,
      columnStyles: {
        0: { cellWidth: innerW - 26 - 40 },
        1: { cellWidth: 26, halign: 'right' },
        2: { cellWidth: 40, halign: 'right' },
      },
    });
    y = finalY() + 8;
  } else {
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('Sin invitaciones, descuentos ni anulaciones registradas.', marginX, y + 2);
    doc.setTextColor(0);
    y += 10;
  }

  // ---- Top ventas por usuario ----
  ensureSpace(28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Top ventas por usuario  ·  ${datos.topUsuarios.length}`, marginX, y);
  y += 3;
  doc.setFont('helvetica', 'normal');

  if (datos.topUsuarios.length > 0) {
    const bodyTop = datos.topUsuarios.map((u) => [
      String(u.rank ?? ''),
      u.nombre,
      u.tickets != null ? String(u.tickets) : '—',
      formatMoneda(u.amount),
    ]);
    autoTable(doc, {
      startY: y,
      head: [['#', 'Usuario', 'Tickets', 'Importe']],
      body: bodyTop,
      theme: 'striped',
      styles: { fontSize: 8.5, cellPadding: 1.6 },
      headStyles: { fillColor: HEAD_COLOR, textColor: 255, fontStyle: 'bold' },
      margin: { left: marginX, right: marginX },
      tableWidth: innerW,
      columnStyles: {
        0: { cellWidth: 12, halign: 'right' },
        1: { cellWidth: innerW - 12 - 28 - 40 },
        2: { cellWidth: 28, halign: 'right' },
        3: { cellWidth: 40, halign: 'right' },
      },
    });
    y = finalY() + 6;
  } else {
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('Sin ventas por usuario en la jornada.', marginX, y + 2);
    doc.setTextColor(0);
    y += 10;
  }

  const arrayBuffer = doc.output('arraybuffer');
  return Buffer.from(arrayBuffer);
}
