/**
 * Deuda con proveedores (solo lectura): facturas de gasto (IN) agrupadas por
 * proveedor, con lo facturado, pagado y pendiente en un rango, la deuda viva
 * anterior al rango, su antigüedad y el saldo cruzado entre sociedades del grupo.
 *
 * `hoy` es la fecha natural en Madrid (fecha documental), no la jornada de
 * negocio. Todas las lecturas van por GSI (`consultaIndice.js`), nunca Scan.
 */

import { normalizeCif } from '../empresaCif.js';
import { formatId6, facturaEmisorPermitido } from '../usuarioLocales.js';
import { fechaIndiceIso } from './clavesIndice.js';
import { fechaEmisionFacturaAIso } from './idDocumento.js';
import { saldoFirmadoFactura } from './compensacionFactura.js';
import { excesoPendienteEfectivo } from './excesoPago.js';
import { facturasPorEstado, facturasPorTipo, remesasActivas } from './consultaIndice.js';
import { indexRemesasActivasPorFactura } from '../remesas/facturaEnRemesa.js';

export const TOLERANCIA_DEUDA = 10;
export const MAX_ANIOS_RANGO_DEUDA = 3;

/** Estados de una IN que pueden conservar saldo vivo. */
export const ESTADOS_CON_SALDO = Object.freeze([
  'pendiente_revision',
  'pendiente_pago',
  'parcialmente_pagada',
  'vencida',
]);
const ESTADOS_CON_SALDO_SET = new Set(ESTADOS_CON_SALDO);
const ESTADOS_EXCLUIDOS = new Set(['anulada', 'borrador']);
const UMBRAL = 0.01;
const MS_DIA = 24 * 60 * 60 * 1000;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function texto(v) {
  return String(v ?? '').trim();
}

/** Fecha guardada (ISO o dd/mm/aaaa) → `YYYY-MM-DD` válido, o ''. */
function fechaIso(valor) {
  return fechaIndiceIso(fechaEmisionFacturaAIso(valor) || '');
}

function fechaEmisionIso(f) {
  return fechaIso(f?.fecha_emision) || fechaIndiceIso(f?.gsi_fecha) || fechaIso(f?.creado_en);
}

function idSociedad(valor) {
  if (texto(valor) === '') return '';
  const id = formatId6(valor);
  return id === '000000' ? '' : id;
}

function diasEntre(desdeIso, hastaIso) {
  return Math.round((Date.parse(`${hastaIso}T00:00:00Z`) - Date.parse(`${desdeIso}T00:00:00Z`)) / MS_DIA);
}

// ─── Funciones puras ───

/** 'CIF:<cif>' | 'ID:<empresa_id>' | 'NOM:<nombre en minúsculas>'. */
export function claveProveedor(f) {
  const cif = normalizeCif(f?.empresa_cif);
  if (cif) return `CIF:${cif}`;
  const id = texto(f?.empresa_id);
  if (id) return `ID:${id}`;
  return `NOM:${texto(f?.empresa_nombre).toLowerCase()}`;
}

/** 'cuadrado' | 'vencido' | 'pendiente'. La tolerancia es inclusiva. */
export function estadoDeuda({ diferencia = 0, anteriorPendiente = 0, vencido = 0 } = {}, tolerancia = TOLERANCIA_DEUDA) {
  if (Math.abs(round2(Number(diferencia) + Number(anteriorPendiente))) <= tolerancia) return 'cuadrado';
  if (Number(vencido) > UMBRAL) return 'vencido';
  return 'pendiente';
}

/** Tramo por días desde `fecha_vencimiento` hasta `hoy`. Sin vencimiento → 'no_vencido'. */
export function tramoAntiguedad(f, hoy) {
  const venc = fechaIso(f?.fecha_vencimiento);
  if (!venc || venc >= hoy) return 'no_vencido';
  const dias = diasEntre(venc, hoy);
  if (dias <= 30) return 'd0_30';
  if (dias <= 60) return 'd31_60';
  if (dias <= 90) return 'd61_90';
  return 'd90mas';
}

