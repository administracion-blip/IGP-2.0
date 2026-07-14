import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
  ActivityIndicator,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { OpcionDesplegable } from './SelectorDesplegable';

type IconName = keyof typeof MaterialIcons.glyphMap;

type Props = {
  label?: string;
  placeholder?: string;
  icono?: IconName;
  opciones: OpcionDesplegable[];
  valorIds: string[];
  onChange: (ids: string[]) => void;
  tituloLista?: string;
  iconoLista?: IconName;
  loading?: boolean;
  disabled?: boolean;
  vacioTexto?: string;
  style?: StyleProp<ViewStyle>;
  buscador?: boolean;
  buscadorPlaceholder?: string;
};

/**
 * Selector desplegable con selección múltiple (checkboxes).
 * No cierra al pulsar una opción; usar el botón «Listo» o el overlay.
 */
export function SelectorDesplegableMulti({
  label,
  placeholder = 'Selecciona…',
  icono,
  opciones,
  valorIds,
  onChange,
  tituloLista,
  iconoLista,
  loading,
  disabled,
  vacioTexto = 'No hay opciones disponibles.',
  style,
  buscador,
  buscadorPlaceholder = 'Buscar…',
}: Props) {
  const [open, setOpen] = useState(false);
  const [filtro, setFiltro] = useState('');
  const seleccionSet = useMemo(() => new Set(valorIds), [valorIds]);
  const seleccionadas = useMemo(
    () => opciones.filter((o) => seleccionSet.has(o.id)),
    [opciones, seleccionSet],
  );

  const opcionesFiltradas = useMemo(() => {
    if (!buscador) return opciones;
    const q = filtro.trim().toLowerCase();
    if (!q) return opciones;
    return opciones.filter((o) =>
      `${o.titulo} ${o.subtitulo ?? ''}`.toLowerCase().includes(q),
    );
  }, [buscador, filtro, opciones]);

  const cerrar = () => {
    setOpen(false);
    setFiltro('');
  };

  const toggleOpcion = (id: string) => {
    if (seleccionSet.has(id)) {
      onChange(valorIds.filter((x) => x !== id));
    } else {
      onChange([...valorIds, id]);
    }
  };

  const resumen =
    seleccionadas.length === 0
      ? null
      : seleccionadas.length === 1
        ? seleccionadas[0].titulo
        : `${seleccionadas.length} seleccionados`;

  return (
    <View style={style}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TouchableOpacity
        style={[styles.trigger, open && styles.triggerActive, disabled && styles.triggerDisabled]}
        onPress={() => !disabled && setOpen(true)}
        activeOpacity={0.7}
        disabled={disabled}
      >
        {icono ? (
          <MaterialIcons name={icono} size={16} color={seleccionadas.length > 0 ? '#0ea5e9' : '#94a3b8'} />
        ) : null}
        <View style={styles.triggerTextWrap}>
          {loading ? (
            <Text style={styles.placeholder}>Cargando…</Text>
          ) : resumen ? (
            <Text style={styles.value} numberOfLines={2}>{resumen}</Text>
          ) : (
            <Text style={styles.placeholder} numberOfLines={1}>{placeholder}</Text>
          )}
        </View>
        {seleccionadas.length > 1 ? (
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{seleccionadas.length}</Text>
          </View>
        ) : null}
        <MaterialIcons name={open ? 'arrow-drop-up' : 'arrow-drop-down'} size={22} color="#64748b" />
      </TouchableOpacity>

      {open && (
        <Modal visible transparent animationType="fade" onRequestClose={cerrar}>
          <Pressable style={styles.overlay} onPress={cerrar}>
            <Pressable onPress={() => {}} style={styles.card}>
              {tituloLista ? (
                <View style={styles.header}>
                  {iconoLista ? <MaterialIcons name={iconoLista} size={15} color="#0ea5e9" /> : null}
                  <Text style={styles.headerText}>{tituloLista}</Text>
                  {valorIds.length > 0 ? (
                    <Text style={styles.headerCount}>{valorIds.length} sel.</Text>
                  ) : null}
                </View>
              ) : null}
              {buscador && !loading && opciones.length > 0 ? (
                <View style={styles.searchWrap}>
                  <MaterialIcons name="search" size={16} color="#94a3b8" />
                  <TextInput
                    style={styles.searchInput}
                    value={filtro}
                    onChangeText={setFiltro}
                    placeholder={buscadorPlaceholder}
                    placeholderTextColor="#94a3b8"
                    autoCorrect={false}
                    autoFocus={Platform.OS === 'web'}
                  />
                  {filtro ? (
                    <TouchableOpacity onPress={() => setFiltro('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <MaterialIcons name="close" size={16} color="#94a3b8" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
              {loading ? (
                <ActivityIndicator size="small" color="#0ea5e9" style={{ marginVertical: 24 }} />
              ) : opcionesFiltradas.length > 0 ? (
                <ScrollView style={styles.scroll} nestedScrollEnabled showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
                  {opcionesFiltradas.map((o) => {
                    const sel = seleccionSet.has(o.id);
                    return (
                      <TouchableOpacity
                        key={o.id}
                        style={[styles.row, sel && styles.rowSelected]}
                        onPress={() => toggleOpcion(o.id)}
                        activeOpacity={0.7}
                      >
                        <MaterialIcons
                          name={sel ? 'check-box' : 'check-box-outline-blank'}
                          size={20}
                          color={sel ? '#0ea5e9' : '#94a3b8'}
                        />
                        {o.badge !== undefined ? (
                          <View style={[styles.badge, sel && styles.badgeSelected]}>
                            <Text style={[styles.badgeText, sel && styles.badgeTextSelected]}>{o.badge}</Text>
                          </View>
                        ) : o.icono ? (
                          <View style={[styles.iconBox, sel && styles.iconBoxSelected]}>
                            <MaterialIcons name={o.icono} size={16} color={sel ? '#0ea5e9' : '#94a3b8'} />
                          </View>
                        ) : null}
                        <View style={styles.rowTextWrap}>
                          <Text style={[styles.rowTitle, sel && styles.rowTitleSelected]} numberOfLines={1}>
                            {o.titulo}
                          </Text>
                          {o.subtitulo ? (
                            <Text style={styles.rowSub} numberOfLines={1}>{o.subtitulo}</Text>
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              ) : opciones.length > 0 ? (
                <View style={styles.empty}>
                  <MaterialIcons name="search-off" size={28} color="#cbd5e1" />
                  <Text style={styles.emptyText}>Sin resultados para «{filtro.trim()}».</Text>
                </View>
              ) : (
                <View style={styles.empty}>
                  <MaterialIcons name="inbox" size={28} color="#cbd5e1" />
                  <Text style={styles.emptyText}>{vacioTexto}</Text>
                </View>
              )}
              <View style={styles.footer}>
                {valorIds.length > 0 ? (
                  <TouchableOpacity
                    style={styles.footerClearBtn}
                    onPress={() => onChange([])}
                  >
                    <Text style={styles.footerClearText}>Limpiar</Text>
                  </TouchableOpacity>
                ) : (
                  <View />
                )}
                <TouchableOpacity style={styles.footerOkBtn} onPress={cerrar}>
                  <Text style={styles.footerOkText}>Listo</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 46,
  },
  triggerActive: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  triggerDisabled: { opacity: 0.6 },
  triggerTextWrap: { flex: 1, minWidth: 0, overflow: 'hidden' },
  value: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1e293b',
  },
  placeholder: { fontSize: 13, color: '#94a3b8' },
  countBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#0ea5e9',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  countBadgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '100%',
    maxWidth: 420,
    maxHeight: '75%',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...(Platform.OS === 'web' && ({ boxShadow: '0 12px 32px rgba(0,0,0,0.18)' } as object)),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerText: { flex: 1, fontSize: 12, fontWeight: '700', color: '#334155' },
  headerCount: { fontSize: 11, fontWeight: '600', color: '#0ea5e9' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    margin: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#1e293b',
    paddingVertical: Platform.OS === 'web' ? 2 : 0,
    ...(Platform.OS === 'web' && ({ outlineStyle: 'none' } as object)),
  },
  scroll: { maxHeight: 360 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  rowSelected: { backgroundColor: '#f0f9ff' },
  rowTextWrap: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 13, fontWeight: '500', color: '#334155' },
  rowTitleSelected: { color: '#0369a1', fontWeight: '700' },
  rowSub: { fontSize: 10, color: '#94a3b8', marginTop: 1 },
  badge: {
    minWidth: 38,
    height: 32,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSelected: { backgroundColor: '#0ea5e9' },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  badgeTextSelected: { color: '#fff' },
  iconBox: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBoxSelected: { backgroundColor: '#e0f2fe' },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 28, paddingHorizontal: 16 },
  emptyText: { fontSize: 12, color: '#94a3b8', textAlign: 'center' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  footerClearBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  footerClearText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  footerOkBtn: {
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  footerOkText: { fontSize: 12, fontWeight: '700', color: '#fff' },
});
