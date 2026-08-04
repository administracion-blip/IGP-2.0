/**
 * Framework de Informes IA — endpoints genéricos.
 *
 * Principio: la IA es SOLO LECTURA. Interpreta datos deterministas, jamás los
 * modifica. Su única escritura es guardar su propio informe en `Igp_InformesIa`.
 *
 * Seguridad:
 * - `requirePermission('ia.informes')` protege TODO el router.
 * - Cada fuente exige además su propio permiso, validado dentro del handler.
 * - Cada fuente filtra los locales del usuario en su generador (no se confía en
 *   el cliente): manipular `parametros.localId` no da acceso a locales ajenos.
 * - Historial/detalle filtran por `alcanceLocales` del informe (o `generadoPor`
 *   en informes legacy sin ese campo). Admin / Locales vacío ven todos.
 */
import { Router } from 'express';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { getFuente, listarFuentes, fuenteMeta } from '../lib/ia/fuentes/index.js';
import {
  chatCompletion,
  iaDisponible,
} from '../lib/ia/openaiClient.js';
import {
  componerSystemPrompt,
  componerUserPrompt,
} from '../lib/ia/prompts.js';
import {
  listarPlantillas,
  resolverPlantilla,
  crearPlantilla,
  actualizarPlantilla,
  borrarPlantilla,
} from '../lib/ia/promptsStore.js';
import {
  nowIso,
  uuid,
  calcularFirmaCache,
  getInformeCacheado,
  guardarInforme,
  listarInformes,
  getInformeById,
  permitirEjecucion,
  usuarioPuedeVerInforme,
} from '../lib/ia/store.js';
import {
  getAjustesIa,
  guardarAjustesIa,
  MODELOS_SUGERIDOS,
} from '../lib/ia/ajustes.js';

const router = Router();

function userKey(user) {
  return String(user?.id_usuario ?? user?.sub ?? user?.email ?? 'anon');
}

/** Alcance de locales del usuario para la firma de cache. */
function alcanceLocalesUsuario(user) {
  if (user?.rol === 'Administrador') return 'ALL';
  const locales = Array.isArray(user?.Locales) ? user.Locales : [];
  if (locales.length === 0) return 'ALL';
  return locales.map((l) => String(l).toLowerCase()).sort();
}

/** GET /api/ia/fuentes — fuentes disponibles para el usuario (por permisos). */
router.get('/ia/fuentes', requirePermission('ia.informes'), async (req, res) => {
  try {
    const todas = listarFuentes();
    const disponibles = [];
    for (const f of todas) {
      // eslint-disable-next-line no-await-in-loop
      if (await hasPermission(req.user, f.permiso)) disponibles.push(f);
    }
    return res.json({ fuentes: disponibles, iaDisponible: iaDisponible() });
  } catch (err) {
    console.error('[ia/fuentes]', err.message || err);
    return res.status(500).json({ error: 'No se pudieron cargar las fuentes' });
  }
});

/**
 * Resuelve la fuente de la request y valida el permiso de fuente.
 * Devuelve la fuente o null (y ya ha respondido con 404/403).
 */
async function requireFuente(req, res, fuenteClave) {
  const fuente = getFuente(String(fuenteClave || ''));
  if (!fuente) {
    res.status(404).json({ error: 'Fuente desconocida' });
    return null;
  }
  if (!(await hasPermission(req.user, fuente.permiso))) {
    res.status(403).json({ error: 'Permiso insuficiente para esta fuente' });
    return null;
  }
  return fuente;
}

/** GET /api/ia/ajustes — ajustes efectivos de la IA (modelo, temperatura, límites). */
router.get('/ia/ajustes', requirePermission('ia.informes'), async (req, res) => {
  try {
    const ajustes = await getAjustesIa();
    const puedeEditar = await hasPermission(req.user, 'ia.ajustes');
    return res.json({ ajustes, modelosSugeridos: MODELOS_SUGERIDOS, iaDisponible: iaDisponible(), puedeEditar });
  } catch (err) {
    console.error('[ia/ajustes:get]', err.message || err);
    return res.status(500).json({ error: 'No se pudieron cargar los ajustes' });
  }
});

