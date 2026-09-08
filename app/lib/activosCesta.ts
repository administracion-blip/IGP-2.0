import { useSyncExternalStore } from 'react';
import type { ActivoListado, GranularidadActivo } from '../types/activos';
import { fotoGeneralUrl, tallaDeActivo, unidadesDeActivo } from './activos';

export type LineaCestaActivo = {
  asset_id: string;
  etiqueta_legible: string;
  marca?: string;
  nombre_modelo?: string;
  /** Local del almacén del que sale la prenda. */
  id_local: string;
  local_nombre?: string;
  /** Local al que se imputa/factura. Vacío hasta que el usuario lo elige. */
  local_imputado_id: string;
  local_imputado_nombre?: string;
  granularidad?: GranularidadActivo;
  cantidad: number;
  max: number;
  talla?: string;
  numero_serie?: string | null;
  foto_url?: string | null;
};

/** Línea explícita (modal del catálogo): ya trae cantidad, tope y local a facturar. */
export type EntradaCestaActivo = {
  asset_id: string;
  etiqueta_legible: string;
  marca?: string;
  nombre_modelo?: string;
  id_local: string;
  local_nombre?: string;
  local_imputado_id?: string;
  local_imputado_nombre?: string;
  granularidad?: GranularidadActivo;
  cantidad: number;
  /** Unidades disponibles en almacén de esa línea. */
  max: number;
  talla?: string;
  numero_serie?: string | null;
  foto_url?: string | null;
};

export type GrupoCestaLocal = {
  local_imputado_id: string;
  local_imputado_nombre: string;
  unidades: number;
  lineas: LineaCestaActivo[];
};

type EstadoCesta = { lineas: LineaCestaActivo[] };

let estado: EstadoCesta = { lineas: [] };
const listeners = new Set<() => void>();

function emitir() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot() {
  return estado.lineas;
}

export function activoSePuedeEntregar(item: Pick<ActivoListado, 'estado' | 'custodio_id'>) {
  return item.estado === 'en_almacen' && !item.custodio_id;
}

function esActivoListado(item: ActivoListado | EntradaCestaActivo): item is ActivoListado {
  return 'estado' in item;
}

export function lineaSinLocalFactura(linea: Pick<LineaCestaActivo, 'local_imputado_id'>) {
  return !String(linea.local_imputado_id || '').trim();
}

/** Desde el listado/ficha: entra con 1 unidad y sin local a facturar. */
export function lineaCestaDesdeActivo(item: ActivoListado, cantidad = 1): LineaCestaActivo {
  const max = Math.max(unidadesDeActivo(item), 1);
  const n = Number.isInteger(cantidad) ? cantidad : 1;
  return {
    asset_id: item.asset_id,
    etiqueta_legible: item.etiqueta_legible,
    marca: item.marca,
    nombre_modelo: item.nombre_modelo,
    id_local: item.id_local,
    local_nombre: item.local_nombre,
    local_imputado_id: '',
    local_imputado_nombre: undefined,
    granularidad: item.granularidad,
    cantidad: Math.max(1, Math.min(n, max)),
    max,
    talla: tallaDeActivo(item) || undefined,
    numero_serie: item.numero_serie ?? null,
    foto_url: fotoGeneralUrl(item),
  };
}

function lineaCestaDesdeEntrada(entrada: EntradaCestaActivo): LineaCestaActivo {
  const max = Math.max(Number.isInteger(entrada.max) ? entrada.max : 1, 1);
  const n = Number.isInteger(entrada.cantidad) ? entrada.cantidad : 1;
  return {
    asset_id: entrada.asset_id,
    etiqueta_legible: entrada.etiqueta_legible,
    marca: entrada.marca,
    nombre_modelo: entrada.nombre_modelo,
    id_local: entrada.id_local,
    local_nombre: entrada.local_nombre,
    local_imputado_id: String(entrada.local_imputado_id || '').trim(),
    local_imputado_nombre: String(entrada.local_imputado_id || '').trim()
      ? entrada.local_imputado_nombre
      : undefined,
    granularidad: entrada.granularidad,
    cantidad: Math.max(1, Math.min(n, max)),
    max,
    talla: entrada.talla || undefined,
    numero_serie: entrada.numero_serie ?? null,
    foto_url: entrada.foto_url ?? null,
  };
}

