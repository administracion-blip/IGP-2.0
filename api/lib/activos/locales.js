/**
 * Alcance por local: reutiliza usuarioPuedeAccederLocal.
 * El maestro igp_Locales se lee por GetItem (id_Locales); no se tocan las
 * tablas de activos con Scan.
 */

import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  formatId6,
  normalizeLocalesUsuario,
  tieneAlcanceGlobalLocales,
  usuarioPuedeAccederLocal,
} from '../usuarioLocales.js';
import { findUsuarioByEmail } from '../dynamo/usuarios.js';
import { errorHttp } from './tipos.js';

export function idLocalNorm(valor) {
  const id = formatId6(valor);
  return !id || id === '000000' ? '' : id;
}

export async function cargarLocal(idLocal) {
  const id = idLocalNorm(idLocal);
  if (!id) return null;
  const r = await docClient.send(
    new GetCommand({ TableName: tables.locales, Key: { id_Locales: id } }),
  );
  return r.Item || null;
}

export async function resolverLocal(idLocal) {
  const id = idLocalNorm(idLocal);
  if (!id) throw errorHttp(400, 'Indica un local válido');
  const loc = await cargarLocal(id);
  if (!loc) throw errorHttp(400, 'El local no existe');
  const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
  const empresaId = loc.id_empresa != null && loc.id_empresa !== ''
    ? formatId6(loc.id_empresa)
    : '';
  return {
    id_local: id,
    local_nombre: nombre || id,
    empresa_id: empresaId && empresaId !== '000000' ? empresaId : null,
  };
}

export async function asegurarLocalAccesible(user, idLocal) {
  const local = await resolverLocal(idLocal);
  const ok = await usuarioPuedeAccederLocal(user, local.id_local);
  if (!ok) throw errorHttp(404, 'Activo no encontrado', 'DESCONOCIDO');
  return local;
}

/**
 * null = todos los locales. Set de id_Locales si el usuario está acotado.
 * El Scan es del maestro de locales (mismo patrón que empresasPermitidasDelUsuario),
 * no de Igp_Activos.
 */
export async function idsLocalesPermitidos(user) {
  if (!user) return new Set();
  if (user.rol === 'Administrador') return null;
  const usuarios = await findUsuarioByEmail(String(user.email || '').trim().toLowerCase());
  const nombres = normalizeLocalesUsuario(usuarios[0]);
  if (tieneAlcanceGlobalLocales(user.rol, nombres)) return null;

  const nombresNorm = new Set(nombres.map((n) => String(n).trim().toLowerCase()));
  const ids = new Set();
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.locales,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    for (const loc of result.Items || []) {
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim().toLowerCase();
      if (!nombre || !nombresNorm.has(nombre)) continue;
      const id = idLocalNorm(loc.id_Locales);
      if (id) ids.add(id);
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return ids;
}
