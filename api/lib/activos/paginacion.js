/**
 * Cursor opaco = LastEvaluatedKey en base64.
 * Copia local (mismo criterio que tasks/banca): no acoplar dominios.
 */

export function codificarCursor(lastKey) {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey), 'utf8').toString('base64');
}

export function decodificarCursor(cursor) {
  const raw = String(cursor || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function limiteValido(valor, { porDefecto = 50, maximo = 200 } = {}) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 1) return porDefecto;
  return Math.min(Math.floor(n), maximo);
}
