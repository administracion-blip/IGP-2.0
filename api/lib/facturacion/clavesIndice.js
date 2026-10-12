/**
 * Atributos de los GSI de facturas, pagos y remesas.
 *
 * Los índices ya existen, pero los registros antiguos no traen `gsi_*`. Cada
 * escritura nueva los rellena aquí. Una clave de índice no puede ser `''`:
 * DynamoDB rechaza el ítem entero. Si el valor no es válido, el atributo no
 * se escribe (en un Update, se quita con REMOVE).
 *
 * Cada atributo se decide por su cuenta: que falte la sort key no impide
 * guardar la partition key, y el ítem simplemente no entra en ese índice.
 */

import { normalizeCif } from '../empresaCif.js';
import { formatId6 } from '../usuarioLocales.js';

export const ATRIBUTOS_GSI_FACTURA = Object.freeze([
  'gsi_tipo',
  'gsi_estado',
  'gsi_fecha',
  'gsi_proveedor',
  'gsi_emisor',
  'gsi_serie',
  'gsi_periodo',
]);

export const ATRIBUTOS_GSI_PAGO = Object.freeze(['gsi_listado', 'gsi_fecha']);

export const ATRIBUTOS_GSI_REMESA = Object.freeze(['gsi_listado', 'gsi_activa', 'gsi_fecha']);

const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_PERIODO = /^(\d{4})-(\d{2})$/;

function texto(valor) {
  return String(valor ?? '').trim();
}

/** `YYYY-MM-DD` real, o los 10 primeros caracteres de un ISO si forman esa fecha. */
export function fechaIndiceIso(valor) {
  const recorte = texto(valor).slice(0, 10);
  const m = RE_FECHA.exec(recorte);
  if (!m) return '';
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const dt = new Date(Date.UTC(anio, mes - 1, dia));
  if (dt.getUTCFullYear() !== anio || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== dia) return '';
  return recorte;
}

/** `AAAA-MM` con mes 01–12. */
function periodoMes(valor) {
  const m = RE_PERIODO.exec(texto(valor));
  if (!m) return '';
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) return '';
  return `${m[1]}-${m[2]}`;
}

function resultado(poner, todos) {
  const limpio = {};
  for (const [clave, valor] of Object.entries(poner)) {
    if (typeof valor === 'string' && valor.trim() !== '') limpio[clave] = valor;
  }
  return {
    poner: limpio,
    quitar: todos.filter((clave) => !(clave in limpio)),
  };
}

/**
 * Fecha de orden de la factura: `fecha_emision` en ISO; si no vale,
 * `creado_en` recortado a fecha. Si ninguna vale, no hay `gsi_fecha`.
 */
function fechaFactura(factura) {
  return fechaIndiceIso(factura?.fecha_emision) || fechaIndiceIso(factura?.creado_en);
}

/**
 * Emisor del índice: `formatId6(emisor_id)` si hay id; si no, `CIF#` más el
 * CIF emisor normalizado. Sin ninguno de los dos, no hay `gsi_emisor`.
 */
function claveEmisor(factura) {
  const id = texto(factura?.emisor_id);
  if (id) return formatId6(id);
  const cif = normalizeCif(factura?.emisor_cif);
  if (cif) return `CIF#${cif}`;
  return '';
}

/**
 * Periodo indexado. Si la factura trae varios `*_periodo`, la prioridad es
 * rappel, después mantenimiento y después ventas internas: solo entra el
 * primero cuyo valor sea un `AAAA-MM` válido.
 */
function clavePeriodo(factura) {
  const candidatos = [
    ['rappel', factura?.rappel_periodo],
    ['mantenimiento', factura?.mantenimiento_periodo],
    ['ventas_internas', factura?.ventas_internas_periodo],
  ];
  for (const [dominio, valor] of candidatos) {
    const periodo = periodoMes(valor);
    if (periodo) return `${dominio}#${periodo}`;
  }
  return '';
}

/**
 * @param {object} factura
 * @returns {{ poner: Record<string, string>, quitar: string[] }}
 */
export function clavesIndiceFactura(factura) {
  const poner = {};
  const tipo = texto(factura?.tipo).toUpperCase();
  if (tipo) poner.gsi_tipo = tipo;
  const estado = texto(factura?.estado);
  if (estado) poner.gsi_estado = estado;
  const fecha = fechaFactura(factura);
  if (fecha) poner.gsi_fecha = fecha;
  const proveedor = normalizeCif(factura?.empresa_cif);
  if (proveedor) poner.gsi_proveedor = proveedor;
  const emisor = claveEmisor(factura);
  if (emisor) poner.gsi_emisor = emisor;
  const serie = texto(factura?.serie);
  if (serie) poner.gsi_serie = serie;
  const periodo = clavePeriodo(factura);
  if (periodo) poner.gsi_periodo = periodo;
  return resultado(poner, ATRIBUTOS_GSI_FACTURA);
}

/**
 * @param {object} pago
 * @returns {{ poner: Record<string, string>, quitar: string[] }}
 */
export function clavesIndicePago(pago) {
  const poner = { gsi_listado: 'PAGO' };
  const fecha = fechaIndiceIso(pago?.fecha);
  if (fecha) poner.gsi_fecha = fecha;
  return resultado(poner, ATRIBUTOS_GSI_PAGO);
}