/** Día anterior a un `YYYY-MM-DD`. */
export function diaAnterior(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

const PARTES_DIA_MADRID = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Día natural en Madrid (`YYYY-MM-DD`). */
export function hoyMadridIso(date = new Date()) {
  const partes = {};
  for (const p of PARTES_DIA_MADRID.formatToParts(date)) {
    if (p.type !== 'literal') partes[p.type] = p.value;
  }
  return `${partes.year}-${partes.month}-${partes.day}`;
}

/** ¿`hasta` queda más de `MAX_ANIOS_RANGO_DEUDA` años después de `desde`? */
export function superaRangoMaximo(desde, hasta, anios = MAX_ANIOS_RANGO_DEUDA) {
  const [y, m, d] = hasta.split('-').map(Number);
  const limite = new Date(Date.UTC(y - anios, m - 1, d)).toISOString().slice(0, 10);
  return desde < limite;
}

/** IN que cuenta para la deuda: ni anulada ni borrador. */
export function esFacturaDeuda(f) {
  return texto(f?.tipo).toUpperCase() === 'IN' && !ESTADOS_EXCLUIDOS.has(texto(f?.estado));
}

function conSaldoVivo(f) {
  return ESTADOS_CON_SALDO_SET.has(texto(f?.estado)) && Math.abs(saldoFirmadoFactura(f)) > UMBRAL;
}

/** Factura completa más los campos calculados de la deuda. */
export function facturaDeuda(f, { hoy, desde = '', idxRemesas = null } = {}) {
  const saldo = saldoFirmadoFactura(f);
  const emision = fechaEmisionIso(f);
  const venc = fechaIso(f?.fecha_vencimiento);
  const vencida = saldo > UMBRAL && !!venc && venc < hoy;
  return {
    ...f,
    fecha_emision: emision || f?.fecha_emision || '',
    fecha_vencimiento: venc || f?.fecha_vencimiento || '',
    saldo_pendiente: saldo,
    exceso_pendiente: excesoPendienteEfectivo(f),
    es_abono: f?.es_abono === true || (Number(f?.total_factura) || 0) < 0,
    remesaActiva: (texto(f?.tipo).toUpperCase() === 'IN' && idxRemesas?.get(f?.id_factura)) || null,
    vencida,
    diasVencida: vencida ? diasEntre(venc, hoy) : 0,
    tramo: saldo > UMBRAL ? tramoAntiguedad(f, hoy) : null,
    anteriorAlPeriodo: !!desde && !!emision && emision < desde,
  };
}

/**
 * CIF normalizado → { id, nombre, cif } de las sociedades del grupo, tomadas de
 * los `emisor_*` de las IN (quien recibe una factura de gasto es del grupo).
 */
export function mapaSociedadesGrupo(facturas) {
  const mapa = new Map();
  for (const f of facturas || []) {
    const cif = normalizeCif(f?.emisor_cif);
    if (!cif) continue;
    const previa = mapa.get(cif);
    mapa.set(cif, {
      id: previa?.id || idSociedad(f.emisor_id),
      nombre: previa?.nombre || texto(f.emisor_nombre),
      cif,
    });
  }
  return mapa;
}

/** Sociedades emisoras que aparecen en `facturas`, por id. */
export function sociedadesDeFacturas(facturas) {
  const porId = new Map();
  for (const f of facturas || []) {
    const id = idSociedad(f?.emisor_id);
    if (!id) continue;
    const previa = porId.get(id);
    porId.set(id, {
      id,
      nombre: previa?.nombre || texto(f.emisor_nombre),
      cif: previa?.cif || normalizeCif(f.emisor_cif),
    });
  }
  return [...porId.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.id.localeCompare(b.id));
}

/**
 * Reglas de "nos debe": la contraparte (`empresa_*` de una IN de la sociedad B)
 * tiene que ser una sociedad nuestra, permitida al usuario y, si se filtra por
 * `emisorId`, esa misma.
 */
function contextoIntragrupo({ sociedadesGrupo, empresasOk, emisorId }) {
  const idsGrupo = new Set([...sociedadesGrupo.values()].map((s) => s.id).filter(Boolean));
  if (empresasOk) for (const id of empresasOk) idsGrupo.add(id);
  const cifPorId = new Map([...sociedadesGrupo.values()].filter((s) => s.id).map((s) => [s.id, s.cif]));

  function idContraparte(f) {
    const cif = normalizeCif(f?.empresa_cif);
    const porCif = cif ? sociedadesGrupo.get(cif)?.id : '';
    if (porCif) return porCif;
    const id = idSociedad(f?.empresa_id);
    return id && idsGrupo.has(id) ? id : '';
  }

  return {
    /** CIF de la sociedad que recibe la factura (la que debe). */
    cifDeudor(f) {
      return normalizeCif(f?.emisor_cif) || cifPorId.get(idSociedad(f?.emisor_id)) || '';
    },
    contraparteNuestra(f) {
      const id = idContraparte(f);
      if (!id) return false;
      if (emisorId && id !== emisorId) return false;
      if (empresasOk && !empresasOk.has(id)) return false;
      return true;
    },
  };
}

function tramosVacios() {
  return { noVencido: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90mas: 0 };
}

const CAMPO_TRAMO = { no_vencido: 'noVencido', d0_30: 'd0_30', d31_60: 'd31_60', d61_90: 'd61_90', d90mas: 'd90mas' };

function redondearTramos(t) {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round2(v)]));
}