export function vaciarCestaActivos() {
  setLineas([]);
}

export function unidadesEnCesta(lineas: LineaCestaActivo[]) {
  return lineas.reduce((s, l) => s + (Number.isInteger(l.cantidad) ? l.cantidad : 0), 0);
}

/**
 * Agrupa por local al que se factura: el trabajador firma prendas de varios
 * locales de una vez y luego hay que separarlas para facturar.
 */
export function agruparCestaPorLocalImputado(lineas: LineaCestaActivo[]): GrupoCestaLocal[] {
  const mapa = new Map<string, GrupoCestaLocal>();
  for (const linea of lineas) {
    const id = String(linea.local_imputado_id || '').trim() || '—';
    const nombre = id === '—'
      ? 'Elige local a facturar'
      : (linea.local_imputado_nombre || id).trim() || id;
    if (!mapa.has(id)) {
      mapa.set(id, { local_imputado_id: id, local_imputado_nombre: nombre, unidades: 0, lineas: [] });
    }
    const grupo = mapa.get(id)!;
    grupo.lineas.push(linea);
    grupo.unidades += Number.isInteger(linea.cantidad) ? linea.cantidad : 0;
  }
  return [...mapa.values()].sort((a, b) => {
    if (a.local_imputado_id === '—' && b.local_imputado_id !== '—') return -1;
    if (b.local_imputado_id === '—' && a.local_imputado_id !== '—') return 1;
    return a.local_imputado_nombre.localeCompare(b.local_imputado_nombre, 'es');
  });
}

function setLineas(lineas: LineaCestaActivo[]) {
  estado = { lineas };
  emitir();
}

export function useCestaActivos() {
  const lineas = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    lineas,
    unidades: unidadesEnCesta(lineas),
    grupos: agruparCestaPorLocalImputado(lineas),
    enCesta: (assetId: string) => lineas.some((l) => l.asset_id === assetId),
    /**
     * Acepta un `ActivoListado` (listado y ficha, entra con 1 unidad) o una línea
     * explícita con cantidad y local a facturar (modal del catálogo).
     */
    anadir(item: ActivoListado | EntradaCestaActivo) {
      if (esActivoListado(item)) {
        if (!activoSePuedeEntregar(item)) return false;
        if (estado.lineas.some((l) => l.asset_id === item.asset_id)) return true;
        setLineas([...estado.lineas, lineaCestaDesdeActivo(item)]);
        return true;
      }
      const nueva = lineaCestaDesdeEntrada(item);
      const previa = estado.lineas.find((l) => l.asset_id === nueva.asset_id);
      if (previa) {
        setLineas(
          estado.lineas.map((l) =>
            l.asset_id === nueva.asset_id
              ? {
                  ...l,
                  max: nueva.max,
                  cantidad: Math.max(1, Math.min(l.cantidad + nueva.cantidad, nueva.max)),
                  local_imputado_id: nueva.local_imputado_id || l.local_imputado_id,
                  local_imputado_nombre: nueva.local_imputado_id
                    ? nueva.local_imputado_nombre
                    : l.local_imputado_nombre,
                }
              : l,
          ),
        );
        return true;
      }
      setLineas([...estado.lineas, nueva]);
      return true;
    },
    quitar(assetId: string) {
      setLineas(estado.lineas.filter((l) => l.asset_id !== assetId));
    },
    setCantidad(assetId: string, cantidad: number) {
      setLineas(
        estado.lineas.map((l) => {
          if (l.asset_id !== assetId) return l;
          const n = Number.isInteger(cantidad) ? cantidad : l.cantidad;
          return { ...l, cantidad: Math.max(1, Math.min(n, l.max)) };
        }),
      );
    },
    setLocalImputado(assetId: string, idLocal: string, nombreLocal?: string) {
      setLineas(
        estado.lineas.map((l) =>
          l.asset_id === assetId
            ? { ...l, local_imputado_id: idLocal, local_imputado_nombre: nombreLocal }
            : l,
        ),
      );
    },
    vaciar() {
      setLineas([]);
    },
  };
}
