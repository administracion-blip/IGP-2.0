import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
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

// [SEC S-08]
/**
 * Empresas (id_empresa formatId6) permitidas para el usuario según sus Locales.
 * JWT no lleva Locales: se recargan desde DB por email (igual que usuarioPuedeAccederLocal).
 * @returns {Promise<null|Set<string>>} null = sin restricción; Set = solo esos emisor_id
 */
export async function empresasPermitidasDelUsuario(user) {
  if (!user) return new Set();
  if (user.rol === 'Administrador') return null;
  try {
    const usuarios = await findUsuarioByEmail(String(user.email || '').trim().toLowerCase());
    const locales = normalizeLocalesUsuario(usuarios[0]);
    if (locales.length === 0) return null;

    const localesNorm = new Set(locales.map((l) => String(l).trim().toLowerCase()));
    const empresas = new Set();
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
        if (!nombre || !localesNorm.has(nombre)) continue;
        if (loc.id_empresa == null || loc.id_empresa === '') continue;
        const idEmp = formatId6(loc.id_empresa);
        if (idEmp && idEmp !== '000000') empresas.add(idEmp);
      }
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    return empresas;
  } catch (err) {
    console.error('[empresasPermitidasDelUsuario]', err.message || err);
    return new Set();
  }
}

// [SEC S-08]
/** ¿Puede el usuario ver/mutar esta factura según emisor_id (sociedad del grupo)? */
export function facturaEmisorPermitido(factura, empresasPermitidas /* null|Set */) {
  if (empresasPermitidas == null) return true;
  const id = formatId6(factura?.emisor_id);
  if (!id || id === '000000') return false;
  return empresasPermitidas.has(id);
}

/** Formatea Date local como YYYY-MM-DD (sin UTC). */
function fechaLocalIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Jornada de negocio actual (misma regla 09:30 que app/lib/jornadaNegocio.ts). */
export function jornadaNegocioHoyIso() {
  const now = new Date();
  const minutesOfDay = now.getHours() * 60 + now.getMinutes();
  const cutoff = 9 * 60 + 30;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (minutesOfDay <= cutoff) d.setDate(d.getDate() - 1);
  return fechaLocalIso(d);
}

/**
 * Día por defecto para briefings «día anterior»: siempre jornada de negocio − 1 día.
 * Ejemplo: 04/08 00:43 → jornada 03/08 → default 02/08.
 */
export function jornadaNegocioInformeDefaultIso() {
  const jornada = jornadaNegocioHoyIso();
  const [y, m, d] = jornada.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 1);
  return fechaLocalIso(date);
}
