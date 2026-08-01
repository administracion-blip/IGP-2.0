import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput } from 'react-native';
import { round2 } from '../../utils/facturacion';
import { parseImporteTexto } from '../../lib/registroMasivo';
import { useRegistroMasivoField } from '../../hooks/useRegistroMasivoFocusChain';

/**
 * Input numérico para celdas del desglose fiscal: maneja un buffer de texto
 * mientras el usuario escribe y solo aplica `onCommit` con el número parseado
 * y redondeado al perder el foco. Acepta coma o punto como separador decimal.
 *
 * Cuando el `initial` cambia desde fuera (p. ej. tras un recálculo del total),
 * el buffer interno se sincroniza solo si el valor externo difiere del parseado
 * — así no se pierde lo que el usuario está tecleando si solo cambia otra fila.
 */
export function DesgloseNumInput({
  initial,
  placeholder,
  onCommit,
  focusFieldId,
  desgloseCampo,
}: {
  initial: number;
  placeholder: string;
  onCommit: (n: number) => void;
  /** Id en la cadena Tab/Enter del registro masivo (solo web). */
  focusFieldId?: string;
  /** Marca el input para captura Tab en window (RN Web no entrega Tab al TextInput). */
  desgloseCampo?: string;
}) {
  const [text, setText] = useState(initial ? String(initial) : '');
  const prevInitial = useRef(initial);
  const textRef = useRef(text);
  textRef.current = text;
  const focus = useRegistroMasivoField(focusFieldId);

  const commitNow = useCallback(() => {
    const n = parseImporteTexto(textRef.current);
    onCommit(round2(n));
    const normalized = n ? String(n) : '';
    setText(normalized);
    textRef.current = normalized;
  }, [onCommit]);

  useEffect(() => {
    if (prevInitial.current !== initial) {
      prevInitial.current = initial;
      const parsed = parseImporteTexto(textRef.current);
      if (initial !== parsed) {
        const next = initial ? String(initial) : '';
        setText(next);
        textRef.current = next;
      }
    }
  }, [initial]);

  const onKeyDown = useCallback(
    (e: {
      nativeEvent?: { key?: string; shiftKey?: boolean };
      key?: string;
      shiftKey?: boolean;
      preventDefault?: () => void;
    }) => {
      const key = e.nativeEvent?.key ?? e.key ?? '';
      if (key === 'Enter') commitNow();
      focus.onKeyDown?.(e);
    },
    [commitNow, focus.onKeyDown],
  );

  return (
    <TextInput
      ref={focus.ref}
      style={styles.input}
      value={text}
      onChangeText={setText}
      onBlur={commitNow}
      onFocus={focus.onFocus}
      {...(Platform.OS === 'web' && focusFieldId
        ? { onKeyDown: onKeyDown as (e: unknown) => void }
        : {})}
      {...(Platform.OS === 'web' && desgloseCampo
        ? ({ dataSet: { desgloseCampo } } as object)
        : {})}
      keyboardType="decimal-pad"
      placeholder={placeholder}
      placeholderTextColor="#94a3b8"
    />
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
    fontSize: 13,
    color: '#1e293b',
    backgroundColor: '#fff',
    textAlign: 'right',
    minWidth: 60,
  },
});
