/**
 * Utilidades de presentación de la conciliación bancaria.
 *
 * Todo lo que llega del backend viene en céntimos enteros; aquí es donde se
 * pasa a euros para pintarlo o para mandarlo al registro de pagos, que sí
 * trabaja en euros.
 */

import type {
  NivelConfianza,
  SugerenciaConciliacion,
  SugerenciasDeFactura,
  TipoSugerencia,
} from '../types/conciliacion';

/**
 * URL del barrido de sugerencias. Sigue el patrón de `queryMovimientos` en
 * `app/lib/banca.ts`: aquí se arma la query y el fetch lo hace la pantalla.
 */
export function queryConciliacionSugerencias(filtros: {
  tipo: 'IN' | 'OUT';
  empresaId?: string;
  desde?: string;
  hasta?: string;
  limite?: number;
}): string {
  const params = new URLSearchParams();
  params.set('tipo', filtros.tipo);
  if (filtros.empresaId?.trim()) params.set('empresaId', filtros.empresaId.trim());
  if (filtros.desde?.trim()) params.set('desde', filtros.desde.trim());
  if (filtros.hasta?.trim()) params.set('hasta', filtros.hasta.trim());
  if (filtros.limite) params.set('limite', String(filtros.limite));
  return `/api/banca/conciliacion/sugerencias?${params.toString()}`;
}

/** Céntimos enteros a euros. */
export function aEuros(centimos: number | undefined | null): number {
  return Math.round(Number(centimos ?? 0)) / 100;
}

/** Euros a céntimos enteros, redondeando (0,1 + 0,2 no da 0,3 en coma flotante). */
export function aCentimos(euros: number | undefined | null): number {
  return Math.round(Number(euros ?? 0) * 100);
}

/** Colores del icono y del badge según lo fiable que sea la sugerencia. */
export function estiloNivel(nivel: NivelConfianza | string): {
  fondo: string;
  texto: string;
  borde: string;
} {
  if (nivel === 'alta') return { fondo: '#f0fdf4', texto: '#16a34a', borde: '#bbf7d0' };
  if (nivel === 'media') return { fondo: '#fffbeb', texto: '#d97706', borde: '#fde68a' };
  return { fondo: '#f1f5f9', texto: '#64748b', borde: '#e2e8f0' };
}

export function etiquetaNivel(nivel: NivelConfianza | string): string {
  if (nivel === 'alta') return 'Coincidencia alta';
  if (nivel === 'media') return 'Coincidencia media';
  return 'Coincidencia baja';
}

export function etiquetaTipoSugerencia(tipo: TipoSugerencia | string): string {
  if (tipo === 'exacta') return 'Importe exacto';
  if (tipo === 'combinacion') return 'Varias facturas';
  return 'Pago parcial';
}

/**
 * Texto del icono en el listado: lo que el usuario lee antes de abrir nada.
 * Se queda en una frase; el detalle va en los motivos de la sugerencia.
 */
export function resumenSugerenciaFactura(entrada: SugerenciasDeFactura): string {
  const total = entrada.sugerencias?.length ?? 0;
  if (total === 0) return 'Sin movimientos candidatos';
  const nivel = etiquetaNivel(entrada.mejorNivel).toLowerCase();
  return total === 1
    ? `Hay un movimiento bancario que puede corresponder a esta factura (${nivel})`
    : `Hay ${total} movimientos bancarios candidatos (${nivel} el mejor)`;
}

/** Índice por id de factura, para que el listado no recorra el array en cada fila.
 *
 * Solo entran facturas cuyo mejor candidato sea de confianza media o alta: las
 * coincidencias bajas no merecen icono en el listado (ruido).
 */
export function indicePorFactura(
  entradas: SugerenciasDeFactura[] | undefined,
): Map<string, SugerenciasDeFactura> {
  const mapa = new Map<string, SugerenciasDeFactura>();
  for (const entrada of entradas || []) {
    const id = String(entrada?.id_factura || '');
    if (!id) continue;
    if (entrada.mejorNivel !== 'alta' && entrada.mejorNivel !== 'media') continue;
    mapa.set(id, entrada);
  }
  return mapa;
}

/**
 * ¿Cuadra el reparto? El movimiento no puede repartir más de lo que le queda
 * libre, y a ninguna factura se le puede asignar más de lo que debe.
 *
 * Se compara en céntimos: en euros, tres importes con decimales dejan de sumar
 * lo que deberían y el usuario ve un error que no entiende.
 */
export function validarReparto(
  sugerencia: Pick<SugerenciaConciliacion, 'conciliableCentimos' | 'facturas'>,
  importesEuros: Record<string, number>,
): { ok: boolean; motivo: string; totalCentimos: number } {
  let totalCentimos = 0;
  for (const factura of sugerencia.facturas || []) {
    const centimos = aCentimos(importesEuros[factura.id_factura]);
    if (centimos < 0) {
      return { ok: false, motivo: 'Los importes no pueden ser negativos', totalCentimos };
    }
    if (centimos > factura.saldoPendienteCentimos) {
      return {
        ok: false,
        motivo: `No puedes asignar más de ${aEuros(factura.saldoPendienteCentimos).toFixed(2)} € a la factura ${factura.numero || factura.id_factura}`,
        totalCentimos,
      };
    }
    totalCentimos += centimos;
  }
  if (totalCentimos <= 0) {
    return { ok: false, motivo: 'Asigna algún importe antes de conciliar', totalCentimos };
  }
  if (totalCentimos > sugerencia.conciliableCentimos) {
    return {
      ok: false,
      motivo: `El reparto suma ${aEuros(totalCentimos).toFixed(2)} € y del movimiento solo quedan ${aEuros(sugerencia.conciliableCentimos).toFixed(2)} €`,
      totalCentimos,
    };
  }
  return { ok: true, motivo: '', totalCentimos };
}
