/**
 * Albaranes que faltan: albaranes citados en una factura de gasto (IN) que no
 * están en Ágora. Llamadas API, clasificación de coincidencias en Ágora,
 * auto-resolución y agrupación del informe.
 *
 * Contrato backend:
 * - PUT  /api/facturacion/facturas/:id/albaranes-faltantes  { albaranes_faltantes, version? } → 409 si la versión no coincide
 * - POST /api/compras/albaranes-faltantes/comprobar          { consultas }
 */
import { apiFetch } from '../utils/api';
import { normDocProveedor } from '../utils/docProveedor';
import type { FacturaListado } from '../types/factura';
import type {
  AlbaranFaltante,
  AlbaranFaltanteInput,
  CoincidenciaAgora,
  ConsultaComprobarAlbaranes,
  EmpresaCoincidencia,
  ResultadoComprobarAlbaran,
  UbicacionOtraEmpresa,
} from '../types/albaranesFaltantes';

export type {
  AlbaranFaltante,
  AlbaranFaltanteInput,
  CoincidenciaAgora,
  ConsultaComprobarAlbaranes,
  EmpresaCoincidencia,
  ResultadoComprobarAlbaran,
  EstadoAlbaranFaltante,
  UbicacionOtraEmpresa,
} from '../types/albaranesFaltantes';

/** Empresa del grupo dueña del almacén de una coincidencia (misma resolución que la conciliación). */
export type ResolverEmpresaCoincidencia = (c: CoincidenciaAgora) => EmpresaCoincidencia;

export const SIN_EMPRESA_ASOCIADA = 'Sin empresa asociada';

const MAX_CONSULTAS_POR_PETICION = 50;
const MAX_NUMEROS_POR_CONSULTA = 100;

