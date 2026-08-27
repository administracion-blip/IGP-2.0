/**
 * Proyectos del módulo de dirección: listado, ficha, escritura y filas hijas
 * (miembros y vínculos).
 *
 * La lectura pura vive en `proyectoLectura.js`, que comparten los dos routers
 * del módulo; aquí está lo que **escribe**, más el listado paginado.
 *
 * Cinco cosas que conviene tener presentes al leer el fichero:
 *
 * 1. **El acceso no se decide aquí.** Cada operación lee el proyecto y pregunta
 *    a `acceso.js`; esto solo traduce ese `false` a un 403 o a un 404.
 * 2. **`gasto_comprometido` y `gasto_real` no se persisten**: se suman al leer
 *    las líneas `COMPRA#` de la partición. Un contador denormalizado que se
 *    toca desde varios sitios se desincroniza, y sumar decenas de líneas que ya
 *    venían en la misma Query no cuesta nada.
 * 3. **`gsi_listado` solo va en el ítem `META`.** Es lo que mantiene el
 *    `Listado-index` con un ítem por proyecto y no con sus miembros, líneas de
 *    compra y vínculos dentro.
 * 4. **`actualizado_en` se refresca en toda escritura**, también en las de las
 *    filas hijas: es la clave de ordenación del listado, y un proyecto donde
 *    acaba de entrar gente tiene que subir.
 * 5. **Los nombres y los permisos de fila los resuelve el servidor.** Todo
 *    proyecto que sale de aquí lleva `responsable_nombre` y `permisos_fila`, y
 *    toda fila de miembro lleva `usuario_nombre`, para que la interfaz no cruce
 *    ids contra `/api/usuarios` ni reimplemente la capa de acceso.
 *
 * Ver `docs/tasks/02-modelo-datos.md` y `docs/tasks/03-contrato-api.md`.
 */

import crypto from 'crypto';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  ESTADOS_PROYECTO,
  ESTADO_LINEA_COMPRA,
  GSI_LISTADO,
  PERMISOS,
  PK,
  PRIORIDADES,
  ROLES_PROYECTO,
  ROL_PROYECTO,
  SK,
  TIPOS_VINCULO,
  aNumeroFinito,
  claveVinculo,
  enLista,
} from './tipos.js';
import {
  filtrarVisibles,
  puedeEditarProyecto,
  puedeVerPresupuesto,
  puedeVerProyecto,
  tienePermiso,
} from './acceso.js';
import {
  leerProyectoCompleto,
  leerProyectoConMiembros,
  proyectosDelUsuario,
} from './proyectoLectura.js';
import { ACCIONES, listarActividad, registrarActividad } from './actividad.js';
import { codificarCursor, decodificarCursor, limiteValido } from './paginacion.js';

const IDX_LISTADO = 'Listado-index';
/** Tipo de entidad, para el registro de actividad y para `filtrarVisibles`. */
const ENTIDAD = 'proyecto';

/** Límite de `BatchWriteItem`. */
const MAX_LOTE = 25;
const MAX_INTENTOS_LOTE = 3;

const ESTADO_INICIAL = 'borrador';
const ESTADO_CERRADO = 'cerrado';
const PRIORIDAD_POR_DEFECTO = 'media';

// Si el integrador renombrara un estado o una prioridad en `tipos.js`, esto salta
// al cargar el módulo y no al escribir un proyecto con un valor inexistente.
if (
  !enLista(ESTADOS_PROYECTO, ESTADO_INICIAL) ||
  !enLista(ESTADOS_PROYECTO, ESTADO_CERRADO) ||
  !enLista(PRIORIDADES, PRIORIDAD_POR_DEFECTO)
) {
  throw new Error('Los valores por defecto de proyecto no coinciden con tipos.js');
}

/** Estados de línea de compra que cuentan como gasto comprometido. */
const ESTADOS_COMPROMETIDO = [ESTADO_LINEA_COMPRA.aprobada, ESTADO_LINEA_COMPRA.pedida];

// ─── Utilidades ───

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function mismoId(a, b) {
  const x = texto(a);
  return x !== '' && x === texto(b);
}

function ahora() {
  return new Date().toISOString();
}

function hoy() {
  return ahora().slice(0, 10);
}

/**
 * Fecha de calendario. Admite el instante ISO completo y se queda con el día,
 * porque los campos de fecha del proyecto son `YYYY-MM-DD`.
 *
 * @returns {string|null} `''` si venía vacía (petición de borrado), `null` si no
 *   es una fecha real.
 */
function aFecha(valor) {
  const bruto = texto(valor);
  if (!bruto) return '';
  const m = bruto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, anio, mes, dia] = m.map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  // Descarta 31 de febrero y compañía: `Date` los desborda al mes siguiente.
  if (fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) return null;
  return bruto.slice(0, 10);
}

/** Céntimos: evita que sumar decimales binarios deje un 149.99999999999997. */
function redondear(valor) {
  return Math.round(valor * 100) / 100;
}

/**
 * @typedef {{ ok: false, status: number, error: string }} Fallo
 */

/** @returns {Fallo} */
function rechazar(status, error) {
  return { ok: false, status, error };
}

