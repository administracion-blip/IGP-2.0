/**
 * Maestro de departamentos del módulo de dirección.
 *
 * Vive en `Igp_Ajustes` (PK `departamentos`, SK `DEP#<id>`) porque son cinco o
 * seis filas: una tabla propia para eso es una tabla más que crear, vigilar y
 * pagar. Ver `docs/tasks/02-modelo-datos.md`.
 *
 * Dos decisiones que conviene tener presentes al leer el fichero:
 *
 * 1. **El id es un UUID, no un slug del nombre.** El nombre se edita, y un slug
 *    derivado quedaría desincronizado con los `departamento_id` ya guardados en
 *    tareas, proyectos y fichas de usuario.
 * 2. **La baja es siempre lógica.** No hay integridad referencial: un
 *    `departamento_id` grabado en otra tabla no puede quedarse apuntando a nada.
 *    Los inactivos no salen en los desplegables (`soloActivos`) pero siguen
 *    resolviendo el nombre de lo ya grabado.
 *
 * El maestro es etiqueta organizativa, **no** control de acceso (D-01): nada de
 * lo que hay aquí decide quién ve qué.
 */

import crypto from 'crypto';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

/** Partición del maestro dentro de la tabla de ajustes. */
export const PK_DEPARTAMENTOS = 'departamentos';
const PREFIJO_SK = 'DEP#';

export function skDepartamento(id) {
  return `${PREFIJO_SK}${id}`;
}

// ─── Normalización ───

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

/** Nombre tal como se guarda: sin extremos ni espacios interiores repetidos. */
function nombreNormalizado(valor) {
  return texto(valor).replace(/\s+/g, ' ');
}

/**
 * Clave de comparación de nombres: ni mayúsculas ni espacios sobrantes.
 * «  Recursos  Humanos » y «recursos humanos» son el mismo departamento.
 */
export function claveNombre(valor) {
  return nombreNormalizado(valor).toLowerCase();
}

