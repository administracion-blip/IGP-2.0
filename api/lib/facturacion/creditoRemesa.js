/**
 * Crédito sin aplicar (exceso de pago o abono con saldo a favor) del mismo
 * par emisor+proveedor que las facturas seleccionadas para una remesa.
 *
 * La clasificación es pura. La lectura usa BatchGet de las anclas y Query
 * de índice (Proveedor-Fecha o Emisor-Fecha), nunca Scan.
 */

import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { normalizeCif } from '../empresaCif.js';
import { formatId6, facturaEmisorPermitido } from '../usuarioLocales.js';
import { facturasPorProveedor, facturasPorEmisor } from './consultaIndice.js';
import { mismoParEmisorProveedor, saldoFirmadoFactura } from './compensacionFactura.js';
import { excesoPendienteEfectivo } from './excesoPago.js';

export const MAX_IDS_CREDITO_REMESA = 200;

const UMBRAL = 0.001;
const MAX_CLAVES_BATCH = 100;
const MAX_INTENTOS_BATCH = 3;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function texto(v) {
  return String(v ?? '').trim();
}

/** Factura seleccionada que puede abrir un par emisor+proveedor. */
export function esAnclaCreditoRemesa(factura, empresasOk = null) {
  if (!factura || factura.tipo !== 'IN') return false;
  if (factura.estado === 'anulada') return false;
  return facturaEmisorPermitido(factura, empresasOk);
}

function esDocumentoAbono(factura) {
  return factura?.es_abono === true || (Number(factura?.total_factura) || 0) < 0;
}

/**
 * Crédito de una factura, o null si no queda saldo a favor.
 * Un abono (marca o total negativo) no se reclasifica como exceso: si su
 * saldo ya está en cero, el crédito está aplicado.
 * @returns {{ motivo: 'abono'|'exceso', importe: number }|null}
 */
export function clasificarCreditoFactura(factura) {
  if (!factura || factura.tipo !== 'IN') return null;
  if (factura.estado === 'anulada' || factura.estado === 'borrador') return null;

  const saldo = saldoFirmadoFactura(factura);
  if (esDocumentoAbono(factura)) {
    if (!(saldo < -UMBRAL)) return null;
    const importe = round2(Math.abs(saldo));
    return importe > 0 ? { motivo: 'abono', importe } : null;
  }

  const exceso = excesoPendienteEfectivo(factura);
  if (!(exceso > UMBRAL)) return null;
  const importe = round2(exceso);
  return importe > 0 ? { motivo: 'exceso', importe } : null;
}

function numeroVisible(factura) {
  const proveedor = texto(factura?.numero_factura_proveedor);
  if (proveedor) return proveedor;
  return texto(factura?.numero_factura);
}