/** Proveedor sin facturas visibles (detalle de una clave fuera de alcance o sin datos). */
export function proveedorVacio(clave) {
  const cif = clave.startsWith('CIF:') ? clave.slice(4) : '';
  const empresaId = clave.startsWith('ID:') ? clave.slice(3) : null;
  return {
    clave,
    nombre: clave.startsWith('NOM:') ? clave.slice(4) : '',
    cif,
    empresaId,
    facturado: 0,
    pagado: 0,
    pendiente: 0,
    diferencia: 0,
    vencido: 0,
    pctPagado: 0,
    estado: 'cuadrado',
    saldoAFavor: false,
    numFacturas: 0,
    numPendientes: 0,
    numVencidas: 0,
    vencimientoMasAntiguo: null,
    anterior: { pendiente: 0, vencido: 0, numFacturas: 0 },
    antiguedad: tramosVacios(),
    intragrupo: null,
  };
}

/**
 * Agrega por proveedor. `periodo` y `anteriores` llegan ya filtrados por alcance
 * pero **no** por `emisorId`: las facturas de otra sociedad del grupo hacen falta
 * para el "nos debe" del intragrupo.
 *
 * @param {object} p
 * @param {object[]} p.periodo IN emitidas dentro del rango.
 * @param {object[]} p.anteriores IN emitidas antes del rango con saldo vivo.
 * @param {string} p.hoy
 * @param {Map<string, {id:string,nombre:string,cif:string}>} [p.sociedadesGrupo]
 * @param {Set<string>|null} [p.empresasOk]
 */
