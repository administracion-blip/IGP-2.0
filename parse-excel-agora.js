#!/usr/bin/env node
/**
 * Parsea el Excel de Ágora (formato HTML) y extrae estructura y datos.
 * Uso: node parse-excel-agora.js [ruta-al-xls]
 * Ejemplo: node parse-excel-agora.js c:/Users/jjcas/Downloads/data_19022026_232133.xls
 */

const fs = require('fs');
const path = process.argv[2] || 'c:/Users/jjcas/Downloads/data_19022026_232133.xls';

if (!fs.existsSync(path)) {
  console.error('Archivo no encontrado:', path);
  process.exit(1);
}

const content = fs.readFileSync(path, 'utf8');

// Extraer cabeceras
const headerMatch = content.match(/<tr[^>]*>([\s\S]*?)<\/tr>/);
const headers = [];
if (headerMatch) {
  const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = thRegex.exec(headerMatch[1])) !== null) {
    headers.push(m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
  }
}

// Extraer filas de datos
const allRows = [];
const trRegex = /<tr>([\s\S]*?)<\/tr>/gi;
let trMatch;
while ((trMatch = trRegex.exec(content)) !== null) {
  if (/<th/i.test(trMatch[1])) continue;
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const cells = [];
  let tdMatch;
  while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
    cells.push(tdMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
  }
  if (cells.length > 0) allRows.push(cells);
}

// Filas con SPEAKEASY o 13/02/2026
const speakeasy13 = allRows.filter((r) =>
  r.some((c) => /SPEAKEASY|Speakeasy|13\/02\/2026/i.test(String(c)))
);

// Filas SPEAKEASY con Fecha Negocio exacta 13/02/2026 (para comparar con API)
const speakeasyDia13 = allRows.filter((r) => {
  const tpvIdx = headers.indexOf('TPV');
  const fechaIdx = headers.indexOf('Fecha Negocio');
  if (tpvIdx < 0 || fechaIdx < 0) return false;
  return /SPEAKEASY/i.test(String(r[tpvIdx] ?? '')) && String(r[fechaIdx] ?? '') === '13/02/2026';
});

// Objeto con índices por cabecera
const toObj = (cells) => {
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = cells[i] ?? '';
  });
  return obj;
};

const result = {
  file: path,
  totalRows: allRows.length,
  headers,
  columnCount: headers.length,
  speakeasy13Count: speakeasy13.length,
  speakeasy13Rows: speakeasy13.map(toObj),
  speakeasyDia13: speakeasyDia13.map(toObj),
  sampleFirst5: allRows.slice(0, 5).map(toObj),
};

console.log(JSON.stringify(result, null, 2));