/**
 * Traduce la decisión de `acceso.js` al fallo que corresponde, o `null` si se puede
 * seguir.
 *
 * **Lo que no se ve responde `404`, no `403`.** Un `403` confirma que el proyecto
 * existe, y quien pregunta ya ha demostrado que no le corresponde saberlo. El `403`
 * se reserva para «lo veo pero no puedo tocarlo», que no revela nada nuevo. Es el
 * mismo criterio que sigue el router de tareas: una respuesta distinta en cada
 * router obligaría a la interfaz a tratar los dos casos.
 *
 * @returns {Fallo|null}
 */
function comprobarAcceso(ctx, leido, { editar = false } = {}) {
  if (!puedeVerProyecto(ctx, leido.proyecto, leido.miembros)) {
    return rechazar(404, 'El proyecto no existe');
  }
  if (editar && !puedeEditarProyecto(ctx, leido.proyecto, leido.miembros)) {
    return rechazar(403, 'No puedes editar este proyecto');
  }
  return null;
}

/**
 * Autor de una escritura, con su nombre visible, para que el historial no muestre
 * ids crudos a quien no tenga `usuarios.ver`. Ambos salen del contexto de acceso,
 * que ya ha leído la ficha del usuario: no cuesta ninguna lectura extra.
 */
function autorDe(ctx) {
  return { id_usuario: ctx?.idUsuario, Nombre: ctx?.nombre };
}

// ─── Nombres de usuario ───

/**
 * Atributos con los que se compone el nombre visible. Mismo criterio que el
 * maestro de departamentos y que el resto del ERP: nombre y apellidos, y el
 * email como último recurso para que nunca quede en blanco.
 */
const PROYECCION_NOMBRE_USUARIO = 'id_usuario, Nombre, Apellidos, Email';
/** Tope de `BatchGetItem`. */
const MAX_CLAVES_BATCH_GET = 100;
const MAX_INTENTOS_BATCH_GET = 3;

function nombreVisibleUsuario(item) {
  const completo = `${item?.Nombre ?? ''} ${item?.Apellidos ?? ''}`.trim();
  return completo || texto(item?.Email) || null;
}

/**
 * Nombre visible de un conjunto de usuarios, resuelto **en lote**.
 *
 * Lo resuelve el backend porque las pantallas del módulo se abren con
 * `proyectos.ver` y cruzar los ids contra `/api/usuarios` exigiría además
 * `usuarios.ver`: quien tuviera el primero y no el segundo vería «responsable no
 * disponible» en todas las columnas. Es el mismo motivo por el que lo hace
 * `departamentos.js`.
 *
 * Una lectura por cada cien ids **distintos**, nunca una por fila: un listado de
 * cincuenta tareas de doce personas son doce claves en un `BatchGet`. Los
 * reintentos están acotados: antes que girar sin fin ante throttling, esos
 * nombres salen sin resolver.
 *
 * La comparte `tareas.js`, que necesita exactamente lo mismo para el responsable
 * de cada tarea.
 *
 * @param {Array<string|undefined>} ids
 * @returns {Promise<Map<string, string|null>>} Los ids que ya no existen en
 *   `igp_usuarios` **no** entran en el mapa: no hay integridad referencial y una
 *   persona borrada no puede tumbar un listado.
 */
export async function nombresDeUsuarios(ids) {
  const unicos = [...new Set((Array.isArray(ids) ? ids : [ids]).map(texto).filter(Boolean))];
  const nombres = new Map();

  for (let i = 0; i < unicos.length; i += MAX_CLAVES_BATCH_GET) {
    let claves = unicos.slice(i, i + MAX_CLAVES_BATCH_GET).map((id) => ({ id_usuario: id }));
    for (let intento = 0; intento < MAX_INTENTOS_BATCH_GET && claves.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchGetCommand({
          RequestItems: {
            [tables.usuarios]: { Keys: claves, ProjectionExpression: PROYECCION_NOMBRE_USUARIO },
          },
        }),
      );
      for (const item of res?.Responses?.[tables.usuarios] || []) {
        nombres.set(texto(item.id_usuario), nombreVisibleUsuario(item));
      }
      claves = res?.UnprocessedKeys?.[tables.usuarios]?.Keys || [];
    }
  }
  return nombres;
}

/** Nombre de un id dentro de un mapa ya resuelto. `null` si no hay id o no existe. */
export function nombreDe(nombres, id) {
  const clave = texto(id);
  if (!clave) return null;
  return nombres?.get(clave) ?? null;
}

// ─── Permisos de fila ───

/**
 * Qué puede hacer quien pregunta con **esta** fila.
 *
 * Sale de `acceso.js` sin reimplementar ni una regla. Existe para que la
 * interfaz no tenga que llevar su propia copia de la capa de acceso: dos
 * implementaciones de la misma decisión divergen, y el síntoma es un botón
 * escondido a quien sí puede pulsarlo.
 *
 * `borrar` refleja el permiso global y la visibilidad, que es lo que comprueba
 * `borrarProyecto`. Si el proyecto tiene tareas, el borrado las lleva consigo.
 */
function permisosFilaProyecto(ctx, proyecto, miembros = []) {
  return {
    editar: puedeEditarProyecto(ctx, proyecto, miembros),
    borrar:
      tienePermiso(ctx, PERMISOS.proyectosBorrar) && puedeVerProyecto(ctx, proyecto, miembros),
  };
}

