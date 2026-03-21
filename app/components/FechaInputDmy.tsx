/**
 * Campo de fecha visible en dd/mm/aaaa; el valor en código es yyyy-mm-dd (ISO).
 */
import React, { useState, useEffect } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { formatFecha, fechaToIso } from '../utils/formatFecha';

export type FechaInputDmyProps = Omit<TextInputProps, 'value' | 'onChangeText'> & {
  valueIso: string;
  onChangeIso: (iso: string) => void;
};

export function FechaInputDmy({
  valueIso,
  onChangeIso,
  placeholder = 'dd/mm/aaaa',
  onBlur,
  ...rest
}: FechaInputDmyProps) {
  const [text, setText] = useState('');

  useEffect(() => {
    setText(valueIso && /^\d{4}-\d{2}-\d{2}$/.test(valueIso) ? formatFecha(valueIso) : '');
  }, [valueIso]);

  return (
    <TextInput
      {...rest}
      value={text}
      placeholder={placeholder}
      placeholderTextColor={rest.placeholderTextColor ?? '#94a3b8'}
      onChangeText={(t) => {
        setText(t);
        const iso = fechaToIso(t);
        if (t.trim() === '') onChangeIso('');
        else if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) onChangeIso(iso);
      }}
      onBlur={(e) => {
        const s = text.trim();
        if (s === '') {
          onChangeIso('');
        } else {
          const iso = fechaToIso(s);
          if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
            onChangeIso(iso);
            setText(formatFecha(iso));
          } else {
            setText(valueIso && /^\d{4}-\d{2}-\d{2}$/.test(valueIso) ? formatFecha(valueIso) : '');
          }
        }
        onBlur?.(e);
      }}
    />
  );
}
