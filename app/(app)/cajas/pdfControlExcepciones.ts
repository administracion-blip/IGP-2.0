/**
 * Generador de PDF para Control de Excepciones (Cajas).
 * Reutiliza el patrón de pdf en `objetivos.tsx`: cabecera + KPIs + tabla con jsPDF/autoTable.
 */

import { applyMotivoPdfCellStyle, formatMotivoLabel } from './motivoBadges';
import { consumoPdfLabel, isConsumoCustomer } from './excepcionesConsumo';

export type PdfExcepcionesOpts = {
  incluirConsumo?: boolean;
};

type jsPDF = import('jspdf').jsPDF;

export type ExceptionType = 'invitacion' | 'promocion' | 'descuento' | 'anulacion' | 'consumo';

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
  CustomerId?: number | string | null;
  CustomerName?: string | null;
};

function clienteLabel(r: ExceptionRowPdf): string {
  if (isConsumoCustomer(r.CustomerId, r.CustomerName)) return 'CONSUMO';
  return r.CustomerName ?? (r.CustomerId != null ? `#${r.CustomerId}` : '—');
}

function motivoConConsumo(r: ExceptionRowPdf): string {
  const base = formatMotivoLabel(r.Reason, r.DiscountRate);
  return isConsumoCustomer(r.CustomerId, r.CustomerName) ? `${base} · CONSUMO` : base;
}

