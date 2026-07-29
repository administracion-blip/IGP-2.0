/**
 * Trabajo programado de una facturación periódica.
 *
 * A diferencia del resto de trabajos del planificador, **no** comprueba si el
 * día y la hora coinciden ahora mismo: esa condición se evalúa en memoria y si
 * el servidor estaba apagado a esa hora la ventana se perdería para siempre, lo
 * que en facturación es inaceptable. En su lugar, el último periodo generado se
 * persiste en los ajustes y la tanda se lanza cuando hoy es igual o posterior al
 * día configurado y quedan periodos por hacer, así que un arranque el día 3
 * recupera el mes pendiente en el primer ciclo.
 *
 * Si hay un hueco de varios meses, se generan **en orden** y por separado: cada
 * factura debe llevar la fecha de emisión de su periodo, porque el correlativo
 * se ancla por año y meter diciembre en la tanda de enero lo numeraría en el
 * ejercicio siguiente.
 *
 * El propio endpoint deja constancia del periodo generado, así que si esa marca
 * fallara el ciclo siguiente volvería a intentarlo sin duplicar nada: los
 * elementos ya están reclamados y la ejecución acabaría con cero facturas.
 *
 * Hay tres desenlaces, no dos, y la diferencia importa:
 * - **completo**: estado `ok` y se pasa al periodo siguiente.
 * - **parcial**: se escribieron documentos pero algo quedó fuera. El endpoint no
 *   marca el periodo, así que aquí se registra estado `parcial` y **no** se
 *   avanza: el mismo periodo se reintenta tras la espera y recoge lo que falta.
 * - **fallo**: nada que hacer con este periodo ahora (error de la petición o
 *   tanda interrumpida). Estado `error` y se para.
 *
 * La mecánica es común a todas las facturaciones periódicas y se comparte para
 * que no puedan divergir en lo delicado (recuperación de meses perdidos, espera
 * tras un fallo y protección frente a tandas solapadas). Cada dominio aporta
 * solo su configuración, su endpoint y qué contar en el log.
 */

import { internalSyncFetchHeaders } from '../internalSync.js';
import { logger } from '../logger.js';
import { periodoAnterior, periodosPendientes } from '../facturacion/facturacionPeriodica.js';

/**
 * Espera antes de reintentar tras un fallo, para no repetir el intento cada
 * minuto mientras el motivo siga ahí (p. ej. una serie mal configurada).
 */
export const REINTENTO_TRAS_FALLO_MS = 30 * 60 * 1000;

/** Último día del mes de una fecha, para no pedir un día 31 en febrero. */
function ultimoDiaDelMes(fecha) {
  return new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0).getDate();
}

/**
 * @param {{
 *   etiqueta: string,
 *   ruta: string,
 *   leerAjustes: () => Promise<object>,
 *   marcarIntentoGeneracion: (estado: object) => Promise<void>,
 *   hayGeneracionEnCurso: () => Promise<boolean>,
 *   mensajeSinSecreto: string,
 *   datosLogOk?: (data: object) => object,
 *   nombreDocumento?: string,
 * }} dominio
 * @returns {(port: number|string) => Promise<void>}
 */