function fechaOrden(factura) {
  const s = texto(factura?.fecha_emision);
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function dedupeFacturas(facturas) {
  const vistos = new Set();
  const out = [];
  for (const f of facturas || []) {
    if (!f) continue;
    const id = texto(f.id_factura);
    if (id) {
      if (vistos.has(id)) continue;
      vistos.add(id);
    }
    out.push(f);
  }
  return out;
}

function nombreNoVacio(facturas, campo) {
  for (const f of facturas) {
    const nombre = texto(f?.[campo]);
    if (nombre) return nombre;
  }
  return '';
}

/**
 * Agrupa el crédito sin aplicar de las candidatas que comparten par con
 * alguna ancla permitida.
 *
 * @param {object[]} anclas facturas seleccionadas para la remesa
 * @param {object[]} candidatas histórico del par (puede incluir otros pares; se filtran)
 * @param {Set<string>|null} [empresasOk] null = sin restricción de sociedad
 * @returns {{ grupos: object[], total: number }}
 */
export function agruparCreditoSinAplicar(anclas, candidatas, empresasOk = null) {
  const permitidas = empresasOk === undefined ? null : empresasOk;
  const anclasOk = dedupeFacturas(anclas).filter((f) => esAnclaCreditoRemesa(f, permitidas));
  if (anclasOk.length === 0) return { grupos: [], total: 0 };

  const clusters = [];
  for (const ancla of anclasOk) {
    const cluster = clusters.find((c) => mismoParEmisorProveedor(c.anclas[0], ancla));
    if (cluster) cluster.anclas.push(ancla);
    else clusters.push({ anclas: [ancla], lineas: [] });
  }

  for (const factura of dedupeFacturas(candidatas)) {
    if (!facturaEmisorPermitido(factura, permitidas)) continue;
    const credito = clasificarCreditoFactura(factura);
    if (!credito) continue;
    const cluster = clusters.find((c) => mismoParEmisorProveedor(c.anclas[0], factura));
    if (!cluster) continue;
    cluster.lineas.push({ factura, ...credito });
  }

  const grupos = [];
  for (const cluster of clusters) {
    if (cluster.lineas.length === 0) continue;
    cluster.lineas.sort((a, b) => {
      const cmp = fechaOrden(a.factura).localeCompare(fechaOrden(b.factura));
      if (cmp !== 0) return cmp;
      return texto(a.factura.id_factura).localeCompare(texto(b.factura.id_factura));
    });
    const fuentes = [...cluster.anclas, ...cluster.lineas.map((l) => l.factura)];
    const lineas = cluster.lineas.map((l) => ({
      id_factura: texto(l.factura.id_factura),
      numero: numeroVisible(l.factura),
      motivo: l.motivo,
      importe: l.importe,
    }));
    grupos.push({
      proveedorNombre: nombreNoVacio(fuentes, 'empresa_nombre'),
      sociedadNombre: nombreNoVacio(fuentes, 'emisor_nombre'),
      lineas,
      total: round2(lineas.reduce((s, l) => s + l.importe, 0)),
    });
  }

  grupos.sort((a, b) =>
    a.proveedorNombre.localeCompare(b.proveedorNombre, 'es', { sensitivity: 'base' })
    || a.sociedadNombre.localeCompare(b.sociedadNombre, 'es', { sensitivity: 'base' }),
  );

  return {
    grupos,
    total: round2(grupos.reduce((s, g) => s + g.total, 0)),
  };
}

/**
 * Misma vía que `facturasDelPar`: con CIF de proveedor, Proveedor-Fecha;
 * si no, Emisor-Fecha. Sirve para no repetir la Query.
 * @returns {{ tipo: 'proveedor'|'emisor', valor: string }|null}
 */
export function claveLecturaPar(factura) {
  const cifProveedor = normalizeCif(factura?.empresa_cif);
  if (cifProveedor) return { tipo: 'proveedor', valor: cifProveedor };
  const idEmisor = texto(factura?.emisor_id);
  if (idEmisor) return { tipo: 'emisor', valor: formatId6(idEmisor) };
  const cifEmisor = normalizeCif(factura?.emisor_cif);
  if (cifEmisor) return { tipo: 'emisor', valor: `CIF#${cifEmisor}` };
  return null;
}

async function cargarFacturasPorIds(ids) {
  const distintos = [...new Set(ids.map((id) => texto(id)).filter(Boolean))];
  if (distintos.length === 0) return [];
  const claves = await Promise.all(distintos.map((id) => keyForFacturaPrincipalId(id)));
  const items = [];
  for (let i = 0; i < claves.length; i += MAX_CLAVES_BATCH) {
    let pendientes = claves.slice(i, i + MAX_CLAVES_BATCH);
    for (let intento = 0; intento < MAX_INTENTOS_BATCH && pendientes.length > 0; intento += 1) {
      const r = await docClient.send(new BatchGetCommand({
        RequestItems: { [tables.facturas]: { Keys: pendientes } },
      }));
      items.push(...(r.Responses?.[tables.facturas] || []));
      pendientes = r.UnprocessedKeys?.[tables.facturas]?.Keys || [];
    }
    if (pendientes.length > 0) {
      throw new Error('BatchGet de facturas dejó claves sin procesar');
    }
  }
  return items;
}

async function leerHistoricoPares(anclas) {
  const porClave = new Map();
  for (const ancla of anclas) {
    const clave = claveLecturaPar(ancla);
    if (!clave) continue;
    const k = `${clave.tipo}:${clave.valor}`;
    if (!porClave.has(k)) porClave.set(k, clave);
  }
  const listas = await Promise.all([...porClave.values()].map((clave) => (
    clave.tipo === 'proveedor'
      ? facturasPorProveedor(clave.valor)
      : facturasPorEmisor(clave.valor)
  )));
  return dedupeFacturas(listas.flat());
}

/**
 * Lee las facturas pedidas y el histórico de sus pares, y devuelve el crédito.
 * Ignora ids que no existen. Una sociedad no permitida no abre par ni aporta crédito.
 *
 * @param {string[]} facturaIds
 * @param {Set<string>|null} [empresasOk]
 */
export async function cargarCreditoSinAplicar(facturaIds, empresasOk = null) {
  const permitidas = empresasOk === undefined ? null : empresasOk;
  const cargadas = await cargarFacturasPorIds(facturaIds);
  const anclas = cargadas.filter((f) => esAnclaCreditoRemesa(f, permitidas));
  const historico = await leerHistoricoPares(anclas);
  return agruparCreditoSinAplicar(anclas, [...historico, ...anclas], permitidas);
}