// ─── Forma pública ───

/**
 * Ítem `META` tal como sale hacia el cliente.
 *
 * El presupuesto y las dos sumas de gasto van juntos: `proyectos.presupuesto_ver`
 * habilita «ver presupuesto, comprometido y real». Sin el permiso **el campo no
 * viaja**, en lugar de viajar a cero: un cero es un dato, y además haría pensar
 * que el proyecto no tiene presupuesto asignado.
 */
function salidaProyecto(item, ctx, gastos) {
  const { PK: _pk, SK: _sk, gsi_listado: _gsi, presupuesto_asignado: presupuesto, ...resto } = item;
  const salida = { ...resto };
  if (puedeVerPresupuesto(ctx)) {
    if (presupuesto !== undefined) salida.presupuesto_asignado = presupuesto;
    if (gastos) Object.assign(salida, gastos);
  }
  return salida;
}

/**
 * Proyecto tal como viaja: la forma pública más lo que la interfaz necesita para
 * pintar la fila sin cruzar nada. `miembros` es solo para decidir los permisos;
 * no sale en el objeto.
 */
function proyectoConExtras(item, ctx, { miembros = [], gastos, nombres } = {}) {
  return {
    ...salidaProyecto(item, ctx, gastos),
    responsable_nombre: nombreDe(nombres, item?.responsable_id),
    permisos_fila: permisosFilaProyecto(ctx, item, miembros),
  };
}

function salidaMiembro(item) {
  const { PK: _pk, SK: _sk, ...resto } = item;
  return resto;
}

/** Fila de miembro con el nombre resuelto, para que la ficha no muestre ids. */
function miembroConNombre(item, nombres) {
  return { ...salidaMiembro(item), usuario_nombre: nombreDe(nombres, item?.usuario_id) };
}

/** `vinculo_clave` es la partición del `Vinculo-index`: dentro se queda. */
function salidaVinculo(item) {
  const { PK: _pk, SK: _sk, vinculo_clave: _clave, ...resto } = item;
  return resto;
}

// ─── Gasto ───

/**
 * Importe con el que una línea entra en el comprometido. `precio_total_estimado`
 * se calcula al guardar la línea (Fase 4); el producto es el respaldo para las
 * que se escribieran sin él.
 */
function importeEstimado(linea) {
  const total = aNumeroFinito(linea?.precio_total_estimado);
  if (total != null) return total;
  const cantidad = aNumeroFinito(linea?.cantidad);
  const unitario = aNumeroFinito(linea?.precio_unitario_estimado);
  return cantidad != null && unitario != null ? cantidad * unitario : 0;
}

/**
 * Comprometido y real de un proyecto a partir de sus líneas `COMPRA#`.
 *
 * Comprometido: lo aprobado y lo ya pedido, por su importe estimado. Real: lo
 * recibido, por el precio que se pagó de verdad. Una línea recibida sale del
 * comprometido y entra en el real: no está en los dos sitios a la vez.
 *
 * @param {object[]} [compras]
 * @returns {{ gasto_comprometido: number, gasto_real: number }}
 */
export function calcularGastos(compras = []) {
  let comprometido = 0;
  let real = 0;
  for (const linea of compras) {
    const estado = texto(linea?.compra_estado);
    if (ESTADOS_COMPROMETIDO.includes(estado)) comprometido += importeEstimado(linea);
    else if (estado === ESTADO_LINEA_COMPRA.recibida) real += aNumeroFinito(linea?.precio_real) ?? 0;
  }
  return { gasto_comprometido: redondear(comprometido), gasto_real: redondear(real) };
}

// ─── Validación de entrada ───

const CAMPOS_TEXTO = ['nombre', 'descripcion', 'departamento_id', 'responsable_id', 'empresa_id'];
const ETIQUETA_FECHA = {
  fecha_inicio: 'inicio',
  fecha_fin_prevista: 'fin prevista',
  fecha_cierre: 'cierre',
};
const CAMPOS_FECHA = Object.keys(ETIQUETA_FECHA);

/** Campos que el `PATCH` acepta. Lo que no esté aquí se ignora. */
export const CAMPOS_EDITABLES = [
  ...CAMPOS_TEXTO,
  ...CAMPOS_FECHA,
  'estado',
  'prioridad',
  'presupuesto_asignado',
];

/**
 * Normaliza y valida el cuerpo de una escritura de proyecto.
 *
 * En el resultado, `''` (texto) y `null` (presupuesto y fechas) significan
 * «borra este campo»: es lo que llega de un formulario con el campo vaciado.
 *
 * @param {object} body
 * @param {{ parcial: boolean }} opciones `parcial` es el `PATCH`: solo se miran
 *   los campos presentes.
 * @returns {{ datos: object, error?: undefined } | { error: string, datos?: undefined }}
 */