const TYPE_LABEL: Record<ExceptionType, string> = {
  invitacion: 'Invitación',
  promocion: 'Promoción',
  descuento: 'Descuento manual',
  anulacion: 'Anulación',
  consumo: 'Consumo',
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
    promocion: { count: 0, total: 0 },
    descuento: { count: 0, total: 0 },
    anulacion: { count: 0, total: 0 },
    consumo: { count: 0, total: 0 },
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
    clienteLabel(r).slice(0, 18),
    motivoConConsumo(r).slice(0, 40),
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
    `Promociones: ${formatMoneda(kpis.promocion.total)} (${kpis.promocion.count})    ·    ` +
    `Descuentos: ${formatMoneda(kpis.descuento.total)} (${kpis.descuento.count})    ·    ` +
    `Anulaciones: ${formatMoneda(kpis.anulacion.total)} (${kpis.anulacion.count})    ·    ` +
    `Consumo: ${formatMoneda(kpis.consumo.total)} (${kpis.consumo.count})    ·    ` +
    `Total filas: ${filas.length}`;
  doc.text(kpiLine, 14, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  // Colores para la columna Tipo
  const colorInvitacion: [number, number, number] = [5, 150, 105];
  const colorPromocion: [number, number, number] = [91, 33, 182];
  const colorDescuento: [number, number, number] = [180, 83, 9];
  const colorAnulacion: [number, number, number] = [185, 28, 28];
  const colorConsumo: [number, number, number] = [14, 116, 144];

  autoTable(doc, {
    startY: y,
    head: [[
      'Tipo', 'Fecha', 'Hora', 'POS', 'Doc', 'Nº', 'Usuario',
      'Producto', 'Cant.', 'Importe', 'Cliente', 'Motivo',
    ]],
    body,
    theme: 'striped',
    styles: { fontSize: 7, cellPadding: 1.2, overflow: 'linebreak' },
    headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
    margin: { left: 10, right: 10 },
    tableWidth: pageW - 20,
    columnStyles: {
      0: { cellWidth: 22, fontStyle: 'bold' },
      1: { cellWidth: 16 },
      2: { cellWidth: 11 },
      3: { cellWidth: 16 },
      4: { cellWidth: 12 },
      5: { cellWidth: 16 },
      6: { cellWidth: 26 },
      7: { cellWidth: 44 },
      8: { cellWidth: 11, halign: 'right' },
      9: { cellWidth: 20, halign: 'right' },
      10: { cellWidth: 24 },
      11: { cellWidth: 38 },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 0) {
        const tipo = filas[data.row.index]?.Type;
        if (tipo === 'invitacion') data.cell.styles.textColor = colorInvitacion;
        else if (tipo === 'promocion') data.cell.styles.textColor = colorPromocion;
        else if (tipo === 'descuento') data.cell.styles.textColor = colorDescuento;
        else if (tipo === 'anulacion') data.cell.styles.textColor = colorAnulacion;
        else if (tipo === 'consumo') data.cell.styles.textColor = colorConsumo;
      }
      if (data.section === 'body' && data.column.index === 9) {
        const tipo = filas[data.row.index]?.Type;
        if (tipo === 'anulacion') data.cell.styles.textColor = colorAnulacion;
      }
      if (data.section === 'body' && data.column.index === 10) {
        const row = filas[data.row.index];
        if (row && isConsumoCustomer(row.CustomerId, row.CustomerName)) {
          data.cell.styles.fillColor = [224, 242, 254];
          data.cell.styles.textColor = [3, 105, 161];
          data.cell.styles.fontStyle = 'bold';
        }
      }
      if (data.section === 'body' && data.column.index === 11) {
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
  promocion: { count: number; quantity: number; amount: number };
  descuento: { count: number; quantity: number; amount: number };
  anulacion: { count: number; quantity: number; amount: number };
  consumo: { count: number; quantity: number; amount: number };
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
        promocion: { count: 0, quantity: 0, amount: 0 },
        descuento: { count: 0, quantity: 0, amount: 0 },
        anulacion: { count: 0, quantity: 0, amount: 0 },
        consumo: { count: 0, quantity: 0, amount: 0 },
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
    promocion: { count: 0, total: 0 },
    descuento: { count: 0, total: 0 },
    anulacion: { count: 0, total: 0 },
    consumo: { count: 0, total: 0 },
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
    `Promociones: ${formatMoneda(kpis.promocion.total)} (${kpis.promocion.count})    ·    ` +
    `Descuentos: ${formatMoneda(kpis.descuento.total)} (${kpis.descuento.count})    ·    ` +
    `Anulaciones: ${formatMoneda(kpis.anulacion.total)} (${kpis.anulacion.count})    ·    ` +
    `Consumo: ${formatMoneda(kpis.consumo.total)} (${kpis.consumo.count})    ·    ` +
    `Usuarios: ${grupos.length}    ·    Filas: ${filas.length}`;
  doc.text(kpiLine, 14, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  const colorInvitacion: [number, number, number] = [5, 150, 105];
  const colorPromocion: [number, number, number] = [91, 33, 182];
  const colorDescuento: [number, number, number] = [180, 83, 9];
  const colorAnulacion: [number, number, number] = [185, 28, 28];
  const colorConsumo: [number, number, number] = [14, 116, 144];

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

    const resumenInv = { count: 0, quantity: 0, amount: 0 };
    const resumenPromo = { count: 0, amount: 0 };
    const resumenDesc = { count: 0, amount: 0 };
    const resumenAnul = { count: 0, amount: 0 };
    const resumenCons = { count: 0, amount: 0 };
    let resumenTotalNeto = 0;

    const resumenBody = grupos.map((g) => {
      resumenInv.count += g.invitacion.count;
      resumenInv.quantity += g.invitacion.quantity;
      resumenInv.amount += g.invitacion.amount;
      resumenPromo.count += g.promocion.count;
      resumenPromo.amount += g.promocion.amount;
      resumenDesc.count += g.descuento.count;
      resumenDesc.amount += g.descuento.amount;
      resumenAnul.count += g.anulacion.count;
      resumenAnul.amount += g.anulacion.amount;
      resumenCons.count += g.consumo.count;
      resumenCons.amount += g.consumo.amount;
      resumenTotalNeto += g.totalAmount;
      return [
        g.userName,
        g.invitacion.count > 0
          ? `${g.invitacion.count} reg · ${g.invitacion.quantity} ud · ${formatMoneda(g.invitacion.amount)}`
          : '—',
        g.promocion.count > 0
          ? `${g.promocion.count} reg · ${formatMoneda(g.promocion.amount)}`
          : '—',
        g.descuento.count > 0
          ? `${g.descuento.count} reg · ${formatMoneda(g.descuento.amount)}`
          : '—',
        g.anulacion.count > 0
          ? `${g.anulacion.count} reg · ${formatMoneda(g.anulacion.amount)}`
          : '—',
        g.consumo.count > 0
          ? `${g.consumo.count} reg · ${formatMoneda(g.consumo.amount)}`
          : '—',
        formatMoneda(g.totalAmount),
      ];
    });

    resumenBody.push([
      'TOTAL',
      resumenInv.count > 0
        ? `${resumenInv.count} reg · ${resumenInv.quantity} ud · ${formatMoneda(resumenInv.amount)}`
        : '—',
      resumenPromo.count > 0
        ? `${resumenPromo.count} reg · ${formatMoneda(resumenPromo.amount)}`
        : '—',
      resumenDesc.count > 0
        ? `${resumenDesc.count} reg · ${formatMoneda(resumenDesc.amount)}`
        : '—',
      resumenAnul.count > 0
        ? `${resumenAnul.count} reg · ${formatMoneda(resumenAnul.amount)}`
        : '—',
      resumenCons.count > 0
        ? `${resumenCons.count} reg · ${formatMoneda(resumenCons.amount)}`
        : '—',
      formatMoneda(resumenTotalNeto),
    ]);

    const totalRowIdx = resumenBody.length - 1;
    const totalColIdx = 6;

    autoTable(doc, {
      startY: y,
      head: [[
        'Usuario', 'Invitaciones', 'Promociones', 'Descuentos', 'Anulaciones', 'Consumo', 'Total neto',
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
        0: { cellWidth: 44, fontStyle: 'bold' },
        1: { cellWidth: 46, halign: 'right' },
        2: { cellWidth: 38, halign: 'right' },
        3: { cellWidth: 38, halign: 'right' },
        4: { cellWidth: 38, halign: 'right' },
        5: { cellWidth: 38, halign: 'right' },
        6: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index === totalRowIdx) {
          data.cell.styles.fillColor = pastelBlueTotal;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.textColor = [3, 105, 161];
        }
        if (data.section === 'body' && data.column.index === totalColIdx && data.row.index !== totalRowIdx) {
          const amt = grupos[data.row.index]?.totalAmount ?? 0;
          if (amt < 0) data.cell.styles.textColor = colorAnulacion;
        }
        if (data.section === 'body' && data.column.index === totalColIdx && data.row.index === totalRowIdx) {
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
      `Promo: ${g.promocion.count} · ${formatMoneda(g.promocion.amount)}    ·    ` +
      `Desc: ${g.descuento.count} · ${formatMoneda(g.descuento.amount)}    ·    ` +
      `Anul: ${g.anulacion.count} · ${formatMoneda(g.anulacion.amount)}    ·    ` +
      `Cons: ${g.consumo.count} · ${formatMoneda(g.consumo.amount)}    ·    ` +
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
      clienteLabel(r).slice(0, 16),
      motivoConConsumo(r).slice(0, 34),
    ]);

    autoTable(doc, {
      startY: y,
      head: [[
        'Tipo', 'Fecha', 'Hora', 'Local', 'POS', 'Doc', 'Nº',
        'Producto', 'Cant.', 'Importe', 'Cliente', 'Motivo',
      ]],
      body,
      theme: 'striped',
      styles: { fontSize: 7, cellPadding: 1, overflow: 'linebreak' },
      headStyles: { fillColor: [203, 213, 225], textColor: 30, fontStyle: 'bold' },
      margin: { left: 10, right: 10 },
      tableWidth: pageW - 20,
      columnStyles: {
        0: { cellWidth: 22, fontStyle: 'bold' },
        1: { cellWidth: 16 },
        2: { cellWidth: 11 },
        3: { cellWidth: 22 },
        4: { cellWidth: 16 },
        5: { cellWidth: 12 },
        6: { cellWidth: 16 },
        7: { cellWidth: 42 },
        8: { cellWidth: 11, halign: 'right' },
        9: { cellWidth: 18, halign: 'right' },
        10: { cellWidth: 22 },
        11: { cellWidth: 34 },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 0) {
          const tipo = g.rows[data.row.index]?.Type;
          if (tipo === 'invitacion') data.cell.styles.textColor = colorInvitacion;
          else if (tipo === 'promocion') data.cell.styles.textColor = colorPromocion;
          else if (tipo === 'descuento') data.cell.styles.textColor = colorDescuento;
          else if (tipo === 'anulacion') data.cell.styles.textColor = colorAnulacion;
          else if (tipo === 'consumo') data.cell.styles.textColor = colorConsumo;
        }
        if (data.section === 'body' && data.column.index === 9) {
          const tipo = g.rows[data.row.index]?.Type;
          if (tipo === 'anulacion') data.cell.styles.textColor = colorAnulacion;
        }
        if (data.section === 'body' && data.column.index === 10) {
          const row = g.rows[data.row.index];
          if (row && isConsumoCustomer(row.CustomerId, row.CustomerName)) {
            data.cell.styles.fillColor = [224, 242, 254];
            data.cell.styles.textColor = [3, 105, 161];
            data.cell.styles.fontStyle = 'bold';
          }
        }
        if (data.section === 'body' && data.column.index === 11) {
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

// ===== PDF resumen por local + Top 10 de usuarios por tipo =====

type ResumenLocalAcc = {
  workplaceId: string;
  nombre: string;
  invitacion: { count: number; amount: number };
  promocion: { count: number; amount: number };
  descuento: { count: number; amount: number };
  anulacion: { count: number; amount: number };
  consumo: { count: number; amount: number };
  totalAmount: number;
};

type TopUsuarioAcc = {
  userKey: string;
  userName: string;
  count: number;
  amount: number;
};

type CategoriaTipo = Exclude<ExceptionType, never>;

const CATEGORIAS_RESUMEN: ReadonlyArray<{
  tipo: CategoriaTipo;
  label: string;
  color: [number, number, number];
}> = [
  { tipo: 'invitacion', label: 'Invitaciones', color: [5, 150, 105] },
  { tipo: 'promocion', label: 'Promociones', color: [91, 33, 182] },
  { tipo: 'descuento', label: 'Descuentos manuales', color: [180, 83, 9] },
  { tipo: 'anulacion', label: 'Anulaciones', color: [185, 28, 28] },
  { tipo: 'consumo', label: 'Consumo', color: [14, 116, 144] },
];

export type PdfResumenLocalesOpts = PdfExcepcionesOpts & {
  /** Mapa código Ágora → nombre legible. Si no se pasa, se usa WorkplaceName/WorkplaceId. */
  nombrePorLocal?: Record<string, string>;
};

/**
 * Genera un PDF vertical (A4) con:
 *  - Resumen por local (alfabético, solo locales con registros).
 *  - Top 10 de usuarios por importe para cada tipo de excepción.
 */
export async function generarPdfResumenLocales(
  filas: ExceptionRowPdf[],
  titulo: string,
  fechaDesde: string,
  fechaHasta: string,
  opts: PdfResumenLocalesOpts = {},
): Promise<jsPDF> {
  const nombrePorLocal = opts.nombrePorLocal ?? {};

  // ----- Agregación por local -----
  const localesMap = new Map<string, ResumenLocalAcc>();
  for (const r of filas) {
    const id = String(r.WorkplaceId ?? '').trim();
    const key = id || '__sin_local__';
    let g = localesMap.get(key);
    if (!g) {
      const nombre =
        nombrePorLocal[id] ?? r.WorkplaceName ?? (id || 'Sin local');
      g = {
        workplaceId: key,
        nombre,
        invitacion: { count: 0, amount: 0 },
        promocion: { count: 0, amount: 0 },
        descuento: { count: 0, amount: 0 },
        anulacion: { count: 0, amount: 0 },
        consumo: { count: 0, amount: 0 },
        totalAmount: 0,
      };
      localesMap.set(key, g);
    }
    const bucket = g[r.Type];
    if (bucket) {
      bucket.count += 1;
      bucket.amount += Number(r.Amount) || 0;
    }
    g.totalAmount += Number(r.Amount) || 0;
  }
  const locales = Array.from(localesMap.values())
    .filter((g) =>
      g.invitacion.count + g.promocion.count + g.descuento.count +
      g.anulacion.count + g.consumo.count > 0,
    )
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));

  // ----- Agregación Top 10 usuarios por tipo -----
  const topPorTipo: Record<CategoriaTipo, TopUsuarioAcc[]> = {
    invitacion: [],
    promocion: [],
    descuento: [],
    anulacion: [],
    consumo: [],
  };
  for (const { tipo } of CATEGORIAS_RESUMEN) {
    const usuariosMap = new Map<string, TopUsuarioAcc>();
    for (const r of filas) {
      if (r.Type !== tipo) continue;
      const id = r.UserId != null ? String(r.UserId) : (r.UserName ?? '').trim();
      const key = id || '__sin_usuario__';
      let u = usuariosMap.get(key);
      if (!u) {
        u = {
          userKey: key,
          userName: r.UserName ?? (r.UserId != null ? `#${r.UserId}` : 'Sin usuario'),
          count: 0,
          amount: 0,
        };
        usuariosMap.set(key, u);
      }
      u.count += 1;
      u.amount += Number(r.Amount) || 0;
    }
    topPorTipo[tipo] = Array.from(usuariosMap.values())
      .sort((a, b) => b.amount - a.amount || b.count - a.count)
      .slice(0, 10);
  }

  // ----- KPIs globales -----
  const kpis = {
    invitacion: { count: 0, total: 0 },
    promocion: { count: 0, total: 0 },
    descuento: { count: 0, total: 0 },
    anulacion: { count: 0, total: 0 },
    consumo: { count: 0, total: 0 },
  };
  for (const r of filas) {
    if (kpis[r.Type]) {
      kpis[r.Type].count += 1;
      kpis[r.Type].total += Number(r.Amount) || 0;
    }
  }

  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 12;
  const contentW = pageW - marginX * 2;
  let y = 14;

  // ----- Cabecera -----
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Control de Excepciones — Resumen', marginX, y);
  y += 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  doc.text(String(titulo), marginX, y);
  y += 5;
  doc.text(`Periodo: ${formatBusinessDayLabel(fechaDesde)} → ${formatBusinessDayLabel(fechaHasta)}`, marginX, y);
  y += 4;
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, marginX, y);
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(3, 105, 161);
  doc.text(consumoPdfLabel(Boolean(opts.incluirConsumo)), marginX, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  // KPI line global
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  const kpiLine =
    `Invitaciones: ${formatMoneda(kpis.invitacion.total)} (${kpis.invitacion.count})    ·    ` +
    `Promociones: ${formatMoneda(kpis.promocion.total)} (${kpis.promocion.count})    ·    ` +
    `Descuentos: ${formatMoneda(kpis.descuento.total)} (${kpis.descuento.count})    ·    ` +
    `Anulaciones: ${formatMoneda(kpis.anulacion.total)} (${kpis.anulacion.count})    ·    ` +
    `Consumo: ${formatMoneda(kpis.consumo.total)} (${kpis.consumo.count})    ·    ` +
    `Locales: ${locales.length}    ·    Filas: ${filas.length}`;
  const kpiLines = doc.splitTextToSize(kpiLine, contentW);
  doc.text(kpiLines, marginX, y);
  y += kpiLines.length * 4 + 4;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);

  // ----- Tabla resumen por local -----
  const pastelBlueHead: [number, number, number] = [186, 230, 253];
  const pastelBlueBody: [number, number, number] = [224, 242, 254];
  const pastelBlueAlt: [number, number, number] = [240, 249, 255];
  const pastelBlueTotal: [number, number, number] = [147, 197, 253];
  const pastelBlueBorder: [number, number, number] = [125, 211, 252];

  if (locales.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(120);
    doc.text('Sin registros en el rango consultado.', marginX, y);
    return doc;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(3, 105, 161);
  doc.text('Resumen por local (alfabético)', marginX, y);
  y += 5;
  doc.setTextColor(0);

  const totales = {
    invitacion: { count: 0, amount: 0 },
    promocion: { count: 0, amount: 0 },
    descuento: { count: 0, amount: 0 },
    anulacion: { count: 0, amount: 0 },
    consumo: { count: 0, amount: 0 },
    totalAmount: 0,
  };
  const localesBody = locales.map((g) => {
    totales.invitacion.count += g.invitacion.count;
    totales.invitacion.amount += g.invitacion.amount;
    totales.promocion.count += g.promocion.count;
    totales.promocion.amount += g.promocion.amount;
    totales.descuento.count += g.descuento.count;
    totales.descuento.amount += g.descuento.amount;
    totales.anulacion.count += g.anulacion.count;
    totales.anulacion.amount += g.anulacion.amount;
    totales.consumo.count += g.consumo.count;
    totales.consumo.amount += g.consumo.amount;
    totales.totalAmount += g.totalAmount;
    return [
      g.nombre,
      g.invitacion.count > 0 ? `${g.invitacion.count} · ${formatMoneda(g.invitacion.amount)}` : '—',
      g.promocion.count > 0 ? `${g.promocion.count} · ${formatMoneda(g.promocion.amount)}` : '—',
      g.descuento.count > 0 ? `${g.descuento.count} · ${formatMoneda(g.descuento.amount)}` : '—',
      g.anulacion.count > 0 ? `${g.anulacion.count} · ${formatMoneda(g.anulacion.amount)}` : '—',
      g.consumo.count > 0 ? `${g.consumo.count} · ${formatMoneda(g.consumo.amount)}` : '—',
      formatMoneda(g.totalAmount),
    ];
  });
  localesBody.push([
    'TOTAL',
    totales.invitacion.count > 0 ? `${totales.invitacion.count} · ${formatMoneda(totales.invitacion.amount)}` : '—',
    totales.promocion.count > 0 ? `${totales.promocion.count} · ${formatMoneda(totales.promocion.amount)}` : '—',
    totales.descuento.count > 0 ? `${totales.descuento.count} · ${formatMoneda(totales.descuento.amount)}` : '—',
    totales.anulacion.count > 0 ? `${totales.anulacion.count} · ${formatMoneda(totales.anulacion.amount)}` : '—',
    totales.consumo.count > 0 ? `${totales.consumo.count} · ${formatMoneda(totales.consumo.amount)}` : '—',
    formatMoneda(totales.totalAmount),
  ]);
  const totalRowIdx = localesBody.length - 1;
  const colorAnulacionRgb: [number, number, number] = [185, 28, 28];

  autoTable(doc, {
    startY: y,
    head: [[
      'Local', 'Invitaciones', 'Promociones', 'Descuentos', 'Anulaciones', 'Consumo', 'Total neto',
    ]],
    body: localesBody,
    theme: 'plain',
    styles: {
      fontSize: 8,
      cellPadding: 1.6,
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
    margin: { left: marginX, right: marginX },
    tableWidth: contentW,
    columnStyles: {
      0: { cellWidth: 44, fontStyle: 'bold' },
      1: { cellWidth: 24, halign: 'right' },
      2: { cellWidth: 24, halign: 'right' },
      3: { cellWidth: 24, halign: 'right' },
      4: { cellWidth: 24, halign: 'right' },
      5: { cellWidth: 24, halign: 'right' },
      6: { cellWidth: contentW - 44 - 24 * 5, halign: 'right', fontStyle: 'bold' },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.row.index === totalRowIdx) {
        data.cell.styles.fillColor = pastelBlueTotal;
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.textColor = [3, 105, 161];
      }
      if (data.section === 'body' && data.column.index === 6) {
        const amt = data.row.index === totalRowIdx
          ? totales.totalAmount
          : locales[data.row.index]?.totalAmount ?? 0;
        if (amt < 0) data.cell.styles.textColor = colorAnulacionRgb;
      }
    },
  });

  const resumenLastY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
  y = resumenLastY + 10;

  // ----- Top 10 usuarios por tipo -----
  for (const { tipo, label, color } of CATEGORIAS_RESUMEN) {
    const top = topPorTipo[tipo];
    if (!top || top.length === 0) continue;

    // Estimación: cabecera (~6mm) + título (~5mm) + filas (~5mm cada una) + margen.
    const neededH = 6 + 5 + (top.length + 1) * 5 + 6;
    if (y + neededH > pageH - 12) {
      doc.addPage();
      y = 14;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(color[0], color[1], color[2]);
    doc.text(`Top 10 usuarios — ${label}`, marginX, y);
    y += 5;
    doc.setTextColor(0);

    const totalImporteTop = top.reduce((s, u) => s + u.amount, 0);
    const totalRegTop = top.reduce((s, u) => s + u.count, 0);
    const topBody = top.map((u, i) => [
      String(i + 1),
      u.userName,
      String(u.count),
      formatMoneda(u.amount),
    ]);
    topBody.push(['', 'TOTAL Top 10', String(totalRegTop), formatMoneda(totalImporteTop)]);
    const topTotalIdx = topBody.length - 1;

    autoTable(doc, {
      startY: y,
      head: [['#', 'Usuario', 'Nº reg.', 'Importe']],
      body: topBody,
      theme: 'plain',
      styles: {
        fontSize: 8,
        cellPadding: 1.4,
        fillColor: [255, 255, 255],
        textColor: [15, 23, 42],
        lineColor: [226, 232, 240],
        lineWidth: 0.2,
        overflow: 'linebreak',
      },
      headStyles: {
        fillColor: color,
        textColor: 255,
        fontStyle: 'bold',
        halign: 'center',
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: marginX, right: marginX },
      tableWidth: contentW,
      columnStyles: {
        0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' },
        1: { cellWidth: contentW - 10 - 24 - 36 },
        2: { cellWidth: 24, halign: 'right' },
        3: { cellWidth: 36, halign: 'right', fontStyle: 'bold' },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index === topTotalIdx) {
          data.cell.styles.fillColor = [241, 245, 249];
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.textColor = [color[0], color[1], color[2]];
        }
        if (data.section === 'body' && data.column.index === 3 && data.row.index !== topTotalIdx) {
          data.cell.styles.textColor = [color[0], color[1], color[2]];
        }
      },
    });

    const lastY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
    y = lastY + 8;
  }

  return doc;
}
