/**
 * Capa de acceso del módulo de dirección — proyectos, tareas y reuniones.
 *
 * El ERP resuelve hoy el acceso con permisos por rol (`requirePermission`), que
 * contestan «¿puede este rol entrar aquí?». Este módulo necesita además
 * responder «¿puede **este** usuario ver **esta** fila?»: una reunión de
 * dirección no la ve quien tenga `reuniones.ver`, la ve quien estuvo o quien
 * esté autorizado. Los dos mecanismos se combinan: el router sigue filtrando
 * por permiso y estas funciones filtran por fila.
 *
 * Tres decisiones que conviene tener presentes al leer el fichero:
 *
 * 1. **Todo se deniega por defecto.** Cuando falta un dato para decidir —el
 *    proyecto de una tarea que no se cargó, una visibilidad desconocida, los
 *    permisos aún sin leer— la respuesta es `false`, nunca `true`. Un error de
 *    programación tiene que traducirse en «no ves esto», no en una fuga.
 * 2. **Las comprobaciones son puras.** Reciben el contexto ya cargado y los
 *    datos de la fila, y no tocan DynamoDB. Así se pueden probar todas las
 *    combinaciones sin montar tablas, que es la única forma realista de tener
 *    cubierto un árbol de decisión de este tamaño.
 * 3. **El contexto se carga una vez por petición.** `cargarContextoAcceso` hace
 *    dos lecturas (usuario y permisos del rol) y las cachea unos segundos, en
 *    lugar del `GetItem` por permiso que hace `hasPermission`. Un listado que
 *    comprueba tres permisos sobre cincuenta filas hacía 150 lecturas.
 *
 * Ver `docs/tasks/04-permisos-y-acceso.md` para la tabla completa de reglas.
 */

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { codigosPermisoEfectivos } from '../permisoAliases.js';
import { normalizeLocalesUsuario, tieneAlcanceGlobalLocales } from '../usuarioLocales.js';
import {
  PERMISOS,
  ROL_ADMINISTRADOR,
  ROL_PROYECTO,
  VISIBILIDAD_REUNION,
  NIVEL_APROBACION,
  ESTADO_LINEA_COMPRA,
  ordenNivelAprobacion,
} from './tipos.js';

/**
 * Vida del contexto en caché. Corto a propósito: quitarle un permiso a un rol
 * debe surtir efecto sin reiniciar la API, y un minuto de desfase es aceptable
 * para algo que se consulta decenas de veces por pantalla.
 */
const CACHE_TTL_MS = 60_000;

/** @type {Map<string, { ctx: object, expira: number }>} */
const cache = new Map();

// ─── Utilidades ───

function normalizarId(valor) {
  if (valor == null) return '';
  return String(valor).trim();
}

/** Igualdad de identificadores que **no** considera iguales dos vacíos. */
function mismoUsuario(a, b) {
  const x = normalizarId(a);
  const y = normalizarId(b);
  return x !== '' && x === y;
}

function normalizarNombre(valor) {
  return normalizarId(valor).toLowerCase();
}

function listaDeIds(valor) {
  if (Array.isArray(valor)) return valor.map(normalizarId).filter(Boolean);
  const uno = normalizarId(valor);
  return uno ? [uno] : [];
}

/**
 * `Object.freeze` sobre un `Set` no impide `add`, así que hay que anular los
 * mutadores a mano. El contexto se sirve **desde la caché a todas las peticiones
 * del mismo usuario**: si un handler le añadiera un permiso «para probar algo»,
 * se lo estaría añadiendo a todas.
 */
function conjuntoInmutable(valores) {
  const conjunto = new Set(valores);
  const bloquear = () => {
    throw new Error('El contexto de acceso es inmutable: no se le añaden permisos');
  };
  conjunto.add = bloquear;
  conjunto.delete = bloquear;
  conjunto.clear = bloquear;
  return Object.freeze(conjunto);
}

// ─── Contexto ───