function normalizarEntrada(body = {}, { parcial }) {
  const datos = {};

  if (!parcial || body.nombre !== undefined) {
    const nombre = texto(body.nombre).replace(/\s+/g, ' ');
    if (!nombre) return { error: 'El nombre del proyecto es obligatorio' };
    datos.nombre = nombre;
  }

  for (const campo of CAMPOS_TEXTO) {
    if (campo === 'nombre' || body[campo] === undefined) continue;
    datos[campo] = texto(body[campo]);
  }

  for (const campo of CAMPOS_FECHA) {
    if (body[campo] === undefined) continue;
    const fecha = aFecha(body[campo]);
    if (fecha === null) {
      return { error: `La fecha de ${ETIQUETA_FECHA[campo]} debe ir en formato AAAA-MM-DD` };
    }
    datos[campo] = fecha || null;
  }

  if (body.estado !== undefined) {
    const estado = texto(body.estado);
    if (!enLista(ESTADOS_PROYECTO, estado)) {
      return { error: `Estado de proyecto no válido: admite ${ESTADOS_PROYECTO.join(', ')}` };
    }
    datos.estado = estado;
  }

  if (body.prioridad !== undefined) {
    const prioridad = texto(body.prioridad);
    if (!enLista(PRIORIDADES, prioridad)) {
      return { error: `Prioridad no válida: admite ${PRIORIDADES.join(', ')}` };
    }
    datos.prioridad = prioridad;
  }

  if (body.presupuesto_asignado !== undefined) {
    if (body.presupuesto_asignado === null || texto(body.presupuesto_asignado) === '') {
      datos.presupuesto_asignado = null;
    } else {
      const importe = aNumeroFinito(body.presupuesto_asignado);
      if (importe == null || importe < 0) {
        return { error: 'El presupuesto asignado debe ser un número mayor o igual que cero' };
      }
      datos.presupuesto_asignado = importe;
    }
  }

  return { datos };
}

// ─── Escritura en DynamoDB ───

/** `BatchWrite` en trozos de 25, reintentando lo que DynamoDB devuelva sin procesar. */
async function escribirLote(peticiones) {
  for (let i = 0; i < peticiones.length; i += MAX_LOTE) {
    let pendientes = peticiones.slice(i, i + MAX_LOTE);
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && pendientes.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [tables.proyectos]: pendientes } }),
      );
      pendientes = res?.UnprocessedItems?.[tables.proyectos] || [];
    }
    if (pendientes.length > 0) {
      throw new Error('DynamoDB no aceptó parte del lote de escritura de proyectos');
    }
  }
}

function filaMiembro(idProyecto, usuarioId, rol, autor, instante) {
  return {
    PK: PK.proyecto(idProyecto),
    SK: SK.miembro(usuarioId),
    usuario_id: usuarioId,
    rol_proyecto: rol,
    añadido_por: autor,
    añadido_en: instante,
  };
}

/**
 * Sube el `actualizado_en` del `META` tras escribir una fila hija.
 *
 * La condición no es decorativa: sin ella, un `Update` sobre un proyecto que
 * otro acaba de borrar recrearía un `META` con solo la clave y la fecha —un
 * proyecto fantasma sin nombre y sin `gsi_listado`, invisible en el listado pero
 * alcanzable por id.
 */
