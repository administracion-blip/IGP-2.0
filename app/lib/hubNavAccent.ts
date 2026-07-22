/** Paleta pastel para iconos de tarjetas hub (rotación por id/índice). */
export const HUB_ACCENT_PRESETS = [
  { accentBg: '#e0f2fe', accentFg: '#0ea5e9' },
  { accentBg: '#dcfce7', accentFg: '#16a34a' },
  { accentBg: '#ede9fe', accentFg: '#7c3aed' },
  { accentBg: '#ccfbf1', accentFg: '#0d9488' },
  { accentBg: '#e0e7ff', accentFg: '#4f46e5' },
  { accentBg: '#cffafe', accentFg: '#0891b2' },
  { accentBg: '#fce7f3', accentFg: '#db2777' },
  { accentBg: '#d1fae5', accentFg: '#059669' },
  { accentBg: '#dbeafe', accentFg: '#2563eb' },
  { accentBg: '#ffedd5', accentFg: '#d97706' },
] as const;

export type HubAccent = { accentBg: string; accentFg: string };

export function hubAccentByIndex(index: number): HubAccent {
  return HUB_ACCENT_PRESETS[index % HUB_ACCENT_PRESETS.length];
}

export function hubAccentById(id: string): HubAccent {
  let n = 0;
  for (let i = 0; i < id.length; i += 1) {
    n = (n + id.charCodeAt(i)) % HUB_ACCENT_PRESETS.length;
  }
  return HUB_ACCENT_PRESETS[n];
}