export function agregarDeudaProveedores({
  periodo = [],
  anteriores = [],
  hoy,
  tolerancia = TOLERANCIA_DEUDA,
  emisorId = '',
  q = '',
  sociedadesGrupo = null,
  empresasOk = null,
}) {
  const emisor = idSociedad(emisorId);
  const grupo = sociedadesGrupo || mapaSociedadesGrupo([...periodo, ...anteriores]);
  const intra = contextoIntragrupo({ sociedadesGrupo: grupo, empresasOk, emisorId: emisor });
  const delEmisor = (f) => !emisor || idSociedad(f.emisor_id) === emisor;

  const filas = new Map();
  function fila(f) {
    const clave = claveProveedor(f);
    let p = filas.get(clave);
    if (!p) {
      p = {
        ...proveedorVacio(clave),
        _fechaNombre: '',
        _sinVencimiento: 0,
      };
      filas.set(clave, p);
    }
    const emision = fechaEmisionIso(f);
    if (!p._fechaNombre || emision > p._fechaNombre) {
      p._fechaNombre = emision || p._fechaNombre;
      p.nombre = texto(f.empresa_nombre) || p.nombre;
      p.cif = normalizeCif(f.empresa_cif) || p.cif;
      p.empresaId = texto(f.empresa_id) || p.empresaId;
    }
    return p;
  }

  function acumularDeudaViva(p, f, saldo) {
    if (saldo <= UMBRAL) return;
    const venc = fechaIso(f.fecha_vencimiento);
    if (!venc) p._sinVencimiento += 1;
    else if (!p.vencimientoMasAntiguo || venc < p.vencimientoMasAntiguo) p.vencimientoMasAntiguo = venc;
    p.antiguedad[CAMPO_TRAMO[tramoAntiguedad(f, hoy)]] += saldo;
  }

  const esVencida = (f, saldo) => {
    const venc = fechaIso(f.fecha_vencimiento);
    return saldo > UMBRAL && !!venc && venc < hoy;
  };

  for (const f of periodo) {
    if (!delEmisor(f)) continue;
    const p = fila(f);
    const saldo = saldoFirmadoFactura(f);
    p.facturado += Number(f.total_factura) || 0;
    p.pagado += Number(f.total_cobrado) || 0;
    p.pendiente += saldo;
    p.numFacturas += 1;
    if (saldo > UMBRAL) p.numPendientes += 1;
    if (esVencida(f, saldo)) {
      p.numVencidas += 1;
      p.vencido += saldo;
    }
    acumularDeudaViva(p, f, saldo);
  }
  for (const f of anteriores) {
    if (!delEmisor(f)) continue;
    const p = fila(f);
    const saldo = saldoFirmadoFactura(f);
    p.anterior.pendiente += saldo;
    p.anterior.numFacturas += 1;
    if (esVencida(f, saldo)) p.anterior.vencido += saldo;
    acumularDeudaViva(p, f, saldo);
  }

  // "Nos debe": saldo de las IN de la sociedad B cuya contraparte es nuestra.
  const nosDebePorCif = new Map();
  for (const f of [...periodo, ...anteriores]) {
    const cifB = intra.cifDeudor(f);
    if (!cifB || !grupo.has(cifB) || !intra.contraparteNuestra(f)) continue;
    nosDebePorCif.set(cifB, (nosDebePorCif.get(cifB) || 0) + saldoFirmadoFactura(f));
  }

  const busqueda = texto(q).toLowerCase();
  const busquedaCif = normalizeCif(q);
  let proveedores = [...filas.values()].map((p) => {
    const { _fechaNombre, _sinVencimiento, ...resto } = p;
    const out = {
      ...resto,
      facturado: round2(p.facturado),
      pagado: round2(p.pagado),
      pendiente: round2(p.pendiente),
      vencido: round2(p.vencido),
      anterior: {
        pendiente: round2(p.anterior.pendiente),
        vencido: round2(p.anterior.vencido),
        numFacturas: p.anterior.numFacturas,
      },
      antiguedad: redondearTramos(p.antiguedad),
    };
    out.diferencia = round2(out.facturado - out.pagado);
    out.pctPagado = out.facturado > 0 ? round2((out.pagado / out.facturado) * 100) : 0;
    out.estado = estadoDeuda(
      { diferencia: out.diferencia, anteriorPendiente: out.anterior.pendiente, vencido: out.vencido + out.anterior.vencido },
      tolerancia,
    );
    out.saldoAFavor = out.estado !== 'cuadrado' && out.diferencia < -tolerancia;
    const soc = out.cif ? grupo.get(out.cif) : null;
    if (soc) {
      const leDebemos = round2(out.pendiente + out.anterior.pendiente);
      const nosDebe = round2(nosDebePorCif.get(out.cif) || 0);
      out.intragrupo = {
        sociedadId: soc.id || null,
        leDebemos,
        nosDebe,
        neto: round2(nosDebe - leDebemos),
        nosDebeParcial: !!empresasOk && !(soc.id && empresasOk.has(soc.id)),
      };
    }
    Object.defineProperty(out, '_sinVencimiento', { value: _sinVencimiento, enumerable: false });
    return out;
  });

  if (busqueda) {
    proveedores = proveedores.filter((p) =>
      p.nombre.toLowerCase().includes(busqueda) || (busquedaCif && p.cif.includes(busquedaCif)));
  }

  proveedores.sort((a, b) =>
    (b.pendiente + b.anterior.pendiente) - (a.pendiente + a.anterior.pendiente)
    || a.nombre.localeCompare(b.nombre, 'es')
    || a.clave.localeCompare(b.clave));

  const kpis = {
    facturado: 0, pagado: 0, pendiente: 0, vencido: 0,
    numFacturas: 0, numProveedores: proveedores.length, pendienteAnterior: 0, vencidoAnterior: 0,
  };
  const antiguedad = { ...tramosVacios(), numSinVencimiento: 0 };
  for (const p of proveedores) {
    kpis.facturado += p.facturado;
    kpis.pagado += p.pagado;
    kpis.pendiente += p.pendiente;
    kpis.vencido += p.vencido;
    kpis.numFacturas += p.numFacturas;
    kpis.pendienteAnterior += p.anterior.pendiente;
    kpis.vencidoAnterior += p.anterior.vencido;
    for (const k of Object.keys(tramosVacios())) antiguedad[k] += p.antiguedad[k];
    antiguedad.numSinVencimiento += p._sinVencimiento;
  }
  for (const k of ['facturado', 'pagado', 'pendiente', 'vencido', 'pendienteAnterior', 'vencidoAnterior']) {
    kpis[k] = round2(kpis[k]);
  }
  for (const k of Object.keys(tramosVacios())) antiguedad[k] = round2(antiguedad[k]);

  return { kpis, antiguedad, proveedores, contraparteNuestra: intra.contraparteNuestra, cifDeudor: intra.cifDeudor };
}

