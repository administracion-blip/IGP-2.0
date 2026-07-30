import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { confColor } from '../../lib/registroMasivo';
import { useRegistroMasivoField } from '../../hooks/useRegistroMasivoFocusChain';
import {
  dropdownItemResaltadoStyle,
  dropdownItemResaltadoTextStyle,
  useDropdownScrollToIndex,
  useDropdownTecladoRegistroMasivo,
  useDropdownCampoFoco,
} from '../../hooks/useDropdownTecladoRegistroMasivo';
import type { Borrador, EmpresaCatalogo } from '../../types/registroMasivo';

const btnFueraTabProps =
  Platform.OS === 'web' ? ({ focusable: false, tabIndex: -1 } as object) : {};

/**
 * Campo "Nombre proveedor" con dropdown de búsqueda en el catálogo de
 * empresas y botón de captura por zona OCR.
 *
 * Al cerrar el dropdown (blur, Tab, flecha) se persiste lo tecleado en
 * `onManualChange`, incluida cadena vacía, para permitir alta por CIF nuevo.
 */
export function ProveedorDropdownField({
  borrador,
  empresas,
  onSelect,
  onManualChange,
  onZona,
  zonaActiva,
  focusFieldId = 'proveedor_nombre',
  nombreSugeridoOcr,
  proveedorEnMaestros,
}: {
  borrador: Borrador;
  empresas: EmpresaCatalogo[];
  onSelect: (e: EmpresaCatalogo) => void;
  onManualChange: (v: string) => void;
  onZona: () => void;
  zonaActiva?: boolean;
  focusFieldId?: string;
  /** Nombre detectado por OCR cuando el CIF no está en maestro (solo hint). */
  nombreSugeridoOcr?: string;
  proveedorEnMaestros?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const omitirBlurCierreRef = useRef(false);
  const searchRef = useRef('');
  const { inputEnFocoRef, inputEnFoco, marcarFoco, marcarBlur } = useDropdownCampoFoco();
  const value = borrador.proveedor_nombre || '';
  const conf = borrador.confianza?.proveedor_nombre;
  const focus = useRegistroMasivoField(focusFieldId);

  const syncSearch = useCallback((v: string) => {
    searchRef.current = v;
    setSearch(v);
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return empresas.slice(0, 50);
    return empresas
      .filter((e) => {
        const nom = (e.Nombre || '').toLowerCase();
        const cif = (e.Cif || '').toLowerCase();
        return nom.includes(q) || cif.includes(q);
      })
      .slice(0, 50);
  }, [search, empresas]);

  const dropdownVisible = open || inputEnFoco;
  const dropdownConResultados = dropdownVisible && filtered.length > 0;

  const cerrarDropdown = useCallback(
    (commitSearch = false) => {
      if (commitSearch && open) {
        onManualChange(searchRef.current.trim());
      }
      marcarBlur();
      setOpen(false);
      syncSearch('');
      setFocusedIndex(0);
    },
    [marcarBlur, onManualChange, open, syncSearch],
  );

  const seleccionar = useCallback(
    (e: EmpresaCatalogo) => {
      onSelect(e);
      cerrarDropdown(false);
    },
    [onSelect, cerrarDropdown],
  );

  const { scrollRef, setItemRef } = useDropdownScrollToIndex(focusedIndex, dropdownConResultados);

  const { webTecladoInputProps } = useDropdownTecladoRegistroMasivo({
    activo: dropdownConResultados,
    activoRef: inputEnFocoRef,
    lista: filtered,
    focusedIndex,
    setFocusedIndex,
    onSeleccionar: seleccionar,
    onCerrar: () => cerrarDropdown(true),
    avanzarFoco: focus.avanzarFoco,
    onKeyDownCadena: focus.onKeyDown,
    omitirBlurCierreRef,
  });

  const hintOcr =
    !proveedorEnMaestros && !value.trim() && (nombreSugeridoOcr || borrador.nombre_sugerido_ocr || '').trim()
      ? (nombreSugeridoOcr || borrador.nombre_sugerido_ocr || '').trim()
      : '';

  return (
    <View style={[styles.fieldRowWrap, { zIndex: 100 }]}>
      <View style={[styles.fieldRow, { zIndex: 100 }]}>
        <View style={styles.fieldLabelWrap}>
          <Text style={styles.fieldLabel}>Nombre proveedor</Text>
          {conf && <View style={[styles.confDot, { backgroundColor: confColor(conf) }]} />}
        </View>
        <View style={{ flex: 1, position: 'relative' as const, zIndex: 100 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <TextInput
              ref={focus.ref}
              style={[styles.fieldInput, { flex: 1 }]}
              value={open ? search : value}
              onChangeText={(v) => {
                if (open) {
                  syncSearch(v);
                  setFocusedIndex(0);
                } else {
                  onManualChange(v);
                }
              }}
              onFocus={() => {
                marcarFoco();
                focus.onFocus?.();
                syncSearch(value);
                setOpen(true);
                setFocusedIndex(0);
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (omitirBlurCierreRef.current) return;
                  cerrarDropdown(true);
                }, 150);
              }}
              {...webTecladoInputProps}
              placeholder="Buscar o dejar vacío si das de alta por CIF…"
              placeholderTextColor="#94a3b8"
            />
            <TouchableOpacity
              onPress={() => {
                if (open) {
                  cerrarDropdown(true);
                } else {
                  syncSearch(value);
                  setOpen(true);
                  setFocusedIndex(0);
                }
              }}
              style={{ padding: 4 }}
              {...btnFueraTabProps}
            >
              <MaterialIcons name={open ? 'arrow-drop-up' : 'arrow-drop-down'} size={22} color="#64748b" />
            </TouchableOpacity>
            {value.trim() ? (
              <TouchableOpacity
                onPress={() => {
                  onManualChange('');
                  syncSearch('');
                  setOpen(false);
                }}
                style={styles.clearBtn}
                accessibilityLabel="Vaciar nombre proveedor"
                {...btnFueraTabProps}
              >
                <MaterialIcons name="close" size={16} color="#64748b" />
              </TouchableOpacity>
            ) : null}
          </View>
          {dropdownVisible && (
            <View style={styles.dropdown}>
              <ScrollView
                ref={scrollRef}
                style={{ maxHeight: 200 }}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
                {filtered.length === 0 ? (
                  <Text style={styles.empty}>Sin resultados — Tab para siguiente campo</Text>
                ) : (
                  filtered.map((e, i) => {
                    const resaltado = i === focusedIndex;
                    return (
                      <TouchableOpacity
                        key={e.id_empresa ?? e.Cif ?? e.Nombre}
                        ref={setItemRef(i)}
                        style={[styles.item, resaltado && dropdownItemResaltadoStyle]}
                        onPress={() => seleccionar(e)}
                      >
                        <Text
                          style={[styles.itemName, resaltado && dropdownItemResaltadoTextStyle]}
                          numberOfLines={1}
                        >
                          {e.Nombre || '—'}
                        </Text>
                        <Text style={styles.itemCif}>{e.Cif || ''}</Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>
            </View>
          )}
        </View>
        <TouchableOpacity
          onPress={onZona}
          style={[styles.zonaBtn, zonaActiva && styles.zonaBtnActive]}
          activeOpacity={0.7}
          {...btnFueraTabProps}
        >
          <MaterialIcons name="crop-free" size={16} color={zonaActiva ? '#fff' : '#0ea5e9'} />
        </TouchableOpacity>
      </View>
      {hintOcr ? (
        <Text style={styles.hintOcr} numberOfLines={2}>
          Sugerido OCR (alta en maestro): {hintOcr}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldRowWrap: { gap: 2, minWidth: 280 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fieldLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 3, width: 110 },
  fieldLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  confDot: { width: 7, height: 7, borderRadius: 4 },
  fieldInput: {
    flex: 1,
    fontSize: 12,
    color: '#334155',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#f8fafc',
  },
  clearBtn: {
    padding: 4,
    borderRadius: 4,
    backgroundColor: '#f1f5f9',
  },
  hintOcr: {
    marginLeft: 116,
    fontSize: 10,
    color: '#b45309',
    lineHeight: 14,
    fontStyle: 'italic',
  },
  zonaBtn: {
    width: 26,
    height: 26,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zonaBtnActive: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0369a1',
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    marginTop: 2,
    zIndex: 999,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
  },
  item: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  itemName: { fontSize: 13, color: '#1e293b', flex: 1 },
  itemCif: { fontSize: 11, color: '#64748b', fontFamily: 'monospace' },
  empty: { padding: 12, fontSize: 12, color: '#94a3b8', textAlign: 'center' },
});
