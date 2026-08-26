/**
 * Capa de acceso del módulo de dirección: quién ve y quién edita cada fila.
 *
 * Aquí no se prueba «la función devuelve un booleano», se prueba el árbol de
 * decisión completo, porque un fallo en él no da error: enseña de más. Las
 * comprobaciones son puras, así que se pueden recorrer todas las combinaciones
 * sin tocar DynamoDB; solo la carga del contexto usa el doble en memoria.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
  crearContextoAcceso,
  contextoVacio,
  cargarContextoAcceso,
  invalidarContextoAcceso,
  tienePermiso,
  rolEnProyecto,
  puedeVerProyecto,
  puedeEditarProyecto,
  puedeVerPresupuesto,
  puedeVerTarea,
  puedeEditarTarea,
  puedeReasignarTarea,
  puedeVerReunion,
  puedeGestionarReunion,
  puedeBorrarAudio,
  nivelAprobacionDe,
  puedeAprobarLinea,
  filtrarVisibles,
} from '../lib/tasks/acceso.js';
import {
  PERMISOS,
  transicionTareaPermitida,
  esEstadoTareaTerminal,
  vencimientoOrdenDe,
  skProyectoDe,
  nivelRequeridoParaImporte,
  ordenNivelAprobacion,
  FECHA_SIN_LIMITE,
} from '../lib/tasks/tipos.js';
import { docClient, tables } from '../lib/db.js';
import { crearRol } from '../lib/roles.js';
import { crearDynamoMemoria } from './dynamoMemoria.mjs';

// ─── Atajos ───

const ANA = 'ana';
const BEA = 'bea';
const CARLOS = 'carlos';

function ctxDe(extra = {}) {
  return crearContextoAcceso({ idUsuario: ANA, rol: 'Encargado', ...extra });
}

const admin = () => crearContextoAcceso({ idUsuario: ANA, rol: 'Administrador' });

// ─── tipos: transiciones de estado ───

test('transicionTareaPermitida: recorridos normales y prohibidos', () => {
  assert.equal(transicionTareaPermitida('pendiente', 'en_curso'), true);
  assert.equal(transicionTareaPermitida('en_curso', 'hecha'), true);
  assert.equal(transicionTareaPermitida('bloqueada', 'en_curso'), true);
  // Una tarea bloqueada no se puede dar por hecha sin desbloquearla antes.
  assert.equal(transicionTareaPermitida('bloqueada', 'hecha'), false);
  // Reabrir sí, pero solo a pendiente.
  assert.equal(transicionTareaPermitida('hecha', 'pendiente'), true);
  assert.equal(transicionTareaPermitida('hecha', 'en_curso'), false);
  assert.equal(transicionTareaPermitida('cancelada', 'hecha'), false);
});

test('transicionTareaPermitida: el mismo estado vale; un estado inventado no', () => {
  assert.equal(transicionTareaPermitida('en_curso', 'en_curso'), true);
  assert.equal(transicionTareaPermitida('en_curso', 'terminada'), false);
  assert.equal(transicionTareaPermitida('', 'pendiente'), false);
  assert.equal(transicionTareaPermitida(undefined, 'pendiente'), false);
});

test('esEstadoTareaTerminal', () => {
  assert.equal(esEstadoTareaTerminal('hecha'), true);
  assert.equal(esEstadoTareaTerminal('cancelada'), true);
  assert.equal(esEstadoTareaTerminal('bloqueada'), false);
});

// ─── tipos: claves derivadas ───

test('vencimientoOrdenDe: solo tareas abiertas y con responsable entran al índice', () => {
  const base = { id_tarea: 't1', responsable_id: BEA, estado: 'pendiente', fecha_limite: '2026-09-01' };
  assert.equal(vencimientoOrdenDe(base), '2026-09-01#t1');
  // Sin fecha límite ordena al final, no al principio.
  assert.equal(vencimientoOrdenDe({ ...base, fecha_limite: undefined }), `${FECHA_SIN_LIMITE}#t1`);
  // Cerrada o sin responsable: fuera del índice, el escritor debe hacer REMOVE.
  assert.equal(vencimientoOrdenDe({ ...base, estado: 'hecha' }), null);
  assert.equal(vencimientoOrdenDe({ ...base, estado: 'cancelada' }), null);
  assert.equal(vencimientoOrdenDe({ ...base, responsable_id: '' }), null);
  assert.equal(vencimientoOrdenDe(null), null);
});

test('skProyectoDe: agrupa abiertas antes que cerradas', () => {
  const base = { id_tarea: 't1', proyecto_id: 'p1', estado: 'en_curso', fecha_limite: '2026-09-01' };
  assert.equal(skProyectoDe(base), 'abierta#2026-09-01#t1');
  assert.equal(skProyectoDe({ ...base, estado: 'hecha' }), 'cerrada#2026-09-01#t1');
  assert.equal(skProyectoDe({ ...base, proyecto_id: undefined }), null);
  // 'abierta' < 'cerrada' en orden lexicográfico: el índice ya sale ordenado.
  assert.ok('abierta' < 'cerrada');
});

// ─── tipos: umbrales de compra ───

test('nivelRequeridoParaImporte: los umbrales son inclusivos', () => {
  const umbrales = { umbral_responsable: 300, umbral_departamento: 1500 };
  assert.equal(nivelRequeridoParaImporte(50, umbrales), 'responsable_proyecto');
  assert.equal(nivelRequeridoParaImporte(299.99, umbrales), 'responsable_proyecto');
  assert.equal(nivelRequeridoParaImporte(300, umbrales), 'responsable_departamento');
  assert.equal(nivelRequeridoParaImporte(1499, umbrales), 'responsable_departamento');
  assert.equal(nivelRequeridoParaImporte(1500, umbrales), 'direccion');
  assert.equal(nivelRequeridoParaImporte(90000, umbrales), 'direccion');
});

test('nivelRequeridoParaImporte: sin umbrales configurados todo exige dirección', () => {
  // El nivel se congela al crear la línea: si aquí se devolviera el escalón bajo,
  // configurar los umbrales después ya no arreglaría la línea.
  const casos = [
    undefined,
    {},
    { umbral_responsable: 300 },
    { umbral_departamento: 1500 },
    { umbral_responsable: 300, umbral_departamento: null },
    { umbral_responsable: 300, umbral_departamento: '' },
    { umbral_responsable: 'trescientos', umbral_departamento: 1500 },
    // Umbrales al revés: configuración incoherente, no se adivina la intención.
    { umbral_responsable: 1500, umbral_departamento: 300 },
  ];
  for (const umbrales of casos) {
    assert.equal(nivelRequeridoParaImporte(40000, umbrales), 'direccion', JSON.stringify(umbrales));
    assert.equal(nivelRequeridoParaImporte(10, umbrales), 'direccion', JSON.stringify(umbrales));
  }
});

test('nivelRequeridoParaImporte: un importe que no es número exige dirección', () => {
  const umbrales = { umbral_responsable: 300, umbral_departamento: 1500 };
  for (const importe of [undefined, null, '', 'mucho', NaN, {}]) {
    assert.equal(nivelRequeridoParaImporte(importe, umbrales), 'direccion', String(importe));
  }
});

test('ordenNivelAprobacion: jerarquía y nivel desconocido', () => {
  assert.ok(ordenNivelAprobacion('direccion') > ordenNivelAprobacion('responsable_departamento'));
  assert.ok(ordenNivelAprobacion('responsable_departamento') > ordenNivelAprobacion('responsable_proyecto'));
  assert.equal(ordenNivelAprobacion('gerencia'), -1);
});

// ─── Permisos globales ───

test('tienePermiso: Administrador no necesita lista de permisos', () => {
  assert.equal(tienePermiso(admin(), PERMISOS.reunionesVerDireccion), true);
  assert.equal(tienePermiso(admin(), 'cualquier.cosa'), true);
});

test('tienePermiso: sin permisos cargados se deniega, nunca se concede por defecto', () => {
  const ctx = crearContextoAcceso({ idUsuario: ANA, rol: 'Encargado', permisosCargados: false });
  assert.equal(tienePermiso(ctx, PERMISOS.reunionesVer), false);
  assert.equal(tienePermiso(contextoVacio(), PERMISOS.reunionesVer), false);
  assert.equal(tienePermiso(null, PERMISOS.reunionesVer), false);
});

test('tienePermiso: respeta los alias heredados del ERP', () => {
  // 'rrss.ver' es alias legacy de 'marketing.proponer' en permisoAliases.js.
  const ctx = ctxDe({ permisos: ['rrss.ver'] });
  assert.equal(tienePermiso(ctx, 'marketing.proponer'), true);
  assert.equal(tienePermiso(ctx, 'marketing.otra_cosa'), false);
});

test('tienePermiso: sin código no se concede nada', () => {
  const ctx = ctxDe({ permisos: [PERMISOS.proyectosVer] });
  assert.equal(tienePermiso(ctx, ''), false);
  assert.equal(tienePermiso(ctx, undefined), false);
  assert.equal(tienePermiso(admin(), ''), false);
});

test('crearContextoAcceso: acepta los permisos como Set o como lista', () => {
  const conSet = crearContextoAcceso({ idUsuario: ANA, permisos: new Set([PERMISOS.reunionesVer]) });
  assert.equal(tienePermiso(conSet, PERMISOS.reunionesVer), true);
  const conLista = crearContextoAcceso({ idUsuario: ANA, permisos: [PERMISOS.reunionesVer] });
  assert.equal(tienePermiso(conLista, PERMISOS.reunionesVer), true);
});

// ─── Proyectos ───

const proyecto = { id_proyecto: 'p1', nombre: 'Reforma barra', responsable_id: BEA };
const miembros = [
  { usuario_id: BEA, rol_proyecto: 'responsable' },
  { usuario_id: ANA, rol_proyecto: 'miembro' },
  { usuario_id: CARLOS, rol_proyecto: 'observador' },
];

test('rolEnProyecto: responsable_id cuenta aunque no figure en miembros', () => {
  const ctx = crearContextoAcceso({ idUsuario: BEA });
  assert.equal(rolEnProyecto(ctx, proyecto, []), 'responsable');
  assert.equal(rolEnProyecto(ctxDe(), proyecto, miembros), 'miembro');
  assert.equal(rolEnProyecto(crearContextoAcceso({ idUsuario: CARLOS }), proyecto, miembros), 'observador');
  assert.equal(rolEnProyecto(crearContextoAcceso({ idUsuario: 'diego' }), proyecto, miembros), null);
});

test('rolEnProyecto: dos usuarios sin id no son el mismo usuario', () => {
  const ctx = crearContextoAcceso({ idUsuario: '' });
  assert.equal(rolEnProyecto(ctx, { id_proyecto: 'p2' }, [{ usuario_id: '', rol_proyecto: 'responsable' }]), null);
});

test('puedeVerProyecto: participar basta; el observador también ve', () => {
  assert.equal(puedeVerProyecto(ctxDe(), proyecto, miembros), true);
  assert.equal(puedeVerProyecto(crearContextoAcceso({ idUsuario: CARLOS }), proyecto, miembros), true);
  assert.equal(puedeVerProyecto(crearContextoAcceso({ idUsuario: 'diego' }), proyecto, miembros), false);
});

test('puedeVerProyecto: tareas.ver_todas es la vía transversal', () => {
  const ctx = crearContextoAcceso({ idUsuario: 'diego', permisos: [PERMISOS.tareasVerTodas] });
  assert.equal(puedeVerProyecto(ctx, proyecto, miembros), true);
  assert.equal(puedeVerProyecto(admin(), proyecto, []), true);
});

test('puedeEditarProyecto: el observador no edita ni con proyectos.editar', () => {
  const observadorConPermiso = crearContextoAcceso({
    idUsuario: CARLOS,
    permisos: [PERMISOS.proyectosEditar, PERMISOS.tareasEditarTodas],
  });
  assert.equal(puedeEditarProyecto(observadorConPermiso, proyecto, miembros), false);
});

test('puedeEditarProyecto: responsable sí; miembro solo con permiso', () => {
  assert.equal(puedeEditarProyecto(crearContextoAcceso({ idUsuario: BEA }), proyecto, miembros), true);
  assert.equal(puedeEditarProyecto(ctxDe(), proyecto, miembros), false);
  assert.equal(puedeEditarProyecto(ctxDe({ permisos: [PERMISOS.proyectosEditar] }), proyecto, miembros), true);
});

test('puedeEditarProyecto: tareas.editar_todas no da acceso al proyecto', () => {
  // Editar el proyecto incluye gestionar miembros: si este permiso llegara aquí,
  // cualquiera con él se añadiría a un proyecto ajeno y lo vería entero.
  const ctx = crearContextoAcceso({ idUsuario: 'diego', permisos: [PERMISOS.tareasEditarTodas] });
  assert.equal(puedeEditarProyecto(ctx, proyecto, miembros), false);
  assert.equal(puedeVerProyecto(ctx, proyecto, miembros), false);
  // Sobre el **contenido** de las tareas de ese proyecto sí alcanza, que es lo
  // que dice su nombre.
  const tarea = { id_tarea: 't5', estado: 'pendiente', responsable_id: BEA, proyecto_id: 'p1' };
  assert.equal(puedeEditarTarea(ctx, tarea, { proyecto, miembros }), true);
  // Reasignar no: cambiar el contenido de una tarea y decidir de quién es son
  // cosas distintas. Reasignar es «quien pueda editar el proyecto», y este
  // permiso queda fuera de eso por D-13; con el atajo, quien lo tuviera repartía
  // trabajo en proyectos ajenos y la otra persona se lo encontraba en su lista.
  assert.equal(puedeReasignarTarea(ctx, tarea, { proyecto, miembros }), false);
});

test('puedeVerPresupuesto: solo con el permiso específico', () => {
  assert.equal(puedeVerPresupuesto(ctxDe()), false);
  assert.equal(puedeVerPresupuesto(ctxDe({ permisos: [PERMISOS.presupuestoVer] })), true);
  assert.equal(puedeVerPresupuesto(admin()), true);
});

// ─── Tareas ───

const tareaSuelta = {
  id_tarea: 't1',
  titulo: 'Pedir taburetes',
  estado: 'pendiente',
  responsable_id: BEA,
  creado_por: ANA,
  menciones: [CARLOS],
};

test('puedeVerTarea: responsable, creador y mencionado la ven; un ajeno no', () => {
  assert.equal(puedeVerTarea(crearContextoAcceso({ idUsuario: BEA }), tareaSuelta), true);
  assert.equal(puedeVerTarea(ctxDe(), tareaSuelta), true);
  assert.equal(puedeVerTarea(crearContextoAcceso({ idUsuario: CARLOS }), tareaSuelta), true);
  assert.equal(puedeVerTarea(crearContextoAcceso({ idUsuario: 'diego' }), tareaSuelta), false);
});

test('puedeVerTarea: si la tarea tiene proyecto y no se pasa, se deniega', () => {
  const tarea = { ...tareaSuelta, creado_por: BEA, responsable_id: BEA, menciones: [], proyecto_id: 'p1' };
  const ctx = ctxDe();
  // Ana es miembro del proyecto, pero sin el proyecto cargado no hay forma de saberlo.
  assert.equal(puedeVerTarea(ctx, tarea), false);
  assert.equal(puedeVerTarea(ctx, tarea, { proyecto, miembros }), true);
});

test('puedeVerTarea: hereda la denegación del proyecto ajeno', () => {
  const tarea = { ...tareaSuelta, creado_por: BEA, responsable_id: BEA, menciones: [], proyecto_id: 'p1' };
  const ctx = crearContextoAcceso({ idUsuario: 'diego' });
  assert.equal(puedeVerTarea(ctx, tarea, { proyecto, miembros }), false);
});

test('puedeVerTarea: haberla creado no salta la visibilidad del proyecto', () => {
  // Diego creó la tarea dentro del proyecto y después lo sacaron del equipo.
  const tarea = { ...tareaSuelta, creado_por: 'diego', responsable_id: BEA, menciones: [], proyecto_id: 'p1' };
  const ctx = crearContextoAcceso({ idUsuario: 'diego' });
  assert.equal(puedeVerTarea(ctx, tarea, { proyecto, miembros }), false);
  // Sin proyecto sí: es su tarea y no cuelga de nada.
  assert.equal(puedeVerTarea(ctx, { ...tarea, proyecto_id: undefined }), true);
});

test('puedeVerTarea: los ids se comparan tal cual, sin rellenar ceros', () => {
  // `id_usuario` es formatId6 ('000012'). Quien escriba la tarea debe guardar el
  // mismo valor: '12' y '000012' no son el mismo usuario para esta capa.
  const ctx = crearContextoAcceso({ idUsuario: '000012' });
  assert.equal(puedeVerTarea(ctx, { id_tarea: 't1', responsable_id: '000012' }), true);
  assert.equal(puedeVerTarea(ctx, { id_tarea: 't1', responsable_id: '12' }), false);
});

test('puedeEditarTarea: estar mencionado no da permiso de escritura', () => {
  const ctx = crearContextoAcceso({ idUsuario: CARLOS });
  assert.equal(puedeVerTarea(ctx, tareaSuelta), true);
  assert.equal(puedeEditarTarea(ctx, tareaSuelta), false);
});

test('puedeEditarTarea: responsable sí; el creador solo si la tarea es suelta', () => {
  assert.equal(puedeEditarTarea(crearContextoAcceso({ idUsuario: BEA }), tareaSuelta), true);
  assert.equal(puedeEditarTarea(ctxDe(), tareaSuelta), true);
  // Con proyecto manda el proyecto: Ana lo creó pero solo es miembro sin permiso.
  const conProyecto = { ...tareaSuelta, proyecto_id: 'p1' };
  assert.equal(puedeEditarTarea(ctxDe(), { ...conProyecto, responsable_id: BEA }, { proyecto, miembros }), false);
});

test('puedeEditarTarea: tareas.editar_todas alcanza a cualquiera', () => {
  const ctx = crearContextoAcceso({ idUsuario: 'diego', permisos: [PERMISOS.tareasEditarTodas] });
  assert.equal(puedeEditarTarea(ctx, tareaSuelta), true);
});

test('puedeReasignarTarea: el responsable no puede quitarse la tarea de encima', () => {
  const tarea = { ...tareaSuelta, proyecto_id: 'p1', responsable_id: ANA, creado_por: BEA };
  const ctx = ctxDe();
  assert.equal(puedeEditarTarea(ctx, tarea, { proyecto, miembros }), true);
  assert.equal(puedeReasignarTarea(ctx, tarea, { proyecto, miembros }), false);
  // El responsable del proyecto sí reparte trabajo.
  const ctxJefa = crearContextoAcceso({ idUsuario: BEA });
  assert.equal(puedeReasignarTarea(ctxJefa, tarea, { proyecto, miembros }), true);
});

test('puedeReasignarTarea: tareas.editar_todas edita el contenido pero no reparte trabajo', () => {
  const ctx = crearContextoAcceso({ idUsuario: 'luis', permisos: [PERMISOS.tareasEditarTodas] });
  const enProyecto = { id_tarea: 't6', estado: 'pendiente', responsable_id: ANA, proyecto_id: 'p1' };
  assert.equal(puedeEditarTarea(ctx, enProyecto, { proyecto, miembros }), true);
  assert.equal(puedeReasignarTarea(ctx, enProyecto, { proyecto, miembros }), false);

  // Y en una tarea suelta tampoco: ahí reasigna quien la creó.
  const suelta = { id_tarea: 't7', estado: 'pendiente', responsable_id: ANA, creado_por: BEA };
  assert.equal(puedeEditarTarea(ctx, suelta), true);
  assert.equal(puedeReasignarTarea(ctx, suelta), false);
  assert.equal(puedeReasignarTarea(crearContextoAcceso({ idUsuario: BEA }), suelta), true);
});

// ─── Reuniones ───

const reunionDireccion = {
  id_reunion: 'r1',
  titulo: 'Comité de dirección',
  fecha: '2026-09-01',
  visibilidad: 'direccion',
  convocada_por: BEA,
};

test('puedeVerReunion: quien asistió la ve, aunque sea de dirección y no tenga permiso', () => {
  const ctx = ctxDe();
  assert.equal(puedeVerReunion(ctx, reunionDireccion, []), false);
  assert.equal(puedeVerReunion(ctx, reunionDireccion, [{ usuario_id: ANA, nombre: 'Ana' }]), true);
});

test('puedeVerReunion: quien convocó la ve siempre', () => {
  assert.equal(puedeVerReunion(crearContextoAcceso({ idUsuario: BEA }), reunionDireccion, []), true);
});

test('puedeVerReunion: dirección exige reuniones.ver_direccion, no reuniones.ver', () => {
  assert.equal(puedeVerReunion(ctxDe({ permisos: [PERMISOS.reunionesVer] }), reunionDireccion, []), false);
  assert.equal(
    puedeVerReunion(ctxDe({ permisos: [PERMISOS.reunionesVerDireccion] }), reunionDireccion, []),
    true,
  );
});

test('puedeVerReunion: restringida solo para los autorizados', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'restringida', usuarios_autorizados: [CARLOS] };
  assert.equal(puedeVerReunion(crearContextoAcceso({ idUsuario: CARLOS }), reunion, []), true);
  // Ni reuniones.ver ni ver_direccion abren una reunión restringida.
  const ctx = ctxDe({ permisos: [PERMISOS.reunionesVer, PERMISOS.reunionesVerDireccion] });
  assert.equal(puedeVerReunion(ctx, reunion, []), false);
});

test('puedeVerReunion: usuarios_autorizados no pinta nada si no es restringida', () => {
  // Una lista olvidada al cambiar la visibilidad no debe abrir la reunión.
  const reunion = { ...reunionDireccion, usuarios_autorizados: [ANA] };
  assert.equal(puedeVerReunion(ctxDe(), reunion, []), false);
});

test('puedeVerReunion: la lista de autorizados vacía no abre nada a nadie', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'restringida', usuarios_autorizados: [''] };
  assert.equal(puedeVerReunion(crearContextoAcceso({ idUsuario: '' }), reunion, []), false);
});

test('puedeVerReunion: un asistente externo sin usuario_id no abre la reunión', () => {
  const asistentes = [{ nombre: 'Proveedor', email: 'x@fuera.com', es_externo: true }];
  assert.equal(puedeVerReunion(crearContextoAcceso({ idUsuario: '' }), reunionDireccion, asistentes), false);
  assert.equal(puedeVerReunion(ctxDe(), reunionDireccion, asistentes), false);
});

test('puedeVerReunion: de empresa, con reuniones.ver basta', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'empresa' };
  assert.equal(puedeVerReunion(ctxDe(), reunion, []), false);
  assert.equal(puedeVerReunion(ctxDe({ permisos: [PERMISOS.reunionesVer] }), reunion, []), true);
});

test('puedeVerReunion: de departamento, por pertenencia o por ser su responsable', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'departamento', departamento_id: 'mkt' };
  const conPermiso = { permisos: [PERMISOS.reunionesVer] };
  assert.equal(puedeVerReunion(ctxDe({ ...conPermiso, departamentos: ['mkt'] }), reunion, []), true);
  assert.equal(puedeVerReunion(ctxDe({ ...conPermiso, departamentos: ['contabilidad'] }), reunion, []), false);
  assert.equal(
    puedeVerReunion(ctxDe(conPermiso), reunion, [], { esResponsableDepartamento: true }),
    true,
  );
  // Pertenecer al departamento no sirve si no se puede entrar al módulo.
  assert.equal(puedeVerReunion(ctxDe({ departamentos: ['mkt'] }), reunion, []), false);
});

test('puedeVerReunion: de departamento sin departamento_id no la ve nadie de fuera', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'departamento' };
  const ctx = ctxDe({ permisos: [PERMISOS.reunionesVer], departamentos: ['mkt', ''] });
  assert.equal(puedeVerReunion(ctx, reunion, []), false);
});

test('puedeVerReunion: el departamento se compara exacto, al contrario que el local', () => {
  // Son IDs (D-12), no nombres: 'MKT' y 'mkt' serían dos departamentos distintos.
  const reunion = { ...reunionDireccion, visibilidad: 'departamento', departamento_id: 'mkt' };
  const ctx = ctxDe({ permisos: [PERMISOS.reunionesVer], departamentos: ['MKT'] });
  assert.equal(puedeVerReunion(ctx, reunion, []), false);
});

test('puedeVerReunion: esResponsableDepartamento solo cuenta si es exactamente true', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'departamento', departamento_id: 'mkt' };
  const ctx = ctxDe({ permisos: [PERMISOS.reunionesVer] });
  for (const valor of [1, 'si', 'false', {}, []]) {
    assert.equal(puedeVerReunion(ctx, reunion, [], { esResponsableDepartamento: valor }), false, String(valor));
  }
});

test('puedeVerReunion: de local, comparando nombres sin distinguir mayúsculas', () => {
  const reunion = {
    ...reunionDireccion,
    visibilidad: 'local',
    local_id: '000004',
    local_nombre: 'Bar Central',
  };
  const conPermiso = { permisos: [PERMISOS.reunionesVer] };
  assert.equal(puedeVerReunion(ctxDe({ ...conPermiso, locales: ['bar central'] }), reunion, []), true);
  assert.equal(puedeVerReunion(ctxDe({ ...conPermiso, locales: ['Otro Sitio'] }), reunion, []), false);
  // Locales vacío = alcance a todo el grupo, igual que en el resto del ERP.
  assert.equal(puedeVerReunion(ctxDe({ ...conPermiso, locales: [] }), reunion, []), true);
});

test('puedeVerReunion: de local sin local_nombre se deniega a quien no tiene alcance global', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'local', local_id: '000004' };
  const ctx = ctxDe({ permisos: [PERMISOS.reunionesVer], locales: ['Bar Central'] });
  assert.equal(puedeVerReunion(ctx, reunion, []), false);
});

test('puedeVerReunion: visibilidad ausente o inventada se deniega', () => {
  const ctx = ctxDe({ permisos: [PERMISOS.reunionesVer, PERMISOS.reunionesVerDireccion] });
  assert.equal(puedeVerReunion(ctx, { id_reunion: 'r9' }, []), false);
  assert.equal(puedeVerReunion(ctx, null, []), false);
  // La comparación es exacta: ni otra caja, ni espacios, ni otro tipo.
  for (const valor of ['publica', 'Empresa', ' empresa', 'EMPRESA', null, 123, ['empresa']]) {
    assert.equal(puedeVerReunion(ctx, { id_reunion: 'r9', visibilidad: valor }, []), false, String(valor));
  }
});

test('puedeGestionarReunion: reuniones.gestionar no abre lo que no se puede ver', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'restringida', usuarios_autorizados: [CARLOS] };
  const ctx = ctxDe({ permisos: [PERMISOS.reunionesGestionar, PERMISOS.reunionesVer] });
  assert.equal(puedeGestionarReunion(ctx, reunion, []), false);
});

test('puedeGestionarReunion: el convocante gestiona; un asistente cualquiera no', () => {
  const asistentes = [{ usuario_id: ANA, nombre: 'Ana' }];
  assert.equal(puedeGestionarReunion(crearContextoAcceso({ idUsuario: BEA }), reunionDireccion, asistentes), true);
  assert.equal(puedeGestionarReunion(ctxDe(), reunionDireccion, asistentes), false);
  assert.equal(
    puedeGestionarReunion(ctxDe({ permisos: [PERMISOS.reunionesGestionar] }), reunionDireccion, asistentes),
    true,
  );
});

test('puedeGestionarReunion: un asistente de una restringida la ve, pero no la gestiona', () => {
  const reunion = { ...reunionDireccion, visibilidad: 'restringida', usuarios_autorizados: [CARLOS] };
  const asistentes = [{ usuario_id: ANA, nombre: 'Ana' }];
  const ctx = ctxDe();
  assert.equal(puedeVerReunion(ctx, reunion, asistentes), true);
  assert.equal(puedeGestionarReunion(ctx, reunion, asistentes), false);
  // Con el permiso, y viéndola por haber asistido, sí.
  const gestor = ctxDe({ permisos: [PERMISOS.reunionesGestionar] });
  assert.equal(puedeGestionarReunion(gestor, reunion, asistentes), true);
  assert.equal(puedeBorrarAudio(gestor, reunion, asistentes), false);
});

test('puedeBorrarAudio: gestionar no incluye borrar el audio', () => {
  const asistentes = [{ usuario_id: ANA, nombre: 'Ana' }];
  const gestor = ctxDe({ permisos: [PERMISOS.reunionesGestionar] });
  assert.equal(puedeGestionarReunion(gestor, reunionDireccion, asistentes), true);
  assert.equal(puedeBorrarAudio(gestor, reunionDireccion, asistentes), false);
  const conBorrado = ctxDe({ permisos: [PERMISOS.reunionesGestionar, PERMISOS.reunionesBorrarAudio] });
  assert.equal(puedeBorrarAudio(conBorrado, reunionDireccion, asistentes), true);
});

// ─── Aprobación de compras ───

const linea = {
  id_linea: 'l1',
  concepto: 'Taburetes',
  solicitante_id: ANA,
  compra_estado: 'propuesta',
  nivel_aprobacion_requerido: 'responsable_departamento',
};

/** Pertenecer a la lista de dirección es un dato que aporta el llamante (A-07). */
const AUX_DIRECCION = { esDireccion: true };
const beaDireccion = () => crearContextoAcceso({ idUsuario: BEA });