async function tocarProyecto(idProyecto, instante) {
  await docClient.send(
    new UpdateCommand({
      TableName: tables.proyectos,
      Key: { PK: PK.proyecto(idProyecto), SK: SK.meta },
      UpdateExpression: 'SET #act = :act',
      ExpressionAttributeNames: { '#act': 'actualizado_en' },
      ExpressionAttributeValues: { ':act': instante },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

/** Todas las claves de la partición de un proyecto, para el borrado físico. */
async function clavesDeParticion(idProyecto) {
  const claves = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.proyectos,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK.proyecto(texto(idProyecto)) },
        ProjectionExpression: 'PK, SK',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const item of res.Items || []) claves.push({ PK: item.PK, SK: item.SK });
    desde = res.LastEvaluatedKey || null;
  } while (desde);
  return claves;
}

// ─── Listado ───

function coincideFiltro(proyecto, { estado, departamento, responsable }) {
  if (estado && texto(proyecto.estado) !== estado) return false;
  if (departamento && texto(proyecto.departamento_id) !== departamento) return false;
  if (responsable && texto(proyecto.responsable_id) !== responsable) return false;
  return true;
}

/**
 * Página del listado, **ya filtrada por visibilidad**.
 *
 * `estado`, `departamento` y `responsable` se filtran en memoria sobre lo que
 * devuelve el `Listado-index`: son decenas de ítems ya leídos y ahorra tres
 * índices (`docs/tasks/02-modelo-datos.md`). El efecto secundario aceptado es
 * que una página puede traer menos elementos que el límite pedido y aun así
 * devolver cursor.
 *
 * La pertenencia de quien mira sale de dos lecturas —una Query al
 * `Miembro-index` y un `BatchGet`—, no de una por fila.
 */
export async function listarProyectosVisibles(ctx, opciones = {}) {
  const { limite, cursor, estado, departamento, responsable } = opciones;
  const filtroEstado = texto(estado);
  if (filtroEstado && !enLista(ESTADOS_PROYECTO, filtroEstado)) {
    return rechazar(400, `Estado de proyecto no válido: admite ${ESTADOS_PROYECTO.join(', ')}`);
  }

  const desde = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.proyectos,
      IndexName: IDX_LISTADO,
      KeyConditionExpression: 'gsi_listado = :g',
      ExpressionAttributeValues: { ':g': GSI_LISTADO.proyecto },
      // El orden del índice es `actualizado_en`: al revés es «actividad reciente
      // primero», que es como se mira un listado de proyectos.
      ScanIndexForward: false,
      Limit: limiteValido(limite),
      ...(desde && { ExclusiveStartKey: desde }),
    }),
  );

  const pagina = res.Items || [];
  const mios = pagina.length > 0 ? await proyectosDelUsuario(ctx?.idUsuario) : new Map();
  const visibles = filtrarVisibles(ctx, ENTIDAD, pagina, (item) => ({
    miembros: mios.get(texto(item.id_proyecto))?.miembros || [],
  }));

  const filtrados = visibles.filter((p) =>
    coincideFiltro(p, { estado: filtroEstado, departamento: texto(departamento), responsable: texto(responsable) }),
  );

  // Un `BatchGet` para los responsables de toda la página. `permisos_fila` no
  // cuesta ninguna lectura: sale de `mios`, que ya se leyó para filtrar la
  // visibilidad y trae la fila de miembro de quien pregunta, que es lo único que
  // mira `puedeEditarProyecto`.
  const nombres = await nombresDeUsuarios(filtrados.map((p) => p.responsable_id));

  return {
    ok: true,
    proyectos: filtrados.map((p) =>
      proyectoConExtras(p, ctx, {
        miembros: mios.get(texto(p.id_proyecto))?.miembros || [],
        nombres,
      }),
    ),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

/**
 * Proyectos en los que participa quien pregunta. Sin paginar a propósito: sale
 * del `Miembro-index` de una persona, que son unos pocos ítems.
 */
export async function listarProyectosDelUsuario(ctx) {
  const mapa = await proyectosDelUsuario(ctx?.idUsuario);
  const entradas = [...mapa.values()]
    .filter((entrada) => entrada.proyecto)
    .sort((a, b) =>
      texto(b.proyecto.actualizado_en).localeCompare(texto(a.proyecto.actualizado_en)),
    );
  const nombres = await nombresDeUsuarios(entradas.map((e) => e.proyecto.responsable_id));
  return {
    ok: true,
    proyectos: entradas.map((e) =>
      proyectoConExtras(e.proyecto, ctx, { miembros: e.miembros, nombres }),
    ),
  };
}

/**
 * Ficha completa: cabecera, miembros, vínculos y las dos sumas de gasto, en una
 * sola Query. Las líneas `COMPRA#` se leen para sumar pero no salen: sus
 * endpoints son de Fase 4.
 *
 * Un proyecto que no se alcanza responde `404`, igual que si no existiera: ver
 * `comprobarAcceso`.
 */
export async function obtenerFichaProyecto(ctx, idProyecto) {
  const leido = await leerProyectoCompleto(idProyecto);
  if (!leido) return rechazar(404, 'El proyecto no existe');
  const denegado = comprobarAcceso(ctx, leido);
  if (denegado) return denegado;

  // Un solo `BatchGet` para el responsable y todo el equipo: un `Get` por fila
  // convertiría la ficha de un proyecto de doce personas en trece lecturas.
  const nombres = await nombresDeUsuarios([
    leido.proyecto.responsable_id,
    ...leido.miembros.map((m) => m?.usuario_id),
  ]);

  return {
    ok: true,
    proyecto: proyectoConExtras(leido.proyecto, ctx, {
      miembros: leido.miembros,
      gastos: calcularGastos(leido.compras),
      nombres,
    }),
    miembros: leido.miembros.map((m) => miembroConNombre(m, nombres)),
    vinculos: leido.vinculos.map(salidaVinculo),
  };
}

/** Historial del proyecto, más reciente primero. Hereda su visibilidad. */
export async function listarActividadProyecto(ctx, idProyecto, { limite, cursor } = {}) {
  const leido = await leerProyectoConMiembros(idProyecto);
  if (!leido) return rechazar(404, 'El proyecto no existe');
  const denegado = comprobarAcceso(ctx, leido);
  if (denegado) return denegado;
  const { actividad, cursor: siguiente } = await listarActividad({
    tipo: ENTIDAD,
    entidadId: texto(idProyecto),
    limite,
    cursor,
  });
  return { ok: true, actividad, cursor: siguiente };
}

// ─── Alta ───

/**
 * Crea el proyecto y la fila de miembro de su responsable.
 *
 * Quien lo crea queda como responsable salvo que indique a otro; si indica a
 * otro, entra además como miembro, porque un proyecto no tiene visibilidad
 * declarada —se es miembro o no— y si no, quien lo acaba de crear no podría ni
 * abrirlo.
 *
 * Los ítems se escriben en un lote. Si el del responsable se quedara por el
 * camino, no perdería el acceso: `responsable_id` de la cabecera ya cuenta como
 * rol de responsable en la capa de acceso.
 */
export async function crearProyecto(ctx, body = {}) {
  const { datos, error } = normalizarEntrada(body, { parcial: false });
  if (error) return rechazar(400, error);
  if (datos.presupuesto_asignado != null && !puedeVerPresupuesto(ctx)) {
    return rechazar(403, 'No tienes permiso para asignar presupuesto');
  }

  const id = crypto.randomUUID();
  const instante = ahora();
  const responsableId = datos.responsable_id || texto(ctx?.idUsuario);

  const meta = {
    PK: PK.proyecto(id),
    SK: SK.meta,
    id_proyecto: id,
    nombre: datos.nombre,
    estado: datos.estado || ESTADO_INICIAL,
    prioridad: datos.prioridad || PRIORIDAD_POR_DEFECTO,
    responsable_id: responsableId,
    creado_por: texto(ctx?.idUsuario),
    creado_en: instante,
    actualizado_en: instante,
    gsi_listado: GSI_LISTADO.proyecto,
  };
  for (const campo of ['descripcion', 'departamento_id', 'empresa_id', ...CAMPOS_FECHA]) {
    if (datos[campo]) meta[campo] = datos[campo];
  }
  if (datos.presupuesto_asignado != null) meta.presupuesto_asignado = datos.presupuesto_asignado;
  if (meta.estado === ESTADO_CERRADO && !meta.fecha_cierre) meta.fecha_cierre = hoy();

  const autorId = texto(ctx?.idUsuario);
  const miembrosNuevos = [];
  if (responsableId) {
    miembrosNuevos.push(filaMiembro(id, responsableId, ROL_PROYECTO.responsable, autorId, instante));
  }
  if (autorId && !mismoId(autorId, responsableId)) {
    miembrosNuevos.push(filaMiembro(id, autorId, ROL_PROYECTO.miembro, autorId, instante));
  }
  await escribirLote([
    { PutRequest: { Item: meta } },
    ...miembrosNuevos.map((Item) => ({ PutRequest: { Item } })),
  ]);

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: id,
    accion: ACCIONES.creada,
    usuario: autorDe(ctx),
    detalle: { nombre: meta.nombre, estado: meta.estado, responsable_id: responsableId },
  });

  const nombres = await nombresDeUsuarios([responsableId]);
  return {
    ok: true,
    proyecto: proyectoConExtras(meta, ctx, { miembros: miembrosNuevos, nombres }),
  };
}

