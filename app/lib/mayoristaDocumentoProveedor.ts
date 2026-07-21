import { formatEur } from './mayoristaCalculos';
import { formatFecha } from '../utils/formatFecha';

export type LineaDocumentoProveedor = {
  producto: string;
  cantidad: number;
  pvp: string;
};

export type DocumentoProveedorData = {
  cliente: string;
  referencia: string;
  fecha: string;
  recogidaEn: string;
  fechaRecogida: string;
  horaRecogida: string;
  lineas: LineaDocumentoProveedor[];
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
};

export function buildDocumentoProveedorData(
  neg: NegCabecera | null | undefined,
  lineas: LineaNeg[],
): DocumentoProveedorData {
  return {
    cliente: neg?.cliente_nombre?.trim() || '—',
    referencia: neg?.nombre?.trim() || '—',
    fecha: formatFecha(neg?.fecha),
    recogidaEn: neg?.recogida_empresa_nombre?.trim() || '—',
    fechaRecogida: formatFecha(neg?.recogida_fecha),
    horaRecogida: neg?.recogida_hora?.trim() || '—',
    lineas: lineas.map((l) => ({
      producto: l.product_name || l.producto_id || '—',
      cantidad: Number(l.cantidad) || 0,
      pvp: formatEur(l.pvp_unitario, 2),
    })),
  };
}

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
    head: [['Producto', 'Cant.', 'PVP']],
    body: data.lineas.length
      ? data.lineas.map((l) => [l.producto, String(l.cantidad), l.pvp])
      : [['—', '—', '—']],
    styles: { fontSize: 10, cellPadding: 3 },
    headStyles: { fillColor: [248, 250, 252], textColor: [71, 85, 105], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 22, halign: 'center' },
      2: { cellWidth: 32, halign: 'right' },
    },
    margin: { left: 14, right: 14 },
  });

  doc.save(filename);
}
