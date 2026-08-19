import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

export type EscCampoLinea = 'ing' | 'cant' | 'ud' | 'merma';

const CAMPOS: EscCampoLinea[] = ['ing', 'cant', 'ud', 'merma'];

function escCampoId(lineaKey: string, campo: EscCampoLinea): string {
  return `${lineaKey}__${campo}`;
}

function parseEscCampo(raw: string | null | undefined): { key: string; campo: EscCampoLinea } | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf('__');
  if (sep <= 0) return null;
  const key = raw.slice(0, sep);
  const campo = raw.slice(sep + 2) as EscCampoLinea;
  if (!key || !CAMPOS.includes(campo)) return null;
  return { key, campo };
}

function findActiveEscCampo(): { key: string; campo: EscCampoLinea } | null {
  if (typeof document === 'undefined') return null;
  let node: Element | null = document.activeElement;
  while (node) {
    const raw = node.getAttribute?.('data-esc-campo');
    const parsed = parseEscCampo(raw);
    if (parsed) return parsed;
    node = node.parentElement;
  }
  return null;
}

function focusEscCampo(campoId: string) {
  if (typeof document === 'undefined') return;
  const safe =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(campoId)
      : campoId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const el = document.querySelector(`[data-esc-campo="${safe}"]`) as HTMLElement | null;
  if (!el) return;
  const input = el.matches('input,textarea,button,[tabindex]')
    ? el
    : (el.querySelector('input,textarea,button,[tabindex="0"]') as HTMLElement | null);
  (input || el).focus?.();
}

type Opts = {
  enabled: boolean;
  /** Orden actual de keys de línea (de arriba a abajo). */
  lineaKeys: string[];
  /** Crea una línea vacía y devuelve su key (síncrono vía ref interno del caller). */
  onAddLineaAlFinal: () => string;
};

/**
 * Tab entre Ingrediente → Cant. → Ud → Merma en la tabla de escandallos (solo web).
 * En Merma de la última fila, Tab crea una línea nueva y enfoca su Ingrediente.
 * Coste / borrar / ojo quedan fuera (sin data-esc-campo).
 */
export function useEscandalloLineasTab({ enabled, lineaKeys, onAddLineaAlFinal }: Opts) {
  const stateRef = useRef({ lineaKeys, onAddLineaAlFinal, enabled });
  stateRef.current = { lineaKeys, onAddLineaAlFinal, enabled };
  const pendingFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const id = pendingFocusRef.current;
    pendingFocusRef.current = null;
    const t = window.setTimeout(() => focusEscCampo(id), 0);
    return () => window.clearTimeout(t);
  }, [lineaKeys]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const { lineaKeys: keys, onAddLineaAlFinal: addLinea, enabled: on } = stateRef.current;
      if (!on || keys.length === 0) return;

      const active = findActiveEscCampo();
      if (!active) return;

      const rowIdx = keys.indexOf(active.key);
      if (rowIdx < 0) return;
      const colIdx = CAMPOS.indexOf(active.campo);
      if (colIdx < 0) return;

      e.preventDefault();
      e.stopPropagation();

      if (e.shiftKey) {
        if (colIdx > 0) {
          focusEscCampo(escCampoId(active.key, CAMPOS[colIdx - 1]));
          return;
        }
        if (rowIdx > 0) {
          focusEscCampo(escCampoId(keys[rowIdx - 1], 'merma'));
        }
        return;
      }

      if (colIdx < CAMPOS.length - 1) {
        focusEscCampo(escCampoId(active.key, CAMPOS[colIdx + 1]));
        return;
      }

      if (rowIdx < keys.length - 1) {
        focusEscCampo(escCampoId(keys[rowIdx + 1], 'ing'));
        return;
      }

      const newKey = addLinea();
      pendingFocusRef.current = escCampoId(newKey, 'ing');
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [enabled]);
}

export { escCampoId };