// ─── Edición ───

/** Miembros con rol de responsable. Las filas de miembro sobreviven al `META`. */
function responsablesEnMiembros(miembros) {
  const ids = new Set();
  for (const m of miembros || []) {
    if (texto(m?.rol_proyecto) === ROL_PROYECTO.responsable && texto(m?.usuario_id)) {
      ids.add(texto(m.usuario_id));
    }
  }
  return ids;
}

/**
 * Quién seguiría siendo responsable si se quitara a `usuarioFuera`. Cuenta el
 * `responsable_id` de la cabecera, que en la capa de acceso vale como rol de
 * responsable aunque no haya fila de miembro.
 */
function responsablesTrasQuitar(proyecto, miembros, usuarioFuera) {
  const ids = responsablesEnMiembros(miembros);
  const responsableMeta = texto(proyecto?.responsable_id);
  if (responsableMeta) ids.add(responsableMeta);
  ids.delete(texto(usuarioFuera));
  return ids;
}

/**
 * Edita la cabecera.
 *
 * Cambiar de responsable le crea su fila de miembro: sin ella no aparecería en
 * el `Miembro-index` y «mis proyectos» no le mostraría el proyecto que dirige.
 * Vaciar `responsable_id` solo se admite si algún miembro sigue teniendo el rol:
 * un proyecto sin responsable no lo puede editar nadie salvo Administrador.
 */
