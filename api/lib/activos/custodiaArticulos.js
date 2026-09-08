/**
 * Vista de lo entregado agrupado por artículo (modelo) y, dentro de cada uno,
 * por trabajador. Las cantidades son unidades: un lote asignado cuenta su
 * `cantidad`; una unidad cuenta 1.
 */

import { tallaDe, unidadesDe } from './stockDisponible.js';
import { localImputadoDe, nombreLocalImputadoDe } from './localImputado.js';

function texto(v) {
  return v == null ? '' : String(v).trim();
}

function compara(a, b) {
  return texto(a).localeCompare(texto(b), 'es');
}

/** Misma preferencia que el listado: foto general del activo si la tiene. */
function claveFotoDeActivo(item) {
  const fotos = Array.isArray(item?.fotos) ? item.fotos : [];
  const foto = fotos.find((f) => f.tipo === 'general' && f.s3_key) || fotos.find((f) => f.s3_key);
  return foto?.s3_key || null;
}

/**
 * Devuelve un artículo por modelo con `foto_s3_key` sin resolver: quien llame
 * decide si firma esa clave o la del modelo.
 */
export function agruparCustodiaPorArticulo(items) {
  const porModelo = new Map();

  for (const it of items || []) {
    const modeloId = texto(it?.modelo_id);
    const custodioId = texto(it?.custodio_id);
    const unidades = unidadesDe(it);
    if (!modeloId || !custodioId || !unidades) continue;

    if (!porModelo.has(modeloId)) {
      porModelo.set(modeloId, {
        modelo_id: modeloId,
        marca: texto(it.marca),
        nombre_modelo: texto(it.nombre_modelo),
        categoria_id: it.categoria_id ?? null,
        foto_s3_key: null,
        cantidad: 0,
        custodios: new Map(),
      });
    }
    const articulo = porModelo.get(modeloId);
    articulo.cantidad += unidades;
    if (!articulo.foto_s3_key) articulo.foto_s3_key = claveFotoDeActivo(it);

    const talla = tallaDe(it);
    const imputadoId = localImputadoDe(it);
    const clave = [custodioId, talla || '', texto(it.id_local), imputadoId].join('|');
    if (!articulo.custodios.has(clave)) {
      articulo.custodios.set(clave, {
        employee_id: custodioId,
        employee_nombre: texto(it.custodio_nombre) || custodioId,
        cantidad: 0,
        talla,
        id_local: texto(it.id_local) || null,
        local_nombre: texto(it.local_nombre) || null,
        local_imputado_id: imputadoId || null,
        local_imputado_nombre: nombreLocalImputadoDe(it) || null,
      });
    }
    articulo.custodios.get(clave).cantidad += unidades;
  }

  return [...porModelo.values()]
    .map((articulo) => ({
      ...articulo,
      custodios: [...articulo.custodios.values()].sort(
        (a, b) => compara(a.employee_nombre, b.employee_nombre) || compara(a.talla, b.talla),
      ),
    }))
    .sort((a, b) => compara(`${a.marca} ${a.nombre_modelo}`, `${b.marca} ${b.nombre_modelo}`));
}
