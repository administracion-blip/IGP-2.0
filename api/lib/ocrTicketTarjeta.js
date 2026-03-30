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
  const amountPatterns = [
    /(?:TOTAL|TOTAL\s+EUR|IMPORTE|TOTAL\s+A\s+PAGAR)[\s:]*([\d]{1,3}(?:[.\s]\d{3})*,\d{2}|[\d]+,\d{2})\s*€?/i,
    /([\d]{1,3}(?:\.\d{3})*,\d{2})\s*€/,
    /EUR\s*([\d]+[,.]\d{2})/i,
    /\b([\d]{1,3}(?:[.\s]\d{3})*,\d{2})\b/,
  ];
  for (const re of amountPatterns) {
    const m = flat.match(re);
    if (m) {
      importe = m[1].replace(/\s/g, '').replace(/\./g, '').replace(',', ',');
      if (importe.includes(',')) break;
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
  const af = pickFirst(/(?:AFILI|COMERCIO|TERMINAL|AID|N[º°]?\s*COM)[^\d]{0,12}(\d{6,12})/i, raw);
  if (af) numeroComercio = af;
  else {
    const longNum = pickFirst(/\b(\d{8,12})\b/, flat);
    if (longNum && !importe.includes(longNum)) numeroComercio = longNum;
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
