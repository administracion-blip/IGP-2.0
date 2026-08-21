/**
 * IBAN que se congela dentro de una factura al emitirla.
 *
 * La cuenta predeterminada del maestro de empresas (`igp_Empresas`, vía
 * `ibanPredeterminadoDeEmpresa`) es la fuente de verdad para emitir, remesar y
 * pagar. Lo que llegue en el cuerpo de la petición o en un borrador de OCR solo
 * vale de respaldo para empresas que aún no tienen ninguna cuenta: si mandara,
 * se podría emitir una factura contra una cuenta que ya no se usa y el campo
 * viejo `Iban` acabaría divergiendo del modelo nuevo.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';
import { ibanPredeterminadoDeEmpresa } from '../empresaIban.js';
import { limpiarIban } from '../remesas/iban.js';

/**
 * Ítem del maestro por `id_empresa`. Los ids guardados no están normalizados
 * igual —unos llevan los ceros a la izquierda y otros no—, así que se prueban
 * las dos formas.
 * @param {unknown} idEmpresa
 * @returns {Promise<object|null>}
 */
export async function buscarEmpresaPorIdEmpresa(idEmpresa) {
  const id = String(idEmpresa ?? '').trim();
  if (!id) return null;
  const claves = [...new Set([id, formatId6(id)])].filter((k) => k && k !== '000000');
  for (const clave of claves) {
    const r = await docClient.send(new GetCommand({ TableName: tables.empresas, Key: { id_empresa: clave } }));
    if (r.Item) return r.Item;
  }
  return null;
}

/**
 * Cuenta predeterminada de una empresa por `id_empresa`, o '' si no tiene.
 * La caché es opcional y evita releer el maestro en tandas de varias facturas.
 * @param {unknown} idEmpresa
 * @param {Map<string, string>} [cache]
 * @returns {Promise<string>}
 */
export async function ibanPredeterminadoPorIdEmpresa(idEmpresa, cache = new Map()) {
  const id = String(idEmpresa ?? '').trim();
  if (!id) return '';
  if (cache.has(id)) return cache.get(id);
  let iban = '';
  try {
    iban = ibanPredeterminadoDeEmpresa(await buscarEmpresaPorIdEmpresa(id));
  } catch (e) {
    console.error('[facturación] IBAN predeterminado de la empresa:', e.message);
  }
  cache.set(id, iban);
  return iban;
}

/**
 * IBAN de emisor y receptor tal como deben quedar congelados en la factura.
 * Cada parte se resuelve con **su** `id_empresa`, y el valor del cuerpo solo
 * entra cuando esa empresa no tiene ninguna cuenta en el maestro.
 * @param {{ emisor_id?: unknown, emisor_iban?: unknown, empresa_id?: unknown, empresa_iban?: unknown }} datos
 * @returns {Promise<{ emisor_iban: string, empresa_iban: string }>}
 */
export async function ibansCongeladosDeFactura(datos) {
  const cache = new Map();
  const emisor = await ibanPredeterminadoPorIdEmpresa(datos?.emisor_id, cache);
  const empresa = await ibanPredeterminadoPorIdEmpresa(datos?.empresa_id, cache);
  return {
    emisor_iban: emisor || limpiarIban(datos?.emisor_iban ?? ''),
    empresa_iban: empresa || limpiarIban(datos?.empresa_iban ?? ''),
  };
}
