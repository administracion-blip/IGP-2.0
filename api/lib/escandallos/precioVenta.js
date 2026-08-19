/**
 * Precio de venta Ágora por tarifa (PriceListId).
 * Prices en producto: { PriceListId, MainPrice, ... } — sin SaleCenterId.
 */

/**
 * Elige MainPrice de un array Prices según priceListId.
 * Match laxo string/number. Si priceListId es null y solo hay una tarifa
 * con MainPrice > 0, usa esa. Si no hay match, null (no inventa otra tarifa).
 *
 * @param {unknown} prices
 * @param {string|number|null|undefined} priceListId
 * @returns {number|null}
 */
export function pickMainPrice(prices, priceListId) {
  if (!Array.isArray(prices) || prices.length === 0) return null;

  const rows = prices
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      PriceListId: p.PriceListId ?? p.priceListId ?? null,
      MainPrice: Number(p.MainPrice ?? p.mainPrice),
    }))
    .filter((p) => p.PriceListId != null && Number.isFinite(p.MainPrice));

  if (!rows.length) return null;

  const want =
    priceListId != null && String(priceListId).trim() !== ''
      ? String(priceListId).trim()
      : null;

  if (want != null) {
    const hit = rows.find((r) => String(r.PriceListId) === want);
    if (hit) return hit.MainPrice;
    // match numérico laxo ("01" vs 1)
    const wantNum = Number(want);
    if (Number.isFinite(wantNum)) {
      const hitNum = rows.find((r) => Number(r.PriceListId) === wantNum);
      if (hitNum) return hitNum.MainPrice;
    }
    return null;
  }

  if (rows.length === 1 && rows[0].MainPrice > 0) {
    return rows[0].MainPrice;
  }
  return null;
}