// ─── Lecturas ───

function sinDuplicados(listas) {
  const vistos = new Map();
  for (const f of listas.flat()) {
    if (f?.id_factura != null && !vistos.has(f.id_factura)) vistos.set(f.id_factura, f);
  }
  return [...vistos.values()];
}

function separarPeriodoYAnteriores(facturas, desde, hasta) {
  const periodo = [];
  const anteriores = [];
  for (const f of facturas) {
    if (!esFacturaDeuda(f)) continue;
    const emision = fechaEmisionIso(f);
    if (emision && emision < desde) {
      if (conSaldoVivo(f)) anteriores.push(f);
    } else if (!emision || emision <= hasta) {
      periodo.push(f);
    }
  }
  return { periodo, anteriores };
}

/** IN del rango (Tipo-Fecha) y deuda viva anterior (Estado-Fecha por estado con saldo). */
async function leerPeriodoYAnteriores(desde, hasta) {
  const limite = diaAnterior(desde);
  const [enRango, ...porEstado] = await Promise.all([
    facturasPorTipo('IN', desde, hasta),
    ...ESTADOS_CON_SALDO.map((estado) => facturasPorEstado(estado, { hasta: limite })),
  ]);
  return separarPeriodoYAnteriores(sinDuplicados([enRango, ...porEstado]), desde, hasta);
}

function ordenarFacturasDetalle(facturas) {
  const pendientes = facturas.filter((f) => Math.abs(f.saldo_pendiente) > UMBRAL);
  const resto = facturas.filter((f) => Math.abs(f.saldo_pendiente) <= UMBRAL);
  pendientes.sort((a, b) => {
    const va = a.fecha_vencimiento || '9999-12-31';
    const vb = b.fecha_vencimiento || '9999-12-31';
    return va.localeCompare(vb) || (a.fecha_emision || '').localeCompare(b.fecha_emision || '');
  });
  resto.sort((a, b) => (b.fecha_emision || '').localeCompare(a.fecha_emision || ''));
  return [...pendientes, ...resto];
}

/**
 * Lecturas comunes a resumen y detalle. Las sociedades del grupo salen de todas
 * las IN leídas (antes del alcance) para que resumen y detalle reconozcan las
 * mismas; los importes, solo de las que están en alcance.
 */