test('nivelAprobacionDe: el escalón sale de la posición, no del permiso', () => {
  assert.equal(nivelAprobacionDe(ctxDe(), proyecto, miembros), null);
  assert.equal(nivelAprobacionDe(crearContextoAcceso({ idUsuario: BEA }), proyecto, miembros), 'responsable_proyecto');
  assert.equal(
    nivelAprobacionDe(ctxDe(), proyecto, miembros, { esResponsableDepartamento: true }),
    'responsable_departamento',
  );
  assert.equal(nivelAprobacionDe(ctxDe(), proyecto, miembros, { esDireccion: true }), 'direccion');
  assert.equal(nivelAprobacionDe(admin(), proyecto, miembros), 'direccion');
});

test('nivelAprobacionDe: proyectos.compras_aprobar no convierte a nadie en dirección', () => {
  // El permiso habilita a participar en aprobaciones (lo comprueba la ruta); el
  // escalón lo decide A-07 y llega como dato.
  const ctx = ctxDe({ permisos: [PERMISOS.comprasAprobar] });
  assert.equal(nivelAprobacionDe(ctx, proyecto, miembros), null);
  assert.equal(puedeAprobarLinea(ctx, proyecto, { ...linea, solicitante_id: BEA }, miembros), false);
});

test('puedeAprobarLinea: quien la pide no la aprueba, ni siendo Administrador', () => {
  const anaAdmin = crearContextoAcceso({ idUsuario: ANA, rol: 'Administrador' });
  assert.equal(puedeAprobarLinea(anaAdmin, proyecto, linea, miembros), false);
  // Otra persona con el mismo nivel sí puede.
  assert.equal(puedeAprobarLinea(beaDireccion(), proyecto, linea, miembros, AUX_DIRECCION), true);
});