function aOrden(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/**
 * `activo` llega por HTTP y puede venir como texto. Además de `'false'`, `'0'` y
 * `0`, la **cadena vacía cuenta como falso**: es el «campo sin rellenar» de un
 * formulario, y tomarla por `true` hacía que un `PATCH { activo: '' }`
 * reactivara un departamento dado de baja.
 */
function aBooleano(valor) {
  if (typeof valor === 'boolean') return valor;
  if (valor == null) return false;
  const t = String(valor).trim().toLowerCase();
  return !(t === '' || t === 'false' || t === '0');
}

/**
 * Forma pública de un ítem. El id sale del SK y no se duplica como atributo:
 * dos copias del mismo dato acaban divergiendo.
 */
function salida(item) {
  if (!item?.SK) return null;
  return {
    id: String(item.SK).slice(PREFIJO_SK.length),
    nombre: texto(item.nombre),
    responsable_id: texto(item.responsable_id),
    // Una fila escrita a mano sin `activo` cuenta como activa.
    activo: item.activo !== false,
    orden: aOrden(item.orden),
  };
}

/** IDs de departamento de una ficha de usuario, sin vacíos ni repetidos. */
export function normalizarIdsDepartamento(valor) {
  const bruto = Array.isArray(valor) ? valor : [valor];
  const vistos = new Set();
  for (const v of bruto) {
    const id = texto(v);
    if (id) vistos.add(id);
  }
  return [...vistos];
}

// ─── Lectura ───

async function leerCrudos() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.ajustes,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': PK_DEPARTAMENTOS, ':sk': PREFIJO_SK },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

// ─── Nombre del responsable ───

/**
 * Atributos con los que se compone el nombre visible de un usuario. Mismo campo
 * y mismo criterio que el resto del ERP (`api/lib/informes/informeDiario.js`):
 * nombre y apellidos, y el email como último recurso.
 */
const PROYECCION_NOMBRE_USUARIO = 'id_usuario, Nombre, Apellidos, Email';
const MAX_CLAVES_BATCH_GET = 100;
const MAX_INTENTOS_BATCH_GET = 3;

function nombreVisibleUsuario(item) {
  if (!item) return null;
  const nombre = `${item.Nombre ?? ''} ${item.Apellidos ?? ''}`.trim();
  return nombre || texto(item.Email) || null;
}

/**
 * Añade `responsable_nombre` a cada departamento.
 *
 * Lo resuelve el backend porque la pantalla del maestro se abre con
 * `base_datos.ver` y cruzarlo contra `/api/usuarios` exigiría `usuarios.ver`:
 * quien tuviera el primero y no el segundo vería el id crudo en la columna
 * Responsable.
 *
 * Una sola lectura para toda la lista —un `BatchGet` de los ids **distintos** de
 * responsable— en lugar de un `Get` por fila. Vale `null` cuando el
 * departamento no tiene responsable o cuando el usuario ya no existe: no hay
 * integridad referencial contra `igp_usuarios` y un responsable borrado no puede
 * tumbar el listado.
 */
async function conNombreDeResponsable(lista) {
  const ids = [...new Set(lista.map((d) => d.responsable_id).filter(Boolean))];
  const nombres = new Map();

  // El maestro son cinco o seis filas, así que en la práctica es una sola
  // llamada; los bucles están por el límite de 100 claves y por las que DynamoDB
  // puede devolver sin procesar. Los reintentos van acotados: antes que girar sin
  // fin, el listado sale con esos nombres a `null`.
  for (let i = 0; i < ids.length; i += MAX_CLAVES_BATCH_GET) {
    let claves = ids.slice(i, i + MAX_CLAVES_BATCH_GET).map((id) => ({ id_usuario: id }));
    for (let intento = 0; intento < MAX_INTENTOS_BATCH_GET && claves.length > 0; intento += 1) {
      const r = await docClient.send(
        new BatchGetCommand({
          RequestItems: {
            [tables.usuarios]: { Keys: claves, ProjectionExpression: PROYECCION_NOMBRE_USUARIO },
          },
        }),
      );
      for (const item of r.Responses?.[tables.usuarios] || []) {
        nombres.set(texto(item.id_usuario), nombreVisibleUsuario(item));
      }
      claves = r.UnprocessedKeys?.[tables.usuarios]?.Keys || [];
    }
  }

  return lista.map((dep) => ({
    ...dep,
    responsable_nombre: dep.responsable_id ? nombres.get(dep.responsable_id) ?? null : null,
  }));
}

/** La misma resolución para el ítem que devuelven `POST` y `PATCH`. */
async function conNombreDeResponsableUno(departamento) {
  if (!departamento) return departamento;
  const [conNombre] = await conNombreDeResponsable([departamento]);
  return conNombre;
}

/**
 * Lista ordenada por `orden` y, a igualdad, por nombre.
 *
 * @param {{ soloActivos?: boolean }} [opciones] `soloActivos` es lo que piden
 *   los desplegables de los formularios; los listados de mantenimiento del
 *   maestro necesitan ver también las bajas.
 */
export async function listarDepartamentos({ soloActivos = false } = {}) {
  const lista = (await leerCrudos()).map(salida).filter(Boolean);
  const visibles = soloActivos ? lista.filter((d) => d.activo) : lista;
  visibles.sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es'));
  return conNombreDeResponsable(visibles);
}

/** Un departamento por id, activo o no, o `null` si no existe. */
export async function obtenerDepartamento(id) {
  const idNorm = texto(id);
  if (!idNorm) return null;
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.ajustes,
      Key: { PK: PK_DEPARTAMENTOS, SK: skDepartamento(idNorm) },
    }),
  );
  return salida(r.Item);
}

/**
 * Responsable de un departamento, o `''` si no existe o no lo tiene.
 *
 * Es la lectura que alimenta `aux.esResponsableDepartamento` de
 * `api/lib/tasks/acceso.js`: la capa de acceso no consulta nada, recibe el dato
 * ya resuelto.
 */
export async function responsableDeDepartamento(id) {
  const dep = await obtenerDepartamento(id);
  return dep?.responsable_id || '';
}

/**
 * De una lista de ids, los que existen de verdad en el maestro.
 *
 * Se queda con los inactivos a propósito: un departamento dado de baja sigue
 * siendo una referencia válida en una ficha ya grabada, y editar el teléfono de
 * un usuario no debe borrarle en silencio su departamento.
 */
export async function filtrarDepartamentosExistentes(ids) {
  const pedidos = normalizarIdsDepartamento(ids);
  if (pedidos.length === 0) return [];
  const existentes = new Set((await leerCrudos()).map((it) => salida(it)?.id).filter(Boolean));
  return pedidos.filter((id) => existentes.has(id));
}

