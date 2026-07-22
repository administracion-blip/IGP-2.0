import { formatEur, round2 } from './mayoristaCalculos';
import { formatFecha } from '../utils/formatFecha';

export type LineaDocumentoProveedor = {
  producto: string;
  cantidad: number;
  pvp: string;
  iva: string;
  total: string;
  totalNum: number;
  ivaImporte: string;
  ivaImporteNum: number;
  totalConIva: string;
  totalConIvaNum: number;
};

export type DocumentoProveedorData = {
  cliente: string;
  referencia: string;
  fecha: string;
  recogidaEn: string;
  fechaRecogida: string;
  horaRecogida: string;
  lineas: LineaDocumentoProveedor[];
  subtotal: string;
  subtotalNum: number;
  subtotalIvaImporte: string;
  subtotalIvaImporteNum: number;
  subtotalConIva: string;
  subtotalConIvaNum: number;
};

type NegCabecera = {
  cliente_nombre?: string;
  nombre?: string;
  fecha?: string;
  recogida_empresa_nombre?: string;
  recogida_fecha?: string;
  recogida_hora?: string;
};

type LineaNeg = {
  product_name?: string;
  producto_id?: string;
  cantidad?: number;
  pvp_unitario?: number;
  ultimo_iva_compra?: number | null;
};

function formatIvaPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return `${s}%`;
}

function ivaPctNum(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(Number(v))) return 0;
  return Math.max(0, Number(v));
}

export function buildDocumentoProveedorData(
  neg: NegCabecera | null | undefined,
  lineas: LineaNeg[],
): DocumentoProveedorData {
  const lineasDoc = lineas.map((l) => {
    const cantidad = Number(l.cantidad) || 0;
    const pvpNum = Number(l.pvp_unitario) || 0;
    const totalNum = round2(cantidad * pvpNum);
    const pct = ivaPctNum(l.ultimo_iva_compra);
    const ivaImporteNum = pct > 0 ? round2(totalNum * (pct / 100)) : 0;
    const totalConIvaNum = round2(totalNum + ivaImporteNum);
    return {
      producto: l.product_name || l.producto_id || '—',
      cantidad,
      pvp: formatEur(pvpNum, 2),
      iva: formatIvaPct(l.ultimo_iva_compra),
      total: formatEur(totalNum, 2),
      totalNum,
      ivaImporte: pct > 0 ? formatEur(ivaImporteNum, 2) : '—',
      ivaImporteNum,
      totalConIva: formatEur(totalConIvaNum, 2),
      totalConIvaNum,
    };
  });
  const subtotalNum = round2(lineasDoc.reduce((s, l) => s + l.totalNum, 0));
  const subtotalIvaImporteNum = round2(lineasDoc.reduce((s, l) => s + l.ivaImporteNum, 0));
  const subtotalConIvaNum = round2(lineasDoc.reduce((s, l) => s + l.totalConIvaNum, 0));
  return {
    cliente: neg?.cliente_nombre?.trim() || '—',
    referencia: neg?.nombre?.trim() || '—',
    fecha: formatFecha(neg?.fecha),
    recogidaEn: neg?.recogida_empresa_nombre?.trim() || '—',
    fechaRecogida: formatFecha(neg?.recogida_fecha),
    horaRecogida: neg?.recogida_hora?.trim() || '—',
    lineas: lineasDoc,
    subtotal: formatEur(subtotalNum, 2),
    subtotalNum,
    subtotalIvaImporte: formatEur(subtotalIvaImporteNum, 2),
    subtotalIvaImporteNum,
    subtotalConIva: formatEur(subtotalConIvaNum, 2),
    subtotalConIvaNum,
  };
}

const PDF_AZUL = [14, 165, 233] as [number, number, number];

export async function descargarPdfDocumentoProveedor(
  data: DocumentoProveedorData,
  filename = 'pedido-proveedor.pdf',
) {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  let y = 16;

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text('Pedido para proveedor', 14, y);
  y += 9;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);

  const infoRows: [string, string][] = [
    ['Cliente', data.cliente],
    ['Referencia', data.referencia],
    ['Fecha', data.fecha],
  ];
  for (const [label, value] of infoRows) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, 14, y);
    doc.setFont('helvetica', 'normal');
    doc.text(value, 42, y);
    y += 6;
  }

  y += 2;
  const boxY = y;
  const boxH = 22;
  doc.setFillColor(255, 251, 235);
  doc.setDrawColor(252, 211, 77);
  doc.roundedRect(14, boxY, pageW - 28, boxH, 2, 2, 'FD');

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(180, 83, 9);
  doc.text('DATOS DE RECOGIDA', 18, boxY + 6);

  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  const recogidaRows: [string, string][] = [
    ['Recogida en', data.recogidaEn],
    ['Fecha recogida', data.fechaRecogida],
    ['Hora', data.horaRecogida],
  ];
  let ry = boxY + 11;
  for (const [label, value] of recogidaRows) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, 18, ry);
    doc.setFont('helvetica', 'normal');
    doc.text(value, 52, ry);
    ry += 5;
  }

  y = boxY + boxH + 8;

  autoTable(doc, {
    startY: y,
    head: [['Producto', 'Cant.', 'PVP', 'IVA', 'Total', 'Imp. IVA', 'Total c/IVA']],
    body: data.lineas.length
      ? data.lineas.map((l) => [
        l.producto,
        String(l.cantidad),
        l.pvp,
        l.iva,
        l.total,
        l.ivaImporte,
        l.totalConIva,
      ])
      : [['—', '—', '—', '—', '—', '—', '—']],
    foot: [
      ['', '', '', 'Subtotal', data.subtotal, data.subtotalIvaImporte, data.subtotalConIva],
    ],
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [248, 250, 252], textColor: [71, 85, 105], fontStyle: 'bold', fontSize: 8 },
    footStyles: {
      fillColor: [248, 250, 252],
      textColor: [15, 23, 42],
      fontStyle: 'bold',
      fontSize: 9,
    },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 14, halign: 'center' },
      2: { cellWidth: 22, halign: 'right' },
      3: { cellWidth: 14, halign: 'center' },
      4: { cellWidth: 24, halign: 'right', fontStyle: 'bold' },
      5: { cellWidth: 22, halign: 'right', textColor: PDF_AZUL },
      6: { cellWidth: 26, halign: 'right', textColor: PDF_AZUL, fontStyle: 'bold' },
    },
    didParseCell: (hookData) => {
      if (hookData.section === 'body') {
        if (hookData.column.index === 4) hookData.cell.styles.fontStyle = 'bold';
        if (hookData.column.index === 5 || hookData.column.index === 6) {
          hookData.cell.styles.textColor = PDF_AZUL;
          if (hookData.column.index === 6) hookData.cell.styles.fontStyle = 'bold';
        }
      }
      if (hookData.section === 'foot') {
        if (hookData.column.index === 5 || hookData.column.index === 6) {
          hookData.cell.styles.textColor = PDF_AZUL;
          hookData.cell.styles.fontStyle = 'bold';
        }
      }
    },
    margin: { left: 14, right: 14 },
    showFoot: 'lastPage',
  });

  doc.save(filename);
}