export function crearTrabajoFacturacionPeriodica({
  etiqueta,
  ruta,
  leerAjustes,
  marcarIntentoGeneracion,
  hayGeneracionEnCurso,
  mensajeSinSecreto,
  datosLogOk = () => ({}),
  nombreDocumento = 'factura',
}) {
  let ultimoFallo = 0;
  /** Evita que el ciclo de cada minuto dispare una segunda tanda sobre la anterior. */
  let enVuelo = false;
  /** El aviso de configuración se persiste una vez por arranque, no cada minuto. */
  let secretoAvisado = false;

  return async function comprobar(port) {
    try {
      const ajustes = await leerAjustes();
      // La generación automática nace desactivada: solo se activa desde Ajustes.
      if (!ajustes.enabled) return;

      // Sin secreto interno la petición cae al camino de autenticación normal y
      // devuelve 401 siempre. Se persiste para que no quede solo en el log
      // mientras la pantalla afirma que la generación automática está activa.
      if (!process.env.INTERNAL_SYNC_SECRET) {
        if (!secretoAvisado) {
          secretoAvisado = true;
          logger.error(`[${etiqueta}] Falta INTERNAL_SYNC_SECRET: la generación automática no puede autenticarse`);
          await marcarIntentoGeneracion({ estado: 'error', mensaje: mensajeSinSecreto }).catch((err) =>
            logger.error({ err }, `[${etiqueta}] No se pudo persistir el aviso de configuración`)
          );
        }
        return;
      }

      const objetivo = periodoAnterior();
      const pendientes = periodosPendientes(ajustes.ultimo_periodo_generado, objetivo);
      if (pendientes.length === 0) return;

      const now = new Date();
      // Un día 29, 30 o 31 no existe en todos los meses: se usa el último día real.
      const diaPrevisto = Math.min(ajustes.dia_generacion, ultimoDiaDelMes(now));
      if (now.getDate() < diaPrevisto) return;
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      // El día previsto se respeta la hora configurada; si ya ha pasado el día,
      // se ejecuta en cuanto se pueda (recuperación).
      if (now.getDate() === diaPrevisto && hhmm < ajustes.hora) return;
      if (Date.now() - ultimoFallo < REINTENTO_TRAS_FALLO_MS) return;

      // Una generación en vuelo (esta o la manual) rebotaría con 409 cada minuto.
      if (enVuelo) return;
      if (await hayGeneracionEnCurso()) {
        logger.info(`[${etiqueta}] Hay una generación en curso: se espera al ciclo siguiente`);
        return;
      }

      enVuelo = true;
      try {
        await marcarIntentoGeneracion({
          periodo: pendientes.join(', '),
          estado: 'en_curso',
          mensaje:
            pendientes.length === 1
              ? ''
              : `Recuperando ${pendientes.length} periodos pendientes, uno por uno y en orden.`,
        }).catch((err) => logger.error({ err }, `[${etiqueta}] No se pudo persistir el estado en curso`));

        for (const periodo of pendientes) {
          logger.info({ periodo }, `[${etiqueta}] Generando ${nombreDocumento}s del periodo ${periodo}`);
          const res = await fetch(`http://127.0.0.1:${port}${ruta}`, {
            method: 'POST',
            headers: internalSyncFetchHeaders(),
            body: JSON.stringify({ periodo }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.interrumpida) {
            ultimoFallo = Date.now();
            const mensaje = data.error || (data.interrumpida ? 'La generación se interrumpió' : res.statusText);
            logger.error({ status: res.status, error: mensaje, periodo }, `[${etiqueta}] Error al generar`);
            await marcarIntentoGeneracion({ periodo, estado: 'error', mensaje }).catch((err) =>
              logger.error({ err }, `[${etiqueta}] No se pudo persistir el fallo`)
            );
            return;
          }

          // Éxito parcial: se escribieron documentos pero algo quedó fuera (una
          // factura que no se pudo escribir, un elemento que cambió a medias). El
          // endpoint no ha marcado el periodo, así que se para aquí en vez de
          // seguir con el mes siguiente: el periodo se reintenta en el ciclo
          // siguiente y recoge solo lo que falta. Antes esto se registraba como
          // "OK" y el mes se quedaba a medias para siempre.
          if (data.parcial) {
            ultimoFallo = Date.now();
            const mensaje =
              `Generación incompleta (${data.motivo_incompleto || 'motivo no indicado'}):` +
              ` ${data.total_facturas ?? 0} ${nombreDocumento}(s) escritos,` +
              ` ${data.errores?.length ?? 0} error(es) de escritura,` +
              ` ${data.descartados?.length ?? 0} descartado(s).` +
              ' El periodo no se da por generado y se reintentará.';
            logger.error(
              {
                periodo,
                facturas: data.total_facturas ?? 0,
                errores: data.errores ?? [],
                descartados: data.descartados?.length ?? 0,
                motivo: data.motivo_incompleto || '',
              },
              `[${etiqueta}] PARCIAL: ${periodo} | ${mensaje}`
            );
            await marcarIntentoGeneracion({ periodo, estado: 'parcial', mensaje }).catch((err) =>
              logger.error({ err }, `[${etiqueta}] No se pudo persistir el estado parcial`)
            );
            return;
          }

          // Un mes sin nada que facturar no es un error: cero facturas y el
          // periodo queda dado por ejecutado. El endpoint ya lo ha marcado.
          logger.info(
            {
              periodo,
              facturas: data.total_facturas ?? 0,
              importe: data.total_importe ?? 0,
              ...datosLogOk(data),
            },
            `[${etiqueta}] OK: ${periodo} | ${data.total_facturas ?? 0} ${nombreDocumento}(s) en borrador`
          );
        }

        ultimoFallo = 0;
        await marcarIntentoGeneracion({
          periodo: pendientes[pendientes.length - 1],
          estado: 'ok',
          mensaje: '',
        }).catch((err) => logger.error({ err }, `[${etiqueta}] No se pudo persistir el estado final`));
      } finally {
        enVuelo = false;
      }
    } catch (err) {
      ultimoFallo = Date.now();
      logger.error({ err }, `[${etiqueta}] scheduler error`);
      await marcarIntentoGeneracion({
        estado: 'error',
        mensaje: err?.message || 'Error inesperado en la generación automática',
      }).catch(() => {});
    }
  };
}
