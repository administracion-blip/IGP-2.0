/**
 * PDF de informe MIA (Motor Inteligente de Aprovisionamiento).
 * Un documento por almacén, con secciones por proveedor.
 * Columnas: producto / cantidad / unidad / importe.
 */
import type { jsPDF } from 'jspdf';
import { formatMoneda } from '../utils/formatMoneda';

export type MiaLineaPdf = {
  productId: string;
  nombre: string;
  cantidadPedida: number;
  unit: string;
  costeLinea: number;
  omitida?: boolean;
};

export type MiaGrupoProveedorPdf = {
  proveedorId: string;
  proveedorNombre: string;
  lineas: MiaLineaPdf[];
};

export type ParamsPdfMiaInforme = {
  warehouseId: string;
  warehouseNombre: string;
  fechaDesde: string;
  fechaHasta: string;
  informeId?: string;
  estado?: string;
  grupos: MiaGrupoProveedorPdf[];
  /** Incluir líneas omitidas (tachadas / marcadas). Por defecto no. */
  incluirOmitidas?: boolean;
};

export type PdfMiaInforme = {
  doc: jsPDF;
  filename: string;
};

type AutoTable = typeof import('jspdf-autotable').default;

function eurPdf(n: number): string {
  return `${formatMoneda(n, { sinSimbolo: true })} EUR`;
}

function formatFechaCorta(iso: string): string {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;
}

function ensureY(doc: jsPDF, y: number, needMm = 28): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y + needMm > pageH - 14) {
    doc.addPage();
    return 16;
  }
  return y;
}

function periodoLabel(desde: string, hasta: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(desde) ? formatFechaCorta(desde) : '—';
  const h = /^\d{4}-\d{2}-\d{2}$/.test(hasta) ? formatFechaCorta(hasta) : '—';
  if (d === '—' && h === '—') return 'Sin rango';
  return `${d} – ${h}`;
}

export function slugAlmacenPdf(nombre: string): string {
  const s = String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'sin-almacen';
}