async function existeOtroConNombre(nombre, idExcluido = '') {
  const clave = claveNombre(nombre);
  return (await leerCrudos()).some((it) => {
    const dep = salida(it);
    // Los inactivos también cuentan: reutilizar un nombre dado de baja se hace
    // reactivándolo, no creando un duplicado que confunda los desplegables.
    return dep && dep.id !== idExcluido && claveNombre(dep.nombre) === clave;
  });
}

// ─── Escritura ───

/**
 * Resultado uniforme de las escrituras, para que el router solo traduzca a HTTP.
 *
 * @typedef {{ ok: true, departamento: object } | { ok: false, status: number, error: string }} ResultadoDepartamento
 */

/** @returns {Promise<ResultadoDepartamento>} */
export async function crearDepartamento({ nombre, responsable_id: responsableId, orden } = {}) {
  const nombreNorm = nombreNormalizado(nombre);
  if (!nombreNorm) {
    return { ok: false, status: 400, error: 'El nombre del departamento es obligatorio' };
  }
  // La comprobación es una lectura previa, no una condición atómica: el `SK` es
  // un UUID, así que no hay clave por la que condicionar el `Put`, y evitar la
  // carrera de verdad pediría una tabla de índice por nombre. Se acepta el
  // riesgo: el maestro lo edita un administrador —dos altas del mismo nombre en
  // el mismo instante son casi imposibles— y si pasara, el duplicado se resuelve
  // borrando uno.
  if (await existeOtroConNombre(nombreNorm)) {
    return { ok: false, status: 409, error: `Ya existe un departamento llamado «${nombreNorm}»` };
  }

  const item = {
    PK: PK_DEPARTAMENTOS,
    SK: skDepartamento(crypto.randomUUID()),
    nombre: nombreNorm,
    responsable_id: texto(responsableId),
    activo: true,
    orden: aOrden(orden),
  };
  await docClient.send(new PutCommand({ TableName: tables.ajustes, Item: item }));
  return { ok: true, departamento: await conNombreDeResponsableUno(salida(item)) };
}

/**
 * Actualiza solo los campos presentes en `cambios`.
 *
 * @param {{ nombre?: string, responsable_id?: string, orden?: number, activo?: boolean }} cambios
 * @returns {Promise<ResultadoDepartamento>}
 */
export async function actualizarDepartamento(id, cambios = {}) {
  const idNorm = texto(id);
  const actual = await obtenerDepartamento(idNorm);
  if (!actual) return { ok: false, status: 404, error: 'El departamento no existe' };

  const nuevos = {};
  if (cambios.nombre !== undefined) {
    const nombreNorm = nombreNormalizado(cambios.nombre);
    if (!nombreNorm) {
      return { ok: false, status: 400, error: 'El nombre del departamento es obligatorio' };
    }
    if (await existeOtroConNombre(nombreNorm, idNorm)) {
      return { ok: false, status: 409, error: `Ya existe un departamento llamado «${nombreNorm}»` };
    }
    nuevos.nombre = nombreNorm;
  }
  if (cambios.responsable_id !== undefined) nuevos.responsable_id = texto(cambios.responsable_id);
  if (cambios.orden !== undefined) nuevos.orden = aOrden(cambios.orden);
  if (cambios.activo !== undefined) nuevos.activo = aBooleano(cambios.activo);

  const campos = Object.keys(nuevos);
  if (campos.length === 0) {
    return { ok: true, departamento: await conNombreDeResponsableUno(actual) };
  }

  const nombres = {};
  const valores = {};
  const asignaciones = campos.map((campo, i) => {
    nombres[`#c${i}`] = campo;
    valores[`:v${i}`] = nuevos[campo];
    return `#c${i} = :v${i}`;
  });

  const r = await docClient.send(
    new UpdateCommand({
      TableName: tables.ajustes,
      Key: { PK: PK_DEPARTAMENTOS, SK: skDepartamento(idNorm) },
      UpdateExpression: `SET ${asignaciones.join(', ')}`,
      ExpressionAttributeNames: nombres,
      ExpressionAttributeValues: valores,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return { ok: true, departamento: await conNombreDeResponsableUno(salida(r.Attributes)) };
}

/**
 * Baja lógica. Nunca borra el ítem: el nombre tiene que seguir resolviéndose
 * para lo que ya lo tiene grabado.
 *
 * @returns {Promise<ResultadoDepartamento>}
 */
export async function desactivarDepartamento(id) {
  return actualizarDepartamento(id, { activo: false });
}
