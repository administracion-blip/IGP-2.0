/**
 * Facturas incluidas en remesas activas (Borrador / Generada).
 * Enfoque B: flag derivado `remesaActiva`, sin estado `en_remesa` en la factura.
 */
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

export const ESTADOS_ACTIVOS = new Set(['Borrador', 'Generada']);

/**
 * @param {object|null|undefined} rem
 * @returns {{ remesaId: string, nombre: string, estado: string }|null}
 */
export function infoRemesaActiva(rem) {
  if (!rem) return null;
  return {
    remesaId: rem.remesaId,
    nombre: rem.nombre || '',
    estado: rem.estado,
  };
}

/**
 * Devuelve la remesa activa que incluye la factura, o null.
 * @param {object[]} remesas
 * @param {string} facturaId
 * @param {string|null} [excludeRemesaId]
 */
export function facturaEnRemesaActiva(remesas, facturaId, excludeRemesaId = null) {
  if (!facturaId) return null;
  for (const rem of remesas || []) {
    if (excludeRemesaId && rem.remesaId === excludeRemesaId) continue;
    if (!ESTADOS_ACTIVOS.has(rem.estado)) continue;
    const lineas = rem.lineas || [];
    if (lineas.some((l) => l.id_factura === facturaId)) {
      return rem;
    }
  }
  return null;
}

/**
 * Índice id_factura → { remesaId, nombre, estado } para remesas activas.
 * Si una factura aparece en varias (no debería), prevalece la primera encontrada.
 * @param {object[]} remesas
 * @returns {Map<string, { remesaId: string, nombre: string, estado: string }>}
 */
export function indexRemesasActivasPorFactura(remesas) {
  const map = new Map();
  for (const rem of remesas || []) {
    if (!ESTADOS_ACTIVOS.has(rem.estado)) continue;
    const info = infoRemesaActiva(rem);
    for (const l of rem.lineas || []) {
      const id = l?.id_factura;
      if (!id || map.has(id)) continue;
      map.set(id, info);
    }
  }
  return map;
}

async function scanRemesas() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.remesas,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Scan de remesas + lookup de remesa activa para una factura.
 * @param {string} facturaId
 * @returns {Promise<{ remesaId: string, nombre: string, estado: string }|null>}
 */
export async function findRemesaActivaDeFactura(facturaId) {
  if (!facturaId) return null;
  const remesas = await scanRemesas();
  return infoRemesaActiva(facturaEnRemesaActiva(remesas, facturaId));
}
