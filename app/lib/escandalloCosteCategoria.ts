/**
 * Categoría virtual de coste teórico de escandallo (no se persiste).
 * Umbrales: (0,3) muy_bajo · [3,5) bajo · [5,8) medio · >=8 alto · <=0 o no calculable → sin_coste.
 */

export type CategoriaCosteId = 'muy_bajo' | 'bajo' | 'medio' | 'alto' | 'sin_coste';

export type CategoriaCosteColores = {
  backgroundColor: string;
  color: string;
  borderColor: string;
};

export type CategoriaCoste = {
  id: CategoriaCosteId;
  label: string;
  /** Texto corto para chips de fila. */
  labelCorto: string;
  colores: CategoriaCosteColores;
};

/** Límites inferiores inclusivos: muy_bajo=0, bajo=3, medio=5, alto=8. */
export const UMBRALES_COSTE_CATEGORIA = {
  muyBajo: 0,
  bajo: 3,
  medio: 5,
  alto: 8,
} as const;

const CATEGORIAS: Record<CategoriaCosteId, Omit<CategoriaCoste, 'id'>> = {
  muy_bajo: {
    label: 'Coste Muy Bajo',
    labelCorto: 'Muy bajo',
    colores: {
      backgroundColor: '#dcfce7',
      color: '#15803d',
      borderColor: '#86efac',
    },
  },
  bajo: {
    label: 'Coste Bajo',
    labelCorto: 'Bajo',
    colores: {
      backgroundColor: '#ecfccb',
      color: '#4d7c0f',
      borderColor: '#bef264',
    },
  },
  medio: {
    label: 'Coste Medio',
    labelCorto: 'Medio',
    colores: {
      backgroundColor: '#fef3c7',
      color: '#b45309',
      borderColor: '#fcd34d',
    },
  },
  alto: {
    label: 'Coste Alto',
    labelCorto: 'Alto',
    colores: {
      backgroundColor: '#fee2e2',
      color: '#b91c1c',
      borderColor: '#fca5a5',
    },
  },
  sin_coste: {
    label: 'Sin coste',
    labelCorto: 'Sin coste',
    colores: {
      backgroundColor: '#f1f5f9',
      color: '#64748b',
      borderColor: '#cbd5e1',
    },
  },
};

/** Orden de pastillas de filtro (sin «Todos»). */
export const CATEGORIAS_COSTE_ORDEN: CategoriaCosteId[] = [
  'muy_bajo',
  'bajo',
  'medio',
  'alto',
  'sin_coste',
];

export function categoriaCostePorId(id: CategoriaCosteId): CategoriaCoste {
  return { id, ...CATEGORIAS[id] };
}

export function categoriaCosteTeorico(coste: number): CategoriaCoste {
  if (!Number.isFinite(coste) || coste <= 0) {
    return categoriaCostePorId('sin_coste');
  }
  if (coste < UMBRALES_COSTE_CATEGORIA.bajo) return categoriaCostePorId('muy_bajo');
  if (coste < UMBRALES_COSTE_CATEGORIA.medio) return categoriaCostePorId('bajo');
  if (coste < UMBRALES_COSTE_CATEGORIA.alto) return categoriaCostePorId('medio');
  return categoriaCostePorId('alto');
}

export type IngredienteCosteInput = {
  ingredienteId?: string | null;
  cantidad?: number | string | null;
  mermaPct?: number | string | null;
};

function parseNum(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Coste teórico = Σ cantidad × (1 + merma%/100) × costeUnitario(ingrediente).
 * `costeUnitarioDe` debe reutilizar la misma lógica de precios que el detalle.
 */
export function costeTeoricoDesdeIngredientes(
  ingredientes: IngredienteCosteInput[] | undefined | null,
  costeUnitarioDe: (ingredienteId: string) => number,
): number {
  if (!Array.isArray(ingredientes) || ingredientes.length === 0) return 0;
  let total = 0;
  for (const ing of ingredientes) {
    const id = String(ing.ingredienteId ?? '').trim();
    if (!id) continue;
    const cant = parseNum(ing.cantidad);
    if (cant == null || cant < 0) continue;
    const merma = parseNum(ing.mermaPct) ?? 0;
    const unit = costeUnitarioDe(id);
    total += cant * (1 + merma / 100) * unit;
  }
  return total;
}
