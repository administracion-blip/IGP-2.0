/**
 * Helpers de enrichment OpenDate/CloseDate para sincronización de cierres Ágora.
 * Extraídos de server.js para uso compartido entre server.js y el router agora.js.
 */

function findValue(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const keyList = Array.isArray(keys) ? keys : [keys];
  const lower = (k) => String(k).toLowerCase();
  for (const key of keyList) {
    const v = obj[key];
    if (v != null && v !== '') return v;
    const found = Object.keys(obj || {}).find((k) => lower(k) === lower(key));
    if (found && obj[found] != null && obj[found] !== '') return obj[found];
  }
  for (const val of Object.values(obj || {})) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const v = findValue(val, keyList, depth + 1);
      if (v != null && v !== '') return v;
    }
  }
  return null;
}

function getMappableRaw(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let out = { ...raw };
  const toMerge = [raw?.CloseOut ?? raw?.closeOut, raw?.Data ?? raw?.data, raw?.Record ?? raw?.record].filter((x) => x != null && typeof x === 'object' && !Array.isArray(x));
  for (const obj of toMerge) {
    out = { ...out, ...obj };
    const inner = obj?.CloseOut ?? obj?.closeOut ?? obj?.Data ?? obj?.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) out = { ...out, ...inner };
  }
  return out;
}

function extractPosFromRaw(raw) {
  const r = getMappableRaw(raw);
  const posId = findValue(r, ['PosId', 'posId', 'PointOfSaleId', 'pointOfSaleId']) ?? r?.Pos?.Id ?? r?.PointOfSale?.Id ?? r?.PointsOfSale?.[0]?.Id ?? null;
  return { posId };
}

export function normalizeCloseOutKeyPartStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

export function normalizeCloseOutKeyPartPosId(posId) {
  if (posId == null) return '';
  return String(posId).trim();
}

export function closeOutAuxiliaryKey(businessDay, workplaceId, posId) {
  const b = normalizeCloseOutKeyPartStr(businessDay);
  const w = normalizeCloseOutKeyPartStr(workplaceId);
  const p = normalizeCloseOutKeyPartPosId(posId);
  return `${b}|${w}|${p}`;
}

export function rawToAuxiliaryKey(raw, businessDayOverride) {
  const r = getMappableRaw(raw);
  const workplaceId = normalizeCloseOutKeyPartStr(
    findValue(r, ['WorkplaceId', 'workplaceId', 'WokrplaceId', 'LocalId', 'localId', 'Workplace', 'workplace']) ?? r?.WorkplaceId ?? r?.Workplace?.Id ?? ''
  );
  const bdRaw = findValue(r, ['BusinessDay', 'businessDay', 'Fecha', 'fecha', 'Date', 'date']) ?? r?.BusinessDay ?? businessDayOverride ?? '';
  const bd = normalizeCloseOutKeyPartStr(bdRaw) || normalizeCloseOutKeyPartStr(businessDayOverride);
  const { posId } = extractPosFromRaw(r);
  return closeOutAuxiliaryKey(bd, workplaceId, posId);
}

export function isEmptyOpenCloseDate(v) {
  if (v == null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

export function extractOpenCloseDatesFromAuxiliaryRaw(raw) {
  const r = getMappableRaw(raw);
  const openDate = findValue(r, ['OpenDate', 'openDate', 'FechaApertura']) ?? r?.OpenDate ?? null;
  const closeDate = findValue(r, ['CloseDate', 'closeDate', 'FechaCierre']) ?? r?.CloseDate ?? null;
  return { openDate, closeDate };
}

/**
 * Post-proceso: solo rellena OpenDate/CloseDate si estaban vacíos.
 * Fuentes: primero PosCloseOuts, luego SystemCloseOuts sobrescribe (prioridad System en duplicados).
 * No modifica Amounts, InvoicePayments ni ningún otro campo.
 */
export function enrichItemsOpenCloseDatesFromAuxiliary(items, businessDay, sysList, posList) {
  const stats = {
    itemsTotal: items.length,
    vaciosOpenAntes: 0,
    vaciosCloseAntes: 0,
    rellenadosOpen: 0,
    rellenadosClose: 0,
    vaciosOpenDespues: 0,
    vaciosCloseDespues: 0,
  };
  const auxByKey = new Map();
  for (const r of posList || []) {
    auxByKey.set(rawToAuxiliaryKey(r, businessDay), r);
  }
  for (const r of sysList || []) {
    auxByKey.set(rawToAuxiliaryKey(r, businessDay), r);
  }

  for (const item of items) {
    const wp = normalizeCloseOutKeyPartStr(item.PK ?? item.WorkplaceId ?? '');
    const bd = normalizeCloseOutKeyPartStr(item.BusinessDay ?? businessDay) || normalizeCloseOutKeyPartStr(businessDay);
    const k = closeOutAuxiliaryKey(bd, wp, item.PosId);

    const openEmpty = isEmptyOpenCloseDate(item.OpenDate);
    const closeEmpty = isEmptyOpenCloseDate(item.CloseDate);
    if (openEmpty) stats.vaciosOpenAntes += 1;
    if (closeEmpty) stats.vaciosCloseAntes += 1;

    const aux = auxByKey.get(k);
    if (aux) {
      const { openDate, closeDate } = extractOpenCloseDatesFromAuxiliaryRaw(aux);
      if (openEmpty && !isEmptyOpenCloseDate(openDate)) {
        item.OpenDate = openDate;
        stats.rellenadosOpen += 1;
      }
      if (closeEmpty && !isEmptyOpenCloseDate(closeDate)) {
        item.CloseDate = closeDate;
        stats.rellenadosClose += 1;
      }
    }
    if (isEmptyOpenCloseDate(item.OpenDate)) stats.vaciosOpenDespues += 1;
    if (isEmptyOpenCloseDate(item.CloseDate)) stats.vaciosCloseDespues += 1;
  }
  return stats;
}

export function accumulateOpenCloseEnrichmentTotals(acc, s) {
  acc.itemsTotal += s.itemsTotal;
  acc.vaciosOpenAntes += s.vaciosOpenAntes;
  acc.vaciosCloseAntes += s.vaciosCloseAntes;
  acc.rellenadosOpen += s.rellenadosOpen;
  acc.rellenadosClose += s.rellenadosClose;
  acc.vaciosOpenDespues += s.vaciosOpenDespues;
  acc.vaciosCloseDespues += s.vaciosCloseDespues;
  return acc;
}
