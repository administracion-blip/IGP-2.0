/**
 * Fuente de datos IA: briefing matutino «día a día».
 *
 * Motor: `buildDiaADia` en `api/lib/ia/motores/diaADia.js`.
 * Filtra locales del usuario dentro de cada bloque (no confía en el cliente).
 *
 * Excepción PII documentada: esta fuente SÍ incluye nombres de cajero/camarero
 * (Cashier/Waiter de tickets Agora) en `excepcionesSospechosas.items`. Es deliberado
 * para el briefing operativo. El resto de fuentes del framework siguen sin enviar
 * nombres al LLM.
 */
import { buildDiaADia } from '../motores/diaADia.js';

export const diaADia = {
  clave: 'dia_a_dia',
  nombre: 'Briefing día a día',
  descripcion:
    'Briefing matutino del día anterior (solo Sede Grupo Paripe): facturación vs día comparable, objetivos MTD (peores/agrupaciones), ratios del día, ventas/hora, invitaciones/descuentos >2€ (nombres Agora), top 3 ventas por usuario/local y mantenimiento del día (reparaciones + limpiezas).',
  permiso: 'ia.informe_dia_a_dia',
  parametros: [
    { nombre: 'fecha', tipo: 'fecha', requerido: false, etiqueta: 'Día (por defecto jornada−1)' },
    { nombre: 'localId', tipo: 'local', requerido: false, etiqueta: 'Local (opcional)' },
  ],
  async generarDatos(params, user) {
    return buildDiaADia(user, { fecha: params?.fecha, localId: params?.localId });
  },
};
