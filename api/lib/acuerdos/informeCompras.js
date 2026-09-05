/**
 * Informe de compras por acuerdo (solo lectura).
 * Cruza detalles de acuerdo con compras Ágora en el solape entre la vigencia
 * del acuerdo (FechaInicio–FechaFin) y el periodo del informe (fechaDesde–fechaHasta).
 * Si no hay solape, el acuerdo se excluye; las compras se consultan solo en el rango efectivo.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { queryComprasPorProductos } from '../dynamo/comprasProveedor.js';

const tableAcuerdos = tables.acuerdos;
const tableAcuerdosDetalles = tables.acuerdosDetalles;

function aportacionUnitaria(d) {
  const ap = Number(d.Aportacion) || 0;
  const ra = Number(d.Rappel) || 0;
  const de = Number(d.DescuentoExtra) || 0;
  return Math.round((ap + ra + de) * 100) / 100;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Solape entre vigencia del acuerdo y periodo del informe (YYYY-MM-DD, string-comparable).
 * Fechas de vigencia vacías no limitan el periodo.
 * @returns {{ desde: string, hasta: string } | null}
 */
export function rangoVigenteEnPeriodo(fechaInicio, fechaFin, periodoDesde, periodoHasta) {
  const desdeVigencia = String(fechaInicio ?? '').trim() || periodoDesde;
  const hastaVigencia = String(fechaFin ?? '').trim() || periodoHasta;
  const desde = desdeVigencia > periodoDesde ? desdeVigencia : periodoDesde;
  const hasta = hastaVigencia < periodoHasta ? hastaVigencia : periodoHasta;
  if (desde > hasta) return null;
  return { desde, hasta };
}

async function cargarAcuerdosMeta() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tableAcuerdos,
      ConsistentRead: true,
      FilterExpression: '#sk = :meta',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':meta': 'META' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function cargarTodosDetalles() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tableAcuerdosDetalles,
      ConsistentRead: true,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * @param {{ fechaDesde: string, fechaHasta: string, estado?: string, marca?: string, soloConCompras?: boolean }} opts
 */
export async function buildInformeCompras(opts) {
  const fechaDesde = String(opts.fechaDesde ?? '').trim();
  const fechaHasta = String(opts.fechaHasta ?? '').trim();
  if (!fechaDesde || !fechaHasta) {
    throw new Error('fechaDesde y fechaHasta son obligatorias (YYYY-MM-DD)');
  }
  if (fechaDesde > fechaHasta) {
    throw new Error('fechaDesde no puede ser mayor que fechaHasta');
  }

  const filtroEstado = String(opts.estado ?? '').trim();
  const filtroMarca = String(opts.marca ?? '').trim().toLowerCase();
  const soloConCompras = opts.soloConCompras === true || opts.soloConCompras === 'true';

  const [acuerdosItems, allDetalles] = await Promise.all([
    cargarAcuerdosMeta(),
    cargarTodosDetalles(),
  ]);

  const detallesPorAcuerdo = {};
  for (const d of allDetalles) {
    if (!detallesPorAcuerdo[d.PK]) detallesPorAcuerdo[d.PK] = [];
    detallesPorAcuerdo[d.PK].push(d);
  }

  const acuerdosFiltrados = acuerdosItems.filter((a) => {
    const detalles = detallesPorAcuerdo[a.PK] || [];
    if (detalles.length === 0) return false;
    if (filtroEstado && a.Estado !== filtroEstado) return false;
    if (filtroMarca && !String(a.Marca || '').toLowerCase().includes(filtroMarca)) return false;
    return true;
  });

  const lineas = [];
  const resumen = [];

  const bloques = await Promise.all(acuerdosFiltrados.map(async (acuerdo) => {
    const rango = rangoVigenteEnPeriodo(
      acuerdo.FechaInicio,
      acuerdo.FechaFin,
      fechaDesde,
      fechaHasta,
    );
    if (!rango) return null;

    const pk = acuerdo.PK;
    const detalles = detallesPorAcuerdo[pk] || [];
    const productIds = new Set(detalles.map((d) => String(d.ProductId || d.SK || '').trim()).filter(Boolean));
    const comprasPorProd = await queryComprasPorProductos(productIds, rango.desde, rango.hasta);

    let totalCompradas = 0;
    let totalAportacionGenerada = 0;
    const lineasAcuerdo = [];

    for (const d of detalles) {
      const pid = String(d.ProductId ?? d.SK ?? '').trim();
      const compradas = comprasPorProd[pid] || 0;
      const au = aportacionUnitaria(d);
      const aportacionGenerada = round2(compradas * au);
      totalCompradas += compradas;
      totalAportacionGenerada += aportacionGenerada;
      lineasAcuerdo.push({
        acuerdoPK: pk,
        Marca: acuerdo.Marca || '',
        Nombre: acuerdo.Nombre || '',
        Estado: acuerdo.Estado || '',
        FechaInicio: acuerdo.FechaInicio || '',
        FechaFin: acuerdo.FechaFin || '',
        ProductId: pid,
        ProductName: d.ProductName || pid,
        Cantidad: d.Cantidad || 0,
        Compradas: compradas,
        Aportacion: Number(d.Aportacion) || 0,
        Rappel: Number(d.Rappel) || 0,
        DescuentoExtra: Number(d.DescuentoExtra) || 0,
        AportacionUnitaria: au,
        AportacionGenerada: aportacionGenerada,
      });
    }

    totalAportacionGenerada = round2(totalAportacionGenerada);

    if (soloConCompras && totalCompradas <= 0) return null;

    lineasAcuerdo.sort((a, b) => (a.ProductName || '').localeCompare(b.ProductName || '', 'es'));

    return {
      resumen: {
        acuerdoPK: pk,
        Marca: acuerdo.Marca || '',
        Nombre: acuerdo.Nombre || '',
        Estado: acuerdo.Estado || '',
        FechaInicio: acuerdo.FechaInicio || '',
        FechaFin: acuerdo.FechaFin || '',
        numProductos: detalles.length,
        totalCompradas,
        totalAportacionGenerada,
      },
      lineas: lineasAcuerdo,
    };
  }));

  for (const bloque of bloques) {
    if (!bloque) continue;
    resumen.push(bloque.resumen);
    lineas.push(...bloque.lineas);
  }

  resumen.sort((a, b) => {
    const m = (a.Marca || '').localeCompare(b.Marca || '', 'es');
    if (m !== 0) return m;
    return (b.totalAportacionGenerada || 0) - (a.totalAportacionGenerada || 0);
  });

  lineas.sort((a, b) => {
    const m = (a.Marca || '').localeCompare(b.Marca || '', 'es');
    if (m !== 0) return m;
    return (a.ProductName || '').localeCompare(b.ProductName || '', 'es');
  });

  const totales = {
    acuerdos: resumen.length,
    compradas: resumen.reduce((s, r) => s + (r.totalCompradas || 0), 0),
    aportacionGenerada: round2(resumen.reduce((s, r) => s + (r.totalAportacionGenerada || 0), 0)),
  };

  return {
    fechaDesde,
    fechaHasta,
    resumen,
    lineas,
    totales,
  };
}
