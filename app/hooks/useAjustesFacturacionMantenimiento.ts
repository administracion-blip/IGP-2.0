/**
 * Configuración de la facturación mensual automática de las reparaciones de
 * mantenimiento: la sociedad de la sede central factura cada mes a las
 * sociedades propietarias de los locales las reparaciones ya valoradas.
 *
 * Persistencia: tabla genérica de ajustes (CRUD en `api/routes/ajustes.js`).
 *   PK = 'mantenimiento'
 *   SK = 'facturacion'
 *   Campos: id_empresa_emisora, serie, dia_generacion, hora,
 *           condiciones_pago, Enabled
 *
 * No confundir con SK='desplazamiento' (`useTarifasMantenimiento`), que guarda
 * las tarifas de valoración en el mismo PK.
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

export { DIA_GENERACION_DEFECTO, HORA_DEFECTO, horaValida } from '../lib/ajustesFacturacionPeriodica';

export const PK_FACTURACION_MANTENIMIENTO = 'mantenimiento';
export const SK_FACTURACION_MANTENIMIENTO = 'facturacion';

/** DEMANDA Y SERVICIOS SL, la sociedad de la sede central. */
export const ID_EMPRESA_EMISORA_DEFECTO = '000359';
/** Serie de venta ya existente para las facturas de mantenimiento. */
export const SERIE_DEFECTO = 'FMANT';

export type AjustesFacturacionMantenimiento = {
  idEmpresaEmisora: string;
  serie: string;
  diaGeneracion: number;
  hora: string;
  condicionesPago: string;
  /**
   * Generación automática activa. Por defecto `false`: mientras no se active a
   * conciencia, el proceso mensual no debe emitir nada.
   */
  enabled: boolean;
};

const AJUSTES_DEFECTO: AjustesFacturacionMantenimiento = {
  idEmpresaEmisora: ID_EMPRESA_EMISORA_DEFECTO,
  serie: SERIE_DEFECTO,
  diaGeneracion: DIA_GENERACION_DEFECTO,
  hora: HORA_DEFECTO,
  condicionesPago: '',
  enabled: false,
};

const ERROR_CARGA = 'No se pudo cargar la configuración de facturación de mantenimiento';

export function useAjustesFacturacionMantenimiento() {
  const [ajustes, setAjustes] = useState<AjustesFacturacionMantenimiento>(AJUSTES_DEFECTO);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/ajustes/${PK_FACTURACION_MANTENIMIENTO}/${SK_FACTURACION_MANTENIMIENTO}`,
      );
      // 404 = todavía no se ha configurado: se trabaja con los valores por defecto.
      if (res.status === 404) {
        setAjustes(AJUSTES_DEFECTO);
        return;
      }
      const data = (await res.json()) as { item?: Record<string, unknown>; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? ERROR_CARGA);
        return;
      }
      const item = data.item ?? {};
      setAjustes({
        idEmpresaEmisora: textoAjuste(item.id_empresa_emisora, ID_EMPRESA_EMISORA_DEFECTO),
        serie: textoAjuste(item.serie, SERIE_DEFECTO),
        diaGeneracion: diaGeneracionAjuste(item.dia_generacion),
        hora: horaGeneracionAjuste(item.hora),
        condicionesPago: String(item.condiciones_pago ?? ''),
        enabled: item.Enabled === true,
      });
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
   * PATCH y no POST: el POST reemplaza el ítem completo y machacaría cualquier
   * otro atributo del ajuste.
   */
  const guardar = useCallback(
    async (next: AjustesFacturacionMantenimiento): Promise<string | null> => {
      try {
        const res = await apiFetch(
          `/api/ajustes/${PK_FACTURACION_MANTENIMIENTO}/${SK_FACTURACION_MANTENIMIENTO}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              id_empresa_emisora: next.idEmpresaEmisora,
              serie: next.serie,
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

  return { ajustes, loading, error, cargar, guardar };
}
