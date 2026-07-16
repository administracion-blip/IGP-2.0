import { importeLetraEur } from './importeLetra.js';

function formatMoneda(n) {
  return (Number(n) || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function formatFecha(iso) {
  if (!iso || iso.length < 10) return iso || '—';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

function lineasMovimiento(mov) {
  if (Array.isArray(mov.lineas) && mov.lineas.length > 0) {
    return mov.lineas.map((l) => ({
      descripcion: String(l.descripcion || l.concepto || '').trim(),
      importe: Number(l.importe) || 0,
    })).filter((l) => l.descripcion);
  }
  const concepto = String(mov.concepto || '').trim();
  const importe = Number(mov.importe) || 0;
  if (concepto) return [{ descripcion: concepto, importe }];
  return [];
}

function resumenConceptos(lineas) {
  if (!lineas.length) return '—';
  if (lineas.length === 1) return lineas[0].descripcion;
  return lineas.map((l) => l.descripcion).join('; ');
}

/**
 * Genera PDF del recibí firmado.
 * @param {object} mov
 * @param {Buffer} firmaPng
 */
export async function generarPdfReciboCashflow(mov, firmaPng) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const mx = 18;
  let y = 20;
  const esPago = mov.tipo === 'pago';
  const titulo = esPago ? 'RECIBÍ' : 'RECIBO DE ENTREGA';
  const lineas = lineasMovimiento(mov);
  const importe = Number(mov.importe) || lineas.reduce((a, l) => a + l.importe, 0);
  const conceptoResumen = resumenConceptos(lineas);

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(titulo, mx, y);
  y += 8;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`N.º ${mov.numeroRecibo || '—'}`, mx, y);
  y += 6;
  doc.text(`Fecha (jornada): ${formatFecha(mov.fecha)}`, mx, y);
  y += 10;

  doc.setFont('helvetica', 'bold');
  doc.text(mov.empresaNombre || '—', mx, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  if (mov.empresaCif) {
    doc.text(`CIF: ${mov.empresaCif}`, mx, y);
    y += 5;
  }
  if (mov.localNombre) {
    doc.text(`Local: ${mov.localNombre}`, mx, y);
    y += 5;
  }
  y += 4;

  doc.setFont('helvetica', 'bold');
  doc.text('Detalle', mx, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text('Concepto', mx, y);
  doc.text('Importe', mx + 140, y, { align: 'right' });
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setDrawColor(200);
  doc.line(mx, y, mx + 174, y);
  y += 4;

  for (const ln of lineas) {
    const descLines = doc.splitTextToSize(ln.descripcion, 130);
    doc.text(descLines, mx, y);
    doc.text(formatMoneda(ln.importe), mx + 174, y, { align: 'right' });
    y += Math.max(descLines.length * 4.5, 5);
  }

  y += 2;
  doc.line(mx, y, mx + 174, y);
  y += 5;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('TOTAL', mx, y);
  doc.text(formatMoneda(importe), mx + 174, y, { align: 'right' });
  y += 6;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  const letra = importeLetraEur(importe);
  const letraLines = doc.splitTextToSize(letra, 170);
  doc.text(letraLines, mx, y);
  y += letraLines.length * 4 + 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');

  if (mov.categoria) {
    doc.text(`Categoría: ${mov.categoria}`, mx, y);
    y += 6;
  }

  const cpNombre = mov.contraparte?.nombre || '—';
  const cpNif = mov.contraparte?.nif || '';
  if (esPago) {
    const cuerpo = `D./Dña. ${cpNombre}${cpNif ? ` (NIF/CIF: ${cpNif})` : ''} declara haber RECIBIDO la cantidad indicada en concepto de: ${conceptoResumen}.`;
    const lines = doc.splitTextToSize(cuerpo, 170);
    doc.text(lines, mx, y);
    y += lines.length * 5 + 6;
  } else {
    const cuerpo = `El abajo firmante, ${mov.firmadoPorNombre || mov.creadoPorNombre || '—'}, en representación de ${mov.empresaNombre || 'la empresa'}, certifica haber RECIBIDO en efectivo la cantidad indicada de D./Dña. ${cpNombre}${cpNif ? ` (NIF/CIF: ${cpNif})` : ''}, en concepto de: ${conceptoResumen}.`;
    const lines = doc.splitTextToSize(cuerpo, 170);
    doc.text(lines, mx, y);
    y += lines.length * 5 + 6;
  }

  y += 4;
  doc.text('Firma:', mx, y);
  y += 2;
  if (firmaPng?.length) {
    try {
      const b64 = firmaPng.toString('base64');
      doc.addImage(`data:image/png;base64,${b64}`, 'PNG', mx, y, 70, 28);
      y += 32;
    } catch {
      y += 10;
    }
  } else {
    y += 10;
  }

  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text(`Registrado por: ${mov.creadoPorNombre || mov.creadoPor || '—'}`, mx, y);
  y += 4;
  if (mov.creadoEn) {
    doc.text(`Fecha registro: ${new Date(mov.creadoEn).toLocaleString('es-ES')}`, mx, y);
    y += 4;
  }
  if (mov.firmadoPorNombre && !esPago) {
    doc.text(`Firmante (encargado): ${mov.firmadoPorNombre}`, mx, y);
    y += 4;
  }
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, mx, y);

  return Buffer.from(doc.output('arraybuffer'));
}
