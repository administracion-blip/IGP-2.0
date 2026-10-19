/**
 * Comprobación de «albaranes que faltan»: busca nº de documento del proveedor
 * (`SupplierDocumentNumber`) en las compras de Ágora de un año y dice en qué
 * albarán y almacén están, si es que están. La empresa del almacén la resuelve
 * el front con su lógica de conciliación.
 *
 * Mismos criterios que la conciliación compras ↔ facturas del front:
 *  - proveedor por CIF normalizado y, si no hay CIF, por nombre normalizado;
 *  - nº de documento solo letras/dígitos en mayúsculas.
 *
 * Sin filtro de alcance de locales/empresas: `GET /agora/purchases` tampoco lo
 * aplica, y lo que se quiere detectar es justo el albarán cargado en otra empresa.
 */

import { queryComprasPorMesFecha } from '../dynamo/comprasProveedor.js';
import { normalizeCif } from '../empresaCif.js';
import { normDocProveedor } from '../facturacion/albaranesFaltantes.js';

export const MAX_CONSULTAS = 50;
export const MAX_NUMEROS_POR_CONSULTA = 100;
export const ERROR_CONSULTA_INVALIDA = 'consulta_invalida';
const ANIO_MIN = 2000;

const TTL_MS = 5 * 60 * 1000;
const MAX_ANIOS_CACHE = 4;

const PROYECCION_COMPRAS = [
  'SupplierDocumentNumber',
  'SupplierCif',
  'SupplierName',
  'WarehouseId',
  'WarehouseName',
  'AlbaranFecha',
  'AlbaranSerie',
  'AlbaranNumero',
].join(', ');

function str(v) {
  return v == null ? '' : String(v).trim();
}