export async function actualizarProyecto(ctx, idProyecto, body = {}) {
  const leido = await leerProyectoCompleto(idProyecto);
  if (!leido) return rechazar(404, 'El proyecto no existe');
  const denegado = comprobarAcceso(ctx, leido, { editar: true });
  if (denegado) return denegado;

  const { datos, error } = normalizarEntrada(body, { parcial: true });
  if (error) return rechazar(400, error);
  if (Object.keys(datos).length === 0) return rechazar(400, 'No hay nada que actualizar');
  if (datos.presupuesto_asignado !== undefined && !puedeVerPresupuesto(ctx)) {
    return rechazar(403, 'No tienes permiso para cambiar el presupuesto');
  }
  // Vaciar `responsable_id` solo se admite si queda algún miembro con el rol:
  // su fila no se borra al vaciar la cabecera.
  if (datos.responsable_id !== undefined && !datos.responsable_id) {
    if (responsablesEnMiembros(leido.miembros).size === 0) {
      return rechazar(409, 'El proyecto no puede quedarse sin responsable');
    }
  }

  const solicitados = new Map(Object.entries(datos));
  // Cerrar deja constancia del día en que se cerró: el campo existe para eso y
  // nadie lo teclea. Al no haberlo pedido nadie, viaja dentro de la entrada de
  // cambio de estado y no genera una de «editada» aparte.
  const derivados = new Set();
  if (
    solicitados.get('estado') === ESTADO_CERRADO &&
    !solicitados.has('fecha_cierre') &&
    !leido.proyecto.fecha_cierre
  ) {
    solicitados.set('fecha_cierre', hoy());
    derivados.add('fecha_cierre');
  }

  const instante = ahora();
  const nombres = { '#act': 'actualizado_en' };
  const valores = { ':act': instante };
  const sets = ['#act = :act'];
  const removes = [];
  const antes = {};
  const despues = {};
  let i = 0;

  for (const [campo, valor] of solicitados) {
    const previo = leido.proyecto[campo];
    const borrar = valor === '' || valor === null;
    if (borrar && previo === undefined) continue;
    if (!borrar && previo === valor) continue;
    nombres[`#c${i}`] = campo;
    if (borrar) {
      removes.push(`#c${i}`);
    } else {
      valores[`:v${i}`] = valor;
      sets.push(`#c${i} = :v${i}`);
    }
    antes[campo] = previo ?? null;
    despues[campo] = borrar ? null : valor;
    i += 1;
  }

  if (i === 0) {
    return {
      ok: true,
      proyecto: proyectoConExtras(leido.proyecto, ctx, {
        miembros: leido.miembros,
        nombres: await nombresDeUsuarios([leido.proyecto.responsable_id]),
      }),
    };
  }

  let actualizado;
  try {
    actualizado = await docClient.send(
      new UpdateCommand({
        TableName: tables.proyectos,
        Key: { PK: PK.proyecto(texto(idProyecto)), SK: SK.meta },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ExpressionAttributeNames: nombres,
        ExpressionAttributeValues: valores,
        // Sin la condición, un `Update` sobre un proyecto que otro acaba de
        // borrar lo recrearía a medias: sin nombre y sin `gsi_listado`.
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return rechazar(404, 'El proyecto no existe');
    }
    throw err;
  }

  const nuevoResponsable = texto(despues.responsable_id);
  if (nuevoResponsable && !leido.miembros.some((m) => mismoId(m?.usuario_id, nuevoResponsable))) {
    await docClient.send(
      new PutCommand({
        TableName: tables.proyectos,
        Item: filaMiembro(
          texto(idProyecto),
          nuevoResponsable,
          ROL_PROYECTO.responsable,
          texto(ctx?.idUsuario),
          instante,
        ),
      }),
    );
  }

  // El cambio de estado tiene entrada propia: es lo que se busca en el historial.
  if (despues.estado !== undefined) {
    await registrarActividad({
      tipo: ENTIDAD,
      entidadId: texto(idProyecto),
      accion: ACCIONES.estadoCambiado,
      usuario: autorDe(ctx),
      detalle: {
        antes: antes.estado,
        despues: despues.estado,
        ...(derivados.has('fecha_cierre') && { fecha_cierre: despues.fecha_cierre }),
      },
    });
  }
  const otros = Object.keys(despues).filter(
    (campo) => campo !== 'estado' && !derivados.has(campo),
  );
  if (otros.length > 0) {
    await registrarActividad({
      tipo: ENTIDAD,
      entidadId: texto(idProyecto),
      accion: ACCIONES.editada,
      usuario: autorDe(ctx),
      detalle: {
        antes: Object.fromEntries(otros.map((c) => [c, antes[c]])),
        despues: Object.fromEntries(otros.map((c) => [c, despues[c]])),
      },
    });
  }

  const final = actualizado.Attributes || leido.proyecto;
  const nombresUsuarios = await nombresDeUsuarios([final.responsable_id]);
  return {
    ok: true,
    proyecto: proyectoConExtras(final, ctx, {
      miembros: leido.miembros,
      nombres: nombresUsuarios,
    }),
  };
}

// ─── Borrado ───

/**
 * Borrado físico del proyecto, de sus filas hijas y de las tareas que cuelgan
 * de él (`Proyecto-index`, sin `Scan`). El historial de `Igp_Actividad` **no**
 * se borra: es append-only y sobrevive a la entidad.
 *
 * Cancelar (`PATCH { estado: 'cancelado' }`) sigue siendo la vía para
 * retirarlo sin perder las tareas.
 */
export async function borrarProyecto(ctx, idProyecto) {
  const leido = await leerProyectoCompleto(idProyecto);
  if (!leido) return rechazar(404, 'El proyecto no existe');
  const denegado = comprobarAcceso(ctx, leido);
  if (denegado) return denegado;

  const { borrarTareasDeProyecto } = await import('./tareas.js');
  const cascada = await borrarTareasDeProyecto({ ctx, idProyecto });

  const claves = await clavesDeParticion(idProyecto);
  await escribirLote(claves.map((Key) => ({ DeleteRequest: { Key } })));

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: texto(idProyecto),
    accion: ACCIONES.borrada,
    usuario: autorDe(ctx),
    detalle: {
      nombre: leido.proyecto.nombre,
      estado: leido.proyecto.estado,
      tareas_borradas: cascada.borradas,
    },
  });

  return { ok: true, tareas_borradas: cascada.borradas };
}

// ─── Miembros ───

/** Alta o cambio de rol de un miembro. Repetir el alta cambia el rol, no duplica. */
export async function anadirMiembro(ctx, idProyecto, body = {}) {
  const leido = await leerProyectoCompleto(idProyecto);
  if (!leido) return rechazar(404, 'El proyecto no existe');
  const denegado = comprobarAcceso(ctx, leido, { editar: true });
  if (denegado) return denegado;

  const usuarioId = texto(body.usuario_id);
  if (!usuarioId) return rechazar(400, 'Falta el usuario que se añade al proyecto');
  const rol = texto(body.rol_proyecto) || ROL_PROYECTO.miembro;
  if (!enLista(ROLES_PROYECTO, rol)) {
    return rechazar(400, `Rol de proyecto no válido: admite ${ROLES_PROYECTO.join(', ')}`);
  }

  const instante = ahora();
  const item = filaMiembro(texto(idProyecto), usuarioId, rol, texto(ctx?.idUsuario), instante);
  await docClient.send(new PutCommand({ TableName: tables.proyectos, Item: item }));
  await tocarProyecto(idProyecto, instante);

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: texto(idProyecto),
    accion: ACCIONES.miembroAnadido,
    usuario: autorDe(ctx),
    detalle: { usuario_id: usuarioId, rol_proyecto: rol },
  });

  return { ok: true, miembro: miembroConNombre(item, await nombresDeUsuarios([usuarioId])) };
}

