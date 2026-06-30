/**
 * Campo de fecha estándar del proyecto.
 * - Visible: dd/mm/aaaa. En código/API preferir yyyy-mm-dd (ISO).
 * - Un toque abre el calendario (web: input type=date; móvil: DateTimePicker).
 * - Pulsación larga o doble toque → edición manual escribiendo (confirma en onBlur).
 * - Calendario opcional vía showCalendar=false (vuelve a edición manual directa).
 */
import React, { useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  TouchableOpacity,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  type TextInputProps,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { MaterialIcons } from '@expo/vector-icons';
import { FechaInputDmy } from './FechaInputDmy';
import {
  type FechaInputFormat,
  isoDesdeValor,
  valorDesdeIso,
} from '../utils/fechaInput';
import { MIN_TOUCH } from '../constants/layout';

export type { FechaInputFormat as InputFechaFormat };

type InputFechaStyleProps = {
  placeholder?: string;
  style?: object;
  editable?: boolean;
  placeholderTextColor?: string;
  showCalendar?: boolean;
};

/** API preferida: estado del padre en ISO yyyy-mm-dd. */
export type InputFechaIsoProps = InputFechaStyleProps &
  Omit<TextInputProps, 'value' | 'onChangeText' | 'style'> & {
    valueIso: string;
    onChangeIso: (iso: string) => void;
    value?: never;
    onChange?: never;
    format?: never;
  };

/** Compatibilidad: estado del padre en ISO o DMY según format. */
export type InputFechaLegacyProps = InputFechaStyleProps & {
  value: string;
  onChange: (value: string) => void;
  format?: FechaInputFormat;
  valueIso?: never;
  onChangeIso?: never;
};

export type InputFechaProps = InputFechaIsoProps | InputFechaLegacyProps;

function isoADate(iso: string): Date {
  if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

function abrirPickerNativo(input: HTMLInputElement) {
  const el = input as HTMLInputElement & { showPicker?: () => void };
  try {
    if (typeof el.showPicker === 'function') el.showPicker();
    else el.click();
  } catch {
    el.click();
  }
}

export function InputFecha(props: InputFechaProps) {
  const {
    placeholder = 'dd/mm/aaaa',
    style,
    editable = true,
    placeholderTextColor = '#94a3b8',
    showCalendar = true,
  } = props;

  const format: FechaInputFormat =
    'format' in props && props.format ? props.format : 'iso';

  const parentValue =
    'valueIso' in props && props.valueIso !== undefined ? props.valueIso : props.value;

  const valueIso = useMemo(
    () =>
      'valueIso' in props && props.valueIso !== undefined
        ? props.valueIso
        : isoDesdeValor(parentValue, format),
    [parentValue, format],
  );

  const onChangeIsoProp = 'onChangeIso' in props ? props.onChangeIso : undefined;
  const onChangeLegacy = 'onChange' in props ? props.onChange : undefined;

  const handleChangeIso = useCallback(
    (iso: string) => {
      if (onChangeIsoProp) {
        onChangeIsoProp(iso);
      } else if (onChangeLegacy) {
        onChangeLegacy(valorDesdeIso(iso, format));
      }
    },
    [onChangeIsoProp, onChangeLegacy, format],
  );

  const [showPicker, setShowPicker] = useState(false);
  const [modoEdicion, setModoEdicion] = useState(false);
  const webDateInputRef = useRef<HTMLInputElement>(null);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dateValue = isoADate(valueIso);

  const fieldStyle = showCalendar
    ? Platform.OS === 'web'
      ? [styles.inputBase, style, styles.webInputField, { borderWidth: 0 }]
      : [styles.inputBase, style ?? styles.inputDefault]
    : (style ?? styles.inputDefault);

  const abrirCalendario = useCallback(() => {
    if (!editable) return;
    if (Platform.OS === 'web') {
      const input = webDateInputRef.current;
      if (!input) return;
      abrirPickerNativo(input);
    } else {
      setShowPicker(true);
    }
  }, [editable]);

  /** Doble toque o pulsación larga: pasar a edición manual escribiendo. */
  const entrarEdicion = useCallback(() => {
    if (!editable) return;
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
    setModoEdicion(true);
  }, [editable]);

  /** Un toque abre calendario; un segundo toque rápido entra en edición manual (nativo). */
  const manejarTap = useCallback(() => {
    if (!editable) return;
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
      setModoEdicion(true);
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      abrirCalendario();
    }, 230);
  }, [editable, abrirCalendario]);

  const salirEdicion = useCallback(() => {
    setModoEdicion(false);
  }, []);

  const handleSelect = useCallback(
    (_ev: unknown, selectedDate?: Date) => {
      if (Platform.OS === 'android') setShowPicker(false);
      if (selectedDate) {
        const y = selectedDate.getFullYear();
        const m = String(selectedDate.getMonth() + 1).padStart(2, '0');
        const d = String(selectedDate.getDate()).padStart(2, '0');
        handleChangeIso(`${y}-${m}-${d}`);
      }
    },
    [handleChangeIso],
  );

  const handleWebCalendarChange = useCallback(
    (e: { target: { value: string } }) => {
      handleChangeIso(e.target.value || '');
    },
    [handleChangeIso],
  );

  const handleWebInputDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      e.preventDefault();
      e.stopPropagation();
      entrarEdicion();
    },
    [entrarEdicion],
  );

  // Campo en edición manual: TextInput editable enfocado; al perder foco vuelve a display.
  const campoEditable = (
    <FechaInputDmy
      autoFocus
      valueIso={valueIso}
      onChangeIso={handleChangeIso}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      editable={editable}
      onBlur={salirEdicion}
      style={fieldStyle}
    />
  );

  // Campo en modo display: muestra la fecha y delega el toque al Pressable (nativo).
  const campoDisplay = (
    <Pressable
      style={styles.displayPress}
      onPress={manejarTap}
      onLongPress={entrarEdicion}
      delayLongPress={300}
      disabled={!editable}
    >
      <FechaInputDmy
        valueIso={valueIso}
        onChangeIso={handleChangeIso}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        editable={false}
        style={[...(Array.isArray(fieldStyle) ? fieldStyle : [fieldStyle]), styles.noPointer]}
      />
    </Pressable>
  );

  const campo = modoEdicion ? campoEditable : campoDisplay;

  // Sin calendario: comportamiento clásico (edición manual directa).
  const fechaInput = (
    <FechaInputDmy
      valueIso={valueIso}
      onChangeIso={handleChangeIso}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      editable={editable}
      style={fieldStyle}
    />
  );

  if (!showCalendar) {
    return fechaInput;
  }

  if (Platform.OS === 'web') {
    const webInputStyle = (
      modoEdicion ? styles.webDateInputPickerOnly : styles.webDateInputOverlay
    ) as React.CSSProperties;

    return (
      <View style={[styles.wrap, styles.webInputRow]}>
        <View style={styles.webFieldWrap}>
          {modoEdicion ? (
            campoEditable
          ) : (
            <FechaInputDmy
              valueIso={valueIso}
              onChangeIso={handleChangeIso}
              placeholder={placeholder}
              placeholderTextColor={placeholderTextColor}
              editable={false}
              style={[...(Array.isArray(fieldStyle) ? fieldStyle : [fieldStyle]), styles.noPointer]}
            />
          )}
          <input
            ref={webDateInputRef}
            type="date"
            value={valueIso}
            onChange={handleWebCalendarChange}
            disabled={!editable}
            style={webInputStyle}
            title={modoEdicion ? undefined : 'Seleccionar fecha (doble clic para escribir)'}
            onDoubleClick={modoEdicion ? undefined : handleWebInputDoubleClick}
            tabIndex={modoEdicion ? -1 : 0}
            aria-hidden={modoEdicion}
            {...(modoEdicion ? { pointerEvents: 'none' as const } : {})}
          />
        </View>
        <TouchableOpacity
          style={styles.webIconBtn}
          onPress={abrirCalendario}
          disabled={!editable}
          accessibilityLabel="Abrir calendario"
        >
          <MaterialIcons name="calendar-today" size={18} color="#64748b" />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {campo}
      <TouchableOpacity
        style={styles.iconBtn}
        onPress={abrirCalendario}
        disabled={!editable}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityLabel="Abrir calendario"
      >
        <MaterialIcons name="calendar-today" size={16} color="#64748b" />
      </TouchableOpacity>
      {showPicker && Platform.OS === 'android' && (
        <DateTimePicker
          value={dateValue}
          mode="date"
          display="default"
          onChange={handleSelect}
        />
      )}
      {showPicker && Platform.OS === 'ios' && (
        <Modal visible transparent animationType="fade">
          <Pressable style={styles.modalOverlay} onPress={() => setShowPicker(false)}>
            <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
              <DateTimePicker
                value={dateValue}
                mode="date"
                display="spinner"
                onChange={handleSelect}
              />
              <TouchableOpacity style={styles.closeBtn} onPress={() => setShowPicker(false)}>
                <MaterialIcons name="check" size={24} color="#0ea5e9" />
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative' as const,
  },
  inputBase: {
    flex: 1,
    paddingRight: 28,
  },
  displayPress: {
    flex: 1,
  },
  noPointer: {
    pointerEvents: 'none',
  },
  webInputRow: {
    minWidth: 130,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    borderRadius: 4,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  webFieldWrap: {
    flex: 1,
    position: 'relative' as const,
    minWidth: 90,
  },
  webInputField: {
    flex: 1,
    borderWidth: 0,
    minWidth: 90,
  },
  inputDefault: {
    fontSize: 12,
    paddingVertical: 3,
    paddingHorizontal: 6,
    minHeight: 24,
    color: '#334155',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
  },
  iconBtn: {
    position: 'absolute',
    right: 4,
    padding: 2,
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    alignItems: 'center',
  },
  webIconBtn: {
    width: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: '#e5e7eb',
  },
  webDateInputOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    opacity: 0,
    cursor: 'pointer',
    zIndex: 2,
    border: 'none',
    background: 'transparent',
    margin: 0,
    padding: 0,
  },
  webDateInputPickerOnly: {
    position: 'absolute',
    left: -9999,
    width: 1,
    height: 1,
    opacity: 0,
    pointerEvents: 'none',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  closeBtn: {
    alignSelf: 'center',
    marginTop: 12,
    padding: 8,
  },
});
