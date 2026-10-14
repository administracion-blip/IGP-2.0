import { ESTADOS_FACTURA_REMESABLES } from './remesas';
import type {
  AntiguedadDeuda,
  ChipDeuda,
  EstadoDeudaProveedor,
  FacturaDeuda,
  ParamsDeudaProveedores,
  ProveedorDeuda,
  RemesaActivaDeuda,
  TramoAntiguedad,
} from '../types/deudaProveedores';

function queryDeuda(params: ParamsDeudaProveedores): string {
  const q = new URLSearchParams();
  q.set('fechaDesde', params.fechaDesde);
  q.set('fechaHasta', params.fechaHasta);
  if (params.emisorId) q.set('emisorId', params.emisorId);
  if (params.proveedor) q.set('proveedor', params.proveedor);
  if (params.incluirFacturas) q.set('incluirFacturas', '1');
  return q.toString();
}

export function urlDeudaProveedores(params: ParamsDeudaProveedores): string {
  return `/api/facturacion/deuda-proveedores?${queryDeuda(params)}`;
}

export function urlDetalleProveedor(
  clave: string,
  params: Omit<ParamsDeudaProveedores, 'proveedor' | 'incluirFacturas'>,
): string {
  return `/api/facturacion/deuda-proveedores/facturas?clave=${encodeURIComponent(clave)}&${queryDeuda(params)}`;
}

const DIA_MADRID = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha natural en Madrid (`YYYY-MM-DD`), la misma que usa el backend como `hoy`. No es jornada de negocio. */
export function hoyMadridIso(date: Date = new Date()): string {
  const partes: Record<string, string> = {};
  for (const p of DIA_MADRID.formatToParts(date)) {
    if (p.type !== 'literal') partes[p.type] = p.value;
  }
  return `${partes.year}-${partes.month}-${partes.day}`;
}

/** 1 de enero del año en curso → hoy (fecha natural en Madrid, ISO). */
export function rangoPorDefecto(): { desde: string; hasta: string } {
  const hoy = hoyMadridIso();
  return { desde: `${hoy.slice(0, 4)}-01-01`, hasta: hoy };
}

const CONFUSABLES_LATIN: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J',
  Α: 'A', Β: 'B', Ε: 'E', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X', Υ: 'Y',
};

/** Debe coincidir con `normalizeCif` de `api/lib/empresaCif.js`. */
export function normalizarCifDeuda(val: unknown): string {
  let out = '';
  for (const ch of String(val ?? '').normalize('NFKC')) out += CONFUSABLES_LATIN[ch] || ch;
  return out
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

/** Clave de proveedor de una factura; debe coincidir con `claveProveedor` del backend. */
export function claveProveedorFactura(
  f: Pick<FacturaDeuda, 'empresa_cif' | 'empresa_id' | 'empresa_nombre'>,
): string {
  const cif = normalizarCifDeuda(f.empresa_cif);
  if (cif) return `CIF:${cif}`;
  const id = String(f.empresa_id ?? '').trim();
  if (id) return `ID:${id}`;
  return `NOM:${String(f.empresa_nombre ?? '').trim().toLowerCase()}`;
}

export const CHIPS_DEUDA: { id: ChipDeuda; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'con_deuda', label: 'Con deuda' },
  { id: 'vencidos', label: 'Vencidos' },
  { id: 'cuadrados', label: 'Cuadrados' },
];

export function filtrarPorChip(proveedores: ProveedorDeuda[], chip: ChipDeuda): ProveedorDeuda[] {
  switch (chip) {
    case 'con_deuda':
      return proveedores.filter((p) => p.estado !== 'cuadrado');
    case 'vencidos':
      return proveedores.filter((p) => p.estado === 'vencido');
    case 'cuadrados':
      return proveedores.filter((p) => p.estado === 'cuadrado');
    default:
      return proveedores;
  }
}

