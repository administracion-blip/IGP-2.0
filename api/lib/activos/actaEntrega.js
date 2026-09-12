/**
 * Acta única de entrega: une plantillas de las categorías y rellena huecos.
 * Un PDF y una firma para toda la cesta.
 */

import { CUERPO_PLANTILLA_DEFAULT, renderCuerpoPlantilla, sanitizarHtmlPlantilla } from './plantillaTexto.js';

export function componerCuerpoActa(cuerpos) {
  const limpios = (Array.isArray(cuerpos) ? cuerpos : [])
    .map((c) => sanitizarHtmlPlantilla(String(c || '')))
    .filter(Boolean);
  if (!limpios.length) return CUERPO_PLANTILLA_DEFAULT;
  if (limpios.length === 1) return limpios[0];
  return limpios
    .map((c, i) => (i === 0 ? c : c.split('{{items}}').join('')))
    .join('<p>—</p>');
}

export function htmlActaATexto(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h2|h3|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderActa(cuerpo, datos) {
  return renderCuerpoPlantilla(cuerpo || CUERPO_PLANTILLA_DEFAULT, datos || {});
}

/**
 * PDF A4 con el texto del acta y la firma PNG al pie.
 * @param {string} html
 * @param {Buffer} firmaPng
 * @param {{ titulo?: string }} [opts]
 */
export async function generarPdfActa(html, firmaPng, opts = {}) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const mx = 18;
  const maxW = 174;
  let y = 20;

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(opts.titulo || 'Acta de entrega de material', mx, y);
  y += 10;

  const texto = htmlActaATexto(html);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  const lineas = doc.splitTextToSize(texto || '—', maxW);
  for (const linea of lineas) {
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    doc.text(linea, mx, y);
    y += 6;
  }

  if (y > 240) {
    doc.addPage();
    y = 20;
  }
  y += 6;
  doc.setFont('helvetica', 'bold');
  doc.text('Firma del trabajador', mx, y);
  y += 4;
  if (firmaPng?.length) {
    try {
      const b64 = Buffer.from(firmaPng).toString('base64');
      doc.addImage(`data:image/png;base64,${b64}`, 'PNG', mx, y, 70, 28);
      y += 32;
    } catch {
      y += 8;
    }
  }
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, mx, y);

  return Buffer.from(doc.output('arraybuffer'));
}
