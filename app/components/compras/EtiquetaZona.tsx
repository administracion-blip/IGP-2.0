import { useMemo } from 'react';
import { View, Text } from 'react-native';
import type { OpcionDesplegable } from '../SelectorDesplegable';

/** Cada letra tiene siempre el mismo color, con texto blanco (puerta de embarque). */
export const COLORES_ZONA: Record<string, string> = {
  A: '#DC2626',
  B: '#2563EB',
  C: '#059669',
  D: '#D97706',
  E: '#7C3AED',
  F: '#0891B2',
  G: '#DB2777',
  H: '#4F46E5',
  I: '#EA580C',
  J: '#0F766E',
  K: '#BE123C',
  L: '#1D4ED8',
  M: '#3F6212',
  N: '#9333EA',
  O: '#B45309',
  P: '#0369A1',
  Q: '#C026D3',
  R: '#B91C1C',
  S: '#0E7490',
  T: '#A16207',
  U: '#4338CA',
  V: '#BE185D',
  W: '#047857',
  X: '#9F1239',
  Y: '#1E3A8A',
  Z: '#6D28D9',
};

export const LETRAS_ZONA = Object.keys(COLORES_ZONA);

export function letraZona(value: unknown): string {
  const s = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]$/.test(s) ? s : '';
}

export function colorZona(zona: unknown): string {
  return COLORES_ZONA[letraZona(zona)] ?? '#334155';
}

export const OPCIONES_ZONA: OpcionDesplegable[] = [
  { id: '', titulo: 'Sin zona' },
  ...LETRAS_ZONA.map((letra) => ({
    id: letra,
    titulo: `Zona ${letra}`,
    badge: letra,
    badgeColor: COLORES_ZONA[letra],
  })),
];

export function mapaZonas(productos: Record<string, unknown>[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of productos) {
    const id = String(p.Id ?? p.id ?? '').trim();
    const zona = letraZona(p.Zona ?? p.zona);
    if (id && zona) map.set(id, zona);
  }
  return map;
}

export function useMapaZonas(productos: Record<string, unknown>[]): Map<string, string> {
  return useMemo(() => mapaZonas(productos), [productos]);
}

function idProductoLinea(linea: object): string {
  const row = linea as Record<string, unknown>;
  return String(row.ProductId ?? row.productId ?? '').trim();
}

function indiceLinea(linea: object): number {
  const row = linea as Record<string, unknown>;
  const n = Number(row.LineaIndex ?? row.lineaIndex);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Orden de recogida: A, B, C… y al final los que no tienen zona.
 * Dentro de la misma letra se conserva el orden de la línea. No reescribe el pedido.
 */
export function ordenarLineasPorZona<T>(lineas: readonly T[], zonas: Map<string, string>): T[] {
  return lineas
    .map((linea, index) => ({ linea, index }))
    .sort((a, b) => {
      const za = letraZona(zonas.get(idProductoLinea(a.linea as object)));
      const zb = letraZona(zonas.get(idProductoLinea(b.linea as object)));
      if (za !== zb) {
        if (!za) return 1;
        if (!zb) return -1;
        return za < zb ? -1 : 1;
      }
      const ia = indiceLinea(a.linea as object);
      const ib = indiceLinea(b.linea as object);
      if (ia !== ib) return ia - ib;
      return a.index - b.index;
    })
    .map((fila) => fila.linea);
}

type Props = {
  zona?: unknown;
  size?: number;
};

/** Cuadrado de puerta de embarque. No pinta nada si el producto no tiene zona. */
export function EtiquetaZona({ zona, size = 28 }: Props) {
  const letra = letraZona(zona);
  if (!letra) return null;
  const font = Math.round(size * 0.58);
  return (
    <View
      accessibilityLabel={`Zona ${letra}`}
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        backgroundColor: colorZona(letra),
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Text style={{ color: '#ffffff', fontWeight: '800', fontSize: font, lineHeight: font + 1 }}>
        {letra}
      </Text>
    </View>
  );
}