test('puedeAprobarLinea: un escalón por debajo no vale; por encima sí', () => {
  const soloResponsableProyecto = crearContextoAcceso({ idUsuario: BEA });
  assert.equal(puedeAprobarLinea(soloResponsableProyecto, proyecto, linea, miembros), false);
  const conDepartamento = crearContextoAcceso({ idUsuario: BEA });
  assert.equal(
    puedeAprobarLinea(conDepartamento, proyecto, linea, miembros, { esResponsableDepartamento: true }),
    true,
  );
  const baja = { ...linea, nivel_aprobacion_requerido: 'responsable_proyecto' };
  assert.equal(puedeAprobarLinea(soloResponsableProyecto, proyecto, baja, miembros), true);
});

test('puedeAprobarLinea: solo se aprueba lo que está propuesto', () => {
  for (const estado of ['aprobada', 'rechazada', 'pedida', 'recibida']) {
    const otra = { ...linea, compra_estado: estado };
    assert.equal(puedeAprobarLinea(beaDireccion(), proyecto, otra, miembros, AUX_DIRECCION), false, estado);
  }
});

test('puedeAprobarLinea: nivel requerido ausente o desconocido se deniega', () => {
  for (const nivel of [undefined, 'gerencia', '']) {
    const otra = { ...linea, nivel_aprobacion_requerido: nivel };
    assert.equal(puedeAprobarLinea(beaDireccion(), proyecto, otra, miembros, AUX_DIRECCION), false, String(nivel));
  }
});

