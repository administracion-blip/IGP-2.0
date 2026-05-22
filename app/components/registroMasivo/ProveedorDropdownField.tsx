import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { confColor } from '../../lib/registroMasivo';
import type { Borrador, EmpresaCatalogo } from '../../types/registroMasivo';

/**
 * Campo "Nombre proveedor" con dropdown de búsqueda en el catálogo de
 * empresas y botón de captura por zona OCR.
 *
 * Patrón controlado: cuando el dropdown está abierto, el `value` del input
 * pasa a ser el `search` interno; al cerrar (selección o blur), vuelve al
 * `borrador.proveedor_nombre`. Los cambios manuales se propagan vía
 * `onManualChange` cuando el dropdown está cerrado, y vía `onSelect` cuando
 * el usuario elige una empresa del listado.
 */
export function ProveedorDropdownField({
  borrador,
  empresas,
  onSelect,
  onManualChange,
  onZona,
  zonaActiva,
}: {
  borrador: Borrador;
  empresas: EmpresaCatalogo[];
  onSelect: (e: EmpresaCatalogo) => void;
  onManualChange: (v: string) => void;
  onZona: () => void;
  zonaActiva?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const value = borrador.proveedor_nombre || '';
  const conf = borrador.confianza?.proveedor_nombre;

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return empresas.slice(0, 50);
    return empresas.filter((e) => {
      const nom = (e.Nombre || '').toLowerCase();
      const cif = (e.Cif || '').toLowerCase();
      return nom.includes(q) || cif.includes(q);
    }).slice(0, 50);
  }, [search, empresas]);

  return (
    <View style={[styles.fieldRow, { zIndex: 100 }]}>
      <View style={styles.fieldLabelWrap}>
        <Text style={styles.fieldLabel}>Nombre proveedor</Text>
        {conf && <View style={[styles.confDot, { backgroundColor: confColor(conf) }]} />}
      </View>
      <View style={{ flex: 1, position: 'relative' as const, zIndex: 100 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <TextInput
            style={[styles.fieldInput, { flex: 1 }]}
            value={open ? search : value}
            onChangeText={(v) => {
              if (open) {
                setSearch(v);
              } else {
                onManualChange(v);
              }
            }}
            onFocus={() => {
              setSearch(value);
              setOpen(true);
            }}
            placeholder="Buscar empresa…"
            placeholderTextColor="#94a3b8"
          />
          <TouchableOpacity
            onPress={() => { setSearch(value); setOpen(!open); }}
            style={{ padding: 4 }}
          >
            <MaterialIcons name={open ? 'arrow-drop-up' : 'arrow-drop-down'} size={22} color="#64748b" />
          </TouchableOpacity>
        </View>
        {open && (
          <View style={styles.dropdown}>
            <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {filtered.length === 0 ? (
                <Text style={styles.empty}>Sin resultados</Text>
              ) : (
                filtered.map((e) => (
                  <TouchableOpacity
                    key={e.id_empresa ?? e.Cif ?? e.Nombre}
                    style={styles.item}
                    onPress={() => {
                      onSelect(e);
                      setOpen(false);
                      setSearch('');
                    }}
                  >
                    <Text style={styles.itemName} numberOfLines={1}>{e.Nombre || '—'}</Text>
                    <Text style={styles.itemCif}>{e.Cif || ''}</Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        )}
      </View>
      <TouchableOpacity
        onPress={onZona}
        style={[styles.zonaBtn, zonaActiva && styles.zonaBtnActive]}
        activeOpacity={0.7}
      >
        <MaterialIcons name="crop-free" size={16} color={zonaActiva ? '#fff' : '#0369a1'} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 280 },
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