/** Borrador, Generada, o Ejecutada que aún tiene líneas pendientes de pago. */
export function remesaQuedaActiva(remesa) {
  const estado = texto(remesa?.estado);
  if (estado === 'Borrador' || estado === 'Generada') return true;
  if (estado !== 'Ejecutada') return false;
  const pendientes = remesa?.lineasPendientesPago;
  return Array.isArray(pendientes) && pendientes.length > 0;
}

/**
 * @param {object} remesa
 * @returns {{ poner: Record<string, string>, quitar: string[] }}
 */
export function clavesIndiceRemesa(remesa) {
  const poner = { gsi_listado: 'REMESA' };
  if (remesaQuedaActiva(remesa)) poner.gsi_activa = 'ACTIVA';
  const fecha = fechaIndiceIso(remesa?.creadoEn);
  if (fecha) poner.gsi_fecha = fecha;
  return resultado(poner, ATRIBUTOS_GSI_REMESA);
}

/** Escribe `poner` y borra `quitar` en el ítem (un Put no puede mandar `''`). */
export function aplicarClavesEnItem(item, claves) {
  if (!item || typeof item !== 'object') return item;
  for (const clave of claves.quitar) delete item[clave];
  for (const [clave, valor] of Object.entries(claves.poner)) {
    if (typeof valor !== 'string' || valor.trim() === '') {
      delete item[clave];
      continue;
    }
    item[clave] = valor;
  }
  return item;
}

export function aplicarClavesFactura(factura) {
  return aplicarClavesEnItem(factura, clavesIndiceFactura(factura));
}

export function aplicarClavesPago(pago) {
  return aplicarClavesEnItem(pago, clavesIndicePago(pago));
}

export function aplicarClavesRemesa(remesa) {
  return aplicarClavesEnItem(remesa, clavesIndiceRemesa(remesa));
}

function partirUpdate(expr) {
  const secciones = { SET: '', REMOVE: '', ADD: '', DELETE: '' };
  const re = /\b(SET|REMOVE|ADD|DELETE)\b/gi;
  const cortes = [];
  let m;
  while ((m = re.exec(expr)) !== null) {
    cortes.push({ clave: m[1].toUpperCase(), inicio: m.index, desde: m.index + m[0].length });
  }
  for (let i = 0; i < cortes.length; i += 1) {
    const hasta = i + 1 < cortes.length ? cortes[i + 1].inicio : expr.length;
    secciones[cortes[i].clave] = expr.slice(cortes[i].desde, hasta).trim().replace(/,\s*$/, '');
  }
  return secciones;
}

/**
 * Añade SET/REMOVE de los `gsi_*` a un UpdateCommand. Los alias no pisan los
 * que ya traiga la expresión.
 *
 * @param {object} params
 * @param {{ poner: Record<string, string>, quitar: string[] }} claves
 */
export function fusionarClavesEnUpdate(params, claves) {
  const secciones = partirUpdate(String(params.UpdateExpression || '').trim());
  const names = { ...(params.ExpressionAttributeNames || {}) };
  const values = { ...(params.ExpressionAttributeValues || {}) };
  const usados = new Set([...Object.keys(names), ...Object.keys(values)]);
  let n = 0;
  const aliasLibre = (conValor) => {
    let name;
    let value;
    do {
      n += 1;
      name = `#gsi${n}`;
      value = `:gsi${n}`;
    } while (usados.has(name) || (conValor && usados.has(value)));
    usados.add(name);
    if (conValor) usados.add(value);
    return { name, value };
  };

  const sets = secciones.SET ? [secciones.SET] : [];
  for (const [attr, val] of Object.entries(claves.poner || {})) {
    if (typeof val !== 'string' || val.trim() === '') continue;
    const { name, value } = aliasLibre(true);
    names[name] = attr;
    values[value] = val;
    sets.push(`${name} = ${value}`);
  }
  const removes = secciones.REMOVE ? [secciones.REMOVE] : [];
  for (const attr of claves.quitar || []) {
    const { name } = aliasLibre(false);
    names[name] = attr;
    removes.push(name);
  }

  const partes = [];
  if (sets.length) partes.push(`SET ${sets.join(', ')}`);
  if (removes.length) partes.push(`REMOVE ${removes.join(', ')}`);
  if (secciones.ADD) partes.push(`ADD ${secciones.ADD}`);
  if (secciones.DELETE) partes.push(`DELETE ${secciones.DELETE}`);

  const out = {
    ...params,
    UpdateExpression: partes.join(' '),
    ExpressionAttributeNames: names,
  };
  if (Object.keys(values).length > 0) out.ExpressionAttributeValues = values;
  return out;
}

/** Update de factura con los `gsi_*` recalculados sobre el ítem ya modificado. */
export function conClavesFactura(params, factura) {
  return fusionarClavesEnUpdate(params, clavesIndiceFactura(factura));
}

/**
 * Update de remesa. `remesa` es el ítem tal como quedará (estado,
 * `lineasPendientesPago` y `creadoEn`), no el de antes del cambio.
 */
export function conClavesRemesa(params, remesa) {
  return fusionarClavesEnUpdate(params, clavesIndiceRemesa(remesa));
}