test('puedeAprobarLinea: una línea sin solicitante no la firma nadie', () => {
  for (const solicitante of [undefined, '', '   ', null]) {
    const otra = { ...linea, solicitante_id: solicitante };
    assert.equal(puedeAprobarLinea(beaDireccion(), proyecto, otra, miembros, AUX_DIRECCION), false);
  }
});

test('puedeAprobarLinea: sin proyecto o sin línea se deniega', () => {
  const bea = beaDireccion();
  assert.equal(puedeAprobarLinea(bea, null, linea, miembros, AUX_DIRECCION), false);
  assert.equal(puedeAprobarLinea(bea, proyecto, null, miembros, AUX_DIRECCION), false);
  assert.equal(nivelAprobacionDe(bea, null, miembros, AUX_DIRECCION), null);
});

test('puedeAprobarLinea: cambiar los umbrales no altera lo que ya está en cola', () => {
  const bea = crearContextoAcceso({ idUsuario: BEA });
  // La línea nació con umbrales altos, así que le bastaba el responsable del proyecto.
  const enCola = { ...linea, nivel_aprobacion_requerido: 'responsable_proyecto' };
  assert.equal(puedeAprobarLinea(bea, proyecto, enCola, miembros), true);
  // Bajar el umbral cambiaría el cálculo de una línea nueva, pero no el de esta.
  assert.equal(nivelRequeridoParaImporte(400, { umbral_responsable: 100, umbral_departamento: 1500 }), 'responsable_departamento');
  assert.equal(puedeAprobarLinea(bea, proyecto, enCola, miembros), true);
});

