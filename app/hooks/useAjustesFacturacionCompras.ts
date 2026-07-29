/**
 * Configuración de la facturación mensual automática de las ventas internas del
 * grupo: cada mes, los pedidos servidos desde un almacén a los locales se
 * convierten en facturas entre la sociedad que sirve y la que recibe, y los
 * rappel en abonos.
 *
 * Persistencia: tabla genérica de ajustes (CRUD en `api/routes/ajustes.js`).
 *   PK = 'compras'
 *   SK = 'facturacion'
 *   Campos: id_empresa_almacen_general, serie_ventas, serie_rappel,
 *           dia_generacion, hora, condiciones_pago, Enabled
 *
 * `id_empresa_almacen_general` es el único emisor que hay que configurar: el
 * Almacén General no pertenece a ningún local, así que su sociedad no se puede
 * deducir. Para los almacenes de local, la sociedad sale del propio local.
 *
 * `ultimo_periodo_generado` lo escribe el proceso mensual, no la pantalla: se
 * expone aparte de `ajustes` para que no pueda viajar en el cuerpo del guardado.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';
import {
  DIA_GENERACION_DEFECTO,
  HORA_DEFECTO,
  diaGeneracionAjuste,
  horaGeneracionAjuste,
  textoAjuste,
} from '../lib/ajustesFacturacionPeriodica';
import { normalizarIdEmpresa } from '../lib/empresaId';

export { DIA_GENERACION_DEFECTO, HORA_DEFECTO, horaValida } from '../lib/ajustesFacturacionPeriodica';

export const PK_FACTURACION_COMPRAS = 'compras';
export const SK_FACTURACION_COMPRAS = 'facturacion';

/** Serie de venta de las facturas de mercancía servida entre sociedades. */
export const SERIE_VENTAS_DEFECTO = 'FMI';
/** Serie de los abonos de rappel. */
export const SERIE_RAPPEL_DEFECTO = 'FRAPPEL';

export type AjustesFacturacionCompras = {
  /**
   * Sociedad que emite lo servido desde el Almacén General, en formato de 6
   * dígitos del maestro. Sin valor por defecto: hay que elegirla a conciencia,
   * porque no se puede deducir de ningún local.
   */
  idEmpresaAlmacenGeneral: string;
  serieVentas: string;
  serieRappel: string;
  diaGeneracion: number;
  hora: string;
  condicionesPago: string;
  /**
   * Generación automática activa. Por defecto `false`: mientras no se active a
   * conciencia, el proceso mensual no debe emitir nada.
   */
  enabled: boolean;
};

const AJUSTES_DEFECTO: AjustesFacturacionCompras = {
  idEmpresaAlmacenGeneral: '',
  serieVentas: SERIE_VENTAS_DEFECTO,
  serieRappel: SERIE_RAPPEL_DEFECTO,
  diaGeneracion: DIA_GENERACION_DEFECTO,
  hora: HORA_DEFECTO,
  condicionesPago: '',
  enabled: false,
};

const ERROR_CARGA = 'No se pudo cargar la configuración de facturación de ventas internas';

export function useAjustesFacturacionCompras() {
  const [ajustes, setAjustes] = useState<AjustesFacturacionCompras>(AJUSTES_DEFECTO);
  /** Último mes ya facturado (AAAA-MM), escrito por el proceso mensual. */
  const [ultimoPeriodoGenerado, setUltimoPeriodoGenerado] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/ajustes/${PK_FACTURACION_COMPRAS}/${SK_FACTURACION_COMPRAS}`);
      // 404 = todavía no se ha configurado: se trabaja con los valores por defecto.
      if (res.status === 404) {
        setAjustes(AJUSTES_DEFECTO);
        setUltimoPeriodoGenerado('');
        return;
      }
      const data = (await res.json()) as { item?: Record<string, unknown>; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? ERROR_CARGA);
        return;
      }
      const item = data.item ?? {};
      setAjustes({
        // Normalizado a 6 dígitos: un id guardado a medias no debe pasar por
        // válido y dejar sin emisor a las facturas del Almacén General.
        idEmpresaAlmacenGeneral: normalizarIdEmpresa(String(item.id_empresa_almacen_general ?? '')),
        serieVentas: textoAjuste(item.serie_ventas, SERIE_VENTAS_DEFECTO),
        serieRappel: textoAjuste(item.serie_rappel, SERIE_RAPPEL_DEFECTO),
        diaGeneracion: diaGeneracionAjuste(item.dia_generacion),
        hora: horaGeneracionAjuste(item.hora),
        condicionesPago: String(item.condiciones_pago ?? ''),
        enabled: item.Enabled === true,
      });
      setUltimoPeriodoGenerado(String(item.ultimo_periodo_generado ?? '').trim());
    } catch (e) {
      setError(errorMessage(e, ERROR_CARGA));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /**
   * Guarda la configuración. Devuelve el mensaje de error, o `null` si fue bien.
   * PATCH y no POST: el POST reemplaza el ítem completo y borraría el marcador
   * `ultimo_periodo_generado` del proceso mensual.
   */
  const guardar = useCallback(
    async (next: AjustesFacturacionCompras): Promise<string | null> => {
      try {
        const res = await apiFetch(
          `/api/ajustes/${PK_FACTURACION_COMPRAS}/${SK_FACTURACION_COMPRAS}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              id_empresa_almacen_general: next.idEmpresaAlmacenGeneral,
              serie_ventas: next.serieVentas,
              serie_rappel: next.serieRappel,
              dia_generacion: next.diaGeneracion,
              hora: next.hora,
              condiciones_pago: next.condicionesPago,
              Enabled: next.enabled,
            }),
          },
        );
        const data = (await res.json()) as { error?: string };
        if (!res.ok || data.error) {
          return data.error ?? 'No se pudo guardar la configuración de facturación';
        }
        setAjustes(next);
        return null;
      } catch (e) {
        return errorMessage(e, 'Error de conexión al guardar la configuración de facturación');
      }
    },
    [],
  );

  return { ajustes, ultimoPeriodoGenerado, loading, error, cargar, guardar };
}
