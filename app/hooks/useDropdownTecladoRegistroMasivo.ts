import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  type NativeSyntheticEvent,
  type ScrollView,
  type TextInputKeyPressEventData,
  type View,
} from 'react-native';

export type DropdownTecladoKeyEvent = {
  nativeEvent?: { key?: string; shiftKey?: boolean };
  key?: string;
  shiftKey?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

function indiceSeguro(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index >= 0 && index < length) return index;
  return 0;
}

function leerTecla(e: DropdownTecladoKeyEvent): { key: string; shift: boolean } {
  return {
    key: e.nativeEvent?.key ?? e.key ?? '',
    shift: e.nativeEvent?.shiftKey ?? e.shiftKey ?? false,
  };
}

/** Foco del input + ref síncrona para teclado antes del commit de React. */
export function useDropdownCampoFoco() {
  const inputEnFocoRef = useRef(false);
  const [inputEnFoco, setInputEnFoco] = useState(false);

  const marcarFoco = useCallback(() => {
    inputEnFocoRef.current = true;
    setInputEnFoco(true);
  }, []);

  const marcarBlur = useCallback(() => {
    inputEnFocoRef.current = false;
    setInputEnFoco(false);
  }, []);

  return { inputEnFocoRef, inputEnFoco, marcarFoco, marcarBlur };
}

/**
 * Teclado tipo combobox ERP para dropdowns del registro masivo (solo web):
 * Tab/Shift+Tab mueven el resaltado, Enter confirma y avanza, Escape cierra.
 */
export function useDropdownTecladoRegistroMasivo<T>(opts: {
  activo: boolean;
  /** Ref síncrona de foco; evita perder Tab/Enter antes de abrir el dropdown. */
  activoRef?: React.MutableRefObject<boolean>;
  lista: T[];
  focusedIndex: number;
  setFocusedIndex: React.Dispatch<React.SetStateAction<number>>;
  onSeleccionar: (item: T) => void;
  onCerrar: () => void;
  avanzarFoco: (delta: 1 | -1) => boolean;
  onKeyDownCadena?: (e: DropdownTecladoKeyEvent) => void;
  omitirBlurCierreRef?: React.MutableRefObject<boolean>;
}) {
  const {
    activo,
    activoRef,
    lista,
    focusedIndex,
    setFocusedIndex,
    onSeleccionar,
    onCerrar,
    avanzarFoco,
    onKeyDownCadena,
    omitirBlurCierreRef,
  } = opts;

  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;

  const tecladoActivo = useCallback(() => {
    const conFoco = activoRef?.current ?? activo;
    return conFoco && Platform.OS === 'web' && lista.length > 0;
  }, [activo, activoRef, lista.length]);

  const seleccionarYAvanzar = useCallback(
    (item: T) => {
      if (omitirBlurCierreRef) omitirBlurCierreRef.current = true;
      onSeleccionar(item);
      requestAnimationFrame(() => {
        avanzarFoco(1);
        setTimeout(() => {
          if (omitirBlurCierreRef) omitirBlurCierreRef.current = false;
        }, 200);
      });
    },
    [onSeleccionar, avanzarFoco, omitirBlurCierreRef],
  );

  const tecladoActivoRef = useRef(tecladoActivo);
  tecladoActivoRef.current = tecladoActivo;

  const manejarTecla = useCallback(
    (e: DropdownTecladoKeyEvent): boolean => {
      const { key, shift } = leerTecla(e);

      if (tecladoActivo()) {
        if (key === 'ArrowDown' || (key === 'Tab' && !shift)) {
          e.preventDefault?.();
          e.stopPropagation?.();
          setFocusedIndex((i) => {
            const next = Math.min(i + 1, lista.length - 1);
            focusedIndexRef.current = next;
            return next;
          });
          return true;
        }
        if (key === 'ArrowUp' || (key === 'Tab' && shift)) {
          e.preventDefault?.();
          e.stopPropagation?.();
          setFocusedIndex((i) => {
            const next = Math.max(i - 1, 0);
            focusedIndexRef.current = next;
            return next;
          });
          return true;
        }
        if (key === 'Enter' && !shift) {
          e.preventDefault?.();
          e.stopPropagation?.();
          seleccionarYAvanzar(lista[indiceSeguro(focusedIndexRef.current, lista.length)]);
          return true;
        }
        if (key === 'Escape') {
          e.preventDefault?.();
          e.stopPropagation?.();
          onCerrar();
          return true;
        }
      }

      onKeyDownCadena?.(e);
      return false;
    },
    [
      tecladoActivo,
      lista,
      setFocusedIndex,
      seleccionarYAvanzar,
      onCerrar,
      onKeyDownCadena,
    ],
  );

  const manejarTeclaRef = useRef(manejarTecla);
  manejarTeclaRef.current = manejarTecla;

  /** RN Web no entrega Tab al TextInput; captura en window antes del navegador. */
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const teclasDropdown = new Set(['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown']);

    const handler = (e: KeyboardEvent) => {
      if (!tecladoActivoRef.current()) return;
      if (!teclasDropdown.has(e.key)) return;
      manejarTeclaRef.current({
        key: e.key,
        shiftKey: e.shiftKey,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
      });
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const onKeyDown = useCallback(
    (e: DropdownTecladoKeyEvent) => {
      manejarTecla(e);
    },
    [manejarTecla],
  );

  const onKeyPress = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (Platform.OS !== 'web' || !tecladoActivo()) return;
      const key = e.nativeEvent?.key ?? '';
      if (key !== 'Tab') return;
      e.preventDefault?.();
      manejarTecla({
        nativeEvent: { key: 'Tab', shiftKey: false },
        preventDefault: () => e.preventDefault?.(),
        stopPropagation: () => e.stopPropagation?.(),
      });
    },
    [tecladoActivo, manejarTecla],
  );

  const webTecladoInputProps =
    Platform.OS === 'web'
      ? ({
          onKeyDown: onKeyDown as (e: unknown) => void,
          onKeyPress,
        } as const)
      : {};

  return { onKeyDown, onKeyPress, webTecladoInputProps };
}

/** Desplaza la fila resaltada dentro del ScrollView del dropdown (web). */
export function useDropdownScrollToIndex(focusedIndex: number, activo: boolean) {
  const scrollRef = useRef<ScrollView>(null);
  const itemRefs = useRef<(View | null)[]>([]);

  useEffect(() => {
    if (!activo || Platform.OS !== 'web') return;
    const node = itemRefs.current[focusedIndex] as unknown as {
      scrollIntoView?: (opts?: ScrollIntoViewOptions) => void;
    };
    node?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [focusedIndex, activo]);

  const setItemRef = useCallback((index: number) => (el: View | null) => {
    itemRefs.current[index] = el;
  }, []);

  return { scrollRef, setItemRef };
}

export const dropdownItemResaltadoStyle = {
  backgroundColor: '#e0f2fe',
  borderLeftWidth: 3,
  borderLeftColor: '#0ea5e9',
} as const;

export const dropdownItemResaltadoTextStyle = {
  color: '#0369a1',
  fontWeight: '700' as const,
};
