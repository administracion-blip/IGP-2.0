/**
 * CIF/NIF en `igp_Empresas`: normalización, lectura con distinto casing y fallback por dígitos.
 */

const CONFUSABLE_TO_LATIN = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
  Ѕ: 'S',
  І: 'I',
  Ј: 'J',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Χ: 'X',
  Υ: 'Y',
};

function mapConfusableCharsToLatin(str) {
  let s = String(str).normalize('NFKC');
  let out = '';
  for (const ch of s) {
    out += CONFUSABLE_TO_LATIN[ch] || ch;
  }
  return out;
}

/** Normaliza CIF/NIF para comparación (homóglifos, solo A–Z0–9). */
export function normalizeCif(val) {
  return mapConfusableCharsToLatin(String(val ?? ''))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

/** Solo dígitos (para fallback cuando la letra inicial difiere entre OCR y maestro). */
export function cifDigitsOnly(normalizedCif) {
  return String(normalizedCif ?? '').replace(/\D/g, '');
}

export function getCifFromEmpresaItem(item) {
  if (!item || typeof item !== 'object') return '';
  const direct = ['Cif', 'cif', 'NIF', 'nif', 'Nif'];
  for (const k of direct) {
    if (item[k] != null && String(item[k]).trim() !== '') return String(item[k]);
  }
  const keyCif = Object.keys(item).find((k) => k.toLowerCase() === 'cif');
  if (keyCif) return String(item[keyCif]);
  const keyNif = Object.keys(item).find((k) => k.toLowerCase() === 'nif');
  if (keyNif) return String(item[keyNif]);
  return '';
}

export function getNombreFromEmpresaItem(item) {
  if (!item || typeof item !== 'object') return '';
  const v = item.Nombre ?? item.nombre;
  if (v != null && String(v).trim() !== '') return String(v).trim();
  const key = Object.keys(item).find((k) => k.toLowerCase() === 'nombre');
  return key ? String(item[key]).trim() : '';
}

export function getIdEmpresaFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  const v = item.id_empresa ?? item.id_Empresa;
  if (v != null && v !== '') return String(v);
  const key = Object.keys(item).find((k) => k.toLowerCase() === 'id_empresa');
  return key ? String(item[key]) : '';
}
