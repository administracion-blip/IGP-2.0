/**
 * PDF de informe de campaña de incentivos por producto.
 */

import type { Campana, ResultadosCampana } from '../types/incentivosProducto';
import { etiquetaDestinatario, etiquetaTipoIncentivo, formatValorIncentivoDisplay } from './incentivosProducto';

type jsPDF = import('jspdf').jsPDF;

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

export function pdfIncentivosCampanaFileSlug(campana: Campana): string {
  const slug = String(campana.nombre || 'campana')
    .replace(/\s+/g, '_')
    .replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]/g, '')
    .slice(0, 30);
  return `incentivos_${slug}_${String(campana.campanaId).slice(0, 8)}`;
}

export async function generarPdfIncentivosCampana(
  campana: Campana,
  resultados: ResultadosCampana,
  opts: { localesMap?: Map<string, string> } = {},
): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const marginX = 12;
  let y = 14;

  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.text('Incentivos por producto', marginX, y);
  y += 7;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(40);
  doc.text(String(campana.nombre || 'Campaña'), marginX, y);
  y += 5;
  doc.text(`Estado: ${campana.estado}`, marginX, y);
  y += 5;
  doc.text(
    `Periodo: ${formatFechaPdf(campana.fechaInicio)} — ${formatFechaPdf(campana.fechaFin)}`,
    marginX,
    y,
  );
  y += 5;
  doc.text(
    `${etiquetaTipoIncentivo(campana.tipoIncentivo)} · ${formatValorIncentivoDisplay(campana.tipoIncentivo, campana.valorIncentivo)} · ${etiquetaDestinatario(campana.destinatario)}`,
    marginX,
    y,
  );
  y += 5;
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, marginX, y);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Resumen', marginX, y);
  y += 2;

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [['Concepto', 'Valor']],
    body: [
      ['Unidades campaña', String(resultados.totales.unidadesCampana)],
      ['Coste incentivo', formatMonedaPdf(resultados.totales.costeIncentivo)],
    ],
    styles: { fontSize: 9, cellPadding: 2.5 },
    headStyles: { fillColor: [14, 165, 233], textColor: 255 },
  });

  y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 20;
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Por producto', marginX, y);
  y += 2;

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [['Producto', 'Uds.', 'Pr. compra', 'Bonif. €/ud', 'Incentivo']],
    body: resultados.porProducto.map((p) => [
      p.productName,
      String(p.udsCampanaTotal),
      p.precioCoste != null ? formatMonedaPdf(p.precioCoste) : '—',
      p.bonificacionUnitaria != null ? formatMonedaPdf(p.bonificacionUnitaria) : '—',
      formatMonedaPdf(p.costeIncentivo),
    ]),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [14, 165, 233], textColor: 255 },
    columnStyles: {
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
    },
  });

  y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 20;

  if (resultados.porEmpleado.length > 0) {
    y += 8;
    if (y > 250) {
      doc.addPage();
      y = 14;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Por empleado', marginX, y);
    y += 2;

    const localesMap = opts.localesMap ?? new Map();
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [['Empleado', 'Local', 'Uds.', 'Importe', 'Incentivo']],
      body: resultados.porEmpleado.map((e) => [
        e.userName || e.agoraUserId,
        localesMap.get(e.localId) || e.localId,
        String(e.unidades),
        formatMonedaPdf(e.importe),
        formatMonedaPdf(e.incentivoDevengado),
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [14, 165, 233], textColor: 255 },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    });
    y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 20;
  }

  if (resultados.porLocal.length > 0) {
    y += 8;
    if (y > 250) {
      doc.addPage();
      y = 14;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Por local', marginX, y);
    y += 2;

    const localesMap = opts.localesMap ?? new Map();
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [['Local', 'Uds.', 'Incentivo']],
      body: resultados.porLocal.map((l) => [
        localesMap.get(l.localId) || l.localId,
        String(l.unidades),
        formatMonedaPdf(l.incentivoDevengado),
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [14, 165, 233], textColor: 255 },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    });
  }

  return doc;
}
