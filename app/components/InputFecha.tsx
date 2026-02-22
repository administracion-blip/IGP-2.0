/**
 * InputFecha: campo de fecha con selector de calendario.
 * - Web: TextInput para escribir (evita bug del año en input type="date") + icono abre calendario.
 * - iOS/Android: TextInput para escribir + icono abre DateTimePicker.
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { MaterialIcons } from '@expo/vector-icons';

export type InputFechaFormat = 'iso' | 'dmy';

function toIso(value: string, format: InputFechaFormat): string | null {
  const s = value.trim();
  if (!s) return null;
  if (format === 'iso' && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (format === 'dmy') {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
    if (m) {
      const d = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      let y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  return null;
}

function fromIso(iso: string, format: InputFechaFormat): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  if (format === 'dmy') {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
  return iso;
}

export type InputFechaProps = {
  value: string;
  onChange: (value: string) => void;
  format?: InputFechaFormat;
  placeholder?: string;
  style?: object;
  editable?: boolean;
  placeholderTextColor?: string;
};

export function InputFecha({
  value,
  onChange,
  format = 'iso',
  placeholder,
  style,
  editable = true,
  placeholderTextColor = '#94a3b8',
}: InputFechaProps) {
  const [showPicker, setShowPicker] = useState(false);
  const webDateInputRef = useRef<HTMLInputElement>(null);

  const isoValue = toIso(value, format) ?? '';
  const dateValue = isoValue
    ? (() => {
        const [y, m, d] = isoValue.split('-').map(Number);
        return new Date(y, m - 1, d);
      })()
    : new Date();

  const handleSelect = useCallback(
    (_ev: unknown, selectedDate?: Date) => {
      if (Platform.OS === 'android') setShowPicker(false);
      if (selectedDate) {
        const y = selectedDate.getFullYear();
        const m = String(selectedDate.getMonth() + 1).padStart(2, '0');
        const d = String(selectedDate.getDate()).padStart(2, '0');
        const iso = `${y}-${m}-${d}`;
        onChange(fromIso(iso, format));
      }
    },
    [format, onChange]
  );

  const handleWebChange = useCallback(
    (e: { target: { value: string } }) => {
      const v = e.target.value;
      onChange(v ? (format === 'dmy' ? fromIso(v, format) : v) : '');
    },
    [format, onChange]
  );

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.wrap, styles.webInputRow]}>
        <TextInput
          style={[styles.inputBase, style ?? styles.inputDefault, styles.webInputField]}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={placeholderTextColor}
          editable={editable}
        />
        <TouchableOpacity
          style={styles.webIconBtn}
          onPress={() => {
            if (!editable) return;
            const input = webDateInputRef.current;
            if (input) {
              try {
                if ('showPicker' in input) (input as HTMLInputElement & { showPicker: () => void }).showPicker();
                else input.click();
              } catch {
                input.click();
              }
            }
          }}
          disabled={!editable}
        >
          <MaterialIcons name="calendar-today" size={18} color="#64748b" />
        </TouchableOpacity>
        <input
          ref={webDateInputRef}
          type="date"
          value={isoValue}
          onChange={handleWebChange}
          disabled={!editable}
          tabIndex={-1}
          style={styles.webDateInputHidden}
          title="Seleccionar fecha"
          aria-hidden
        />
      </View>
    );
  }

  const inputStyle = [styles.inputBase, style ?? styles.inputDefault];
  return (
    <View style={styles.wrap}>
      <TextInput
        style={inputStyle}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        editable={editable}
      />
      <TouchableOpacity
        style={styles.iconBtn}
        onPress={() => editable && setShowPicker(true)}
        disabled={!editable}
      >
        <MaterialIcons name="calendar-today" size={14} color="#64748b" />
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
              <TouchableOpacity
                style={styles.closeBtn}
                onPress={() => setShowPicker(false)}
              >
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
  webInputRow: {
    minWidth: 130,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    borderRadius: 4,
    backgroundColor: '#fff',
    overflow: 'hidden',
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
  },
  webIconWrap: {
    position: 'absolute',
    right: 4,
    top: 0,
    bottom: 0,
    width: 36,
    minWidth: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  webIconBtn: {
    width: 32,
    minWidth: 32,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'stretch',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: '#e5e7eb',
  },
  webDateInputHidden: {
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