/**
 * Construye el contexto de acceso. Separado de la carga para poder armarlo a
 * mano en las pruebas y en los trabajos programados.
 *
 * @param {object} datos
 * @param {string} [datos.idUsuario]
 * @param {string} [datos.rol]
 * @param {string} [datos.nombre] Nombre visible, para firmar el historial.
 * @param {string[]|Set<string>} [datos.permisos] Códigos concedidos al rol.
 * @param {boolean} [datos.permisosCargados] `false` mientras no se hayan leído:
 *   con esto puesto, todo permiso se deniega aunque la lista venga vacía.
 * @param {string[]} [datos.locales] **Nombres** de local, no IDs.
 * @param {string[]} [datos.departamentos] IDs de departamento.
 */
export function crearContextoAcceso({
  idUsuario = '',
  rol = '',
  nombre = '',
  permisos = [],
  permisosCargados,
  locales = [],
  departamentos = [],
} = {}) {
  const rolNorm = normalizarId(rol);
  const localesNorm = listaDeIds(locales);
  return Object.freeze({
    idUsuario: normalizarId(idUsuario),
    rol: rolNorm,
    // Va en el contexto porque la ficha del usuario ya se lee aquí: sin esto, cada
    // escritura que firma el historial acabaría haciendo su propio `GetItem`.
    nombre: typeof nombre === 'string' ? nombre.trim() : '',
    esAdmin: rolNorm === ROL_ADMINISTRADOR,
    permisos: conjuntoInmutable(permisos instanceof Set ? permisos : listaDeIds(permisos)),
    permisosCargados: permisosCargados ?? true,
    locales: Object.freeze(localesNorm),
    alcanceGlobalLocales: tieneAlcanceGlobalLocales(rolNorm, localesNorm),
    departamentos: Object.freeze(listaDeIds(departamentos)),
  });
}

/** Contexto sin identidad: deniega todo. Para rutas internas o tokens huérfanos. */
export function contextoVacio() {
  return crearContextoAcceso({ permisosCargados: false });
}

/**
 * Nombre visible de una ficha, con el mismo criterio que el resto del ERP: nombre y
 * apellidos, y el email como último recurso para que nunca quede en blanco.
 */
function nombreVisible(ficha) {
  const completo = `${ficha?.Nombre ?? ''} ${ficha?.Apellidos ?? ''}`.trim();
  return completo || String(ficha?.Email ?? '').trim();
}

