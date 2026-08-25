/**
 * Fuente de datos IA: ventas por artículo (rango de fechas × locales × familias).
 *
 * Motor: `buildVentasPorArticulo` en `api/lib/ia/motores/ventasPorArticulo.js`.
 * Datos desde Igp_VentasProducto (no Ágora en vivo). Filtra locales del usuario
 * en el motor. Expone `datosParaPrompt` para enviar solo el top 50 al LLM.
 */
import {
  buildVentasPorArticulo,
  datosParaPromptVentasPorArticulo,
} from '../motores/ventasPorArticulo.js';

export const ventasPorArticulo = {
  clave: 'ventas_por_articulo',
  nombre: 'Ventas por artículo',
  descripcion:
    'Ranking de artículos vendidos en un rango de fechas (unidades e importe bruto), con filtro opcional por locales (solo Sede Grupo Paripe), familias Ágora y grupos de familias IA. Incluye subtotales por familia.',
  permiso: 'ia.informe_ventas_articulo',
  parametros: [
    { nombre: 'fechaDesde', tipo: 'fecha', requerido: false, etiqueta: 'Desde (por defecto 1 ene año en curso)' },
    { nombre: 'fechaHasta', tipo: 'fecha', requerido: false, etiqueta: 'Hasta (por defecto hoy)' },
    { nombre: 'localIds', tipo: 'locales', requerido: false, etiqueta: 'Locales (vacío = todos permitidos)' },
    { nombre: 'familiaIds', tipo: 'familias', requerido: false, etiqueta: 'Familias Ágora' },
    { nombre: 'grupoIds', tipo: 'grupos_familias', requerido: false, etiqueta: 'Grupos de familias IA' },
    { nombre: 'agruparPorLocal', tipo: 'opcion', requerido: false, etiqueta: 'Agrupar resumen por local', defecto: 'false', opciones: [{ valor: 'false', etiqueta: 'No' }, { valor: 'true', etiqueta: 'Sí' }] },
  ],
  async generarDatos(params, user) {
    return buildVentasPorArticulo(user, {
      fechaDesde: params?.fechaDesde,
      fechaHasta: params?.fechaHasta,
      localIds: params?.localIds,
      familiaIds: params?.familiaIds,
      grupoIds: params?.grupoIds,
      incluirSubtotalesFamilia: params?.incluirSubtotalesFamilia,
      agruparPorLocal: params?.agruparPorLocal,
    });
  },
  datosParaPrompt(datosJson) {
    return datosParaPromptVentasPorArticulo(datosJson);
  },
};
