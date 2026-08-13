/**
 * Creación de entradas + sincronización con Ágora (Coupons import).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { buildCouponPayload, importCoupons, validateAgoraBaseUrl } from '../agora/couponsImport.js';
import { formatId6 } from '../usuarioLocales.js';
import {
  AGORA_SYNC,
  WHATSAPP_STATUS,
  findEntradaByCode,
  getConfig,
  getEntrada,
  getTipo,
  nowIso,
  pkLocal,
  putEntradaWithCodeLock,
  putEvento,
  skEntrada,
  updateEntradaFields,
} from './entradasStore.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Código alfanumérico seguro (sin caracteres ambiguos 0/O/1/I). */
export function generateEntradaCode(length = 8) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

async function allocateUniqueCode(localId, preferred) {
  const id = formatId6(localId);
  if (preferred) {
    const code = String(preferred).trim().toUpperCase();
    if (!/^[A-Z0-9]{4,32}$/.test(code)) {
      const err = new Error('code no válido (4–32 caracteres alfanuméricos)');
      err.status = 400;
      throw err;
    }
    // No reutilizar códigos ya emitidos (aunque estén anulados en IGP).
    const existing = await findEntradaByCode(code, id);
    if (existing) {
      const err = new Error('Ya existe una entrada con ese código en este local');
      err.status = 409;
      throw err;
    }
    return code;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateEntradaCode(8);
    const existing = await findEntradaByCode(code, id);
    if (!existing) return code;
  }
  const err = new Error('No se pudo generar un código único; reintenta');
  err.status = 503;
  throw err;
}

function usuarioLabel(user) {
  return String(user?.email || user?.sub || '').trim() || null;
}

/**
 * Sincroniza una entrada ya persistida con Ágora.
 * @returns {Promise<object>} entrada actualizada
 */
export async function syncEntradaConAgora(entrada, { user } = {}) {
  const localId = formatId6(entrada.localId);
  const config = await getConfig(localId);

  if (!config?.enabled) {
    const msg = 'La integración de entradas Ágora no está habilitada para este local';
    await updateEntradaFields(entrada, {
      agoraSyncStatus: AGORA_SYNC.ERROR,
      agoraSyncError: msg,
      agoraSyncAt: nowIso(),
    });
    await putEvento({
      entradaId: entrada.entradaId,
      tipo: 'agora_sync_error',
      detalle: msg,
      usuario: usuarioLabel(user),
    });
    return getEntrada(localId, entrada.entradaId);
  }

  let baseUrl;
  try {
    baseUrl = validateAgoraBaseUrl(config.agoraBaseUrl);
  } catch (e) {
    const msg = e.message || 'baseUrl Ágora inválida';
    await updateEntradaFields(entrada, {
      agoraSyncStatus: AGORA_SYNC.ERROR,
      agoraSyncError: msg,
      agoraSyncAt: nowIso(),
    });
    await putEvento({
      entradaId: entrada.entradaId,
      tipo: 'agora_sync_error',
      detalle: msg,
      usuario: usuarioLabel(user),
    });
    return getEntrada(localId, entrada.entradaId);
  }

  const token = String(config.agoraApiToken || '').trim();
  if (!token) {
    const msg = 'No hay Api-Token de Ágora configurado para este local';
    await updateEntradaFields(entrada, {
      agoraSyncStatus: AGORA_SYNC.ERROR,
      agoraSyncError: msg,
      agoraSyncAt: nowIso(),
    });
    await putEvento({
      entradaId: entrada.entradaId,
      tipo: 'agora_sync_error',
      detalle: msg,
      usuario: usuarioLabel(user),
    });
    return getEntrada(localId, entrada.entradaId);
  }

  await updateEntradaFields(entrada, {
    agoraSyncStatus: AGORA_SYNC.SYNCING,
    agoraSyncError: null,
    agoraSyncAt: nowIso(),
  });
  await putEvento({
    entradaId: entrada.entradaId,
    tipo: 'agora_sync_start',
    detalle: 'Inicio sync Ágora',
    usuario: usuarioLabel(user),
  });

  try {
    const coupon = buildCouponPayload({
      settingsId: entrada.agoraSettingsId,
      code: entrada.code,
      createdAt: entrada.creadoEn,
      validUntil: entrada.validUntil,
      validFrom: entrada.validFrom,
      validTo: entrada.validTo,
      printAtPosId: entrada.printAtPosId,
    });

    const result = await importCoupons({
      baseUrl,
      apiToken: token,
      coupons: [coupon],
    });

    const updated = await updateEntradaFields(entrada, {
      agoraSyncStatus: AGORA_SYNC.SYNCED,
      agoraSyncError: null,
      agoraSyncAt: nowIso(),
      agoraSyncResponse: result?.data != null ? JSON.stringify(result.data).slice(0, 2000) : null,
    });
    await putEvento({
      entradaId: entrada.entradaId,
      tipo: 'agora_sync_ok',
      detalle: 'Sincronizado con Ágora',
      usuario: usuarioLabel(user),
    });
    return updated;
  } catch (err) {
    const msg = err.message || 'Error al sincronizar con Ágora';
    const updated = await updateEntradaFields(entrada, {
      agoraSyncStatus: AGORA_SYNC.ERROR,
      agoraSyncError: msg.slice(0, 1000),
      agoraSyncAt: nowIso(),
    });
    await putEvento({
      entradaId: entrada.entradaId,
      tipo: 'agora_sync_error',
      detalle: msg.slice(0, 1000),
      usuario: usuarioLabel(user),
    });
    return updated;
  }
}