/**
 * Baja de un miembro.
 *
 * No se admite dejar el proyecto sin nadie con rol de responsable: quien lo
 * dirige es quien aprueba sus compras y quien puede editarlo, y un proyecto
 * huérfano solo lo podría tocar un Administrador.
 */
export async function quitarMiembro(ctx, idProyecto, usuarioId) {
  const leido = await leerProyectoCompleto(idProyecto);
  if (!leido) return rechazar(404, 'El proyecto no existe');
  const denegado = comprobarAcceso(ctx, leido, { editar: true });
  if (denegado) return denegado;

  const id = texto(usuarioId);
  const fila = leido.miembros.find((m) => mismoId(m?.usuario_id, id));
  if (!fila) return rechazar(404, 'Esa persona no es miembro del proyecto');

  const esResponsable =
    texto(fila.rol_proyecto) === ROL_PROYECTO.responsable ||
    mismoId(leido.proyecto.responsable_id, id);
  if (esResponsable && responsablesTrasQuitar(leido.proyecto, leido.miembros, id).size === 0) {
    return rechazar(409, 'El proyecto no puede quedarse sin responsable');
  }

  const instante = ahora();
  await docClient.send(
    new DeleteCommand({
      TableName: tables.proyectos,
      Key: { PK: PK.proyecto(texto(idProyecto)), SK: SK.miembro(id) },
    }),
  );
  await tocarProyecto(idProyecto, instante);

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: texto(idProyecto),
    accion: ACCIONES.miembroQuitado,
    usuario: autorDe(ctx),
    detalle: { usuario_id: id, rol_proyecto: texto(fila.rol_proyecto) },
  });

  return { ok: true };
}

// ─── Vínculos ───

/** Vincula una entidad de IGP al proyecto: `{ tipo, id, etiqueta }`. */
export async function anadirVinculo(ctx, idProyecto, body = {}) {
  const leido = await leerProyectoCompleto(idProyecto);
  if (!leido) return rechazar(404, 'El proyecto no existe');
  const denegado = comprobarAcceso(ctx, leido, { editar: true });
  if (denegado) return denegado;

  const tipo = texto(body.tipo);
  if (!enLista(TIPOS_VINCULO, tipo)) {
    return rechazar(400, `Tipo de vínculo no válido: admite ${TIPOS_VINCULO.join(', ')}`);
  }
  const entidadId = texto(body.id);
  if (!entidadId) return rechazar(400, 'Falta el identificador de la entidad que se vincula');

  const instante = ahora();
  const item = {
    PK: PK.proyecto(texto(idProyecto)),
    SK: SK.vinculo(tipo, entidadId),
    tipo,
    id: entidadId,
    // La etiqueta es el nombre en el momento de vincular: así la tarjeta se
    // pinta sin resolver la entidad en cada lectura.
    ...(texto(body.etiqueta) && { etiqueta: texto(body.etiqueta) }),
    vinculo_clave: claveVinculo(tipo, entidadId),
    añadido_por: texto(ctx?.idUsuario),
    añadido_en: instante,
  };
  await docClient.send(new PutCommand({ TableName: tables.proyectos, Item: item }));
  await tocarProyecto(idProyecto, instante);

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: texto(idProyecto),
    accion: ACCIONES.vinculoAnadido,
    usuario: autorDe(ctx),
    detalle: { tipo, id: entidadId, etiqueta: item.etiqueta ?? null },
  });

  return { ok: true, vinculo: salidaVinculo(item) };
}

export async function quitarVinculo(ctx, idProyecto, tipo, entidadId) {
  const leido = await leerProyectoCompleto(idProyecto);
  if (!leido) return rechazar(404, 'El proyecto no existe');
  const denegado = comprobarAcceso(ctx, leido, { editar: true });
  if (denegado) return denegado;

  const tipoNorm = texto(tipo);
  const idNorm = texto(entidadId);
  const existe = leido.vinculos.some(
    (v) => texto(v?.tipo) === tipoNorm && texto(v?.id) === idNorm,
  );
  if (!existe) return rechazar(404, 'El vínculo no existe');

  const instante = ahora();
  await docClient.send(
    new DeleteCommand({
      TableName: tables.proyectos,
      Key: { PK: PK.proyecto(texto(idProyecto)), SK: SK.vinculo(tipoNorm, idNorm) },
    }),
  );
  await tocarProyecto(idProyecto, instante);

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: texto(idProyecto),
    accion: ACCIONES.vinculoQuitado,
    usuario: autorDe(ctx),
    detalle: { tipo: tipoNorm, id: idNorm },
  });

  return { ok: true };
}
