import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from './db.js';
import { findUsuarioByEmail } from './dynamo/usuarios.js';

export function formatId6(val) {
  if (val == null || val === '') return '000000';
  const s = String(val).replace(/^0+/, '') || '0';
  const n = parseInt(s, 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

/** Nombres de locales permitidos desde registro igp_usuarios (campo `Local`). */
export function normalizeLocalesUsuario(record) {
  if (!record) return [];
  const rawLocal = record.Local ?? record.Locales;
  if (Array.isArray(rawLocal)) {
    return rawLocal
      .filter((l) => l != null && String(l).trim() !== '')
      .map((l) => String(l).trim());
  }
  if (rawLocal != null && String(rawLocal).trim() !== '') {
    return [String(rawLocal).trim()];
  }
  return [];
}

/**
 * ¿Puede el usuario del token acceder a este local?
 * Administrador o Locales vacío = todos.
 */
export async function usuarioPuedeAccederLocal(user, idLocal) {
  if (!user) return false;
  if (user.rol === 'Administrador') return true;
  try {
    const usuarios = await findUsuarioByEmail(String(user.email || '').trim().toLowerCase());
    const locales = normalizeLocalesUsuario(usuarios[0]);
    if (locales.length === 0) return true;
    const loc = await docClient.send(
      new GetCommand({ TableName: tables.locales, Key: { id_Locales: formatId6(idLocal) } }),
    );
    const nombre = String(loc.Item?.nombre ?? loc.Item?.Nombre ?? '').trim().toLowerCase();
    if (!nombre) return false;
    return locales.some((l) => String(l).trim().toLowerCase() === nombre);
  } catch (err) {
    console.error('[usuarioPuedeAccederLocal]', err.message || err);
    return false;
  }
}

/** Jornada de negocio actual (misma regla 09:30 que app/lib/jornadaNegocio.ts). */
export function jornadaNegocioHoyIso() {
  const now = new Date();
  const minutesOfDay = now.getHours() * 60 + now.getMinutes();
  const cutoff = 9 * 60 + 30;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (minutesOfDay <= cutoff) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