/**
 * Crea la entrada en Dynamo y lanza sync Ágora.
 */
export async function createEntradaAndSync(body, user) {
  const localId = formatId6(body.localId);
  const tipoId = String(body.tipoId || '').trim();
  if (!tipoId) {
    const err = new Error('tipoId es obligatorio');
    err.status = 400;
    throw err;
  }

  const tipo = await getTipo(localId, tipoId);
  if (!tipo || tipo.activo === false) {
    const err = new Error('Tipo de entrada no encontrado o inactivo');
    err.status = 404;
    throw err;
  }

  const settingsId = Number(tipo.agoraSettingsId);
  if (!Number.isFinite(settingsId) || settingsId <= 0) {
    const err = new Error('El tipo no tiene agoraSettingsId válido');
    err.status = 400;
    throw err;
  }

  const validUntil = body.validUntil != null && body.validUntil !== ''
    ? String(body.validUntil).trim()
    : null;
  const validFrom = body.validFrom != null && body.validFrom !== ''
    ? String(body.validFrom).trim()
    : null;
  const validTo = body.validTo != null && body.validTo !== ''
    ? String(body.validTo).trim()
    : null;

  if (validUntil && (validFrom || validTo)) {
    const err = new Error('validUntil no se puede combinar con validFrom/validTo');
    err.status = 400;
    throw err;
  }
  if (Boolean(validFrom) !== Boolean(validTo)) {
    const err = new Error('validFrom y validTo deben indicarse juntos');
    err.status = 400;
    throw err;
  }

  let printAtPosId = null;
  if (body.printAtPosId != null && body.printAtPosId !== '') {
    const n = Number(body.printAtPosId);
    if (!Number.isFinite(n) || n <= 0) {
      const err = new Error('printAtPosId debe ser un número positivo');
      err.status = 400;
      throw err;
    }
    printAtPosId = n;
  }

  const code = await allocateUniqueCode(localId, body.code);
  const entradaId = randomUUID();
  const creadoEn = nowIso();
  const telefono = body.telefono != null ? String(body.telefono).trim() : '';
  const clienteNombre = body.clienteNombre != null ? String(body.clienteNombre).trim() : '';

  const item = {
    PK: pkLocal(localId),
    SK: skEntrada(creadoEn, entradaId),
    entradaId,
    localId,
    tipoId,
    tipoNombre: String(tipo.nombre || '').trim(),
    agoraSettingsId: settingsId,
    code,
    creadoEn,
    creadoPor: usuarioLabel(user),
    telefono: telefono || null,
    clienteNombre: clienteNombre || null,
    validUntil: validUntil || null,
    validFrom: validFrom || null,
    validTo: validTo || null,
    printAtPosId,
    agoraSyncStatus: AGORA_SYNC.PENDING,
    agoraSyncError: null,
    agoraSyncAt: null,
    whatsappStatus: WHATSAPP_STATUS.NONE,
    whatsappEnviadoEn: null,
    anulado: false,
    anuladoEn: null,
    anuladoPor: null,
  };

  try {
    await putEntradaWithCodeLock(item);
  } catch (err) {
    const name = err?.name || '';
    if (
      name === 'ConditionalCheckFailedException'
      || name === 'TransactionCanceledException'
    ) {
      const e = new Error('Ya existe una entrada con ese código en este local');
      e.status = 409;
      throw e;
    }
    throw err;
  }

  await putEvento({
    entradaId,
    tipo: 'creada',
    detalle: `Entrada creada code=${code}`,
    usuario: usuarioLabel(user),
  });

  return syncEntradaConAgora(item, { user });
}

/**
 * Reintenta sync Ágora de una entrada existente.
 */
export async function reintentarSync(localId, entradaId, user) {
  const id = formatId6(localId);
  const entrada = await getEntrada(id, entradaId);
  if (!entrada) {
    const err = new Error('Entrada no encontrada');
    err.status = 404;
    throw err;
  }
  if (entrada.anulado) {
    const err = new Error('No se puede sincronizar una entrada anulada');
    err.status = 409;
    throw err;
  }
  if (entrada.agoraSyncStatus === AGORA_SYNC.SYNCING) {
    const syncAt = entrada.agoraSyncAt ? Date.parse(entrada.agoraSyncAt) : 0;
    const staleMs = 2 * 60 * 1000;
    if (Number.isFinite(syncAt) && Date.now() - syncAt < staleMs) {
      const err = new Error('La entrada ya se está sincronizando');
      err.status = 409;
      throw err;
    }
    // SYNCING antiguo (proceso caído): permitir reintento
  }

  await putEvento({
    entradaId: entrada.entradaId,
    tipo: 'agora_reintento',
    detalle: 'Reintento manual de sync Ágora',
    usuario: usuarioLabel(user),
  });

  return syncEntradaConAgora(entrada, { user });
}
