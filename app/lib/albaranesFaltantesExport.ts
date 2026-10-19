/**
 * Exportación del informe «Albaranes que faltan» (Excel y PDF).
 * Mismo patrón que la conciliación: XLSX (web descarga / nativo comparte) y
 * jsPDF + autotable con bloques por sociedad y proveedor.
 */
import { Platform } from 'react-native';
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { jsPDF } from 'jspdf';
import { formatMoneda } from '../utils/formatMoneda';
import {
  type FilaInformeAF,
  agruparFilasInforme,
  estadoLabelFila,
  ubicacionAgoraLabel,
} from './albaranesFaltantes';
import { formatFecha } from '../utils/formatFecha';

export type ContextoInformeAF = {
  desde: string;
  hasta: string;
  sociedadLabel: string;
  estadoLabel: string;
};

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function rangoLabel(desde: string, hasta: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(desde) ? formatFecha(desde) : '—';
  const h = /^\d{4}-\d{2}-\d{2}$/.test(hasta) ? formatFecha(hasta) : '—';
  if (d === '—' && h === '—') return 'Sin filtro de fechas';
  return `${d} – ${h}`;
}

function sufijoFichero(desde: string, hasta: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(desde) ? desde : 'sin-desde';
  const h = /^\d{4}-\d{2}-\d{2}$/.test(hasta) ? hasta : 'sin-hasta';
  return `${d}_${h}`;
}

export async function exportarExcelAlbaranesFaltantes(filas: FilaInformeAF[], ctx: ContextoInformeAF): Promise<void> {
  const rows: (string | number)[][] = [[
    'Sociedad', 'Proveedor', 'CIF proveedor', 'Nº doc. prov.', 'Fecha albarán', 'Importe',
    'Nº factura', 'Fecha factura', 'Nota', 'Estado', 'Ubicación en Ágora',
  ]];
  for (const f of filas) {
    rows.push([
      f.sociedadNombre,
      f.proveedorNombre,
      f.proveedorCif,
      f.numeroDoc,
      f.fechaAlbaran ? formatFecha(f.fechaAlbaran) : '',
      f.importe ?? '',
      f.facturaNumero,
      f.facturaFecha ? formatFecha(f.facturaFecha) : '',
      f.nota,
      estadoLabelFila(f),
      ubicacionAgoraLabel(f),
    ]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Albaranes que faltan');
  const fname = `albaranes_que_faltan_${sufijoFichero(ctx.desde, ctx.hasta)}.xlsx`;
  if (Platform.OS === 'web') {
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: MIME_XLSX });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  const fileUri = `${FileSystemLegacy.cacheDirectory ?? ''}${fname}`;
  await FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 });
  await Sharing.shareAsync(fileUri, { mimeType: MIME_XLSX, dialogTitle: fname });
}

/** Helvetica no pinta bien €; usar número + " EUR" ASCII. */
function eurPdf(n: number | null): string {
  if (n == null) return '—';
  return `${formatMoneda(n, { sinSimbolo: true })} EUR`;
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;
}

function ensureY(doc: jsPDF, y: number, needMm: number): number {
  if (y + needMm > doc.internal.pageSize.getHeight() - 14) {
    doc.addPage();
    return 16;
  }
  return y;
}

export async function generarPdfAlbaranesFaltantes(filas: FilaInformeAF[], ctx: ContextoInformeAF): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  // Horizontal: 8 columnas con nota y estado no caben cómodas en vertical.
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();

  let y = 16;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text('Albaranes que faltan', 14, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('Albaranes citados en factura que no están en Ágora', 14, y);
  y += 4.5;
  doc.text(`Fechas de factura: ${rangoLabel(ctx.desde, ctx.hasta)}`, 14, y);
  y += 4.5;
  doc.text(`Sociedad: ${ctx.sociedadLabel}  ·  Estado: ${ctx.estadoLabel}  ·  ${filas.length} albarán(es)`, 14, y);
  y += 4.5;
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
  y += 8;
  doc.setTextColor(0);

  for (const soc of agruparFilasInforme(filas)) {
    y = ensureY(doc, y, 30);
    doc.setFillColor(241, 245, 249);
    doc.rect(14, y - 4, pageW - 28, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text(soc.cif ? `${soc.nombre}  (${soc.cif})` : soc.nombre, 16, y + 1);
    y += 10;

    for (const prov of soc.proveedores) {
      y = ensureY(doc, y, 24);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(30, 41, 59);
      const n = prov.filas.length;
      doc.text(
        `${prov.nombre}${prov.cif ? `  ·  CIF ${prov.cif}` : ''}  ·  ${n} albarán${n !== 1 ? 'es' : ''}`,
        14,
        y,
      );
      y += 2;
      autoTable(doc, {
        startY: y,
        head: [['Nº doc. prov.', 'Fecha albarán', 'Importe', 'Nº factura', 'Fecha factura', 'Nota', 'Estado', 'Ubicación en Ágora']],
        body: prov.filas.map((f) => [
          f.numeroDoc || '—',
          f.fechaAlbaran ? formatFecha(f.fechaAlbaran) : '—',
          eurPdf(f.importe),
          f.facturaNumero || '—',
          f.facturaFecha ? formatFecha(f.facturaFecha) : '—',
          f.nota || '',
          estadoLabelFila(f),
          ubicacionAgoraLabel(f),
        ]),
        styles: { fontSize: 8, cellPadding: 1.6, overflow: 'linebreak' },
        headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        columnStyles: {
          0: { cellWidth: 30, fontStyle: 'bold' },
          1: { cellWidth: 22 },
          2: { cellWidth: 26, halign: 'right' },
          3: { cellWidth: 28 },
          4: { cellWidth: 22 },
          6: { cellWidth: 40 },
          7: { cellWidth: 44 },
        },
        margin: { left: 14, right: 14 },
      });
      y = lastTableY(doc, y) + 6;
    }
    y += 2;
  }

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text(`Pág. ${i}/${pageCount} · Albaranes que faltan`, 14, doc.internal.pageSize.getHeight() - 8);
  }
  return doc;
}

export async function exportarPdfAlbaranesFaltantes(filas: FilaInformeAF[], ctx: ContextoInformeAF): Promise<void> {
  const doc = await generarPdfAlbaranesFaltantes(filas, ctx);
  const filename = `albaranes_que_faltan_${sufijoFichero(ctx.desde, ctx.hasta)}.pdf`;
  if (Platform.OS === 'web') {
    doc.save(filename);
    return;
  }
  const base64 = doc.output('datauristring').split(',')[1] || '';
  const fileUri = `${FileSystemLegacy.cacheDirectory ?? ''}${filename}`;
  await FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 });
  await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: filename });
}
