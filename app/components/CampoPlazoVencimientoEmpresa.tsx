import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { SelectorDesplegable, type OpcionDesplegable } from './SelectorDesplegable';
import {
  PLAZOS_VENCIMIENTO,
  PLAZO_MAX_DIAS,
  etiquetaPlazo,
  parseDiasPlazo,
} from '../utils/plazoVencimiento';

const ID_SIN_PLAZO = 'sin';
const ID_OTRO = 'otro';

const OPCIONES: OpcionDesplegable[] = [
  { id: ID_SIN_PLAZO, titulo: 'Sin plazo', subtitulo: 'Se fija el vencimiento a mano en cada factura' },
  ...PLAZOS_VENCIMIENTO.map((n) => ({ id: String(n), titulo: etiquetaPlazo(n) })),
  { id: ID_OTRO, titulo: 'Otro…', subtitulo: 'Indica los días (0–365)' },
];

type Props = {
  /** Valor del formulario: '' (sin plazo), días como texto ('30') o texto antiguo no reconocido. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputStyle?: StyleProp<ViewStyle>;
  otroInputStyle?: StyleProp<TextStyle>;
};

/**
 * Plazo de vencimiento del maestro igp_Empresas (días desde fecha de factura; 0 = contado).
 * El formulario guarda los días como texto; quien guarda lo convierte a Number.
 */
export function CampoPlazoVencimientoEmpresa({ value, onChange, disabled = false, inputStyle, otroInputStyle }: Props) {
  const texto = String(value ?? '').trim();
  const dias = useMemo(() => parseDiasPlazo(texto), [texto]);
  const noReconocido = !!texto && dias == null;
  const esPredefinido = dias != null && (PLAZOS_VENCIMIENTO as readonly number[]).includes(dias);

  const [modoOtro, setModoOtro] = useState(() => dias != null && !esPredefinido);
  const [otroTexto, setOtroTexto] = useState(() => (dias != null && !esPredefinido ? String(dias) : ''));
  /** Último valor enviado por el propio campo: en «Otro…» se emite '' o un valor de la lista sin salir del modo. */
  const ultimoEmitido = useRef<string | null>(null);

  const emitir = (v: string) => {
    ultimoEmitido.current = v;
    onChange(v);
  };

  useEffect(() => {
    if (ultimoEmitido.current === texto) return;
    ultimoEmitido.current = null;
    const otro = dias != null && !esPredefinido;
    setModoOtro(otro);
    setOtroTexto(otro ? String(dias) : '');
  }, [texto, dias, esPredefinido]);

  const valorId = modoOtro
    ? ID_OTRO
    : dias != null
      ? String(dias)
      : !texto
        ? ID_SIN_PLAZO
        : null;

  const otroInvalido = modoOtro && otroTexto.trim() !== '' && parseDiasPlazo(Number(otroTexto)) == null;

  return (
    <View style={styles.wrap}>
      <SelectorDesplegable
        icono="event"
        placeholder="Elige un plazo…"
        tituloLista="Plazo de vencimiento"
        iconoLista="event"
        opciones={OPCIONES}
        valorId={valorId}
        disabled={disabled}
        onSeleccionar={(id) => {
          if (id === ID_OTRO) {
            setModoOtro(true);
            const n = otroTexto ? parseDiasPlazo(Number(otroTexto)) : null;
            emitir(n != null ? String(n) : '');
            return;
          }
          setModoOtro(false);
          emitir(id === ID_SIN_PLAZO ? '' : id);
        }}
        triggerStyle={[styles.trigger, inputStyle]}
      />
      {noReconocido && !modoOtro ? (
        <Text style={styles.aviso}>
          Valor antiguo no reconocido: «{texto}». Elige un plazo.
        </Text>
      ) : null}
      {modoOtro ? (
        <View style={styles.otroWrap}>
          <Text style={styles.otroLabel}>Días desde fecha de factura</Text>
          <TextInput
            style={[styles.otroInput, otroInputStyle]}
            value={otroTexto}
            onChangeText={(t) => {
              const limpio = t.replace(/[^\d]/g, '').slice(0, 3);
              setOtroTexto(limpio);
              const n = limpio ? parseDiasPlazo(Number(limpio)) : null;
              emitir(n != null ? String(n) : limpio);
            }}
            placeholder="Ej. 40"
            placeholderTextColor="#94a3b8"
            keyboardType="number-pad"
            inputMode="numeric"
            editable={!disabled}
          />
          {otroInvalido ? (
            <Text style={styles.error}>Indica un número de días entre 0 y {PLAZO_MAX_DIAS}.</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  trigger: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  aviso: { fontSize: 11, color: '#d97706', fontWeight: '500' },
  otroWrap: { gap: 4 },
  otroLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  otroInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 13,
    color: '#334155',
  },
  error: { fontSize: 11, color: '#dc2626' },
});
