import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { round2 } from '../../utils/facturacion';

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
}: {
  initial: number;
  placeholder: string;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(initial ? String(initial) : '');
  const prevInitial = useRef(initial);
  useEffect(() => {
    if (prevInitial.current !== initial) {
      prevInitial.current = initial;
      const parsed = parseFloat(text.replace(',', '.'));
      if (initial !== parsed) {
        setText(initial ? String(initial) : '');
      }
    }
  }, [initial]);
  return (
    <TextInput
      style={styles.input}
      value={text}
      onChangeText={setText}
      onBlur={() => {
        const n = parseFloat(text.replace(',', '.')) || 0;
        onCommit(round2(n));
        setText(n ? String(n) : '');
      }}
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
