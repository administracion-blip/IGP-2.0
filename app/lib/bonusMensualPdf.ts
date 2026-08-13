/**
 * PDF de bonus mensual RRHH (grupo → empresas → locales → anexo nómina).
 * A4 landscape: pág. 1 cabecera+grupo; cada empresa en página nueva; locales 50/50.
 */

type jsPDF = import('jspdf').jsPDF;

const HEAD_FILL: [number, number, number] = [14, 165, 233]; // #0ea5e9
const COLOR_INCENTIVO: [number, number, number] = [22, 101, 52];
const COLOR_TOTAL: [number, number, number] = [21, 128, 61]; // #15803d
const FILL_AMBER: [number, number, number] = [254, 243, 199]; // #fef3c7
const FILL_AMBER_BORDER: [number, number, number] = [251, 191, 36]; // #fbbf24
const FILL_TOTAL: [number, number, number] = [220, 252, 231]; // #dcfce7
const FILL_TOTAL_BORDER: [number, number, number] = [134, 239, 172]; // #86efac
const MARGIN_X = 12;
const PAGE_BOTTOM = 192;
const PAGE_TOP = 12;
const COL_GAP = 4;
/** Altura estimada mínima de un bloque local (título + métricas + tabla corta). */
const LOCAL_BLOCK_MIN_H = 52;

export type BonusPdfIncentivoDetalle = {
  destinatario?: string;
  productId?: string;
  productName?: string;
  userName?: string;
  unidades?: number;
  incentivoEur?: number;
};

export type BonusPdfLocal = {
  localId: string;
  localNombre: string;
  realGross: number;
  objGross: number;
  desvGross: number;
  desvSinIva: number;
  incentivosCampana: number;
  baseFondo: number;
  pctEfectivo: number;
  fondo: number;
  total?: number;
  incentivosDetalle?: BonusPdfIncentivoDetalle[];
};

export type BonusPdfTotales = {
  realGross: number;
  objGross: number;
  desvGross: number;
  desvSinIva: number;
  incentivos: number;
  baseFondo: number;
  fondo: number;
  total?: number;
};

export type BonusPdfEmpresa = {
  id_empresa: string;
  nombre: string;
  totales: BonusPdfTotales;
  locales: BonusPdfLocal[];
};

export type BonusPdfDatos = {
  mes: string;
  hastaFecha: string;
  estado: string;
  pctDefaultGlobal: number;
  empresas: BonusPdfEmpresa[];
  totalesGrupo: BonusPdfTotales;
};

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

function formatPctPdf(n: number): string {
  if (!Number.isFinite(n)) return '0 %';
  return `${String(n).replace('.', ',')} %`;
}

function etiquetaEstado(estado: string): string {
  const e = String(estado || '').toLowerCase();
  if (e === 'cerrado') return 'Cerrado';
  if (e === 'borrador') return 'Borrador';
  return estado || '—';
}

function etiquetaPeriodo(mes: string): string {
  const m = String(mes || '').trim();
  const match = /^(\d{4})-(\d{1,2})$/.exec(m);
  if (!match) return m || '—';
  const anio = match[1];
  const mesNum = Number(match[2]);
  const nombres = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  const nombre = nombres[mesNum - 1];
  return nombre ? `${nombre} ${anio}` : m;
}

function nombreEmpleado(d: BonusPdfIncentivoDetalle): string {
  if (d.destinatario === 'equipo') return 'Equipo';
  return d.userName || '—';
}

function udsCelda(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '';
  return String(n);
}

function incentivoCelda(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || Math.abs(n) < 0.005) return '';
  return formatMonedaPdf(n);
}

function totalPdf(incentivos: number, fondo: number, total?: number): number {
  if (total != null && Number.isFinite(total)) return Number(total);
  return Math.round(((Number(incentivos) || 0) + (Number(fondo) || 0)) * 100) / 100;
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;
}

function pageWidth(doc: jsPDF): number {
  return doc.internal.pageSize.getWidth();
}