// ─── Filtrado de listados ───

test('filtrarVisibles: deja pasar solo lo visible en cada tipo', () => {
  const ctx = ctxDe({ permisos: [PERMISOS.reunionesVer] });

  const proyectos = [proyecto, { id_proyecto: 'p2', nombre: 'Ajeno', responsable_id: 'diego' }];
  const visiblesProy = filtrarVisibles(ctx, 'proyecto', proyectos, (p) =>
    p.id_proyecto === 'p1' ? { miembros } : { miembros: [] },
  );
  assert.deepEqual(visiblesProy.map((p) => p.id_proyecto), ['p1']);

  const tareas = [tareaSuelta, { id_tarea: 't9', estado: 'pendiente', responsable_id: 'diego' }];
  assert.deepEqual(
    filtrarVisibles(ctx, 'tarea', tareas).map((t) => t.id_tarea),
    ['t1'],
  );

  const reuniones = [
    reunionDireccion,
    { id_reunion: 'r2', visibilidad: 'empresa', convocada_por: BEA },
  ];
  assert.deepEqual(
    filtrarVisibles(ctx, 'reunion', reuniones).map((r) => r.id_reunion),
    ['r2'],
  );
});

test('filtrarVisibles: entrada no-lista devuelve lista vacía; tipo desconocido lanza', () => {
  const ctx = admin();
  assert.deepEqual(filtrarVisibles(ctx, 'tarea', null), []);
  assert.deepEqual(filtrarVisibles(ctx, 'tarea', undefined), []);
  assert.throws(() => filtrarVisibles(ctx, 'acuerdo', []), /tipo no soportado/);
});

