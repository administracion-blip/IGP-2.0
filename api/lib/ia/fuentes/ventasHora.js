/**
 * Fuente de datos IA: ventas por hora.
 *
 * Motor determinista: `buildVentasPorHora` de `api/lib/agora/ventasPorHora.js`.
 * Agrupa las ventas del día por hora del reloj y por franja, con total del grupo
 * y desglose por local. Filtra los locales del usuario dentro del motor (no confía
 * en el cliente). No expone datos personales, solo local, hora e importes.
 */
import { buildVentasPorHora } from '../../agora/ventasPorHora.js';

export const ventasHora = {
  clave: 'ventas_hora',
  nombre: 'Ventas por hora',
  descripcion: 'Distribución de la facturación de un día por hora y por franja horaria, con total del grupo y desglose por local. Útil para detectar horas punta y valle.',
  permiso: 'ia.informe_ventas_hora',
  parametros: [
    { nombre: 'fecha', tipo: 'fecha', requerido: false, etiqueta: 'Día (por defecto, ayer)' },
    { nombre: 'localId', tipo: 'local', requerido: false, etiqueta: 'Local (opcional)' },
  ],
  async generarDatos(params, user) {
    return buildVentasPorHora(user, { fecha: params?.fecha, localId: params?.localId });
  },
};