function colGeometry(doc: jsPDF): { colW: number; leftX: number; rightX: number } {
  const pageW = pageWidth(doc);
  const colW = (pageW - 2 * MARGIN_X - COL_GAP) / 2;
  return {
    colW,
    leftX: MARGIN_X,
    rightX: MARGIN_X + colW + COL_GAP,
  };
}

function ensureY(doc: jsPDF, y: number, needMm = 24, onNewPage?: () => number): number {
  if (y + needMm > PAGE_BOTTOM) {
    doc.addPage();
    return onNewPage ? onNewPage() : PAGE_TOP;
  }
  return y;
}

function didParseIncentivoCols(incentivoCols: number[]) {
  return (data: {
    section: string;
    column: { index: number };
    cell: { text: string[]; styles: Record<string, unknown> };
  }) => {
    if (data.section !== 'body') return;
    const text = String(data.cell.text?.[0] ?? '').trim();
    if (!text) return;
    if (incentivoCols.includes(data.column.index)) {
      data.cell.styles.fontStyle = 'bold';
      data.cell.styles.textColor = COLOR_INCENTIVO;
    }
  };
}

/** Banda fuerte a ancho completo: título EMPRESA. */
function drawEmpresaBand(doc: jsPDF, nombre: string, y: number, compact = false): number {
  const pageW = pageWidth(doc);
  const barH = compact ? 7 : 9;
  const topY = y;
  doc.setFillColor(...HEAD_FILL);
  doc.rect(MARGIN_X, topY, pageW - 2 * MARGIN_X, barH, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(compact ? 9 : 11);
  doc.setTextColor(255, 255, 255);
  const label = compact ? `${(nombre || 'Empresa').toUpperCase()} (cont.)` : (nombre || 'Empresa').toUpperCase();
  doc.text(label, MARGIN_X + 3, topY + barH / 2 + 1.2);
  return topY + barH + (compact ? 3 : 4);
}

function drawLocalTitle(doc: jsPDF, nombre: string, y: number): number {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text((nombre || 'Local').toUpperCase(), MARGIN_X, y);
  return y + 5;
}

function addPageFooters(doc: jsPDF, generado: string): void {
  const total = doc.getNumberOfPages();
  const pageH = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    const pageW = pageWidth(doc);
    doc.text(`${generado} · Página ${i}/${total}`, pageW / 2, pageH - 6, { align: 'center' });
  }
}

export function pdfBonusMensualFileSlug(mes: string): string {
  const slug = String(mes || 'mes')
    .replace(/\s+/g, '_')
    .replace(/[^\w\-]/g, '')
    .slice(0, 20);
  return `bonus_mensual_${slug || 'mes'}`;
}