async function leerDeudaEnAlcance(desde, hasta, empresasOk) {
  const leido = await leerPeriodoYAnteriores(desde, hasta);
  const sociedadesGrupo = mapaSociedadesGrupo([...leido.periodo, ...leido.anteriores]);
  const enAlcance = (f) => facturaEmisorPermitido(f, empresasOk);
  return {
    sociedadesGrupo,
    periodo: leido.periodo.filter(enAlcance),
    anteriores: leido.anteriores.filter(enAlcance),
  };
}

/**
 * Resumen por proveedor.
 * @param {{ desde:string, hasta:string, empresasOk:Set<string>|null, emisorId?:string, q?:string, hoy:string, incluirFacturas?:boolean }} p
 */
export async function cargarDeudaProveedores({ desde, hasta, empresasOk, emisorId = '', q = '', hoy, incluirFacturas = false }) {
  const { sociedadesGrupo, periodo, anteriores } = await leerDeudaEnAlcance(desde, hasta, empresasOk);
  const sociedades = sociedadesDeFacturas([...periodo, ...anteriores]);

  const { kpis, antiguedad, proveedores } = agregarDeudaProveedores({
    periodo, anteriores, hoy, emisorId, q, sociedadesGrupo, empresasOk,
  });

  let facturas = [];
  if (incluirFacturas) {
    const idxRemesas = indexRemesasActivasPorFactura(await remesasActivas());
    const claves = new Set(proveedores.map((p) => p.clave));
    const emisor = idSociedad(emisorId);
    facturas = [...periodo, ...anteriores]
      .filter((f) => (!emisor || idSociedad(f.emisor_id) === emisor) && claves.has(claveProveedor(f)))
      .map((f) => facturaDeuda(f, { hoy, desde, idxRemesas }))
      .sort((a, b) => texto(a.empresa_nombre).localeCompare(texto(b.empresa_nombre), 'es')
        || (a.fecha_emision || '').localeCompare(b.fecha_emision || ''));
  }

  return {
    rango: { desde, hasta },
    hoy,
    tolerancia: TOLERANCIA_DEUDA,
    sociedades,
    kpis,
    antiguedad,
    proveedores,
    facturas,
  };
}

/**
 * Detalle de un proveedor. Usa las mismas lecturas y la misma agregación que el
 * resumen y filtra en JS: la tarjeta del detalle es la del resumen. Leer solo
 * Proveedor-Fecha/Emisor-Fecha no basta para saber qué contrapartes son del
 * grupo, y su histórico anterior no se puede acotar por estado.
 */
export async function cargarDetalleProveedor({ clave, desde, hasta, empresasOk, emisorId = '', hoy }) {
  const { sociedadesGrupo, periodo, anteriores } = await leerDeudaEnAlcance(desde, hasta, empresasOk);
  const emisor = idSociedad(emisorId);
  const todas = [...periodo, ...anteriores];
  const propiasVisibles = todas.filter((f) =>
    claveProveedor(f) === clave && (!emisor || idSociedad(f.emisor_id) === emisor));

  const agregado = agregarDeudaProveedores({ periodo, anteriores, hoy, emisorId, sociedadesGrupo, empresasOk });
  const proveedor = agregado.proveedores.find((p) => p.clave === clave) || proveedorVacio(clave);

  const idxRemesas = indexRemesasActivasPorFactura(await remesasActivas());
  const aDeuda = (f) => facturaDeuda(f, { hoy, desde, idxRemesas });
  const facturas = ordenarFacturasDetalle(propiasVisibles.map(aDeuda));

  let intragrupo = null;
  if (proveedor.intragrupo) {
    const cif = proveedor.cif;
    const nosDebe = todas
      .filter((f) => agregado.cifDeudor(f) === cif && agregado.contraparteNuestra(f))
      .map(aDeuda)
      .filter((f) => Math.abs(f.saldo_pendiente) > UMBRAL);
    intragrupo = {
      leDebemos: facturas.filter((f) => Math.abs(f.saldo_pendiente) > UMBRAL),
      nosDebe: ordenarFacturasDetalle(nosDebe),
    };
  }

  return { rango: { desde, hasta }, proveedor, facturas, intragrupo };
}