function parteFechaArchivo(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

export function rangoFechasFilenameMia(desde: string, hasta: string): string {
  const d = parteFechaArchivo(desde);
  const h = parteFechaArchivo(hasta);
  if (d && h) return `${d}_${h}`;
  if (d) return `${d}_sin-hasta`;
  if (h) return `sin-desde_${h}`;
  return 'sin-fecha';
}

export function filenamePdfMiaInforme(
  warehouseNombre: string,
  fechaDesde: string,
  fechaHasta: string,
): string {
  return `mia_pedido_${slugAlmacenPdf(warehouseNombre)}_${rangoFechasFilenameMia(fechaDesde, fechaHasta)}.pdf`;
}

function qtyPdf(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('es-ES', { maximumFractionDigits: 3 });
}

function renderProveedor(
  doc: jsPDF,
  autoTable: AutoTable,
  g: MiaGrupoProveedorPdf,
  y: number,
): number {
  const lineas = g.lineas;
  const totalGrupo = lineas
    .filter((l) => !l.omitida)
    .reduce((s, l) => s + (Number.isFinite(l.costeLinea) ? l.costeLinea : 0), 0);
  const unidades = lineas
    .filter((l) => !l.omitida)
    .reduce((s, l) => s + (Number.isFinite(l.cantidadPedida) ? l.cantidadPedida : 0), 0);

  y = ensureY(doc, y, 32);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text(g.proveedorNombre || g.proveedorId || 'Proveedor', 14, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Id: ${g.proveedorId || '—'}  ·  Líneas: ${lineas.length}  ·  Ud.: ${qtyPdf(unidades)}  ·  Total: ${eurPdf(totalGrupo)}`,
    14,
    y,
  );
  y += 5;
  doc.setTextColor(0);

  autoTable(doc, {
    startY: y,
    head: [['Producto', 'Cantidad', 'Unidad', 'Importe']],
    body: lineas.length
      ? lineas.map((l) => {
          const omit = l.omitida === true;
          const nombre = omit ? `[omitida] ${l.nombre || l.productId}` : l.nombre || l.productId || '—';
          return [
            nombre,
            qtyPdf(l.cantidadPedida),
            l.unit || '—',
            omit ? '—' : eurPdf(l.costeLinea),
          ];
        })
      : [['—', 'Sin líneas', '—', '—']],
    styles: { fontSize: 8, cellPadding: 1.8 },
    headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    columnStyles: {
      1: { halign: 'right', cellWidth: 28 },
      2: { cellWidth: 24 },
      3: { halign: 'right', cellWidth: 32 },
    },
    margin: { left: 14, right: 14 },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const row = lineas[data.row.index];
      if (row?.omitida) {
        data.cell.styles.textColor = [148, 163, 184];
      }
    },
  });
  return lastTableY(doc, y) + 8;
}

/**
 * Genera un PDF del informe MIA para un almacén (secciones por proveedor).
 */
export async function generarPdfMiaInforme(params: ParamsPdfMiaInforme): Promise<PdfMiaInforme> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const incluirOmitidas = params.incluirOmitidas === true;
  const grupos = params.grupos
    .map((g) => ({
      ...g,
      lineas: (g.lineas || []).filter((l) => incluirOmitidas || !l.omitida),
    }))
    .filter((g) => g.lineas.length > 0)
    .sort((a, b) =>
      (a.proveedorNombre || a.proveedorId).localeCompare(b.proveedorNombre || b.proveedorId, 'es'),
    );

  const lineasActivas = grupos.flatMap((g) => g.lineas.filter((l) => !l.omitida));
  const costeTotal = lineasActivas.reduce(
    (s, l) => s + (Number.isFinite(l.costeLinea) ? l.costeLinea : 0),
    0,
  );
  const unidadesTotal = lineasActivas.reduce(
    (s, l) => s + (Number.isFinite(l.cantidadPedida) ? l.cantidadPedida : 0),
    0,
  );

  let y = 16;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text('MIA — Pedido de aprovisionamiento', 14, y);
  y += 7;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(params.warehouseNombre || `Almacén ${params.warehouseId}`, 14, y);
  y += 5.5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Almacén Id: ${params.warehouseId || '—'}`, 14, y);
  y += 4.5;
  doc.text(`Periodo objetivo: ${periodoLabel(params.fechaDesde, params.fechaHasta)}`, 14, y);
  y += 4.5;
  if (params.estado) {
    doc.text(`Estado: ${params.estado}`, 14, y);
    y += 4.5;
  }
  if (params.informeId) {
    doc.text(`Informe: ${params.informeId}`, 14, y);
    y += 4.5;
  }
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
  y += 6;
  doc.setTextColor(0);

  autoTable(doc, {
    startY: y,
    head: [['Proveedores', 'Líneas', 'Unidades', 'Coste total']],
    body: [[
      String(grupos.length),
      String(lineasActivas.length),
      qtyPdf(unidadesTotal),
      eurPdf(costeTotal),
    ]],
    styles: { fontSize: 8.5, cellPadding: 2.5, halign: 'center', valign: 'middle' },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontStyle: 'bold', textColor: [15, 23, 42] },
    columnStyles: {
      2: { halign: 'right' },
      3: { halign: 'right' },
    },
    margin: { left: 14, right: 14 },
  });
  y = lastTableY(doc, y) + 8;

  if (grupos.length === 0) {
    y = ensureY(doc, y, 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text('No hay líneas para incluir en el pedido.', 14, y);
  } else {
    for (const g of grupos) {
      y = renderProveedor(doc, autoTable, g, y);
    }
  }

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text(
      `Pág. ${i}/${pageCount} · MIA · ${params.warehouseNombre || params.warehouseId}`,
      14,
      doc.internal.pageSize.getHeight() - 8,
    );
  }

  return {
    doc,
    filename: filenamePdfMiaInforme(params.warehouseNombre, params.fechaDesde, params.fechaHasta),
  };
}