/** PUT /api/ia/ajustes — modificar ajustes (solo con permiso ia.ajustes). */
router.put('/ia/ajustes', requirePermission('ia.ajustes'), async (req, res) => {
  try {
    const ajustes = await guardarAjustesIa(req.body || {}, req.user);
    return res.json({ ajustes });
  } catch (err) {
    console.error('[ia/ajustes:put]', err.message || err);
    return res.status(500).json({ error: 'No se pudieron guardar los ajustes' });
  }
});

/** GET /api/ia/prompts?fuente= — plantillas de una fuente (código + usuario). */
router.get('/ia/prompts', requirePermission('ia.informes'), async (req, res) => {
  const fuente = await requireFuente(req, res, req.query.fuente);
  if (!fuente) return undefined;
  try {
    const plantillas = await listarPlantillas(fuente.clave);
    return res.json({ plantillas });
  } catch (err) {
    console.error('[ia/prompts:list]', err.message || err);
    return res.status(500).json({ error: 'No se pudieron cargar las plantillas' });
  }
});

/** POST /api/ia/prompts — crear plantilla. body { fuente, nombre, instrucciones, esDefault } */
router.post('/ia/prompts', requirePermission('ia.prompts_gestionar'), async (req, res) => {
  const { fuente: fuenteClave, nombre, instrucciones, esDefault } = req.body || {};
  const fuente = await requireFuente(req, res, fuenteClave);
  if (!fuente) return undefined;
  if (!String(nombre || '').trim() || !String(instrucciones || '').trim()) {
    return res.status(400).json({ error: 'Nombre e instrucciones son obligatorios' });
  }
  try {
    const plantilla = await crearPlantilla(fuente.clave, { nombre, instrucciones, esDefault }, req.user);
    return res.json({ plantilla });
  } catch (err) {
    console.error('[ia/prompts:create]', err.message || err);
    return res.status(500).json({ error: 'No se pudo crear la plantilla' });
  }
});

/** PUT /api/ia/prompts/:promptId?fuente= — editar plantilla. */
router.put('/ia/prompts/:promptId', requirePermission('ia.prompts_gestionar'), async (req, res) => {
  const fuente = await requireFuente(req, res, req.query.fuente || req.body?.fuente);
  if (!fuente) return undefined;
  try {
    const plantilla = await actualizarPlantilla(fuente.clave, String(req.params.promptId), req.body || {});
    if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada o no editable' });
    return res.json({ plantilla });
  } catch (err) {
    console.error('[ia/prompts:update]', err.message || err);
    return res.status(500).json({ error: 'No se pudo actualizar la plantilla' });
  }
});