test('filtrarVisibles: tareas con proyecto y sin auxDe salen todas fuera', () => {
  // Contrato para quien escriba el listado de la Fase 1A: si no adjunta el
  // proyecto de cada tarea, el filtro las oculta. Es el lado seguro, pero hay que
  // saberlo o el listado sale vacío sin explicación.
  const ctx = ctxDe();
  const tareas = [{ id_tarea: 't1', estado: 'pendiente', responsable_id: 'diego', proyecto_id: 'p1' }];
  assert.deepEqual(filtrarVisibles(ctx, 'tarea', tareas), []);
  assert.deepEqual(
    filtrarVisibles(ctx, 'tarea', tareas, () => ({ proyecto, miembros })).map((t) => t.id_tarea),
    ['t1'],
  );
});

// ─── Carga del contexto (con doble de DynamoDB) ───

function montarUsuarios({ usuario, permisos = [] } = {}) {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  if (usuario) db.sembrar(tables.usuarios, usuario);
  for (const p of permisos) {
    db.sembrar(tables.rolesPermisos, { PK: `ROL#${usuario?.Rol}`, SK: `PERMISO#${p}` });
  }
  db.instalar(docClient);
  return db;
}

test('cargarContextoAcceso: lee rol, permisos, locales y departamentos', async () => {
  invalidarContextoAcceso();
  montarUsuarios({
    usuario: {
      id_usuario: ANA,
      Email: 'ana@igp.local',
      Rol: 'Encargado',
      Local: ['Bar Central'],
      Departamentos: ['mkt'],
    },
    permisos: [PERMISOS.reunionesVer, PERMISOS.proyectosVer],
  });

  const ctx = await cargarContextoAcceso({ sub: ANA, rol: 'Encargado' });
  assert.equal(ctx.idUsuario, ANA);
  assert.equal(ctx.rol, 'Encargado');
  assert.equal(ctx.nombre, 'ana@igp.local', 'sin nombre en la ficha, el email');
  assert.equal(ctx.esAdmin, false);
  assert.equal(ctx.permisosCargados, true);
  assert.equal(tienePermiso(ctx, PERMISOS.reunionesVer), true);
  assert.equal(tienePermiso(ctx, PERMISOS.reunionesGestionar), false);
  assert.deepEqual(ctx.locales, ['Bar Central']);
  assert.deepEqual(ctx.departamentos, ['mkt']);
  assert.equal(ctx.alcanceGlobalLocales, false);
});

