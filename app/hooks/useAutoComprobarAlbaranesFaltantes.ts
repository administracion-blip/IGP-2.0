/**
 * Tras cargar facturas (o sincronizar con Ágora), comprueba en Ágora los
 * albaranes que faltan pendientes y resuelve automáticamente los que ya están
 * en la misma sociedad de su factura. No bloquea la UI.
 *
 * Cada nota se comprueba una sola vez por `tokenRecarga`: las actualizaciones
 * que provoca el propio hook no relanzan la comprobación. Si la comprobación
 * falla o el guardado choca con otra edición (409), la nota vuelve a quedar
 * pendiente de comprobar.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { FacturaListado } from '../types/factura';
import {
  type AlbaranFaltante,
  type NotaPendienteRef,
  type ResolverEmpresaCoincidencia,
  ConflictoVersionError,
  calcularCambiosAuto,
  comprobarAlbaranesFaltantes,
  consultasDesdeNotas,
  firmaNota,
  guardarAlbaranesFaltantes,
  notasPendientes,
} from '../lib/albaranesFaltantes';

const CONCURRENCIA_PUT = 3;

async function enParalelo<T>(items: T[], limite: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function useAutoComprobarAlbaranesFaltantes(params: {
  facturas: FacturaListado[];
  facturasRef: MutableRefObject<FacturaListado[]>;
  /** Cambia en cada carga completa de facturas (incluida la de tras sincronizar). */
  tokenRecarga: number;
  habilitado: boolean;
  cifSociedadDeFactura: (f: FacturaListado) => string;
  empresaDeCoincidencia: ResolverEmpresaCoincidencia;
  onFacturaActualizada: (facturaId: string, items: AlbaranFaltante[], version?: number) => void;
  onResueltas: (n: number) => void;
}): void {
  const { facturas, facturasRef, tokenRecarga, habilitado, cifSociedadDeFactura, empresaDeCoincidencia } = params;
  const comprobadasRef = useRef<Set<string>>(new Set());
  const tokenRef = useRef(tokenRecarga);
  const callbacksRef = useRef(params);
  callbacksRef.current = params;

  useEffect(() => {
    if (tokenRef.current !== tokenRecarga) {
      tokenRef.current = tokenRecarga;
      comprobadasRef.current = new Set();
    }
    if (!habilitado || tokenRecarga === 0) return;

    const nuevas = notasPendientes(facturas).filter((n) => !comprobadasRef.current.has(firmaNota(n)));
    if (nuevas.length === 0) return;
    const comprobadas = comprobadasRef.current;
    for (const n of nuevas) comprobadas.add(firmaNota(n));
    const liberar = (notas: NotaPendienteRef[]) => {
      for (const n of notas) comprobadas.delete(firmaNota(n));
    };

    void (async () => {
      let indice: Awaited<ReturnType<typeof comprobarAlbaranesFaltantes>>;
      try {
        indice = await comprobarAlbaranesFaltantes(consultasDesdeNotas(nuevas));
      } catch (e) {
        liberar(nuevas);
        console.warn('[albaranes-faltantes] Comprobación automática fallida', e);
        return;
      }
      const calcular = (facturasActuales: FacturaListado[], notas: NotaPendienteRef[]) =>
        calcularCambiosAuto({
          facturas: facturasActuales,
          notas,
          indice,
          cifSociedadDeFactura,
          empresaDeCoincidencia,
          ahoraIso: new Date().toISOString(),
        });
      const candidatas = calcular(facturasRef.current, nuevas).map((c) => c.facturaId);
      if (candidatas.length === 0) return;
      let resueltas = 0;
      await enParalelo(candidatas, CONCURRENCIA_PUT, async (facturaId) => {
        const notasFactura = nuevas.filter((n) => n.facturaId === facturaId);
        const actual = facturasRef.current.find((f) => f.id_factura === facturaId);
        if (!actual) return;
        const [cambio] = calcular([actual], notasFactura);
        if (!cambio) return;
        try {
          const saved = await guardarAlbaranesFaltantes(facturaId, cambio.items, cambio.version);
          callbacksRef.current.onFacturaActualizada(facturaId, saved.albaranes_faltantes, saved.version);
          resueltas += cambio.resueltas;
        } catch (e) {
          if (e instanceof ConflictoVersionError) {
            // Con la versión local caducada cada reintento daría 409: se espera a la siguiente recarga.
            console.warn('[albaranes-faltantes] La factura cambió antes de guardar la auto-resolución; se reintentará al recargar', facturaId);
            return;
          }
          console.warn('[albaranes-faltantes] No se pudo guardar la auto-resolución', facturaId, e);
        }
      });
      if (resueltas > 0) callbacksRef.current.onResueltas(resueltas);
    })();
  }, [facturas, facturasRef, tokenRecarga, habilitado, cifSociedadDeFactura, empresaDeCoincidencia]);
}