/** DELETE /api/ia/prompts/:promptId?fuente= — borrar plantilla (no afecta informes emitidos). */
router.delete('/ia/prompts/:promptId', requirePermission('ia.prompts_gestionar'), async (req, res) => {
  const fuente = await requireFuente(req, res, req.query.fuente);
  if (!fuente) return undefined;
  try {
    const ok = await borrarPlantilla(fuente.clave, String(req.params.promptId));
    if (!ok) return res.status(400).json({ error: 'No se puede borrar la plantilla por defecto' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[ia/prompts:delete]', err.message || err);
    return res.status(500).json({ error: 'No se pudo borrar la plantilla' });
  }
});

/** Filtro ACL de historial/detalle: alcance de locales (B) o autor (A, legacy). */
function filtroAclInformes(user) {
  const alcance = alcanceLocalesUsuario(user);
  const uk = userKey(user);
  return (informe) => usuarioPuedeVerInforme(user, informe, alcance, uk);
}

/** GET /api/ia/informes?fuente=&limit= — historial de una fuente (solo alcance del usuario). */
router.get('/ia/informes', requirePermission('ia.informes'), async (req, res) => {
  const fuenteClave = String(req.query.fuente || '');
  const fuente = getFuente(fuenteClave);
  if (!fuente) return res.status(404).json({ error: 'Fuente desconocida' });
  if (!(await hasPermission(req.user, fuente.permiso))) {
    return res.status(403).json({ error: 'Permiso insuficiente para esta fuente' });
  }
  try {
    const informes = await listarInformes(fuenteClave, req.query.limit, filtroAclInformes(req.user));
    return res.json({ informes });
  } catch (err) {
    console.error('[ia/informes:list]', err.message || err);
    return res.status(500).json({ error: 'No se pudo cargar el historial' });
  }
});

/** GET /api/ia/informes/:informeId?fuente= — detalle con datosJson (404 si fuera de alcance). */
router.get('/ia/informes/:informeId', requirePermission('ia.informes'), async (req, res) => {
  const fuenteClave = String(req.query.fuente || '');
  const fuente = getFuente(fuenteClave);
  if (!fuente) return res.status(404).json({ error: 'Fuente desconocida' });
  if (!(await hasPermission(req.user, fuente.permiso))) {
    return res.status(403).json({ error: 'Permiso insuficiente para esta fuente' });
  }
  try {
    const informe = await getInformeById(
      fuenteClave,
      String(req.params.informeId),
      filtroAclInformes(req.user),
    );
    if (!informe) return res.status(404).json({ error: 'Informe no encontrado' });
    return res.json({ informe });
  } catch (err) {
    console.error('[ia/informes:detail]', err.message || err);
    return res.status(500).json({ error: 'No se pudo cargar el informe' });
  }
});

/**
 * POST /api/ia/informes — genera (o sirve de cache) un informe.
 * body: { fuente, parametros, force? }
 */
router.post('/ia/informes', requirePermission('ia.informes'), async (req, res) => {
  const { fuente: fuenteClave, parametros = {}, promptId: promptIdReq, force = false } = req.body || {};
  const fuente = getFuente(String(fuenteClave || ''));
  if (!fuente) return res.status(404).json({ error: 'Fuente desconocida' });

  if (!(await hasPermission(req.user, fuente.permiso))) {
    return res.status(403).json({ error: 'Permiso insuficiente para esta fuente' });
  }

  const plantilla = await resolverPlantilla(fuente.clave, promptIdReq);
  if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' });
  const promptId = plantilla.promptId;

  // La versión de la plantilla entra en la firma: editar el texto invalida la cache.
  // Persistir alcanceLocales permite filtrar historial/detalle por ACL (opción B).
  const alcanceLocales = alcanceLocalesUsuario(req.user);
  const firmaCache = calcularFirmaCache({
    fuente: fuente.clave,
    parametros,
    promptId: `${promptId}@${plantilla.actualizadoEn || 'code'}`,
    alcanceLocales,
  });

  try {
    if (!force) {
      const cacheado = await getInformeCacheado(fuente.clave, firmaCache);
      if (cacheado) return res.json({ informe: cacheado, cache: true });
    }

    const ajustes = await getAjustesIa();

    if (!permitirEjecucion(userKey(req.user), ajustes.maxEjecucionesHora)) {
      return res.status(429).json({ error: `Límite de ${ajustes.maxEjecucionesHora} informes por hora alcanzado. Inténtalo más tarde.` });
    }

    const datosJson = await fuente.generarDatos(parametros, req.user);

    let resumen = null;
    let modelo = null;
    let costeTokens = { prompt: 0, completion: 0 };

    if (iaDisponible()) {
      const datosStr = JSON.stringify(datosJson);
      if (datosStr.length > ajustes.maxDatosJsonChars) {
        return res.status(413).json({ error: 'El conjunto de datos es demasiado grande para generar el informe.' });
      }
      const system = componerSystemPrompt(plantilla.instrucciones);
      const user = componerUserPrompt(datosJson);
      const salida = await chatCompletion({
        system,
        user,
        model: ajustes.modelo,
        temperature: ajustes.temperatura,
      });
      resumen = salida.text;
      modelo = salida.model;
      costeTokens = salida.usage;
    }

    const informe = {
      informeId: uuid(),
      fuente: fuente.clave,
      parametros,
      promptId,
      promptNombre: plantilla.nombre || '',
      firmaCache,
      alcanceLocales,
      datosJson,
      resumen,
      modelo: modelo || (iaDisponible() ? ajustes.modelo : null),
      costeTokens,
      generadoPor: userKey(req.user),
      generadoPorNombre: req.user?.Nombre || req.user?.email || '',
      generadoEn: nowIso(),
    };

    const guardado = await guardarInforme(informe);
    return res.json({ informe: guardado, cache: false });
  } catch (err) {
    console.error('[ia/informes:post]', err.message || err);
    return res.status(500).json({ error: err.message || 'No se pudo generar el informe' });
  }
});

export default router;