async function permisosDelRol(rol) {
  const codigos = new Set();
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tables.rolesPermisos,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `ROL#${rol}`, ':sk': 'PERMISO#' },
        ProjectionExpression: 'SK',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    for (const item of result.Items || []) {
      const codigo = String(item.SK || '').replace(/^PERMISO#/, '');
      if (codigo) codigos.add(codigo);
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return codigos;
}

/**
 * Carga el contexto del usuario del token: rol, permisos, locales y
 * departamentos.
 *
 * Los errores de DynamoDB **se propagan** en lugar de devolver un contexto
 * vacío: si la tabla de permisos no responde, la petición debe fallar con 500 y
 * no parecer un problema de permisos del usuario.
 *
 * @param {{ sub?: string, id_usuario?: string, rol?: string }} user `req.user`.
 * @param {{ forzar?: boolean }} [opciones] `forzar` salta la caché.
 */
export async function cargarContextoAcceso(user, { forzar = false } = {}) {
  const idUsuario = normalizarId(user?.sub ?? user?.id_usuario);
  if (!idUsuario) return contextoVacio();

  if (!forzar) {
    const entrada = cache.get(idUsuario);
    if (entrada && entrada.expira > Date.now()) return entrada.ctx;
  }

  const got = await docClient.send(
    new GetCommand({
      TableName: tables.usuarios,
      Key: { id_usuario: idUsuario },
      // `Local` es palabra reservada en DynamoDB; de ahí el alias.
      ProjectionExpression: 'id_usuario, #rol, #local, Locales, Departamentos, Nombre, Apellidos, Email',
      ExpressionAttributeNames: { '#rol': 'Rol', '#local': 'Local' },
    }),
  );

  // Token válido de un usuario que ya no existe: se deniega y no se cachea,
  // para que recrearlo surta efecto de inmediato.
  if (!got.Item) return contextoVacio();

  // El rol sale **solo** de la ficha (D-09). Nunca del token: si se vacía el `Rol`
  // de un usuario, con el token vivo hasta 8 h el respaldo le devolvería el rol que
  // tenía al entrar.
  //
  // Vaciar el rol es hoy una operación **manual** sobre DynamoDB: el PUT de
  // `api/routes/usuarios.js` trata la cadena vacía como «no enviado» y conserva el
  // valor, y el desplegable de la ficha no ofrece la opción «sin rol». Para cortar
  // el acceso desde la interfaz, la vía es borrar el usuario.
  const rol = normalizarId(got.Item.Rol);
  const permisos = rol ? await permisosDelRol(rol) : new Set();
  const ctx = crearContextoAcceso({
    idUsuario,
    rol,
    nombre: nombreVisible(got.Item),
    permisos,
    permisosCargados: true,
    locales: normalizeLocalesUsuario(got.Item),
    departamentos: got.Item.Departamentos,
  });

  cache.set(idUsuario, { ctx, expira: Date.now() + CACHE_TTL_MS });
  return ctx;
}

/**
 * Descarta el contexto cacheado. Sin argumento vacía la caché entera; hay que
 * llamarla al cambiar los permisos de un rol o el alta de un usuario.
 */
export function invalidarContextoAcceso(idUsuario) {
  if (idUsuario === undefined) cache.clear();
  else cache.delete(normalizarId(idUsuario));
}

// ─── Permisos globales ───

/** Administrador siempre; el resto solo si el código (o un alias) está concedido. */
export function tienePermiso(ctx, codigo) {
  if (!ctx || !codigo) return false;
  if (ctx.esAdmin) return true;
  if (!ctx.permisosCargados) return false;
  return codigosPermisoEfectivos(codigo).some((c) => ctx.permisos.has(c));
}

// ─── Proyectos ───

/**
 * Rol del usuario dentro del proyecto, o `null` si no participa.
 * `responsable_id` cuenta como responsable aunque no esté en la lista de
 * miembros: es el campo que se rellena al crear el proyecto.
 */
export function rolEnProyecto(ctx, proyecto, miembros = []) {
  if (!ctx || !proyecto) return null;
  if (mismoUsuario(proyecto.responsable_id, ctx.idUsuario)) return ROL_PROYECTO.responsable;
  const fila = (miembros || []).find((m) => mismoUsuario(m?.usuario_id, ctx.idUsuario));
  if (!fila) return null;
  return normalizarId(fila.rol_proyecto) || ROL_PROYECTO.miembro;
}

/** Participar en el proyecto —con cualquier rol— basta para verlo. */
export function puedeVerProyecto(ctx, proyecto, miembros = []) {
  if (!ctx || !proyecto) return false;
  if (ctx.esAdmin) return true;
  if (rolEnProyecto(ctx, proyecto, miembros)) return true;
  return tienePermiso(ctx, PERMISOS.tareasVerTodas);
}

/**
 * El observador nunca edita, tenga el permiso global que tenga.
 *
 * `tareas.editar_todas` **no** llega hasta aquí, aunque sea tentador: editar un
 * proyecto incluye gestionar sus miembros, así que concederlo dejaría a cualquiera
 * con ese permiso añadirse a un proyecto ajeno y verlo entero por la vía legítima.
 * El permiso alcanza a las tareas, que es lo que dice su nombre.
 */
export function puedeEditarProyecto(ctx, proyecto, miembros = []) {
  if (!ctx || !proyecto) return false;
  if (ctx.esAdmin) return true;
  const rol = rolEnProyecto(ctx, proyecto, miembros);
  if (rol === ROL_PROYECTO.observador) return false;
  if (rol === ROL_PROYECTO.responsable) return true;
  return rol === ROL_PROYECTO.miembro && tienePermiso(ctx, PERMISOS.proyectosEditar);
}

/** El presupuesto asignado se oculta a quien no tenga el permiso específico. */
export function puedeVerPresupuesto(ctx) {
  return tienePermiso(ctx, PERMISOS.presupuestoVer);
}

// ─── Tareas ───

/**
 * @typedef {object} ContextoTarea
 * @property {object} [proyecto] Proyecto de la tarea, si la tarea tiene uno.
 * @property {object[]} [miembros] Miembros de ese proyecto.
 */

/**
 * Una tarea con proyecto hereda la visibilidad del proyecto. Si la tarea
 * declara `proyecto_id` y no se pasa el proyecto, se deniega: no se puede
 * decidir sin ese dato y adivinarlo sería filtrarlo.
 *
 * Haberla creado **no** es vía de acceso cuando la tarea pertenece a un
 * proyecto: si a alguien lo sacan del proyecto, o la tarea se mueve a uno
 * confidencial, dejaría una ventana abierta al contenido de la tarea.
 *
 * @param {object} ctx
 * @param {object} tarea
 * @param {ContextoTarea} [aux]
 */
export function puedeVerTarea(ctx, tarea, aux = {}) {
  if (!ctx || !tarea) return false;
  if (ctx.esAdmin) return true;
  if (mismoUsuario(tarea.responsable_id, ctx.idUsuario)) return true;
  if ((tarea.menciones || []).some((m) => mismoUsuario(m, ctx.idUsuario))) return true;
  if (tienePermiso(ctx, PERMISOS.tareasVerTodas)) return true;
  if (normalizarId(tarea.proyecto_id)) {
    return aux.proyecto ? puedeVerProyecto(ctx, aux.proyecto, aux.miembros) : false;
  }
  return mismoUsuario(tarea.creado_por, ctx.idUsuario);
}

/**
 * Editar es más estrecho que ver: estar mencionado no da permiso de escritura.
 * El creador sí puede editar **su** tarea suelta, para poder corregir lo que
 * acaba de escribir; si la tarea pertenece a un proyecto, manda el proyecto.
 *
 * @param {ContextoTarea} [aux]
 */
export function puedeEditarTarea(ctx, tarea, aux = {}) {
  if (!ctx || !tarea) return false;
  if (ctx.esAdmin) return true;
  if (mismoUsuario(tarea.responsable_id, ctx.idUsuario)) return true;
  if (tienePermiso(ctx, PERMISOS.tareasEditarTodas)) return true;
  if (normalizarId(tarea.proyecto_id)) {
    return aux.proyecto ? puedeEditarProyecto(ctx, aux.proyecto, aux.miembros) : false;
  }
  return mismoUsuario(tarea.creado_por, ctx.idUsuario);
}

/**
 * Cambiar de responsable no es editar: la asigna quien manda en el proyecto, no
 * quien la tiene asignada, para que nadie se quite trabajo de encima solo.
 *
 * `tareas.editar_todas` **no** llega hasta aquí. Cambiar el contenido de una
 * tarea y decidir de quién es son cosas distintas: con el atajo, quien tuviera
 * ese permiso repartía trabajo en proyectos de los que no es miembro y la otra
 * persona se lo encontraba en su lista. Reasignar es «quien pueda editar el
 * proyecto», y D-13 deja `tareas.editar_todas` fuera de eso.
 *
 * @param {ContextoTarea} [aux]
 */
export function puedeReasignarTarea(ctx, tarea, aux = {}) {
  if (!ctx || !tarea) return false;
  if (ctx.esAdmin) return true;
  if (normalizarId(tarea.proyecto_id)) {
    return aux.proyecto ? puedeEditarProyecto(ctx, aux.proyecto, aux.miembros) : false;
  }
  return mismoUsuario(tarea.creado_por, ctx.idUsuario);
}

// ─── Reuniones ───

/**
 * ¿Alcanza el usuario el local de la reunión? Compara por nombre, como `Locales`.
 *
 * Quien tiene `Locales` vacío alcanza **todos** los locales, igual que en el resto
 * del ERP (D-13). Es la puerta más ancha del módulo y conviene tenerlo presente al
 * dar de alta usuarios de oficina: si no se le pone ningún local, ve las reuniones
 * de local de todo el grupo. Para lo confidencial está `restringida`, que no
 * depende de esto.
 */
function alcanzaLocalDeReunion(ctx, reunion) {
  if (ctx.alcanceGlobalLocales) return true;
  const nombre = normalizarNombre(reunion.local_nombre);
  if (!nombre) return false;
  return ctx.locales.some((l) => normalizarNombre(l) === nombre);
}

/**
 * @typedef {object} ContextoReunion
 * @property {boolean} [esResponsableDepartamento] `true` si el usuario es el
 *   responsable del departamento de la reunión. Lo resuelve el llamante con el
 *   maestro de departamentos; aquí no se lee nada.
 */

/**
 * Visibilidad de una reunión.
 *
 * Hay dos vías independientes. La primera es haber estado: quien convocó o
 * figura como asistente la ve siempre, sin depender de permisos ni de la
 * visibilidad declarada — habría que explicarle por qué no puede leer el acta
 * de una reunión a la que fue. La segunda es el alcance declarado, y esa sí
 * exige `reuniones.ver` (o `reuniones.ver_direccion` para las de dirección).
 *
 * @param {object[]} [asistentes]
 * @param {ContextoReunion} [aux]
 */
export function puedeVerReunion(ctx, reunion, asistentes = [], aux = {}) {
  if (!ctx || !reunion) return false;
  if (ctx.esAdmin) return true;
  if (mismoUsuario(reunion.convocada_por, ctx.idUsuario)) return true;
  if ((asistentes || []).some((a) => mismoUsuario(a?.usuario_id, ctx.idUsuario))) return true;

  switch (reunion.visibilidad) {
    case VISIBILIDAD_REUNION.restringida:
      return (reunion.usuarios_autorizados || []).some((u) => mismoUsuario(u, ctx.idUsuario));
    case VISIBILIDAD_REUNION.direccion:
      return tienePermiso(ctx, PERMISOS.reunionesVerDireccion);
    case VISIBILIDAD_REUNION.empresa:
      return tienePermiso(ctx, PERMISOS.reunionesVer);
    case VISIBILIDAD_REUNION.departamento: {
      if (!tienePermiso(ctx, PERMISOS.reunionesVer)) return false;
      if (aux.esResponsableDepartamento === true) return true;
      const dep = normalizarId(reunion.departamento_id);
      return dep !== '' && ctx.departamentos.includes(dep);
    }
    case VISIBILIDAD_REUNION.local:
      if (!tienePermiso(ctx, PERMISOS.reunionesVer)) return false;
      return alcanzaLocalDeReunion(ctx, reunion);
    default:
      // Visibilidad ausente o desconocida: se deniega.
      return false;
  }
}

/**
 * Convocar, editar el acta, validar propuestas o borrar el audio. Exige poder
 * ver la reunión: tener `reuniones.gestionar` no debe abrir una reunión
 * restringida a la que no se tiene acceso.
 *
 * @param {object[]} [asistentes]
 * @param {ContextoReunion} [aux]
 */
export function puedeGestionarReunion(ctx, reunion, asistentes = [], aux = {}) {
  if (!ctx || !reunion) return false;
  if (ctx.esAdmin) return true;
  if (!puedeVerReunion(ctx, reunion, asistentes, aux)) return false;
  if (mismoUsuario(reunion.convocada_por, ctx.idUsuario)) return true;
  return tienePermiso(ctx, PERMISOS.reunionesGestionar);
}

/** Borrar el audio es irreversible y va aparte del resto de la gestión. */
export function puedeBorrarAudio(ctx, reunion, asistentes = [], aux = {}) {
  if (!puedeGestionarReunion(ctx, reunion, asistentes, aux)) return false;
  return tienePermiso(ctx, PERMISOS.reunionesBorrarAudio);
}

// ─── Aprobación de compras ───

/**
 * @typedef {object} ContextoAprobacion
 * @property {boolean} [esDireccion] `true` si el usuario está en la lista de
 *   dirección de configuración. Lo resuelve el llamante.
 * @property {boolean} [esResponsableDepartamento] `true` si es el responsable del
 *   departamento del proyecto.
 */

/**
 * Escalón máximo que este usuario puede firmar en este proyecto, o `null` si
 * ninguno.
 *
 * El escalón sale de la **posición** de la persona, no de tener el permiso:
 * `proyectos.compras_aprobar` habilita a participar en aprobaciones —lo comprueba
 * la ruta—, pero no convierte a nadie en dirección. Si lo hiciera, a quien se le
 * concede para que firme compras de 200 € le estaríamos dando también las de
 * 40.000 €. Quién es dirección lo decide A-07 y llega por `aux.esDireccion`.
 *
 * @param {ContextoAprobacion} [aux]
 * @returns {'responsable_proyecto'|'responsable_departamento'|'direccion'|null}
 */
export function nivelAprobacionDe(ctx, proyecto, miembros = [], aux = {}) {
  if (!ctx || !proyecto) return null;
  if (ctx.esAdmin) return NIVEL_APROBACION.direccion;
  if (aux.esDireccion === true) return NIVEL_APROBACION.direccion;
  if (aux.esResponsableDepartamento === true) return NIVEL_APROBACION.responsableDepartamento;
  if (rolEnProyecto(ctx, proyecto, miembros) === ROL_PROYECTO.responsable) {
    return NIVEL_APROBACION.responsableProyecto;
  }
  return null;
}

/**
 * ¿Puede este usuario aprobar esta línea de compra?
 *
 * Quien pide no aprueba, **sin excepción para Administrador**: un control de
 * gasto con puerta trasera para el rol que más gente tiene no controla nada. Si
 * hace falta aprobar una compra propia, la firma otra persona.
 *
 * Se compara contra `nivel_aprobacion_requerido` guardado en la línea, no
 * contra los umbrales actuales, para que tocar la configuración no cambie lo
 * que ya está en curso.
 *
 * @param {ContextoAprobacion} [aux]
 */
export function puedeAprobarLinea(ctx, proyecto, linea, miembros = [], aux = {}) {
  if (!ctx || !proyecto || !linea) return false;
  if (linea.compra_estado !== ESTADO_LINEA_COMPRA.propuesta) return false;
  // Sin solicitante no hay forma de aplicar la regla, así que no se aprueba: es
  // un dato roto, no una línea que cualquiera pueda firmar.
  if (!normalizarId(linea.solicitante_id)) return false;
  if (mismoUsuario(linea.solicitante_id, ctx.idUsuario)) return false;

  const requerido = ordenNivelAprobacion(linea.nivel_aprobacion_requerido);
  if (requerido < 0) return false;

  const nivel = nivelAprobacionDe(ctx, proyecto, miembros, aux);
  if (!nivel) return false;
  return ordenNivelAprobacion(nivel) >= requerido;
}

// ─── Filtrado de listados ───

/**
 * Filtra una lista dejando solo lo visible. `auxDe` devuelve, para cada
 * elemento, los datos que la comprobación necesita (el proyecto de una tarea,
 * los asistentes de una reunión).
 *
 * Un tipo desconocido lanza en lugar de devolver lista vacía: una errata en la
 * llamada tiene que salir en la primera prueba, no esconderse en un listado que
 * un día aparece sin filas.
 *
 * @param {'proyecto'|'tarea'|'reunion'} tipo
 * @param {(item: object) => object} [auxDe]
 */
export function filtrarVisibles(ctx, tipo, items, auxDe = () => ({})) {
  const lista = Array.isArray(items) ? items : [];
  switch (tipo) {
    case 'proyecto':
      return lista.filter((it) => puedeVerProyecto(ctx, it, auxDe(it)?.miembros));
    case 'tarea':
      return lista.filter((it) => puedeVerTarea(ctx, it, auxDe(it) || {}));
    case 'reunion':
      return lista.filter((it) => {
        const aux = auxDe(it) || {};
        return puedeVerReunion(ctx, it, aux.asistentes, aux);
      });
    default:
      throw new Error(`filtrarVisibles: tipo no soportado "${tipo}"`);
  }
}
