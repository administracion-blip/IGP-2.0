/**
 * Auth por API key para el namespace /integraciones (independiente de JWT / X-Internal-Secret).
 * Solo lectura: rechaza métodos distintos de GET bajo el namespace.
 */
import crypto from 'crypto';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const GSI_KEY_HASH = 'GsiKeyHash';

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function hashesIguales(hexA, hexB) {
  try {
    const a = Buffer.from(String(hexA || ''), 'utf8');
    const b = Buffer.from(String(hexB || ''), 'utf8');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function scopesDeItem(item) {
  const raw = item?.scopes;
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  return [];
}

function sufijoKeyParaLog(apiKey) {
  const s = String(apiKey || '');
  if (s.length < 4) return '****';
  return s.slice(-4);
}

/**
 * Rechaza POST/PUT/PATCH/DELETE (y cualquier no-GET) bajo /integraciones.
 * Debe aplicarse al namespace antes de los handlers.
 */
export function rejectNonGetIntegraciones(req, res, next) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido: este namespace es solo lectura (GET)' });
  }
  return next();
}

/**
 * Valida cabecera X-Api-Key: SHA-256 → GSI GsiKeyHash → activa + scope.
 * @param {{ scope: string }} opts
 */
export function requireIntegracionApiKey(opts = {}) {
  const scopeRequerido = String(opts.scope || '').trim();

  return async function integracionApiKeyMiddleware(req, res, next) {
    const apiKeyHeader = req.headers['x-api-key'];
    const apiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : '';
    if (!apiKey) {
      return res.status(401).json({ error: 'API key no proporcionada' });
    }

    const keyHash = sha256Hex(apiKey);

    let item = null;
    try {
      const result = await docClient.send(
        new QueryCommand({
          TableName: tables.integracionesApi,
          IndexName: GSI_KEY_HASH,
          KeyConditionExpression: 'key_hash = :h',
          ExpressionAttributeValues: { ':h': keyHash },
          Limit: 5,
        }),
      );
      const candidatos = result.Items || [];
      for (const cand of candidatos) {
        if (!hashesIguales(keyHash, cand.key_hash)) continue;
        item = cand;
        break;
      }
    } catch (err) {
      console.error('[integracionApiKey] Error consultando clave', err?.message || err);
      return res.status(500).json({ error: 'Error autenticando integración' });
    }

    if (!item || item.activa !== true) {
      const prefix = item?.key_prefix ? String(item.key_prefix) : '';
      console.warn(
        '[integracionApiKey] Rechazada',
        prefix ? `prefix=${prefix}` : 'sin-match',
        prefix ? `tail=${sufijoKeyParaLog(apiKey)}` : '',
      );
      return res.status(401).json({ error: 'API key inválida o inactiva' });
    }

    if (scopeRequerido && !scopesDeItem(item).includes(scopeRequerido)) {
      console.warn(
        '[integracionApiKey] Sin scope',
        `prefix=${String(item.key_prefix || '')}`,
        `tail=${sufijoKeyParaLog(apiKey)}`,
      );
      return res.status(401).json({ error: 'API key sin permiso para este recurso' });
    }

    req.integracion = {
      id_clave: item.id_clave,
      id_integracion: item.id_integracion,
      nombre: item.nombre,
      key_prefix: item.key_prefix,
      scopes: scopesDeItem(item),
    };

    // Única escritura permitida: last_used_at en Igp_IntegracionesApi (no actuaciones).
    if (item.id_clave) {
      docClient
        .send(
          new UpdateCommand({
            TableName: tables.integracionesApi,
            Key: { id_clave: String(item.id_clave) },
            UpdateExpression: 'SET last_used_at = :t',
            ExpressionAttributeValues: { ':t': new Date().toISOString() },
          }),
        )
        .catch((err) => {
          console.warn('[integracionApiKey] No se pudo actualizar last_used_at', err?.message || err);
        });
    }

    return next();
  };
}
