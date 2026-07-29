import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, type TextInput } from 'react-native';

type FocusFn = () => void;

type RegistroMasivoFocusContextValue = {
  register: (fieldId: string, focusFn: FocusFn) => () => void;
  focusRelative: (currentId: string, delta: 1 | -1) => boolean;
  focusField: (fieldId: string) => void;
  lastFocusedFieldId: string | null;
  setLastFocusedFieldId: (id: string | null) => void;
};

const RegistroMasivoFocusContext = createContext<RegistroMasivoFocusContextValue | null>(null);

export function RegistroMasivoFocusProvider({
  fieldOrder,
  children,
}: {
  fieldOrder: string[];
  children: ReactNode;
}) {
  const registryRef = useRef<Map<string, FocusFn>>(new Map());
  const orderRef = useRef(fieldOrder);
  orderRef.current = fieldOrder;
  const [lastFocusedFieldId, setLastFocusedFieldIdState] = useState<string | null>(null);

  const register = useCallback((fieldId: string, focusFn: FocusFn) => {
    registryRef.current.set(fieldId, focusFn);
    return () => {
      registryRef.current.delete(fieldId);
    };
  }, []);

  const focusField = useCallback((fieldId: string) => {
    registryRef.current.get(fieldId)?.();
  }, []);

  const focusRelative = useCallback((currentId: string, delta: 1 | -1): boolean => {
    const order = orderRef.current;
    const idx = order.indexOf(currentId);
    if (idx < 0) return false;
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= order.length) return false;
    focusField(order[nextIdx]);
    return true;
  }, [focusField]);

  const setLastFocusedFieldId = useCallback((id: string | null) => {
    setLastFocusedFieldIdState(id);
  }, []);

  const value = useMemo(
    (): RegistroMasivoFocusContextValue => ({
      register,
      focusRelative,
      focusField,
      lastFocusedFieldId,
      setLastFocusedFieldId,
    }),
    [register, focusRelative, focusField, lastFocusedFieldId, setLastFocusedFieldId],
  );

  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  return (
    <RegistroMasivoFocusContext.Provider value={value}>
      {children}
    </RegistroMasivoFocusContext.Provider>
  );
}

export function useRegistroMasivoFocus() {
  return useContext(RegistroMasivoFocusContext);
}

/** Registra un campo editable y devuelve ref + handlers para Tab/Enter (solo web). */
export function useRegistroMasivoField(
  fieldId: string | undefined,
  opts?: { multiline?: boolean },
) {
  const ctx = useRegistroMasivoFocus();
  const ref = useRef<TextInput>(null);

  useEffect(() => {
    if (!ctx || !fieldId) return;
    return ctx.register(fieldId, () => {
      ref.current?.focus();
    });
  }, [ctx, fieldId]);

  const onFocus = useCallback(() => {
    if (ctx && fieldId) ctx.setLastFocusedFieldId(fieldId);
  }, [ctx, fieldId]);

  const onKeyDown = useCallback(
    (e: {
      nativeEvent?: { key?: string; shiftKey?: boolean };
      key?: string;
      shiftKey?: boolean;
      preventDefault?: () => void;
    }) => {
      if (!ctx || !fieldId || Platform.OS !== 'web') return;
      const key = e.nativeEvent?.key ?? e.key ?? '';
      const shift = e.nativeEvent?.shiftKey ?? e.shiftKey ?? false;
      if (key === 'Tab') {
        if (ctx.focusRelative(fieldId, shift ? -1 : 1)) {
          e.preventDefault?.();
        }
      } else if (key === 'Enter' && !shift && !opts?.multiline) {
        if (ctx.focusRelative(fieldId, 1)) {
          e.preventDefault?.();
        }
      }
    },
    [ctx, fieldId, opts?.multiline],
  );

  const avanzarFoco = useCallback(
    (delta: 1 | -1) => {
      if (!ctx || !fieldId) return false;
      return ctx.focusRelative(fieldId, delta);
    },
    [ctx, fieldId],
  );

  return {
    ref,
    onFocus: ctx && fieldId ? onFocus : undefined,
    onKeyDown: ctx && fieldId ? onKeyDown : undefined,
    avanzarFoco,
  };
}

export function buildRegistroMasivoFocusOrder(desgloseLineCount: number): string[] {
  const n = Math.max(1, desgloseLineCount);
  const desgloseIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    desgloseIds.push(`desglose_${i}_base`, `desglose_${i}_pct`);
  }
  return [
    'empresa_grupo',
    'proveedor_cif',
    'proveedor_nombre',
    'numero_factura',
    'fecha_emision',
    ...desgloseIds,
    'observaciones',
  ];
}

/** Campo con foco → clave de zona OCR (solo campos con recorte). */
export const REGISTRO_MASIVO_ZONA_POR_FOCUS: Record<string, string> = {
  proveedor_cif: 'proveedor_cif',
  proveedor_nombre: 'proveedor_nombre',
  numero_factura: 'numero_factura_proveedor',
  fecha_emision: 'fecha_emision',
};

/**
 * Tras OCR, enfoca Empresa y deja lista lista para Tab/Enter (solo web).
 * `tick` se incrementa cada vez que termina una extracción OCR.
 */
export function RegistroMasivoAutoFocusEmpresa({
  tick,
  enabled,
  onAbrirDropdown,
}: {
  tick: number;
  enabled: boolean;
  onAbrirDropdown?: () => void;
}) {
  const ctx = useRegistroMasivoFocus();
  const onAbrirRef = useRef(onAbrirDropdown);
  onAbrirRef.current = onAbrirDropdown;

  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled || tick === 0 || !ctx) return;

    const id = window.setTimeout(() => {
      onAbrirRef.current?.();
      ctx.focusField('empresa_grupo');
    }, 80);

    return () => clearTimeout(id);
  }, [tick, enabled, ctx]);

  return null;
}

/** Atajos globales web: F2 recorte, Escape cancelar zona, Alt+←/→ entre borradores. */
export function RegistroMasivoKeyboardShortcuts({
  enabled = true,
  zonaActiva,
  onCancelZona,
  onActivarZona,
  onNavPrev,
  onNavNext,
}: {
  enabled?: boolean;
  zonaActiva: boolean;
  onCancelZona: () => void;
  onActivarZona: (field: string) => void;
  onNavPrev: () => void;
  onNavNext: () => void;
}) {
  const ctx = useRegistroMasivoFocus();

  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && zonaActiva) {
        e.preventDefault();
        onCancelZona();
        return;
      }
      if (e.key === 'F2' && ctx?.lastFocusedFieldId) {
        const zonaField = REGISTRO_MASIVO_ZONA_POR_FOCUS[ctx.lastFocusedFieldId];
        if (zonaField) {
          e.preventDefault();
          onActivarZona(zonaField);
        }
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') onNavPrev();
        else onNavNext();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, ctx, zonaActiva, onCancelZona, onActivarZona, onNavPrev, onNavNext]);

  return null;
}