export async function generarPdfBonusMensual(datos: BonusPdfDatos): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const generado = new Date().toLocaleString('es-ES');
  const periodo = etiquetaPeriodo(datos.mes);
  const estadoTxt = etiquetaEstado(datos.estado);
  const tg = datos.totalesGrupo;
  const { colW, leftX, rightX } = colGeometry(doc);
  const leftMargin = { left: leftX, right: MARGIN_X + colW + COL_GAP };
  const rightMargin = { left: rightX, right: MARGIN_X };

  let y = PAGE_TOP;

  // —— 1. Cabecera (página 1) ——
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text('IGP · RRHH · BONUS MENSUAL', MARGIN_X, y);
  y += 6;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(40);
  doc.text(`Periodo: ${periodo}`, MARGIN_X, y);
  y += 5;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Datos hasta: ${formatFechaPdf(datos.hastaFecha)}   ·   Estado: ${estadoTxt}   ·   % global fondo: ${formatPctPdf(datos.pctDefaultGlobal)}`,
    MARGIN_X,
    y,
  );
  y += 4;
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text('IGP-2.0 · Uso interno', MARGIN_X, y);
  y += 7;

  // —— 2. Resumen grupo ——
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text('Resumen del grupo', MARGIN_X, y);
  y += 4;

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X },
    head: [['Concepto', 'Importe']],
    body: [
      ['Real c/IVA', formatMonedaPdf(tg.realGross)],
      ['Obj c/IVA', formatMonedaPdf(tg.objGross)],
      ['Desv c/IVA', formatMonedaPdf(tg.desvGross)],
      ['Desv s/IVA', formatMonedaPdf(tg.desvSinIva)],
      ['Incentivos', formatMonedaPdf(tg.incentivos)],
      ['Base fondo', formatMonedaPdf(tg.baseFondo)],
      ['Fondo común', formatMonedaPdf(tg.fondo)],
      ['Total', formatMonedaPdf(totalPdf(tg.incentivos, tg.fondo, tg.total))],
    ],
    styles: { fontSize: 9, cellPadding: 2.2 },
    headStyles: { fillColor: HEAD_FILL, textColor: 255 },
    columnStyles: {
      0: { cellWidth: 55, fontStyle: 'bold' },
      1: { halign: 'right', cellWidth: 40 },
    },
    tableWidth: 95,
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const concepto = String(data.row.raw?.[0] ?? '');
      if (concepto === 'Incentivos' || concepto === 'Fondo común') {
        if (data.column.index === 1) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.textColor = COLOR_INCENTIVO;
        }
      }
      if (concepto === 'Total') {
        data.cell.styles.fillColor = FILL_TOTAL;
        data.cell.styles.fontStyle = 'bold';
        if (data.column.index === 1) data.cell.styles.textColor = COLOR_TOTAL;
      }
    },
  });

  // —— 3. Por empresa (cada una en página nueva) ——
  for (const emp of datos.empresas || []) {
    doc.addPage();
    y = PAGE_TOP;
    const empNombre = emp.nombre || 'Empresa';

    y = drawEmpresaBand(doc, empNombre, y, false);

    // Totales empresa (compactos, una fila)
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN_X, right: MARGIN_X },
      head: [['Real', 'Obj', 'Desv c/IVA', 'Desv s/IVA', 'Incentivos', 'Base', 'Fondo', 'Total']],
      body: [[
        formatMonedaPdf(emp.totales?.realGross ?? 0),
        formatMonedaPdf(emp.totales?.objGross ?? 0),
        formatMonedaPdf(emp.totales?.desvGross ?? 0),
        formatMonedaPdf(emp.totales?.desvSinIva ?? 0),
        formatMonedaPdf(emp.totales?.incentivos ?? 0),
        formatMonedaPdf(emp.totales?.baseFondo ?? 0),
        formatMonedaPdf(emp.totales?.fondo ?? 0),
        formatMonedaPdf(totalPdf(
          emp.totales?.incentivos ?? 0,
          emp.totales?.fondo ?? 0,
          emp.totales?.total,
        )),
      ]],
      styles: { fontSize: 7, cellPadding: 1.4, halign: 'right' },
      headStyles: { fillColor: HEAD_FILL, textColor: 255, halign: 'right' },
      didParseCell: (data) => {
        didParseIncentivoCols([4, 6])(data);
        if (data.section === 'body' && data.column.index === 7) {
          data.cell.styles.fillColor = FILL_TOTAL;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.textColor = COLOR_TOTAL;
        }
        if (data.section === 'head' && data.column.index === 7) {
          data.cell.styles.fillColor = [22, 163, 74];
        }
      },
    });
    y = lastTableY(doc, y + 12) + 6;

    for (const loc of emp.locales || []) {
      const detalle = loc.incentivosDetalle || [];
      const needH = LOCAL_BLOCK_MIN_H + Math.min(detalle.length, 6) * 4;
      y = ensureY(doc, y, needH, () => drawEmpresaBand(doc, empNombre, PAGE_TOP, true));

      y = drawLocalTitle(doc, loc.localNombre || loc.localId, y);
      const colTitleY = y;
      const tablesStartY = y + 3;

      // —— Izquierda: BONUS COMÚN ——
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(15, 23, 42);
      doc.text('BONUS COMÚN', leftX, colTitleY);

      autoTable(doc, {
        startY: tablesStartY,
        margin: { ...leftMargin, bottom: 14 },
        head: [['Métrica', 'Valor']],
        body: [
          ['Real c/IVA', formatMonedaPdf(loc.realGross)],
          ['Obj c/IVA', formatMonedaPdf(loc.objGross)],
          ['Desv c/IVA', formatMonedaPdf(loc.desvGross)],
          ['Desv s/IVA', formatMonedaPdf(loc.desvSinIva)],
          ['Incentivos', formatMonedaPdf(loc.incentivosCampana)],
          ['Base fondo', formatMonedaPdf(loc.baseFondo)],
          ['% efectivo', formatPctPdf(loc.pctEfectivo)],
          ['Fondo', formatMonedaPdf(loc.fondo)],
          ['Total', formatMonedaPdf(totalPdf(loc.incentivosCampana, loc.fondo, loc.total))],
        ],
        styles: { fontSize: 7.5, cellPadding: 1.5 },
        headStyles: { fillColor: HEAD_FILL, textColor: 255 },
        columnStyles: {
          0: { cellWidth: colW * 0.45, fontStyle: 'bold' },
          1: { halign: 'right' },
        },
        didParseCell: (data) => {
          if (data.section !== 'body') return;
          const concepto = String(data.row.raw?.[0] ?? '');
          if (concepto === 'Incentivos' || concepto === 'Fondo') {
            if (data.column.index === 1) {
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.textColor = COLOR_INCENTIVO;
            }
          }
          if (concepto === 'Total') {
            data.cell.styles.fillColor = FILL_TOTAL;
            data.cell.styles.fontStyle = 'bold';
            if (data.column.index === 1) data.cell.styles.textColor = COLOR_TOTAL;
          }
        },
      });
      let leftY = lastTableY(doc, tablesStartY + 40) + 3;

      // Caja ámbar FONDO COMÚN
      const boxH = 10;
      const boxW = colW;
      doc.setFillColor(...FILL_AMBER);
      doc.setDrawColor(...FILL_AMBER_BORDER);
      doc.setLineWidth(0.3);
      doc.roundedRect(leftX, leftY, boxW, boxH, 1, 1, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(120, 53, 15);
      doc.text('FONDO COMÚN', leftX + 2.5, leftY + 6.5);
      doc.setFontSize(9);
      doc.text(formatMonedaPdf(loc.fondo), leftX + boxW - 2.5, leftY + 6.5, { align: 'right' });
      leftY += boxH + 2;

      // Caja verde TOTAL (incentivos + fondo)
      doc.setFillColor(...FILL_TOTAL);
      doc.setDrawColor(...FILL_TOTAL_BORDER);
      doc.setLineWidth(0.3);
      doc.roundedRect(leftX, leftY, boxW, boxH, 1, 1, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...COLOR_TOTAL);
      doc.text('TOTAL', leftX + 2.5, leftY + 6.5);
      doc.setFontSize(9);
      doc.text(
        formatMonedaPdf(totalPdf(loc.incentivosCampana, loc.fondo, loc.total)),
        leftX + boxW - 2.5,
        leftY + 6.5,
        { align: 'right' },
      );
      leftY += boxH + 2;

      // —— Derecha: BONUS POR EMPLEADO ——
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(15, 23, 42);
      doc.text('BONUS POR EMPLEADO', rightX, colTitleY);

      let rightY = tablesStartY;
      if (detalle.length === 0) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text('Sin incentivos de campaña', rightX, rightY + 5);
        rightY += 14;
      } else {
        // 1 fila por empleado (incl. Equipo): suma Uds e Importe; sin producto.
        const porEmpleado = new Map<string, { unidades: number; incentivoEur: number }>();
        for (const d of detalle) {
          const empleado = nombreEmpleado(d);
          const prev = porEmpleado.get(empleado) || { unidades: 0, incentivoEur: 0 };
          prev.unidades += Number(d.unidades) || 0;
          prev.incentivoEur = Math.round((prev.incentivoEur + (Number(d.incentivoEur) || 0)) * 100) / 100;
          porEmpleado.set(empleado, prev);
        }
        const bodyEmpleado = [...porEmpleado.entries()]
          .sort((a, b) => a[0].localeCompare(b[0], 'es'))
          .map(([empleado, agg]) => [
            empleado,
            udsCelda(agg.unidades),
            incentivoCelda(agg.incentivoEur),
          ]);
        autoTable(doc, {
          startY: rightY,
          margin: { ...rightMargin, bottom: 14 },
          head: [['Empleado', 'Uds', 'Importe']],
          body: bodyEmpleado,
          styles: { fontSize: 7, cellPadding: 1.4, overflow: 'linebreak' },
          headStyles: { fillColor: HEAD_FILL, textColor: 255 },
          columnStyles: {
            0: { cellWidth: colW * 0.5 },
            1: { halign: 'right', cellWidth: colW * 0.2 },
            2: { halign: 'right', cellWidth: colW * 0.3 },
          },
          didParseCell: didParseIncentivoCols([2]),
        });
        rightY = lastTableY(doc, rightY + 16) + 2;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(...COLOR_INCENTIVO);
        doc.text(
          `Subtotal: ${formatMonedaPdf(loc.incentivosCampana)}`,
          rightX + colW,
          rightY + 3,
          { align: 'right' },
        );
        rightY += 6;
      }

      y = Math.max(leftY, rightY) + COL_GAP + 2;
    }
  }

  // —— 4. Anexo nómina ——
  doc.addPage();
  y = PAGE_TOP;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text('Anexo nómina', MARGIN_X, y);
  y += 5;

  // Incentivos: 1 fila por empleado + empresa (suma; sin producto).
  // Fondo común: 1 fila por local al final (bolsa, no por persona).
  const incentivosAgg = new Map<string, { empleado: string; empresa: string; importe: number }>();
  const fondoRows: string[][] = [];
  for (const emp of datos.empresas || []) {
    const empresaNombre = emp.nombre || '';
    for (const loc of emp.locales || []) {
      for (const d of loc.incentivosDetalle || []) {
        const importe = Number(d.incentivoEur) || 0;
        if (Math.abs(importe) < 0.005) continue;
        const empleado = nombreEmpleado(d);
        const key = `${empleado}\u0001${empresaNombre}`;
        const prev = incentivosAgg.get(key);
        if (prev) prev.importe = Math.round((prev.importe + importe) * 100) / 100;
        else incentivosAgg.set(key, { empleado, empresa: empresaNombre, importe });
      }
      const fondo = Number(loc.fondo) || 0;
      if (fondo > 0.005) {
        fondoRows.push([
          `Fondo común · ${loc.localNombre || loc.localId}`,
          empresaNombre,
          formatMonedaPdf(fondo),
        ]);
      }
    }
  }

  const anexoBody = [
    ...[...incentivosAgg.values()]
      .sort((a, b) =>
        a.empresa.localeCompare(b.empresa, 'es') || a.empleado.localeCompare(b.empleado, 'es'),
      )
      .map((r) => [r.empleado, r.empresa, formatMonedaPdf(r.importe)]),
    ...fondoRows,
  ];

  if (anexoBody.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text('No hay líneas de nómina para este mes.', MARGIN_X, y);
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN_X, right: MARGIN_X, bottom: 14 },
      head: [['Empleado', 'Empresa', 'Importe']],
      body: anexoBody,
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: HEAD_FILL, textColor: 255 },
      columnStyles: {
        0: { cellWidth: 80 },
        1: { cellWidth: 'auto' },
        2: { halign: 'right', cellWidth: 36 },
      },
      didParseCell: didParseIncentivoCols([2]),
    });
  }

  // —— 5. Pie ——
  addPageFooters(doc, generado);
  return doc;
}