/** Igual que `normNombre` del front de conciliación. */
export function normNombre(val) {
  return String(val ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Igual que `claveProveedor` del front de conciliación. */
export function claveProveedor(cif, nombre) {
  const c = normalizeCif(cif);
  if (c) return `cif:${c}`;
  const n = normNombre(nombre);
  return n ? `nom:${n}` : '__sin_proveedor__';
}

// ─── Caché en memoria ───

/** anio → { ts, promesa } con las líneas del año ya proyectadas. */
const _comprasPorAnio = new Map();

export function invalidarCacheComprobacionAlbaranes() {
  _comprasPorAnio.clear();
}

function comprasDelAnio(anio) {
  const ahora = Date.now();
  const hit = _comprasPorAnio.get(anio);
  if (hit && ahora - hit.ts < TTL_MS) return hit.promesa;
  const promesa = queryComprasPorMesFecha(`${anio}-01-01`, `${anio}-12-31`, { projection: PROYECCION_COMPRAS });
  _comprasPorAnio.delete(anio);
  _comprasPorAnio.set(anio, { ts: ahora, promesa });
  while (_comprasPorAnio.size > MAX_ANIOS_CACHE) {
    _comprasPorAnio.delete(_comprasPorAnio.keys().next().value);
  }
  promesa.catch(() => {
    if (_comprasPorAnio.get(anio)?.promesa === promesa) _comprasPorAnio.delete(anio);
  });
  return promesa;
}

// ─── Validación ───

/**
 * Solo el lote en sí puede invalidar la petición (`consultas` no array, vacío o
 * más de `MAX_CONSULTAS`). Una consulta suelta inválida —sin CIF ni nombre del
 * proveedor, `anio` fuera de 2000..año actual+1, `numeros` que no es array o
 * con más de `MAX_NUMEROS_POR_CONSULTA`— no tumba el resto: sale marcada con
 * `invalida: true` y en el cruce da una entrada por cada número válido con
 * `coincidencias: []` y `error: 'consulta_invalida'` (ninguna si no hay
 * números).
 *
 * @returns {{ ok: true, consultas: Array<{ proveedor_cif: string, proveedor_nombre: string, anio: number | null, numeros: string[], invalida?: true }> }
 *   | { ok: false, error: string }}
 */
export function validarConsultas(body, anioActual = new Date().getUTCFullYear()) {
  const consultas = body?.consultas;
  if (!Array.isArray(consultas) || consultas.length === 0) {
    return { ok: false, error: 'consultas debe ser un array no vacío' };
  }
  if (consultas.length > MAX_CONSULTAS) {
    return { ok: false, error: `Como máximo ${MAX_CONSULTAS} consultas por petición` };
  }
  const out = [];
  for (const c of consultas) {
    const obj = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
    const proveedorCif = str(obj.proveedor_cif);
    const proveedorNombre = str(obj.proveedor_nombre);
    const anio = Number(obj.anio);
    const anioValido = Number.isInteger(anio) && anio >= ANIO_MIN && anio <= anioActual + 1;
    const numerosArray = Array.isArray(obj.numeros);
    const invalida = obj !== c
      || (!normalizeCif(proveedorCif) && !normNombre(proveedorNombre))
      || !anioValido
      || !numerosArray
      || obj.numeros.length > MAX_NUMEROS_POR_CONSULTA;
    out.push({
      proveedor_cif: proveedorCif,
      proveedor_nombre: proveedorNombre,
      anio: Number.isInteger(anio) ? anio : null,
      numeros: numerosArray ? obj.numeros.map((n) => str(n)) : [],
      ...(invalida && { invalida: true }),
    });
  }
  return { ok: true, consultas: out };
}

// ─── Cruce ───

function fechaDia(v) {
  const m = str(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/**
 * Cruza las consultas con unas líneas de compra ya cargadas (función pura).
 * Una entrada por nº pedido (normalizado y sin repetir dentro de la consulta);
 * los números que normalizados quedan vacíos se omiten. Cada coincidencia es un
 * par (albarán, almacén): si las líneas de un albarán tienen almacenes
 * distintos, sale una por almacén.
 *
 * Coincidencia: `{ warehouse_id, almacen, fecha, albaran, numero_doc_proveedor }`.
 */
export function cruzarConsultas(consultas, lineasPorAnio) {
  const resultados = [];
  for (const c of consultas) {
    const claveObjetivo = claveProveedor(c.proveedor_cif, c.proveedor_nombre);
    const pedidos = [];
    const vistos = new Set();
    for (const n of c.numeros) {
      const norm = normDocProveedor(n);
      if (!norm || vistos.has(norm)) continue;
      vistos.add(norm);
      pedidos.push(norm);
    }

    const base = { proveedor_cif: c.proveedor_cif, proveedor_nombre: c.proveedor_nombre, anio: c.anio };
    if (c.invalida) {
      for (const norm of pedidos) {
        resultados.push({ ...base, numero_norm: norm, coincidencias: [], error: ERROR_CONSULTA_INVALIDA });
      }
      continue;
    }

    /** numero_norm → Map(albarán+almacén → coincidencia) */
    const porNumero = new Map(pedidos.map((n) => [n, new Map()]));
    for (const linea of lineasPorAnio.get(c.anio) || []) {
      const norm = normDocProveedor(linea.SupplierDocumentNumber);
      const albaranes = norm && porNumero.get(norm);
      if (!albaranes) continue;
      if (claveProveedor(linea.SupplierCif, linea.SupplierName) !== claveObjetivo) continue;
      const serie = str(linea.AlbaranSerie);
      const numero = str(linea.AlbaranNumero);
      const warehouseId = str(linea.WarehouseId);
      const almacen = str(linea.WarehouseName);
      const key = [serie, numero, warehouseId, almacen].join('\u0001');
      if (albaranes.has(key)) continue;
      albaranes.set(key, {
        warehouse_id: warehouseId,
        almacen,
        fecha: fechaDia(linea.AlbaranFecha),
        albaran: serie || numero ? `${serie}-${numero}` : '',
        numero_doc_proveedor: str(linea.SupplierDocumentNumber),
      });
    }

    for (const norm of pedidos) {
      const coincidencias = [...porNumero.get(norm).values()]
        .sort((a, b) => a.fecha.localeCompare(b.fecha)
          || a.albaran.localeCompare(b.albaran)
          || a.warehouse_id.localeCompare(b.warehouse_id));
      resultados.push({ ...base, numero_norm: norm, coincidencias });
    }
  }
  return resultados;
}

/** @returns {Promise<{ resultados: object[] }>} */
export async function comprobarAlbaranesFaltantes(consultas) {
  const anios = [...new Set(consultas.filter((c) => !c.invalida).map((c) => c.anio))];
  const lineas = await Promise.all(anios.map((a) => comprasDelAnio(a)));
  const lineasPorAnio = new Map(anios.map((a, i) => [a, lineas[i]]));
  return { resultados: cruzarConsultas(consultas, lineasPorAnio) };
}
