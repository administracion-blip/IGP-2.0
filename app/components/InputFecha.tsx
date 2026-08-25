/**
 * Campo de fecha estándar del proyecto.
 * - Visible: dd/mm/aaaa. En código/API preferir yyyy-mm-dd (ISO).
 * - Un toque abre el calendario (web: input type=date; móvil: DateTimePicker).
 * - Pulsación larga o doble toque → edición manual escribiendo (confirma en onBlur).
 * - Calendario opcional vía showCalendar=false (vuelve a edición manual directa).
 */
import React, { useState, useCallback, useRef, useMemo, type Ref } from 'react';
import {
  View,
  TouchableOpacity,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
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
  /** Altura fija (~32px) con texto e icono centrados; para toolbars y filtros compactos. */
  compact?: boolean;
  /** Trigger tipo toolbar (texto + chevron, sin icono calendario ni divisor). */
  modoToolbar?: boolean;
  /** ISO yyyy-mm-dd: límite máximo del calendario (web `max` / nativo `maximumDate`). */
  maxIso?: string;
  /** ISO yyyy-mm-dd: límite mínimo del calendario (web `min` / nativo `minimumDate`). */
  minIso?: string;
};

/** API preferida: estado del padre en ISO yyyy-mm-dd. */
export type InputFechaIsoProps = InputFechaStyleProps &
  Omit<TextInputProps, 'value' | 'onChangeText' | 'style'> & {
    valueIso: string;
    onChangeIso: (iso: string) => void;
    /** Ref al TextInput interno (p. ej. cadena Tab del registro masivo). */
    inputRef?: Ref<TextInput>;
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

const COMPACT_HEIGHT_DEFAULT = 32;

export function InputFecha(props: InputFechaProps) {
  const {
    placeholder = 'dd/mm/aaaa',
    style,
    editable = true,
    placeholderTextColor = '#94a3b8',
    showCalendar = true,
    compact = false,
    modoToolbar = false,
    maxIso,
    minIso,
    onFocus,
    onKeyDown,
    ...textInputRest
  } = props;

  const maximumDate = maxIso && /^\d{4}-\d{2}-\d{2}$/.test(maxIso) ? isoADate(maxIso) : undefined;
  const minimumDate = minIso && /^\d{4}-\d{2}-\d{2}$/.test(minIso) ? isoADate(minIso) : undefined;

  const inputRef = 'inputRef' in props ? props.inputRef : undefined;

  const compactHeight = useMemo(() => {
    if (!compact) return COMPACT_HEIGHT_DEFAULT;
    const h = (style as { height?: number } | undefined)?.height;
    return typeof h === 'number' && h > 0 ? h : COMPACT_HEIGHT_DEFAULT;
  }, [compact, style]);

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

  /** En formularios, el `style` del padre define borde/radio/alto del contenedor (coherente con otros campos). */
  const containerFromStyle = useMemo((): StyleProp<ViewStyle> | null => {
    if (compact || !style || Platform.OS !== 'web') return null;
    const f = StyleSheet.flatten(style);
    if (!f) return null;
    const out: ViewStyle = {};
    if (f.backgroundColor != null) out.backgroundColor = f.backgroundColor;
    if (f.borderWidth != null) out.borderWidth = f.borderWidth;
    if (f.borderColor != null) out.borderColor = f.borderColor;
    if (f.borderRadius != null) out.borderRadius = f.borderRadius;
    if (f.minHeight != null) out.minHeight = f.minHeight;
    if (f.height != null) out.height = f.height;
    return Object.keys(out).length ? out : null;
  }, [style, compact]);

  const wrapFormStyle = !compact ? ({ flex: 1, width: '100%', minWidth: 0 } as const) : null;

  const compactFieldStyle = compact
    ? {
        flex: 1,
        borderWidth: 0,
        paddingVertical: 0,
        paddingHorizontal: 8,
        paddingRight: 4,
        fontSize: (style as { fontSize?: number } | undefined)?.fontSize ?? 12,
        color: '#334155',
        textAlignVertical: 'center' as const,
        backgroundColor: 'transparent',
        minHeight: compactHeight,
        height: compactHeight,
        ...(Platform.OS === 'web'
          ? ({ lineHeight: `${compactHeight}px` } as object)
          : { lineHeight: compactHeight }),
      }
    : undefined;

  const fieldStyle = showCalendar
    ? Platform.OS === 'web'
      ? compact
        ? [styles.inputBase, compactFieldStyle]
        : [styles.inputBase, style, styles.webInputField, { borderWidth: 0 }]
      : compact
        ? [styles.inputBase, compactFieldStyle]
        : [styles.inputBase, style ?? styles.inputDefault]
    : compact
      ? [compactFieldStyle, style]
      : (style ?? styles.inputDefault);

  const wrapToolbarStyle = compact && modoToolbar ? styles.wrapToolbar : null;
  const compactHeightFinal = compact && modoToolbar ? 34 : compactHeight;

  const wrapCompactStyle = compact
    ? [styles.wrapCompact, wrapToolbarStyle, style, { height: compactHeightFinal, minHeight: compactHeightFinal }]
    : null;

  const iconBtnStyle = compact ? (modoToolbar ? styles.toolbarIconBtn : styles.iconBtnCompact) : styles.iconBtn;
  const webIconBtnStyle = compact ? (modoToolbar ? styles.toolbarIconBtn : styles.webIconBtnCompact) : styles.webIconBtn;

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
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      style={fieldStyle}
      {...textInputRest}
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
      ref={inputRef}
      valueIso={valueIso}
      onChangeIso={handleChangeIso}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      editable={editable}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      style={fieldStyle}
      {...textInputRest}
    />
  );

  if (!showCalendar) {
    return fechaInput;
  }

  if (Platform.OS === 'web') {
    const webInputStyle = (
      modoEdicion ? styles.webDateInputPickerOnly : styles.webDateInputOverlay
    ) as React.CSSProperties;

    if (compact && modoToolbar) {
      return (
        <View style={[styles.wrap, styles.wrapToolbar, style]}>
          <View style={[styles.webFieldWrap, styles.webFieldWrapCompact, styles.toolbarFieldWrap]}>
            <FechaInputDmy
              valueIso={valueIso}
              onChangeIso={handleChangeIso}
              placeholder={placeholder}
              placeholderTextColor={placeholderTextColor}
              editable={editable}
              style={styles.toolbarInput}
            />
          </View>
          <TouchableOpacity
            style={styles.toolbarIconBtn}
            onPress={abrirCalendario}
            disabled={!editable}
            accessibilityLabel="Abrir calendario"
          >
            <MaterialIcons name="calendar-today" size={18} color="#64748b" />
          </TouchableOpacity>
          <input
            ref={webDateInputRef}
            type="date"
            value={valueIso}
            onChange={handleWebCalendarChange}
            disabled={!editable}
            max={maxIso || undefined}
            min={minIso || undefined}
            style={styles.webDateInputToolbarHidden as React.CSSProperties}
            tabIndex={-1}
            aria-hidden
          />
        </View>
      );
    }

    return (
      <View
        style={
          compact
            ? [styles.wrap, ...(wrapCompactStyle ?? [])]
            : [styles.wrap, styles.webInputRow, containerFromStyle, wrapFormStyle]
        }
      >
        <View style={[styles.webFieldWrap, compact && styles.webFieldWrapCompact]}>
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
            max={maxIso || undefined}
            min={minIso || undefined}
            style={webInputStyle}
            title={modoEdicion ? undefined : 'Seleccionar fecha (doble clic para escribir)'}
            onDoubleClick={modoEdicion ? undefined : handleWebInputDoubleClick}
            tabIndex={modoEdicion ? -1 : 0}
            aria-hidden={modoEdicion}
            {...(modoEdicion ? { pointerEvents: 'none' as const } : {})}
          />
        </View>
        <TouchableOpacity
          style={webIconBtnStyle}
          onPress={abrirCalendario}
          disabled={!editable}
          accessibilityLabel="Abrir calendario"
        >
          <MaterialIcons name="calendar-today" size={compact ? 16 : 18} color="#64748b" />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={compact ? [styles.wrap, ...(wrapCompactStyle ?? [])] : [styles.wrap, containerFromStyle, wrapFormStyle]}>
      {compact ? (
        <View style={styles.compactFieldOuter}>
          {modoToolbar ? (
            <FechaInputDmy
              valueIso={valueIso}
              onChangeIso={handleChangeIso}
              placeholder={placeholder}
              placeholderTextColor={placeholderTextColor}
              editable={editable}
              style={styles.toolbarInput}
            />
          ) : (
            campo
          )}
        </View>
      ) : (
        campo
      )}
      <TouchableOpacity
        style={iconBtnStyle}
        onPress={abrirCalendario}
        disabled={!editable}
        hitSlop={compact ? { top: 4, bottom: 4, left: 4, right: 4 } : { top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityLabel="Abrir calendario"
      >
        <MaterialIcons name="calendar-today" size={modoToolbar ? 18 : 16} color="#64748b" />
      </TouchableOpacity>
      {showPicker && Platform.OS === 'android' && (
        <DateTimePicker
          value={dateValue}
          mode="date"
          display="default"
          onChange={handleSelect}
          {...(maximumDate ? { maximumDate } : {})}
          {...(minimumDate ? { minimumDate } : {})}
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
                {...(maximumDate ? { maximumDate } : {})}
                {...(minimumDate ? { minimumDate } : {})}
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
  wrapCompact: {
    overflow: 'hidden',
    alignItems: 'center',
    width: '100%',
  },
  compactFieldOuter: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
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
  webFieldWrapCompact: {
    justifyContent: 'center',
    alignSelf: 'stretch',
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
  iconBtnCompact: {
    width: 28,
    height: 28,
    minWidth: 28,
    minHeight: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 2,
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
  webIconBtnCompact: {
    width: 28,
    height: 28,
    minWidth: 28,
    minHeight: 28,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: '#e2e8f0',
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
  wrapToolbar: {
    width: '100%' as unknown as number,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    minHeight: 34,
    height: 34,
    overflow: 'hidden',
    alignItems: 'center',
  },
  toolbarFieldWrap: { flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center' },
  toolbarInput: {
    flex: 1,
    width: '100%' as unknown as number,
    minWidth: 0,
    borderWidth: 0,
    paddingVertical: 0,
    paddingHorizontal: 8,
    paddingRight: 2,
    fontSize: 12,
    color: '#334155',
    backgroundColor: 'transparent',
    minHeight: 32,
    height: 32,
    ...(Platform.OS === 'web'
      ? ({ lineHeight: '32px', outlineStyle: 'none' } as object)
      : { lineHeight: 32 }),
  },
  toolbarIconBtn: {
    width: 28,
    height: 28,
    minWidth: 28,
    minHeight: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 2,
    flexShrink: 0,
  },
  webDateInputToolbarHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
  },
});
