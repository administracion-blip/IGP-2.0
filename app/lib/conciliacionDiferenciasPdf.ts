/**
 * PDF de incidencias de conciliación compras ↔ facturas (descuadre / dif. leve)
 * para revisión del jefe de economato. Un documento por empresa.
 */
import type { jsPDF } from 'jspdf';
import { formatMoneda } from '../utils/formatMoneda';
import { labelEstado } from '../utils/facturacion';

export type AlbaranPdfDif = {
  fechaIso: string;
  label: string;
  totalConIva: number;
  numDoc: string;
  vinculado: boolean;
};

export type FacturaPdfDif = {
  fechaIso: string;
  numero: string;
  numeroProveedor: string;
  total: number;
  estado: string;
  vinculada: boolean;
};

export type NodoPdfDiferencia = {
  nombre: string;
  cif: string;
  empresaCif: string;
  empresaNombre: string;
  estado: 'descuadre' | 'leve';
  estadoLabel: string;
  dif: number;
  totalAlbaranesBase: number;
  totalAlbaranesConIva: number;
  totalFacturasBase: number;
  totalFacturasTotal: number;
  albaranes: AlbaranPdfDif[];
  facturas: FacturaPdfDif[];
};

export type ParamsPdfConciliacionDiferencias = {
  nodos: NodoPdfDiferencia[];
  fechaDesde: string;
  fechaHasta: string;
  /** Texto opcional (empresa filtro, búsqueda) para trazabilidad en cabecera. */
  contextoFiltro?: string;
  /** Si se indica, cabecera fija de esa empresa (PDF de un solo grupo). */
  empresaFija?: { nombre: string; cif?: string };
};

export type PdfConciliacionPorEmpresa = {
  doc: jsPDF;
  empresaLabel: string;
  filename: string;
};

type AutoTable = typeof import('jspdf-autotable').default;

/** Helvetica no pinta bien €; usar número + " EUR" ASCII. */
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
  if (d === '—' && h === '—') return 'Sin filtro de fechas';
  return `${d} – ${h}`;
}

/** Slug para nombre de fichero (patrón similar a pdfExcepcionesFileSlug). */
export function slugEmpresaPdf(nombre: string): string {
  const s = String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'sin-empresa';
}

function parteFechaArchivo(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

/** Fragmento de fechas del nombre de fichero. */
export function rangoFechasFilename(desde: string, hasta: string): string {
  const d = parteFechaArchivo(desde);
  const h = parteFechaArchivo(hasta);
  if (d && h) return `${d}_${h}`;
  if (d) return `${d}_sin-hasta`;
  if (h) return `sin-desde_${h}`;
  return 'sin-fecha';
}

export function filenamePdfConciliacionEmpresa(
  empresaLabel: string,
  fechaDesde: string,
  fechaHasta: string,
): string {
  return `conciliacion_diferencias_${slugEmpresaPdf(empresaLabel)}_${rangoFechasFilename(fechaDesde, fechaHasta)}.pdf`;
}

/** Agrupa nodos por empresa (CIF) y ordena proveedores por |dif| desc. */
export function agruparPorEmpresa(
  nodos: NodoPdfDiferencia[],
): { empresaKey: string; empresaLabel: string; empresaCif: string; nodos: NodoPdfDiferencia[] }[] {
  const map = new Map<string, { empresaLabel: string; empresaCif: string; nodos: NodoPdfDiferencia[] }>();
  for (const n of nodos) {
    const key = n.empresaCif ? `cif:${n.empresaCif}` : 'sin';
    const label = n.empresaNombre || (n.empresaCif ? n.empresaCif : 'Sin empresa');
    let g = map.get(key);
    if (!g) {
      g = { empresaLabel: label, empresaCif: n.empresaCif || '', nodos: [] };
      map.set(key, g);
    }
    g.nodos.push(n);
  }
  const grupos = Array.from(map.entries()).map(([empresaKey, g]) => ({
    empresaKey,
    empresaLabel: g.empresaLabel,
    empresaCif: g.empresaCif,
    nodos: g.nodos.sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif) || a.nombre.localeCompare(b.nombre, 'es')),
  }));
  grupos.sort((a, b) => {
    if (a.empresaKey === 'sin') return 1;
    if (b.empresaKey === 'sin') return -1;
    return a.empresaLabel.localeCompare(b.empresaLabel, 'es');
  });
  return grupos;
}

