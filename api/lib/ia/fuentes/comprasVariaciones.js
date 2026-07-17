/**
 * Fuente de datos IA: variaciones de compras a proveedor.
 *
 * Motor determinista: `buildAnalisisComprasVariaciones` de
 * `api/lib/compras/analisisCompras.js`. Compara el gasto de los últimos `dias`
 * días con el periodo anterior de igual duración, agrupado por proveedor,
 * familia o producto. No expone datos personales, solo cifras de negocio.
 *
 * Nota: las líneas de compra no están asociadas a un local, así que esta fuente
 * no filtra por local (se protege con su permiso `ia.informe_compras`).
 */
import { buildAnalisisComprasVariaciones } from '../../compras/analisisCompras.js';

export const comprasVariaciones = {
  clave: 'compras_variaciones',
  nombre: 'Variaciones de compras a proveedor',
  descripcion: 'Compara el gasto en compras de los últimos días con el periodo anterior, agrupado por proveedor, familia o producto. Destaca las mayores subidas y bajadas.',
  permiso: 'ia.informe_compras',
  parametros: [
    {
      nombre: 'dias',
      tipo: 'numero',
      requerido: false,
      etiqueta: 'Días por periodo (7–120)',
      defecto: 30,
    },
    {
      nombre: 'agrupacion',
      tipo: 'opcion',
      requerido: false,
      etiqueta: 'Agrupar por',
      opciones: [
        { valor: 'proveedor', etiqueta: 'Proveedor' },
        { valor: 'familia', etiqueta: 'Familia' },
        { valor: 'producto', etiqueta: 'Producto' },
      ],
      defecto: 'proveedor',
    },
  ],
  async generarDatos(params) {
    return buildAnalisisComprasVariaciones({
      dias: params?.dias,
      agrupacion: params?.agrupacion,
    });
  },
};
