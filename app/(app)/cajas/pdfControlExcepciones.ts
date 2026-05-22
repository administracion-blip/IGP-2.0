/**
 * Generador de PDF para Control de Excepciones (Cajas).
 * Reutiliza el patrón de pdf en `objetivos.tsx`: cabecera + KPIs + tabla con jsPDF/autoTable.
 */

import { applyMotivoPdfCellStyle, formatMotivoLabel } from './motivoBadges';
import { consumoPdfLabel } from './excepcionesConsumo';

export type PdfExcepcionesOpts = {
  incluirConsumo?: boolean;
};

type jsPDF = import('jspdf').jsPDF;

export type ExceptionType = 'invitacion' | 'descuento' | 'anulacion';

export type ExceptionRowPdf = {
  Type: ExceptionType;
  WorkplaceId: string;
  WorkplaceName: string | null;
  PosId: number | string | null;
  PosName: string | null;
  BusinessDay: string;
  DateTime: string;
  DocumentType: string;
  TicketNumber: string;
  InvoiceNumber: string;
  UserId: number | string | null;
  UserName: string | null;
  Amount: number;
  Quantity: number | null;
  ProductName: string | null;
  Reason: string | null;
  DiscountRate: number | null;
};

const TYPE_LABEL: Record<ExceptionType, string> = {
  invitacion: 'Invitación',
  descuento: 'Descuento manual',
  anulacion: 'Anulación',
};