test('cargarContextoAcceso: el nombre visible viaja en el contexto para firmar el historial', async () => {
  // Va aquí porque la ficha ya se lee para resolver rol y permisos: si no, cada
  // escritura que registra actividad acabaría haciendo su propio GetItem.
  invalidarContextoAcceso();
  const db = montarUsuarios({
    usuario: { id_usuario: ANA, Rol: 'Encargado', Nombre: 'Ana', Apellidos: 'Ruiz', Email: 'ana@igp.local' },
  });
  const lecturas = db.operaciones.length;
  const ctx = await cargarContextoAcceso({ sub: ANA });
  assert.equal(ctx.nombre, 'Ana Ruiz');
  assert.ok(db.operaciones.length > lecturas);

  // Y de la caché, sin volver a leer.
  const tras = db.operaciones.length;
  assert.equal((await cargarContextoAcceso({ sub: ANA })).nombre, 'Ana Ruiz');
  assert.equal(db.operaciones.length, tras);
});

test('cargarContextoAcceso: sin Locales el alcance es todo el grupo', async () => {
  invalidarContextoAcceso();
  montarUsuarios({ usuario: { id_usuario: ANA, Rol: 'Encargado' } });
  const ctx = await cargarContextoAcceso({ sub: ANA });
  assert.equal(ctx.alcanceGlobalLocales, true);
  assert.deepEqual(ctx.departamentos, []);
});

test('cargarContextoAcceso: el rol de la base de datos manda sobre el del token', async () => {
  invalidarContextoAcceso();
  montarUsuarios({ usuario: { id_usuario: ANA, Rol: 'Encargado' } });
  // Token emitido cuando Ana era Administrador: al recargar deja de serlo.
  const ctx = await cargarContextoAcceso({ sub: ANA, rol: 'Administrador' });
  assert.equal(ctx.rol, 'Encargado');
  assert.equal(ctx.esAdmin, false);
});

test('cargarContextoAcceso: vaciar el Rol en la ficha corta el acceso aunque el token diga otra cosa', async () => {
  invalidarContextoAcceso();
  // Vaciar el rol es la forma de cortarle el acceso a quien se va, y el token
  // sigue vivo hasta 8 h: no puede servir de respaldo.
  montarUsuarios({ usuario: { id_usuario: ANA, Rol: '' } });
  const ctx = await cargarContextoAcceso({ sub: ANA, rol: 'Administrador' });
  assert.equal(ctx.rol, '');
  assert.equal(ctx.esAdmin, false);
  assert.equal(tienePermiso(ctx, PERMISOS.proyectosVer), false);
});