/** Normaliza CIF/NIF para comparar (solo A–Z0–9, mayúsculas). */
export function normCif(val: unknown): string {
  return String(val ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function normNombre(val: unknown): string {
  return String(val ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Años de consulta: el de la fecha del albarán o, si no hay, el de la factura
 * (y el anterior si la factura es de enero o febrero: albaranes de diciembre).
 * Descarta años fuera de 2000..actual+1.
 */
export function aniosConsulta(fechaAlbaran: string | null | undefined, fechaFactura: string | null | undefined): number[] {
  const maxAnio = new Date().getFullYear() + 1;
  const validos = (anios: number[]) => anios.filter((a) => Number.isInteger(a) && a >= 2000 && a <= maxAnio);
  const ma = String(fechaAlbaran ?? '').match(/^(\d{4})-\d{2}-\d{2}/);
  if (ma) return validos([Number(ma[1])]);
  const mf = String(fechaFactura ?? '').match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!mf) return [];
  const anio = Number(mf[1]);
  const mes = Number(mf[2]);
  return validos(mes === 1 || mes === 2 ? [anio, anio - 1] : [anio]);
}

/** La factura tiene proveedor identificado (CIF o nombre) para consultar en Ágora. */
export function facturaConProveedor(f: Pick<FacturaListado, 'empresa_cif' | 'empresa_nombre'>): boolean {
  return !!(String(f.empresa_cif ?? '').trim() || String(f.empresa_nombre ?? '').trim());
}

/** Nº factura visible: nº del proveedor o, si falta, el interno. */
export function numeroFacturaVisible(f: FacturaListado): string {
  return String(f.numero_factura_proveedor || f.numero_factura || '—').trim();
}

export function fechaFacturaIso(f: FacturaListado): string {
  return String(f.fecha_emision ?? '').slice(0, 10);
}

function claveProveedorConsulta(cif: string, nombre: string): string {
  const c = normCif(cif);
  return c ? `cif:${c}` : `nom:${normNombre(nombre)}`;
}

/** Clave de un resultado de comprobación (proveedor + año + nº normalizado). */
export function claveResultado(cif: string, nombre: string, anio: number | string, numeroNorm: string): string {
  return `${claveProveedorConsulta(cif, nombre)}|${String(anio)}|${numeroNorm}`;
}

/**
 * Coincidencias fusionadas de todos los años consultados. `undefined` si
 * ningún año tiene resultado válido (no comprobado).
 */
export function coincidenciasDe(
  indice: Map<string, CoincidenciaAgora[]>,
  proveedorCif: string,
  proveedorNombre: string,
  anios: number[],
  numeroNorm: string,
): CoincidenciaAgora[] | undefined {
  let algun = false;
  const vistas = new Set<string>();
  const out: CoincidenciaAgora[] = [];
  for (const anio of anios) {
    const lista = indice.get(claveResultado(proveedorCif, proveedorNombre, anio, numeroNorm));
    if (!lista) continue;
    algun = true;
    for (const c of lista) {
      const k = `${c.warehouse_id}|${c.almacen}|${c.fecha}|${c.albaran}`;
      if (vistas.has(k)) continue;
      vistas.add(k);
      out.push(c);
    }
  }
  return algun ? out : undefined;
}

// ── API ──

/** El PUT se rechazó porque la factura cambió (versión distinta). */
export class ConflictoVersionError extends Error {
  constructor() {
    super('La factura ha cambiado mientras la editabas. Recarga la conciliación y vuelve a intentarlo.');
    this.name = 'ConflictoVersionError';
  }
}

export async function guardarAlbaranesFaltantes(
  facturaId: string,
  items: AlbaranFaltanteInput[],
  version?: number,
): Promise<{ albaranes_faltantes: AlbaranFaltante[]; version?: number }> {
  const res = await apiFetch(`/api/facturacion/facturas/${facturaId}/albaranes-faltantes`, {
    method: 'PUT',
    body: JSON.stringify(version != null ? { albaranes_faltantes: items, version } : { albaranes_faltantes: items }),
  });
  if (res.status === 409) throw new ConflictoVersionError();
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new Error(data?.error || `No se pudieron guardar los albaranes que faltan (${res.status})`);
  }
  return {
    albaranes_faltantes: Array.isArray(data.albaranes_faltantes) ? data.albaranes_faltantes : [],
    version: typeof data.version === 'number' ? data.version : undefined,
  };
}

/**
 * Comprueba en Ágora (todo el año, todas las empresas) por proveedor y Nº doc.
 * prov. Trocea a ≤ 50 consultas por petición y ≤ 100 números por consulta.
 * Devuelve un índice `claveResultado → coincidencias`; las consultas inválidas
 * no entran en el índice (quedan como no comprobadas).
 */
export async function comprobarAlbaranesFaltantes(
  consultas: ConsultaComprobarAlbaranes[],
): Promise<Map<string, CoincidenciaAgora[]>> {
  const planas: ConsultaComprobarAlbaranes[] = [];
  for (const c of consultas) {
    const nums = Array.from(new Set(c.numeros.map((n) => normDocProveedor(n)).filter(Boolean)));
    for (let i = 0; i < nums.length; i += MAX_NUMEROS_POR_CONSULTA) {
      planas.push({ ...c, numeros: nums.slice(i, i + MAX_NUMEROS_POR_CONSULTA) });
    }
  }
  const indice = new Map<string, CoincidenciaAgora[]>();
  for (let i = 0; i < planas.length; i += MAX_CONSULTAS_POR_PETICION) {
    const lote = planas.slice(i, i + MAX_CONSULTAS_POR_PETICION);
    const res = await apiFetch('/api/compras/albaranes-faltantes/comprobar', {
      method: 'POST',
      body: JSON.stringify({ consultas: lote }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      throw new Error(data?.error || `No se pudo comprobar en Ágora (${res.status})`);
    }
    const resultados: ResultadoComprobarAlbaran[] = Array.isArray(data.resultados) ? data.resultados : [];
    for (const r of resultados) {
      if (r.error) continue;
      const k = claveResultado(r.proveedor_cif, r.proveedor_nombre, r.anio, normDocProveedor(r.numero_norm));
      indice.set(k, Array.isArray(r.coincidencias) ? r.coincidencias : []);
    }
  }
  return indice;
}

// ── Clasificación ──

export type ClasificacionAgora =
  | { tipo: 'misma'; coincidencia: CoincidenciaAgora }
  | { tipo: 'otra'; coincidencia: CoincidenciaAgora; ubicacion: UbicacionOtraEmpresa }
  | { tipo: 'sin_empresa'; coincidencia: CoincidenciaAgora; ubicacion: UbicacionOtraEmpresa }
  | { tipo: 'ninguna' };

/**
 * Clasifica por la empresa del almacén de cada coincidencia. Prioridad: misma
 * sociedad que la factura > otra sociedad > almacén sin empresa asociada.
 * Si la sociedad de la factura no se resuelve, ninguna cuenta como «misma».
 */
export function clasificarCoincidencias(
  coincidencias: CoincidenciaAgora[] | undefined,
  cifSociedadFactura: string,
  empresaDeCoincidencia: ResolverEmpresaCoincidencia,
): ClasificacionAgora {
  const lista = coincidencias ?? [];
  if (lista.length === 0) return { tipo: 'ninguna' };
  const cifFactura = normCif(cifSociedadFactura);
  const conEmpresa = lista.map((c) => {
    const emp = empresaDeCoincidencia(c);
    return { c, cif: normCif(emp.cif), nombre: String(emp.nombre ?? '').trim() };
  });
  const misma = cifFactura ? conEmpresa.find((x) => x.cif === cifFactura) : undefined;
  if (misma) return { tipo: 'misma', coincidencia: misma.c };
  const otra = conEmpresa.find((x) => x.cif);
  if (otra) {
    return {
      tipo: 'otra',
      coincidencia: otra.c,
      ubicacion: ubicacionDesdeCoincidencia(otra.c, { cif: otra.cif, nombre: otra.nombre || otra.cif }),
    };
  }
  const sin = conEmpresa[0].c;
  return { tipo: 'sin_empresa', coincidencia: sin, ubicacion: ubicacionDesdeCoincidencia(sin, { cif: '', nombre: SIN_EMPRESA_ASOCIADA }) };
}

export function ubicacionDesdeCoincidencia(c: CoincidenciaAgora, empresa: EmpresaCoincidencia): UbicacionOtraEmpresa {
  return {
    empresa_cif: empresa.cif ?? '',
    empresa_nombre: empresa.nombre ?? '',
    almacen: c.almacen ?? '',
    fecha: c.fecha ?? '',
  };
}

function mismaUbicacion(a: AlbaranFaltante['en_otra_empresa'], b: AlbaranFaltante['en_otra_empresa']): boolean {
  if (!a || !b) return a === b;
  return (
    normCif(a.empresa_cif) === normCif(b.empresa_cif)
    && a.almacen === b.almacen
    && String(a.fecha).slice(0, 10) === String(b.fecha).slice(0, 10)
  );
}

// ── Auto-resolución al recargar ──

export type NotaPendienteRef = {
  facturaId: string;
  notaId: string;
  numeroNorm: string;
  anios: number[];
  proveedorCif: string;
  proveedorNombre: string;
};

/** Notas pendientes de las facturas (no anuladas, con proveedor identificado) con año resoluble. */
export function notasPendientes(facturas: FacturaListado[]): NotaPendienteRef[] {
  const out: NotaPendienteRef[] = [];
  for (const f of facturas) {
    if (f.estado === 'anulada' || !facturaConProveedor(f)) continue;
    for (const n of f.albaranes_faltantes ?? []) {
      if (n?.estado !== 'pendiente') continue;
      const numeroNorm = n.numero_norm || normDocProveedor(n.numero_doc_proveedor);
      const anios = aniosConsulta(n.fecha_albaran, fechaFacturaIso(f));
      if (!numeroNorm || anios.length === 0 || !n.id) continue;
      out.push({
        facturaId: f.id_factura,
        notaId: n.id,
        numeroNorm,
        anios,
        proveedorCif: String(f.empresa_cif ?? '').trim(),
        proveedorNombre: String(f.empresa_nombre ?? '').trim(),
      });
    }
  }
  return out;
}

export function firmaNota(n: NotaPendienteRef): string {
  return `${n.facturaId}|${n.notaId}|${n.numeroNorm}|${n.anios.join(',')}`;
}

/** Agrupa notas por (proveedor, año) en consultas para `comprobar`. */
export function consultasDesdeNotas(notas: NotaPendienteRef[]): ConsultaComprobarAlbaranes[] {
  const map = new Map<string, ConsultaComprobarAlbaranes>();
  for (const n of notas) {
    for (const anio of n.anios) {
      const k = `${claveProveedorConsulta(n.proveedorCif, n.proveedorNombre)}|${anio}`;
      let c = map.get(k);
      if (!c) {
        c = { proveedor_cif: n.proveedorCif, proveedor_nombre: n.proveedorNombre, anio, numeros: [] };
        map.set(k, c);
      }
      if (!c.numeros.includes(n.numeroNorm)) c.numeros.push(n.numeroNorm);
    }
  }
  return Array.from(map.values());
}

export type CambioAutoFactura = {
  facturaId: string;
  items: AlbaranFaltante[];
  resueltas: number;
  /** Versión de la factura sobre la que se calcularon los cambios. */
  version?: number;
};

/**
 * Aplica el resultado de la comprobación a las notas pendientes indicadas:
 * misma sociedad → resuelta (auto); otra sociedad o almacén sin empresa →
 * actualiza `en_otra_empresa` si cambió; sin coincidencias o no comprobada →
 * sin cambios. Solo devuelve las facturas con algún cambio.
 */
export function calcularCambiosAuto(params: {
  facturas: FacturaListado[];
  notas: NotaPendienteRef[];
  indice: Map<string, CoincidenciaAgora[]>;
  cifSociedadDeFactura: (f: FacturaListado) => string;
  empresaDeCoincidencia: ResolverEmpresaCoincidencia;
  ahoraIso: string;
}): CambioAutoFactura[] {
  const { facturas, notas, indice, cifSociedadDeFactura, empresaDeCoincidencia, ahoraIso } = params;
  const porFactura = new Map<string, Map<string, NotaPendienteRef>>();
  for (const n of notas) {
    let m = porFactura.get(n.facturaId);
    if (!m) {
      m = new Map();
      porFactura.set(n.facturaId, m);
    }
    m.set(n.notaId, n);
  }
  const cambios: CambioAutoFactura[] = [];
  for (const f of facturas) {
    const refs = porFactura.get(f.id_factura);
    if (!refs || !Array.isArray(f.albaranes_faltantes)) continue;
    const cifSoc = cifSociedadDeFactura(f);
    let resueltas = 0;
    let cambiada = false;
    const items = f.albaranes_faltantes.map((nota) => {
      const ref = refs.get(nota.id);
      if (!ref || nota.estado !== 'pendiente') return nota;
      const numeroNorm = nota.numero_norm || normDocProveedor(nota.numero_doc_proveedor);
      if (numeroNorm !== ref.numeroNorm) return nota;
      const lista = coincidenciasDe(indice, ref.proveedorCif, ref.proveedorNombre, ref.anios, ref.numeroNorm);
      if (!lista) return nota;
      const cls = clasificarCoincidencias(lista, cifSoc, empresaDeCoincidencia);
      if (cls.tipo === 'misma') {
        resueltas += 1;
        cambiada = true;
        return { ...nota, estado: 'resuelta' as const, resuelta_por: 'auto' as const, resuelta_en: ahoraIso, en_otra_empresa: null };
      }
      if (cls.tipo === 'otra' || cls.tipo === 'sin_empresa') {
        if (mismaUbicacion(nota.en_otra_empresa, cls.ubicacion)) return nota;
        cambiada = true;
        return { ...nota, en_otra_empresa: cls.ubicacion };
      }
      return nota;
    });
    if (cambiada) cambios.push({ facturaId: f.id_factura, items, resueltas, version: f.version });
  }
  return cambios;
}

// ── Informe ──

export type FiltroEstadoInforme = 'pendiente' | 'resuelta' | 'todas';
export const SOCIEDAD_TODAS = 'todas';
export const SOCIEDAD_SIN = 'sin';

export type FilaInformeAF = {
  key: string;
  facturaId: string;
  sociedadCif: string;
  sociedadNombre: string;
  proveedorNombre: string;
  proveedorCif: string;
  numeroDoc: string;
  fechaAlbaran: string;
  importe: number | null;
  facturaNumero: string;
  facturaFecha: string;
  nota: string;
  estado: AlbaranFaltante['estado'];
  resueltaPor: AlbaranFaltante['resuelta_por'];
  enOtraEmpresa: AlbaranFaltante['en_otra_empresa'];
};

export type GrupoProveedorInforme = {
  key: string;
  nombre: string;
  cif: string;
  filas: FilaInformeAF[];
};

export type GrupoSociedadInforme = {
  key: string;
  nombre: string;
  cif: string;
  proveedores: GrupoProveedorInforme[];
  total: number;
};

export const SIN_SOCIEDAD_LABEL = 'Sin sociedad';

export function estadoLabelFila(f: Pick<FilaInformeAF, 'estado' | 'resueltaPor' | 'enOtraEmpresa'>): string {
  if (f.estado === 'resuelta') return f.resueltaPor === 'manual' ? 'Resuelta (manual)' : 'Resuelta (auto)';
  if (f.enOtraEmpresa) return `En otra empresa: ${f.enOtraEmpresa.empresa_nombre || f.enOtraEmpresa.empresa_cif || '—'}`;
  return 'Pendiente';
}

export function ubicacionAgoraLabel(f: Pick<FilaInformeAF, 'enOtraEmpresa'>): string {
  const u = f.enOtraEmpresa;
  if (!u) return '';
  return [u.empresa_nombre || u.empresa_cif, u.almacen].filter(Boolean).join(' · ');
}

export function construirFilasInforme(params: {
  facturas: FacturaListado[];
  desde: string;
  hasta: string;
  sociedad: string;
  estado: FiltroEstadoInforme;
  cifSociedadDeFactura: (f: FacturaListado) => string;
  nombreSociedad: (cif: string) => string;
}): FilaInformeAF[] {
  const { facturas, desde, hasta, sociedad, estado, cifSociedadDeFactura, nombreSociedad } = params;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(desde) ? desde : null;
  const h = /^\d{4}-\d{2}-\d{2}$/.test(hasta) ? hasta : null;
  const filas: FilaInformeAF[] = [];
  for (const f of facturas) {
    if (f.estado === 'anulada') continue;
    const notas = f.albaranes_faltantes ?? [];
    if (notas.length === 0) continue;
    const fFecha = fechaFacturaIso(f);
    if (d && (!fFecha || fFecha < d)) continue;
    if (h && (!fFecha || fFecha > h)) continue;
    const socCif = cifSociedadDeFactura(f);
    if (sociedad === SOCIEDAD_SIN && socCif) continue;
    if (sociedad.startsWith('cif:') && socCif !== sociedad.slice(4)) continue;
    for (const n of notas) {
      if (estado !== 'todas' && n.estado !== estado) continue;
      filas.push({
        key: `${f.id_factura}:${n.id || n.numero_norm}`,
        facturaId: f.id_factura,
        sociedadCif: socCif,
        sociedadNombre: socCif ? nombreSociedad(socCif) : SIN_SOCIEDAD_LABEL,
        proveedorNombre: String(f.empresa_nombre ?? '').trim() || 'Proveedor sin identificar',
        proveedorCif: String(f.empresa_cif ?? '').trim(),
        numeroDoc: n.numero_doc_proveedor,
        fechaAlbaran: n.fecha_albaran || '',
        importe: n.importe,
        facturaNumero: numeroFacturaVisible(f),
        facturaFecha: fFecha,
        nota: n.nota || '',
        estado: n.estado,
        resueltaPor: n.resuelta_por,
        enOtraEmpresa: n.en_otra_empresa,
      });
    }
  }
  return ordenarFilasInforme(filas);
}

function cmpSociedad(a: FilaInformeAF, b: FilaInformeAF): number {
  const aSin = !a.sociedadCif;
  const bSin = !b.sociedadCif;
  if (aSin !== bSin) return aSin ? 1 : -1;
  return a.sociedadNombre.localeCompare(b.sociedadNombre, 'es');
}

export function ordenarFilasInforme(filas: FilaInformeAF[]): FilaInformeAF[] {
  return [...filas].sort((a, b) => {
    const cs = cmpSociedad(a, b);
    if (cs !== 0) return cs;
    const cp = a.proveedorNombre.localeCompare(b.proveedorNombre, 'es');
    if (cp !== 0) return cp;
    const fa = a.fechaAlbaran || a.facturaFecha;
    const fb = b.fechaAlbaran || b.facturaFecha;
    const cf = fa.localeCompare(fb);
    if (cf !== 0) return cf;
    return a.numeroDoc.localeCompare(b.numeroDoc, 'es');
  });
}

/** Agrupa filas ya ordenadas: sociedad → proveedor (mantiene el orden). */
export function agruparFilasInforme(filas: FilaInformeAF[]): GrupoSociedadInforme[] {
  const grupos: GrupoSociedadInforme[] = [];
  const porSoc = new Map<string, GrupoSociedadInforme>();
  const porProv = new Map<string, GrupoProveedorInforme>();
  for (const f of filas) {
    const kSoc = f.sociedadCif ? `cif:${f.sociedadCif}` : SOCIEDAD_SIN;
    let g = porSoc.get(kSoc);
    if (!g) {
      g = { key: kSoc, nombre: f.sociedadNombre, cif: f.sociedadCif, proveedores: [], total: 0 };
      porSoc.set(kSoc, g);
      grupos.push(g);
    }
    g.total += 1;
    const kProv = `${kSoc}|${claveProveedorConsulta(f.proveedorCif, f.proveedorNombre)}`;
    let p = porProv.get(kProv);
    if (!p) {
      p = { key: kProv, nombre: f.proveedorNombre, cif: f.proveedorCif, filas: [] };
      porProv.set(kProv, p);
      g.proveedores.push(p);
    }
    p.filas.push(f);
  }
  return grupos;
}