function formatMoneda(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const parts = value.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

function formatBusinessDayLabel(iso: string): string {
  if (!iso || typeof iso !== 'string') return '—';
  const parts = iso.trim().split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatHora(iso: string): string {
  if (!iso) return '—';
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const m2 = String(iso).match(/(\d{2}):(\d{2})(:\d{2})?/);
  if (m2) return `${m2[1]}:${m2[2]}`;
  return '—';
}

export function pdfExcepcionesFileSlug(nombre: string): string {
  return String(nombre || 'sin-nombre')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'sin-nombre';
}

/**
 * Genera un PDF con la tabla de excepciones para el rango/local indicado.
 * El llamador se encarga de guardar/compartir (en web `doc.save()`, en nativo
 * volcar a base64 y compartir con expo-sharing).
 */
export async function generarPdfExcepciones(
  filas: ExceptionRowPdf[],
  titulo: string,
  fechaDesde: string,
  fechaHasta: string,
  opts: PdfExcepcionesOpts = {},
): Promise<jsPDF> {
  const kpis = {
    invitacion: { count: 0, total: 0 },
    descuento: { count: 0, total: 0 },
    anulacion: { count: 0, total: 0 },
  };
  for (const r of filas) {
    if (kpis[r.Type]) {
      kpis[r.Type].count += 1;
      kpis[r.Type].total += Number(r.Amount) || 0;
    }
  }

  const body = filas.map((r) => [
    TYPE_LABEL[r.Type] ?? r.Type,
    formatBusinessDayLabel(r.BusinessDay),
    formatHora(r.DateTime),
    r.PosName ?? (r.PosId != null ? String(r.PosId) : ''),
    r.DocumentType ?? '',
    r.TicketNumber || r.InvoiceNumber || '',
    String(r.UserName ?? (r.UserId != null ? `#${r.UserId}` : '')).slice(0, 28),
    String(r.ProductName ?? '').slice(0, 36),
    r.Quantity != null ? String(r.Quantity) : '',
    formatMoneda(Number(r.Amount) || 0),
    formatMotivoLabel(r.Reason, r.DiscountRate).slice(0, 36),
  ]);

  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  let y = 12;

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Control de Excepciones — Cajas', 14, y);
  y += 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  doc.text(String(titulo), 14, y);
  y += 5;
  doc.text(`Periodo: ${formatBusinessDayLabel(fechaDesde)} → ${formatBusinessDayLabel(fechaHasta)}`, 14, y);
  y += 4;
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(3, 105, 161);
  doc.text(consumoPdfLabel(Boolean(opts.incluirConsumo)), 14, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  // KPIs
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  const kpiLine =
    `Invitaciones: ${formatMoneda(kpis.invitacion.total)} (${kpis.invitacion.count})    ·    ` +
    `Descuentos: ${formatMoneda(kpis.descuento.total)} (${kpis.descuento.count})    ·    ` +
    `Anulaciones: ${formatMoneda(kpis.anulacion.total)} (${kpis.anulacion.count})    ·    ` +
    `Total filas: ${filas.length}`;
  doc.text(kpiLine, 14, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  // Colores para la columna Tipo
  const colorInvitacion: [number, number, number] = [5, 150, 105];
  const colorDescuento: [number, number, number] = [180, 83, 9];
  const colorAnulacion: [number, number, number] = [185, 28, 28];

  autoTable(doc, {
    startY: y,
    head: [[
      'Tipo', 'Fecha', 'Hora', 'POS', 'Doc', 'Nº', 'Usuario',
      'Producto', 'Cant.', 'Importe', 'Motivo',
    ]],
    body,
    theme: 'striped',
    styles: { fontSize: 7, cellPadding: 1.2, overflow: 'linebreak' },
    headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
    margin: { left: 10, right: 10 },
    tableWidth: pageW - 20,
    columnStyles: {
      0: { cellWidth: 24, fontStyle: 'bold' },
      1: { cellWidth: 18 },
      2: { cellWidth: 12 },
      3: { cellWidth: 18 },
      4: { cellWidth: 14 },
      5: { cellWidth: 18 },
      6: { cellWidth: 30 },
      7: { cellWidth: 50 },
      8: { cellWidth: 12, halign: 'right' },
      9: { cellWidth: 22, halign: 'right' },
      10: { cellWidth: 40 },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 0) {
        const tipo = filas[data.row.index]?.Type;
        if (tipo === 'invitacion') data.cell.styles.textColor = colorInvitacion;
        else if (tipo === 'descuento') data.cell.styles.textColor = colorDescuento;
        else if (tipo === 'anulacion') data.cell.styles.textColor = colorAnulacion;
      }
      if (data.section === 'body' && data.column.index === 9) {
        const tipo = filas[data.row.index]?.Type;
        if (tipo === 'anulacion') data.cell.styles.textColor = colorAnulacion;
      }
      if (data.section === 'body' && data.column.index === 10) {
        applyMotivoPdfCellStyle(
          data.cell.styles as Record<string, unknown>,
          filas[data.row.index]?.Reason,
        );
      }
    },
  });

  return doc;
}

type GrupoUsuarioPdf = {
  userKey: string;
  userName: string;
  invitacion: { count: number; quantity: number; amount: number };
  descuento: { count: number; quantity: number; amount: number };
  anulacion: { count: number; quantity: number; amount: number };
  totalAmount: number;
  rows: ExceptionRowPdf[];
};

function agruparPorUsuario(filas: ExceptionRowPdf[]): GrupoUsuarioPdf[] {
  const map = new Map<string, GrupoUsuarioPdf>();
  for (const r of filas) {
    const id = r.UserId != null ? String(r.UserId) : (r.UserName ?? '').trim();
    const key = id || '__sin_usuario__';
    let g = map.get(key);
    if (!g) {
      g = {
        userKey: key,
        userName: r.UserName ?? (r.UserId != null ? `#${r.UserId}` : 'Sin usuario'),
        invitacion: { count: 0, quantity: 0, amount: 0 },
        descuento: { count: 0, quantity: 0, amount: 0 },
        anulacion: { count: 0, quantity: 0, amount: 0 },
        totalAmount: 0,
        rows: [],
      };
      map.set(key, g);
    }
    const bucket = g[r.Type];
    if (bucket) {
      bucket.count += 1;
      bucket.quantity += Number(r.Quantity) || 0;
      bucket.amount += Number(r.Amount) || 0;
    }
    g.totalAmount += Number(r.Amount) || 0;
    g.rows.push(r);
  }
  return Array.from(map.values()).sort((a, b) => a.userName.localeCompare(b.userName, 'es'));
}

/**
 * Variante agrupada: cada usuario aparece con su cabecera-subtotal y debajo la tabla con
 * sus registros (visibles, no colapsados). Salto de página automático entre grupos.
 */
export async function generarPdfExcepcionesAgrupado(
  filas: ExceptionRowPdf[],
  titulo: string,
  fechaDesde: string,
  fechaHasta: string,
  opts: PdfExcepcionesOpts = {},
): Promise<jsPDF> {
  const grupos = agruparPorUsuario(filas);

  // KPIs globales
  const kpis = {
    invitacion: { count: 0, total: 0 },
    descuento: { count: 0, total: 0 },
    anulacion: { count: 0, total: 0 },
  };
  for (const r of filas) {
    if (kpis[r.Type]) {
      kpis[r.Type].count += 1;
      kpis[r.Type].total += Number(r.Amount) || 0;
    }
  }

  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  let y = 12;

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Control de Excepciones — Cajas (agrupado por usuario)', 14, y);
  y += 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  doc.text(String(titulo), 14, y);
  y += 5;
  doc.text(`Periodo: ${formatBusinessDayLabel(fechaDesde)} → ${formatBusinessDayLabel(fechaHasta)}`, 14, y);
  y += 4;
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(3, 105, 161);
  doc.text(consumoPdfLabel(Boolean(opts.incluirConsumo)), 14, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  const kpiLine =
    `Invitaciones: ${formatMoneda(kpis.invitacion.total)} (${kpis.invitacion.count})    ·    ` +
    `Descuentos: ${formatMoneda(kpis.descuento.total)} (${kpis.descuento.count})    ·    ` +
    `Anulaciones: ${formatMoneda(kpis.anulacion.total)} (${kpis.anulacion.count})    ·    ` +
    `Usuarios: ${grupos.length}    ·    Filas: ${filas.length}`;
  doc.text(kpiLine, 14, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  const colorInvitacion: [number, number, number] = [5, 150, 105];
  const colorDescuento: [number, number, number] = [180, 83, 9];
  const colorAnulacion: [number, number, number] = [185, 28, 28];

  // --- Cuadro resumen por usuario (azul pastel) antes del detalle ---
  const pastelBlueHead: [number, number, number] = [186, 230, 253];
  const pastelBlueBody: [number, number, number] = [224, 242, 254];
  const pastelBlueAlt: [number, number, number] = [240, 249, 255];
  const pastelBlueTotal: [number, number, number] = [147, 197, 253];
  const pastelBlueBorder: [number, number, number] = [125, 211, 252];

  if (grupos.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(3, 105, 161);
    doc.text('Resumen por usuario', 14, y);
    y += 5;
    doc.setTextColor(0);

    const resumenInv = {
      count: 0, quantity: 0, amount: 0,
    };
    const resumenDesc = { count: 0, amount: 0 };
    const resumenAnul = { count: 0, amount: 0 };
    let resumenTotalNeto = 0;

    const resumenBody = grupos.map((g) => {
      resumenInv.count += g.invitacion.count;
      resumenInv.quantity += g.invitacion.quantity;
      resumenInv.amount += g.invitacion.amount;
      resumenDesc.count += g.descuento.count;
      resumenDesc.amount += g.descuento.amount;
      resumenAnul.count += g.anulacion.count;
      resumenAnul.amount += g.anulacion.amount;
      resumenTotalNeto += g.totalAmount;
      return [
        g.userName,
        g.invitacion.count > 0
          ? `${g.invitacion.count} reg · ${g.invitacion.quantity} ud · ${formatMoneda(g.invitacion.amount)}`
          : '—',
        g.descuento.count > 0
          ? `${g.descuento.count} reg · ${formatMoneda(g.descuento.amount)}`
          : '—',
        g.anulacion.count > 0
          ? `${g.anulacion.count} reg · ${formatMoneda(g.anulacion.amount)}`
          : '—',
        formatMoneda(g.totalAmount),
      ];
    });

    resumenBody.push([
      'TOTAL',
      resumenInv.count > 0
        ? `${resumenInv.count} reg · ${resumenInv.quantity} ud · ${formatMoneda(resumenInv.amount)}`
        : '—',
      resumenDesc.count > 0
        ? `${resumenDesc.count} reg · ${formatMoneda(resumenDesc.amount)}`
        : '—',
      resumenAnul.count > 0
        ? `${resumenAnul.count} reg · ${formatMoneda(resumenAnul.amount)}`
        : '—',
      formatMoneda(resumenTotalNeto),
    ]);

    const totalRowIdx = resumenBody.length - 1;

    autoTable(doc, {
      startY: y,
      head: [[
        'Usuario', 'Invitaciones', 'Descuentos', 'Anulaciones', 'Total neto',
      ]],
      body: resumenBody,
      theme: 'plain',
      styles: {
        fontSize: 8,
        cellPadding: 2,
        fillColor: pastelBlueBody,
        textColor: [15, 23, 42],
        lineColor: pastelBlueBorder,
        lineWidth: 0.25,
        overflow: 'linebreak',
      },
      headStyles: {
        fillColor: pastelBlueHead,
        textColor: [3, 105, 161],
        fontStyle: 'bold',
        halign: 'center',
      },
      alternateRowStyles: { fillColor: pastelBlueAlt },
      margin: { left: 10, right: 10 },
      tableWidth: pageW - 20,
      columnStyles: {
        0: { cellWidth: 52, fontStyle: 'bold' },
        1: { cellWidth: 58, halign: 'right' },
        2: { cellWidth: 48, halign: 'right' },
        3: { cellWidth: 48, halign: 'right' },
        4: { cellWidth: 32, halign: 'right', fontStyle: 'bold' },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index === totalRowIdx) {
          data.cell.styles.fillColor = pastelBlueTotal;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.textColor = [3, 105, 161];
        }
        if (data.section === 'body' && data.column.index === 4 && data.row.index !== totalRowIdx) {
          const amt = grupos[data.row.index]?.totalAmount ?? 0;
          if (amt < 0) data.cell.styles.textColor = colorAnulacion;
        }
        if (data.section === 'body' && data.column.index === 4 && data.row.index === totalRowIdx) {
          if (resumenTotalNeto < 0) data.cell.styles.textColor = colorAnulacion;
        }
      },
    });

    const resumenLastY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
    y = resumenLastY + 10;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(3, 105, 161);
    doc.text('Detalle por usuario', 14, y);
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0);
  }

  for (const g of grupos) {
    // Salto de página si quedan menos de ~40mm libres antes de la cabecera del grupo
    if (y > pageH - 40) {
      doc.addPage();
      y = 12;
    }

    // Cabecera del usuario (resumen)
    doc.setFillColor(241, 245, 249);
    doc.setDrawColor(226, 232, 240);
    doc.rect(10, y, pageW - 20, 8, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(g.userName, 12, y + 5.4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    const resumen =
      `Inv: ${g.invitacion.count} (${g.invitacion.quantity} ud · ${formatMoneda(g.invitacion.amount)})    ·    ` +
      `Desc: ${g.descuento.count} · ${formatMoneda(g.descuento.amount)}    ·    ` +
      `Anul: ${g.anulacion.count} · ${formatMoneda(g.anulacion.amount)}    ·    ` +
      `Total: ${formatMoneda(g.totalAmount)}`;
    doc.text(resumen, pageW - 12, y + 5.4, { align: 'right' });
    y += 9;

    const body = g.rows.map((r) => [
      TYPE_LABEL[r.Type] ?? r.Type,
      formatBusinessDayLabel(r.BusinessDay),
      formatHora(r.DateTime),
      r.WorkplaceName ?? r.WorkplaceId ?? '',
      r.PosName ?? (r.PosId != null ? String(r.PosId) : ''),
      r.DocumentType ?? '',
      r.TicketNumber || r.InvoiceNumber || '',
      String(r.ProductName ?? '').slice(0, 40),
      r.Quantity != null ? String(r.Quantity) : '',
      formatMoneda(Number(r.Amount) || 0),
      formatMotivoLabel(r.Reason, r.DiscountRate).slice(0, 36),
    ]);

    autoTable(doc, {
      startY: y,
      head: [[
        'Tipo', 'Fecha', 'Hora', 'Local', 'POS', 'Doc', 'Nº',
        'Producto', 'Cant.', 'Importe', 'Motivo',
      ]],
      body,
      theme: 'striped',
      styles: { fontSize: 7, cellPadding: 1, overflow: 'linebreak' },
      headStyles: { fillColor: [203, 213, 225], textColor: 30, fontStyle: 'bold' },
      margin: { left: 10, right: 10 },
      tableWidth: pageW - 20,
      columnStyles: {
        0: { cellWidth: 22, fontStyle: 'bold' },
        1: { cellWidth: 18 },
        2: { cellWidth: 12 },
        3: { cellWidth: 24 },
        4: { cellWidth: 18 },
        5: { cellWidth: 14 },
        6: { cellWidth: 18 },
        7: { cellWidth: 48 },
        8: { cellWidth: 12, halign: 'right' },
        9: { cellWidth: 20, halign: 'right' },
        10: { cellWidth: 38 },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 0) {
          const tipo = g.rows[data.row.index]?.Type;
          if (tipo === 'invitacion') data.cell.styles.textColor = colorInvitacion;
          else if (tipo === 'descuento') data.cell.styles.textColor = colorDescuento;
          else if (tipo === 'anulacion') data.cell.styles.textColor = colorAnulacion;
        }
        if (data.section === 'body' && data.column.index === 9) {
          const tipo = g.rows[data.row.index]?.Type;
          if (tipo === 'anulacion') data.cell.styles.textColor = colorAnulacion;
        }
        if (data.section === 'body' && data.column.index === 10) {
          applyMotivoPdfCellStyle(
            data.cell.styles as Record<string, unknown>,
            g.rows[data.row.index]?.Reason,
          );
        }
      },
    });

    // Avanzar y a la posición tras la tabla
    const lastY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
    y = lastY + 6;
  }

  return doc;
}