test('cargarContextoAcceso: el contexto cacheado es inmutable', async () => {
  invalidarContextoAcceso();
  montarUsuarios({ usuario: { id_usuario: ANA, Rol: 'Encargado' } });
  const ctx = await cargarContextoAcceso({ sub: ANA });
  // Lo sirve la caché a todas las peticiones del usuario: si se pudiera tocar,
  // se tocaría para todas.
  assert.throws(() => ctx.permisos.add(PERMISOS.proyectosBorrar), /inmutable/);
  assert.throws(() => ctx.permisos.clear(), /inmutable/);
  assert.throws(() => ctx.locales.push('Bar Central'), TypeError);
  assert.throws(() => ctx.departamentos.push('mkt'), TypeError);
  assert.equal(tienePermiso(ctx, PERMISOS.proyectosBorrar), false);
});

test('cargarContextoAcceso: un fallo de DynamoDB se propaga, no se disfraza de permiso', async () => {
  invalidarContextoAcceso();
  const db = montarUsuarios({ usuario: { id_usuario: ANA, Rol: 'Encargado' } });
  db.interceptar('GetCommand', tables.usuarios, () => {
    throw new Error('ProvisionedThroughputExceededException');
  });
  // Degradar a «contexto vacío» convertiría una avería en un 403 y nadie sabría
  // por qué de pronto no ve nada.
  await assert.rejects(() => cargarContextoAcceso({ sub: ANA }), /Throughput/);
});

test('cargarContextoAcceso: cachea y la invalidación fuerza recarga', async () => {
  invalidarContextoAcceso();
  const db = montarUsuarios({
    usuario: { id_usuario: ANA, Rol: 'Encargado' },
    permisos: [PERMISOS.reunionesVer],
  });

  await cargarContextoAcceso({ sub: ANA });
  const lecturas = db.operaciones.length;
  assert.ok(lecturas > 0);

  await cargarContextoAcceso({ sub: ANA });
  assert.equal(db.operaciones.length, lecturas, 'la segunda llamada no debe leer nada');

  await cargarContextoAcceso({ sub: ANA }, { forzar: true });
  assert.ok(db.operaciones.length > lecturas, 'forzar debe releer');

  const tras = db.operaciones.length;
  invalidarContextoAcceso(ANA);
  await cargarContextoAcceso({ sub: ANA });
  assert.ok(db.operaciones.length > tras, 'invalidar debe releer');
});

test('invalidarContextoAcceso: sin argumento vacía la caché de todos los usuarios', async () => {
  invalidarContextoAcceso();
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.usuarios, { id_usuario: ANA, Rol: 'Encargado' });
  db.sembrar(tables.usuarios, { id_usuario: BEA, Rol: 'Encargado' });
  db.instalar(docClient);

  await cargarContextoAcceso({ sub: ANA });
  await cargarContextoAcceso({ sub: BEA });
  const lecturas = db.operaciones.length;
  await cargarContextoAcceso({ sub: ANA });
  await cargarContextoAcceso({ sub: BEA });
  assert.equal(db.operaciones.length, lecturas, 'los dos deben venir de caché');

  // No hay invalidación por rol: cambiar los permisos de un rol obliga a vaciarla.
  invalidarContextoAcceso();
  await cargarContextoAcceso({ sub: ANA });
  await cargarContextoAcceso({ sub: BEA });
  assert.ok(db.operaciones.length > lecturas, 'ninguno debe seguir cacheado');
});

test('cargarContextoAcceso: la entrada caduca por tiempo', async () => {
  invalidarContextoAcceso();
  const db = montarUsuarios({ usuario: { id_usuario: ANA, Rol: 'Encargado' } });
  await cargarContextoAcceso({ sub: ANA });
  const lecturas = db.operaciones.length;

  const ahora = Date.now;
  try {
    Date.now = () => ahora() + 61_000;
    await cargarContextoAcceso({ sub: ANA });
  } finally {
    Date.now = ahora;
  }
  assert.ok(db.operaciones.length > lecturas, 'pasado el TTL debe releer');
});

test('cargarContextoAcceso: usuario borrado deniega todo y no se cachea', async () => {
  invalidarContextoAcceso();
  const db = montarUsuarios({ usuario: { id_usuario: BEA, Rol: 'Encargado' } });

  const ctx = await cargarContextoAcceso({ sub: ANA, rol: 'Administrador' });
  assert.equal(ctx.idUsuario, '');
  assert.equal(ctx.esAdmin, false, 'el rol del token no debe colar sin usuario en base');
  assert.equal(tienePermiso(ctx, PERMISOS.proyectosVer), false);

  const lecturas = db.operaciones.length;
  await cargarContextoAcceso({ sub: ANA });
  assert.ok(db.operaciones.length > lecturas, 'un usuario inexistente no debe quedar cacheado');
});

test('cargarContextoAcceso: token sin sub no llega a consultar', async () => {
  invalidarContextoAcceso();
  const db = montarUsuarios({ usuario: { id_usuario: ANA, Rol: 'Encargado' } });
  const ctx = await cargarContextoAcceso({});
  assert.equal(ctx.permisosCargados, false);
  assert.equal(db.operaciones.length, 0);
});

test('crearRol clonando permisos invalida el contexto cacheado', async () => {
  invalidarContextoAcceso();
  const db = montarUsuarios({
    usuario: { id_usuario: ANA, Rol: 'Encargado' },
    permisos: [PERMISOS.proyectosVer],
  });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Administrador', SK: `PERMISO#${PERMISOS.proyectosBorrar}` });

  const antes = await cargarContextoAcceso({ sub: ANA });
  assert.equal(tienePermiso(antes, PERMISOS.proyectosBorrar), false);

  // «Encargado» existe de facto: tiene filas PERMISO# pero ningún META, y
  // `crearRol` solo comprueba el META. Así que se puede «crear» un rol que ya
  // usa gente y clonarle los permisos de Administrador.
  await crearRol({ nombre: 'Encargado', clonarDe: 'Administrador' });

  const despues = await cargarContextoAcceso({ sub: ANA });
  assert.equal(
    tienePermiso(despues, PERMISOS.proyectosBorrar),
    true,
    'clonar permisos tiene que vaciar la caché: si no, Ana los tiene y el contexto no se entera',
  );
});
