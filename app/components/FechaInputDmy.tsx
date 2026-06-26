/**
 * Núcleo del campo de fecha: visible dd/mm/aaaa, valor yyyy-mm-dd (ISO).
 * Solo confirma al padre en onBlur para no resetear el cursor al escribir rápido.
 * En pantallas usar InputFecha (incluye calendario opcional).
 */
import React, { useState, useEffect, useRef } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { isoValidoDesdeDmy, isoADisplay } from '../utils/fechaInput';

export type FechaInputDmyProps = Omit<TextInputProps, 'value' | 'onChangeText'> & {
  valueIso: string;
  onChangeIso: (iso: string) => void;
};

export function FechaInputDmy({
  valueIso,
  onChangeIso,
  placeholder = 'dd/mm/aaaa',
  onBlur,
  onFocus,
  ...rest
}: FechaInputDmyProps) {
  const [text, setText] = useState('');
  const focusedRef = useRef(false);
  const textRef = useRef('');

  useEffect(() => {
    if (focusedRef.current) return;
    const display = isoADisplay(valueIso);
    setText(display);
    textRef.current = display;
  }, [valueIso]);

  return (
    <TextInput
      {...rest}
      value={text}
      placeholder={placeholder}
      placeholderTextColor={rest.placeholderTextColor ?? '#94a3b8'}
      onChangeText={(t) => {
        textRef.current = t;
        setText(t);
      }}
      onFocus={(e) => {
        focusedRef.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        const s = textRef.current.trim();
        if (s === '') {
          onChangeIso('');
          setText('');
          textRef.current = '';
        } else {
          const iso = isoValidoDesdeDmy(s);
          if (iso) {
            onChangeIso(iso);
            const display = isoADisplay(iso);
            setText(display);
            textRef.current = display;
          } else {
            const display = isoADisplay(valueIso);
            setText(display);
            textRef.current = display;
          }
        }
        onBlur?.(e);
      }}
    />
  );
}
