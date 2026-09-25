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

const MARCADOR_ITEMS = '<<<ITEMS>>>';
const PLACEHOLDER_ITEMS = '\u0000ITEMS\u0000';

export function htmlActaATexto(html) {
  return String(html || '')
    .split(MARCADOR_ITEMS).join(PLACEHOLDER_ITEMS)
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
    .split(PLACEHOLDER_ITEMS).join(MARCADOR_ITEMS)
    .trim();
}

/** Miniatura JPEG para el PDF. Si sharp falla, null (el ítem va sin foto). */
export async function thumbJpeg(buffer) {
  if (!buffer?.length) return null;
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(buffer)
      .resize(160, 160, { fit: 'cover' })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch {
    return null;
  }
}

export function renderActa(cuerpo, datos) {
  return renderCuerpoPlantilla(cuerpo || CUERPO_PLANTILLA_DEFAULT, datos || {});
}

/**
 * PDF A4 con el texto del acta y la firma PNG al pie.
 * Si `opts.items` tiene entradas y el texto contiene `<<<ITEMS>>>`, dibuja
 * cada ítem (thumb JPEG 16×16 mm + texto) en ese hueco.
 * @param {string} html
 * @param {Buffer} firmaPng
 * @param {{ titulo?: string, items?: { texto: string, jpeg?: Buffer | null }[] }} [opts]
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
  const items = Array.isArray(opts.items) ? opts.items : [];
  const idxItems = items.length ? texto.indexOf(MARCADOR_ITEMS) : -1;

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');

  const dibujarLineas = (lineas) => {
    for (const linea of lineas) {
      if (y > 250) {
        doc.addPage();
        y = 20;
      }
      doc.text(linea, mx, y);
      y += 6;
    }
  };

  if (idxItems < 0) {
    dibujarLineas(doc.splitTextToSize(texto || '—', maxW));
  } else {
    const antes = texto.slice(0, idxItems).trimEnd();
    const despues = texto.slice(idxItems + MARCADOR_ITEMS.length).split(MARCADOR_ITEMS).join('').trimStart();
    if (antes) dibujarLineas(doc.splitTextToSize(antes, maxW));

    const thumbMm = 16;
    const gap = 3;
    const filaH = 18;
    const textW = maxW - thumbMm - gap;

    for (const item of items) {
      if (y > 250) {
        doc.addPage();
        y = 20;
      }
      const jpeg = item?.jpeg;
      const textoItem = String(item?.texto || '').trim() || '—';
      if (jpeg?.length) {
        try {
          const b64 = Buffer.from(jpeg).toString('base64');
          doc.addImage(`data:image/jpeg;base64,${b64}`, 'JPEG', mx, y - 4, thumbMm, thumbMm);
        } catch {
          // foto inválida: el texto sigue
        }
        const lineasItem = doc.splitTextToSize(textoItem, textW);
        let ty = y;
        for (const linea of lineasItem) {
          doc.text(linea, mx + thumbMm + gap, ty);
          ty += 6;
        }
        y += Math.max(filaH, ty - y + 2);
      } else {
        dibujarLineas(doc.splitTextToSize(textoItem, maxW));
        y += 2;
      }
    }

    if (despues) {
      y += 4;
      dibujarLineas(doc.splitTextToSize(despues, maxW));
    }
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

/**
 * PDF informativo de lo que el trabajador tiene ahora. No se firma ni se guarda.
 * @param {{ trabajador?: string, fecha?: string, cantidad?: number, items?: { texto: string, jpeg?: Buffer | null }[] }} [opts]
 */
export async function generarPdfInventarioCustodia(opts = {}) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const mx = 18;
  const maxW = 174;
  let y = 20;
  const items = Array.isArray(opts.items) ? opts.items : [];
  const cantidad = Number.isFinite(Number(opts.cantidad))
    ? Number(opts.cantidad)
    : items.length;
  const fecha = String(opts.fecha || '').trim() || new Date().toLocaleDateString('es-ES');
  const trabajador = String(opts.trabajador || '').trim() || '—';
  const prendasTxt = cantidad === 1 ? '1 prenda en su poder' : `${cantidad} prendas en su poder`;

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Inventario de custodia', mx, y);
  y += 10;

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  const cabecera = doc.splitTextToSize(`${trabajador}\n${fecha}\n${prendasTxt}`, maxW);
  for (const linea of cabecera) {
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    doc.text(linea, mx, y);
    y += 6;
  }
  y += 4;

  const thumbMm = 16;
  const gap = 3;
  const filaH = 18;
  const textW = maxW - thumbMm - gap;

  for (const item of items) {
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    const jpeg = item?.jpeg;
    const textoItem = String(item?.texto || '').trim() || '—';
    if (jpeg?.length) {
      try {
        const b64 = Buffer.from(jpeg).toString('base64');
        doc.addImage(`data:image/jpeg;base64,${b64}`, 'JPEG', mx, y - 4, thumbMm, thumbMm);
      } catch {
        // foto inválida: el texto sigue
      }
      const lineasItem = doc.splitTextToSize(textoItem, textW);
      let ty = y;
      for (const linea of lineasItem) {
        doc.text(linea, mx + thumbMm + gap, ty);
        ty += 6;
      }
      y += Math.max(filaH, ty - y + 2);
    } else {
      const lineas = doc.splitTextToSize(textoItem, maxW);
      for (const linea of lineas) {
        if (y > 250) {
          doc.addPage();
          y = 20;
        }
        doc.text(linea, mx, y);
        y += 6;
      }
      y += 2;
    }
  }

  if (y > 270) {
    doc.addPage();
    y = 20;
  }
  y += 8;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('Documento informativo. No sustituye las actas firmadas.', mx, y);

  return Buffer.from(doc.output('arraybuffer'));
}
