/**
 * Fuente de datos IA: consecución mensual por local (con importes).
 *
 * Motor determinista: `buildObjetivoMensualConImportes` de
 * `api/lib/agora/objetivoMensual.js`. Filtra locales del usuario dentro del
 * motor (no confía en el cliente). No expone datos personales, solo local +
 * cifras de negocio.
 */
import { buildObjetivoMensualConImportes } from '../../agora/objetivoMensual.js';

export const objetivosMes = {
  clave: 'objetivos_mes',
  nombre: 'Consecución del objetivo mensual',
  descripcion: 'Consecución del mes en curso (hasta ayer) por local, con importes y comparación con el año anterior.',
  permiso: 'ia.informe_objetivos',
  parametros: [
    { nombre: 'localId', tipo: 'local', requerido: false, etiqueta: 'Local (opcional)' },
  ],
  async generarDatos(params, user) {
    return buildObjetivoMensualConImportes(user, { localId: params?.localId });
  },
};