function renderProveedor(
  doc: jsPDF,
  autoTable: AutoTable,
  p: NodoPdfDiferencia,
  y: number,
): number {
  y = ensureY(doc, y, 36);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text(p.nombre || 'Proveedor sin identificar', 14, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`CIF: ${p.cif || '—'}  ·  ${p.estadoLabel}  ·  Dif: ${eurPdf(p.dif)}`, 14, y);
  y += 4.5;
  doc.text(
    `Alb c/IVA: ${eurPdf(p.totalAlbaranesConIva)}  ·  Fact total: ${eurPdf(p.totalFacturasTotal)}  ·  Bases alb/fact: ${eurPdf(p.totalAlbaranesBase)} / ${eurPdf(p.totalFacturasBase)}`,
    14,
    y,
  );
  y += 5;
  doc.setTextColor(0);

  y = ensureY(doc, y, 24);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text('Albaranes', 14, y);
  y += 2;
  autoTable(doc, {
    startY: y,
    head: [['Fecha', 'Nº / label', 'Total c/IVA', 'Nº doc. prov.', 'Vinc.']],
    body: p.albaranes.length
      ? p.albaranes.map((a) => [
          formatFechaCorta(a.fechaIso),
          a.label || '—',
          eurPdf(a.totalConIva),
          a.numDoc || '—',
          a.vinculado ? 'Sí' : 'No',
        ])
      : [['—', 'Sin albaranes', '—', '—', '—']],
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
    columnStyles: {
      0: { cellWidth: 22 },
      2: { halign: 'right', cellWidth: 32 },
      3: { cellWidth: 28 },
      4: { cellWidth: 14, halign: 'center' },
    },
    margin: { left: 14, right: 14 },
  });
  y = lastTableY(doc, y) + 4;

  y = ensureY(doc, y, 24);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text('Facturas', 14, y);
  y += 2;
  autoTable(doc, {
    startY: y,
    head: [['Fecha', 'Nº', 'Nº proveedor', 'Total', 'Estado', 'Vinc.']],
    body: p.facturas.length
      ? p.facturas.map((f) => [
          formatFechaCorta(f.fechaIso),
          f.numero || '—',
          f.numeroProveedor || '—',
          eurPdf(f.total),
          labelEstado(f.estado),
          f.vinculada ? 'Sí' : 'No',
        ])
      : [['—', 'Sin facturas', '—', '—', '—', '—']],
    styles: { fontSize: 7.5, cellPadding: 1.5 },
    headStyles: { fillColor: [71, 85, 105], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
    columnStyles: {
      0: { cellWidth: 22 },
      3: { halign: 'right', cellWidth: 30 },
      5: { cellWidth: 14, halign: 'center' },
    },
    margin: { left: 14, right: 14 },
  });
  return lastTableY(doc, y) + 8;
}

export async function generarPdfConciliacionDiferencias(
  params: ParamsPdfConciliacionDiferencias,
): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const nProv = params.nodos.length;
  const sumaAbsDif = params.nodos.reduce((s, n) => s + Math.abs(n.dif), 0);
  const totalAlb = params.nodos.reduce((s, n) => s + n.totalAlbaranesConIva, 0);
  const totalFact = params.nodos.reduce((s, n) => s + n.totalFacturasTotal, 0);
  const difNeta = totalAlb - totalFact;

  let y = 16;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text('Conciliación compras — Diferencias', 14, y);
  y += 7;

  if (params.empresaFija) {
    const empNombre = params.empresaFija.nombre || 'Sin empresa';
    const empCif = params.empresaFija.cif?.trim();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text(empCif ? `${empNombre}  ·  CIF ${empCif}` : empNombre, 14, y);
    y += 5.5;
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`Periodo: ${periodoLabel(params.fechaDesde, params.fechaHasta)}`, 14, y);
  y += 4.5;
  if (params.contextoFiltro?.trim()) {
    doc.text(`Filtros: ${params.contextoFiltro.trim()}`, 14, y);
    y += 4.5;
  }
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
  y += 6;
  doc.setTextColor(0);

  const kpiHead = nProv > 1
    ? ['Proveedores', 'Albaranes (c/IVA)', 'Facturas', 'Dif. neta', 'Suma |dif|']
    : ['Proveedores', 'Albaranes (c/IVA)', 'Facturas', 'Dif. neta'];
  const kpiBody = nProv > 1
    ? [[String(nProv), eurPdf(totalAlb), eurPdf(totalFact), eurPdf(difNeta), eurPdf(sumaAbsDif)]]
    : [[String(nProv), eurPdf(totalAlb), eurPdf(totalFact), eurPdf(difNeta)]];
  const difNetaCol = 3;

  autoTable(doc, {
    startY: y,
    head: [kpiHead],
    body: kpiBody,
    styles: { fontSize: 8.5, cellPadding: 2.5, halign: 'center', valign: 'middle' },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontStyle: 'bold', textColor: [15, 23, 42] },
    columnStyles: {
      0: { cellWidth: nProv > 1 ? 24 : 28 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      ...(nProv > 1 ? { 4: { halign: 'right' as const } } : {}),
    },
    margin: { left: 14, right: 14 },
    didParseCell: (data) => {
      if (data.section !== 'body' || data.column.index !== difNetaCol) return;
      if (Math.abs(difNeta) > 0.005) {
        data.cell.styles.textColor = [185, 28, 28];
      }
    },
  });
  y = lastTableY(doc, y) + 8;

  // Con empresa fija: un solo grupo → solo detalle de proveedores (sin banda de empresa).
  if (params.empresaFija) {
    for (const p of params.nodos) {
      y = renderProveedor(doc, autoTable, p, y);
    }
  } else {
    const grupos = agruparPorEmpresa(params.nodos);
    for (const g of grupos) {
      y = ensureY(doc, y, 20);
      doc.setFillColor(241, 245, 249);
      doc.rect(14, y - 4, doc.internal.pageSize.getWidth() - 28, 8, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      const empCif = g.empresaCif || g.nodos[0]?.empresaCif;
      doc.text(empCif ? `${g.empresaLabel}  (${empCif})` : g.empresaLabel, 16, y + 1);
      y += 10;

      for (const p of g.nodos) {
        y = renderProveedor(doc, autoTable, p, y);
      }
    }
  }

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    const pieEmp = params.empresaFija?.nombre ? ` · ${params.empresaFija.nombre}` : '';
    doc.text(
      `Pág. ${i}/${pageCount} · Conciliación compras — Diferencias${pieEmp}`,
      14,
      doc.internal.pageSize.getHeight() - 8,
    );
  }

  return doc;
}

/**
 * Genera un PDF por empresa con nodos de diferencias.
 * Omite grupos sin nodos. No genera documentos vacíos.
 */
export async function generarPdfsConciliacionDiferenciasPorEmpresa(
  params: ParamsPdfConciliacionDiferencias,
): Promise<PdfConciliacionPorEmpresa[]> {
  const grupos = agruparPorEmpresa(params.nodos).filter((g) => g.nodos.length > 0);
  const out: PdfConciliacionPorEmpresa[] = [];
  for (const g of grupos) {
    const doc = await generarPdfConciliacionDiferencias({
      ...params,
      nodos: g.nodos,
      empresaFija: { nombre: g.empresaLabel, cif: g.empresaCif || undefined },
    });
    out.push({
      doc,
      empresaLabel: g.empresaLabel,
      filename: filenamePdfConciliacionEmpresa(g.empresaLabel, params.fechaDesde, params.fechaHasta),
    });
  }
  return out;
}