export function normalizarTextoBusqueda(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Filtra por nombre o CIF ignorando acentos, mayúsculas y separadores del CIF. */
export function filtrarPorTexto(proveedores: ProveedorDeuda[], texto: string): ProveedorDeuda[] {
  const q = normalizarTextoBusqueda(texto);
  if (!q) return proveedores;
  const qCif = q.replace(/[^a-z0-9]/g, '');
  return proveedores.filter((p) => {
    if (normalizarTextoBusqueda(p.nombre).includes(q)) return true;
    const cif = normalizarTextoBusqueda(p.cif).replace(/[^a-z0-9]/g, '');
    return !!qCif && cif.includes(qCif);
  });
}

export const COLOR_ESTADO_DEUDA: Record<EstadoDeudaProveedor, { color: string; bg: string; border: string }> = {
  cuadrado: { color: '#16a34a', bg: '#dcfce7', border: '#bbf7d0' },
  pendiente: { color: '#d97706', bg: '#fef3c7', border: '#fde68a' },
  vencido: { color: '#dc2626', bg: '#fee2e2', border: '#fecaca' },
};

export const ETIQUETA_ESTADO_DEUDA: Record<EstadoDeudaProveedor, string> = {
  cuadrado: 'Cuadrado',
  pendiente: 'Pendiente',
  vencido: 'Vencido',
};

export const COLOR_INTRAGRUPO = '#7c3aed';

export const TRAMOS_ANTIGUEDAD: {
  tramo: TramoAntiguedad;
  campo: keyof AntiguedadDeuda;
  label: string;
  color: string;
}[] = [
  { tramo: 'no_vencido', campo: 'noVencido', label: 'No vencido', color: '#0ea5e9' },
  { tramo: 'd0_30', campo: 'd0_30', label: '0–30 días', color: '#fbbf24' },
  { tramo: 'd31_60', campo: 'd31_60', label: '31–60 días', color: '#f97316' },
  { tramo: 'd61_90', campo: 'd61_90', label: '61–90 días', color: '#ef4444' },
  { tramo: 'd90mas', campo: 'd90mas', label: 'Más de 90 días', color: '#991b1b' },
];

export function saldoPendienteFactura(f: Pick<FacturaDeuda, 'saldo_pendiente'>): number {
  const n = Number(f.saldo_pendiente) || 0;
  return n > 0.001 ? n : 0;
}

export function idRemesaActiva(r: RemesaActivaDeuda | null | undefined): string {
  return String(r?.remesaId ?? r?.id ?? '').trim();
}

/** Estado remesable, saldo > 0 y sin remesa activa. */
export function esFacturaRemesableDeuda(f: FacturaDeuda): boolean {
  return (
    ESTADOS_FACTURA_REMESABLES.has(String(f.estado ?? ''))
    && saldoPendienteFactura(f) > 0
    && !f.remesaActiva
  );
}

export function puedeTenerDocumento(f: FacturaDeuda): boolean {
  return !!f.documento_file_key || (Array.isArray(f.adjuntos) && f.adjuntos.length > 0);
}

/** Texto del neto intragrupo calculado sobre lo que nos debe y lo que le debemos. */
export function textoNetoIntragrupo(leDebemos: number, nosDebe: number): { texto: string; importe: number } {
  const neto = (Number(nosDebe) || 0) - (Number(leDebemos) || 0);
  if (Math.abs(neto) < 0.005) return { texto: 'cuadrado', importe: 0 };
  return neto > 0 ? { texto: 'nos deben', importe: neto } : { texto: 'les debemos', importe: -neto };
}

export function etiquetaFacturaDeuda(f: Pick<FacturaDeuda, 'numero_factura_proveedor' | 'numero_factura' | 'id_factura'>): string {
  return f.numero_factura_proveedor?.trim() || f.numero_factura?.trim() || f.id_factura;
}

/** Lee `{ error }` del cuerpo de una respuesta fallida (texto en español del backend). */
export async function mensajeErrorRespuesta(r: Response, fallback: string): Promise<string> {
  try {
    const data = (await r.json()) as { error?: unknown };
    if (typeof data?.error === 'string' && data.error.trim()) return data.error;
  } catch {
    // cuerpo no JSON
  }
  return fallback;
}
