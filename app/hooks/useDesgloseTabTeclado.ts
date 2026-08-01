import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { round2 } from '../utils/facturacion';
import { parseImporteTexto } from '../lib/registroMasivo';
import { LINEA_VACIA, type LineaDesglose } from '../types/registroMasivo';
import type { useRegistroMasivoFocus } from './useRegistroMasivoFocusChain';

function lineaTieneDatos(L: LineaDesglose): boolean {
  return (Number(L.base) || 0) > 0
    || (Number(L.porcentaje) || 0) > 0
    || (Number(L.cuota) || 0) > 0;
}

function aplicarPorcentajeLinea(L: LineaDesglose, porcentaje: number): LineaDesglose {
  const base = round2(Number(L.base) || 0);
  const pct = Number(porcentaje) || 0;
  return {
    ...L,
    porcentaje: pct,
    cuota: round2((base * pct) / 100),
    origen: 'manual',
  };
}

/** RN Web no entrega Tab al TextInput; lee el campo % activo vía data-desglose-campo. */
function findDesglosePctInput(): { index: number; value: string } | null {
  const active = document.activeElement;
  if (!active) return null;

  let node: Element | null = active;
  let campo: string | null = null;
  let input: HTMLInputElement | null = active instanceof HTMLInputElement ? active : null;

  while (node) {
    const c = node.getAttribute?.('data-desglose-campo');
    if (c) {
      campo = c;
      if (node instanceof HTMLInputElement) input = node;
      break;
    }
    node = node.parentElement;
  }

  if (!campo?.endsWith('_pct')) return null;
  const m = /^(\d+)_pct$/.exec(campo);
  if (!m) return null;

  return {
    index: parseInt(m[1], 10),
    value: input?.value ?? '',
  };
}

/**
 * Tab/Enter en el campo % del desglose fiscal (registro masivo, solo web):
 * - última línea con datos → crea línea nueva y enfoca su Base;
 * - última línea vacía con más filas → elimina la fila y va a Observaciones;
 * - no es la última → confirma % y enfoca Base de la siguiente fila.
 */
export function useDesgloseTabTeclado(
  linesEffective: LineaDesglose[],
  emit: (nuevas: LineaDesglose[]) => void,
  focusCtx: ReturnType<typeof useRegistroMasivoFocus>,
) {
  const stateRef = useRef({ linesEffective, emit, focusCtx });
  stateRef.current = { linesEffective, emit, focusCtx };

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' && e.key !== 'Enter') return;
      if (e.shiftKey) return;

      const found = findDesglosePctInput();
      if (!found) return;

      const { index: i, value: raw } = found;
      const { linesEffective: lines, emit: emitLines, focusCtx: ctx } = stateRef.current;
      if (!ctx || !lines[i]) return;

      const committedPct = round2(parseImporteTexto(raw));
      const lineActualizada = aplicarPorcentajeLinea(lines[i], committedPct);
      const isLast = i === lines.length - 1;
      const tieneDatos = lineaTieneDatos(lineActualizada);

      e.preventDefault();
      e.stopPropagation();

      if (!isLast) {
        emitLines(lines.map((ln, idx) => (idx === i ? lineActualizada : ln)));
        window.setTimeout(() => ctx.focusField(`desglose_${i + 1}_base`), 0);
        return;
      }

      if (tieneDatos) {
        emitLines([
          ...lines.map((ln, idx) => (idx === i ? lineActualizada : ln)),
          { ...LINEA_VACIA },
        ]);
        window.setTimeout(() => ctx.focusField(`desglose_${i + 1}_base`), 80);
        return;
      }

      if (lines.length > 1) {
        emitLines(lines.filter((_, idx) => idx !== i));
        window.setTimeout(() => ctx.focusField('observaciones'), 80);
        return;
      }

      emitLines(lines.map((ln, idx) => (idx === i ? lineActualizada : ln)));
      ctx.focusField('observaciones');
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);
}
