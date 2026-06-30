/**
 * Heurísticas sobre texto crudo de ticket/boleta (Tesseract) para campos de arqueo tarjeta.
 * No sustituye revisión humana; mejora con formatos reales de vuestros TPV.
 */

function pickFirst(re, text, flags = 'i') {
  const r = new RegExp(re, flags);
  const m = text.match(r);
  return m ? m[1]?.trim() : '';
}

/**
 * @param {string} text
 * @returns {{ banco: string; importe: string; numeroComercio: string; fechaHora: string; ocrRaw: string }}
 */
export function parseTextoTicketTarjeta(text) {
  const raw = String(text || '').replace(/\r/g, '\n');
  const flat = raw.replace(/\s+/g, ' ');

  let importe = '';
  // Importante: NO admitir el espacio como separador de miles. En tickets con columnas
  // "Cantidad" e "Importe" (p. ej. "54  472,00 €") el espacio uniría ambos valores
  // dando "54472,00". Solo el punto agrupa miles; el € o la palabra TOTAL fijan el valor.
  const amountPatterns = [
    /([\d]{1,3}(?:\.\d{3})*,\d{2})\s*€/,
    /(?:TOTAL\s+A\s+PAGAR|TOTAL\s+EUR|IMPORTE|TOTAL)[^\d€]{0,10}([\d]{1,3}(?:\.\d{3})*,\d{2})/i,
    /EUR\s*([\d]{1,3}(?:\.\d{3})*,\d{2})/i,
    /\b([\d]{1,3}(?:\.\d{3})*,\d{2})\b/,
  ];
  for (const re of amountPatterns) {
    const m = flat.match(re);
    if (m && m[1].includes(',')) {
      importe = m[1];
      break;
    }
  }
  if (importe) {
    const normalized = importe.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(normalized);
    if (Number.isFinite(num)) importe = num.toFixed(2).replace('.', ',');
  }

  let fechaHora = '';
  const fd = pickFirst(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/, flat);
  const tm = pickFirst(/(\d{1,2}:\d{2}(?::\d{2})?)/, flat);
  if (fd && tm) fechaHora = `${fd} ${tm}`;
  else if (fd) fechaHora = fd;
  else if (tm) fechaHora = tm;

  let numeroComercio = '';
  // El nº de comercio/afiliación va junto a su etiqueta. Permitimos ":" y espacios
  // (incluido salto de línea) entre la etiqueta y los dígitos.
  const af = pickFirst(/(?:AFILIACI[OÓ]N|AFILI|N[º°]?\s*COMERCIO|COMERCIO|TERMINAL|AID|N[º°]?\s*COM)\s*[:.\-]?\s*(\d{6,12})/i, raw);
  if (af) numeroComercio = af;
  else {
    // Fallback: número largo aislado que no forme parte del importe. Se prioriza el que
    // no empieza por "0" (el TPV suele llevar ceros a la izquierda, p. ej. 00723023).
    const importeDigits = importe.replace(/\D/g, '');
    const candidatos = (flat.match(/\b\d{8,12}\b/g) || []).filter((n) => n !== importeDigits);
    const noCero = candidatos.find((n) => !n.startsWith('0'));
    numeroComercio = noCero || candidatos[0] || '';
  }

  let banco = '';
  const banks = [
    'BBVA', 'Santander', 'CaixaBank', 'Caixa', 'Sabadell', 'Bankinter', 'Unicaja', 'ING',
    'EVO', 'Kutxabank', 'Abanca', 'Ibercaja', 'Cajamar', 'N26', 'Revolut',
  ];
  for (const b of banks) {
    if (new RegExp(`\\b${b}\\b`, 'i').test(flat)) {
      banco = b;
      break;
    }
  }
  // "Comercia Global Payments" es la marca adquirente de CaixaBank: si no se ha
  // identificado banco por nombre directo, este encabezado lo resuelve.
  if (!banco && /COMERCIA(?:\s+GLOBAL\s+PAYMENTS)?|GLOBAL\s+PAYMENTS/i.test(flat)) {
    banco = 'CaixaBank';
  }
  if (!banco) {
    const m = flat.match(/(BANCO\s+[A-ZÁÉÍÓÚÑ][A-Za-záéíóúñ\s]{2,22})/i);
    if (m) banco = m[1].trim().slice(0, 40);
  }

  return {
    banco,
    importe,
    numeroComercio,
    fechaHora,
    ocrRaw: raw.slice(0, 4000),
  };
}
