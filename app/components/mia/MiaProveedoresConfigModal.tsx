/**
 * Plazo de entrega y frecuencia de pedido por proveedor (stock mínimo/máximo MIA).
 * El valor por producto, si existe, tiene prioridad sobre este.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, radius, statusColors } from '../../constants/theme';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch, errorMessage } from '../../utils/api';

type ProveedorConfig = {
  proveedorId: string;
  proveedorNombre: string;
  plazoDias: number | null;
  frecuenciaDias: number | null;
  guardado?: boolean;
};

type Borrador = { plazo: string; frecuencia: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  warehouseId: string | null;
  almacenNombre?: string;
};

function aTexto(n: number | null | undefined): string {
  return n == null ? '' : String(n).replace('.', ',');
}

/** '' → null; número ≥ 0 → número; otra cosa → NaN. */
function leerDias(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

export function MiaProveedoresConfigModal({ visible, onClose, warehouseId, almacenNombre }: Props) {
  const { isPhone } = useBreakpoint();
  const [items, setItems] = useState<ProveedorConfig[]>([]);
  const [borradores, setBorradores] = useState<Record<string, Borrador>>({});
  const [loading, setLoading] = useState(false);
  const [guardandoId, setGuardandoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState('');

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : '';
      const r = await apiFetch(`/api/mia/proveedores-config${qs}`);
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error || 'No se pudieron cargar los proveedores');
        setItems([]);
        return;
      }
      const list: ProveedorConfig[] = Array.isArray(data.items) ? data.items : [];
      setItems(list);
      const b: Record<string, Borrador> = {};
      for (const p of list) b[p.proveedorId] = { plazo: aTexto(p.plazoDias), frecuencia: aTexto(p.frecuenciaDias) };
      setBorradores(b);
    } catch (e) {
      setError(errorMessage(e, 'Error cargando proveedores'));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [warehouseId]);

  useEffect(() => {
    if (visible) {
      setFiltro('');
      void cargar();
    }
  }, [visible, cargar]);

  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) => p.proveedorNombre.toLowerCase().includes(q) || p.proveedorId.toLowerCase().includes(q),
    );
  }, [items, filtro]);

  const cambiado = (p: ProveedorConfig) => {
    const b = borradores[p.proveedorId];
    if (!b) return false;
    return b.plazo.trim() !== aTexto(p.plazoDias) || b.frecuencia.trim() !== aTexto(p.frecuenciaDias);
  };

  const editar = (id: string, patch: Partial<Borrador>) => {
    setBorradores((prev) => ({ ...prev, [id]: { ...(prev[id] || { plazo: '', frecuencia: '' }), ...patch } }));
  };

  const guardar = async (p: ProveedorConfig) => {
    const b = borradores[p.proveedorId];
    if (!b) return;
    const plazoDias = leerDias(b.plazo);
    const frecuenciaDias = leerDias(b.frecuencia);
    if (Number.isNaN(plazoDias) || Number.isNaN(frecuenciaDias)) {
      setError(`«${p.proveedorNombre || p.proveedorId}»: los días deben ser un número ≥ 0 o quedar vacíos.`);
      return;
    }
    setGuardandoId(p.proveedorId);
    setError(null);
    try {
      const r = await apiFetch('/api/mia/proveedores-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proveedorId: p.proveedorId,
          proveedorNombre: p.proveedorNombre,
          plazoDias,
          frecuenciaDias,
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error || 'No se pudo guardar');
        return;
      }
      const item: ProveedorConfig = { ...p, ...data.item, guardado: true };
      setItems((prev) => prev.map((x) => (x.proveedorId === p.proveedorId ? item : x)));
      editar(p.proveedorId, { plazo: aTexto(item.plazoDias), frecuencia: aTexto(item.frecuenciaDias) });
    } catch (e) {
      setError(errorMessage(e, 'Error guardando el proveedor'));
    } finally {
      setGuardandoId(null);
    }
  };

  const handleClose = () => {
    if (guardandoId) return;
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable style={styles.overlay} onPress={handleClose}>
        <Pressable style={[styles.modal, isPhone && styles.modalPhone]} onPress={() => {}}>
          <View style={styles.header}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title}>Plazo y frecuencia por proveedor</Text>
              <Text style={styles.subtitle} numberOfLines={3}>
                Con los dos valores, MIA pide hasta el stock máximo. Se aplica en todos los almacenes
                y el valor de un producto tiene prioridad.
                {almacenNombre ? ` Lista: proveedores de ${almacenNombre} y los ya configurados.` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={handleClose} disabled={!!guardandoId} style={styles.iconBtn}>
              <MaterialIcons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <MaterialIcons name="error-outline" size={16} color={statusColors.danger.text} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TextInput
            style={styles.input}
            value={filtro}
            onChangeText={setFiltro}
            placeholder="Buscar proveedor…"
            placeholderTextColor={colors.textMuted}
          />

          {!isPhone ? (
            <View style={styles.tableHead}>
              <Text style={[styles.th, styles.colNombre]}>Proveedor</Text>
              <Text style={[styles.th, styles.colDias]}>Plazo (días)</Text>
              <Text style={[styles.th, styles.colDias]}>Frecuencia (días)</Text>
              <View style={styles.colAccion} />
            </View>
          ) : null}

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.vacio}>Cargando proveedores…</Text>
            </View>
          ) : (
            <ScrollView style={styles.lista} nestedScrollEnabled>
              {visibles.length === 0 ? (
                <Text style={styles.vacio}>
                  {items.length === 0
                    ? 'No hay proveedores en la configuración ni en las compras recientes de este almacén.'
                    : 'Ningún proveedor coincide con la búsqueda.'}
                </Text>
              ) : (
                visibles.map((p) => {
                  const b = borradores[p.proveedorId] || { plazo: '', frecuencia: '' };
                  const sucio = cambiado(p);
                  const guardando = guardandoId === p.proveedorId;
                  return (
                    <View key={p.proveedorId} style={[styles.row, isPhone && styles.rowPhone]}>
                      <View style={[styles.colNombre, isPhone && styles.nombrePhone]}>
                        <Text style={styles.nombre} numberOfLines={1}>
                          {p.proveedorNombre || p.proveedorId}
                        </Text>
                        <Text style={styles.meta}>
                          Id {p.proveedorId}
                          {p.plazoDias != null && p.frecuenciaDias != null ? ' · mínimo/máximo activo' : ''}
                        </Text>
                      </View>
                      <TextInput
                        style={[styles.inputDias, styles.colDias, isPhone && styles.inputPhone]}
                        value={b.plazo}
                        onChangeText={(t) => editar(p.proveedorId, { plazo: t })}
                        keyboardType="decimal-pad"
                        placeholder={isPhone ? 'Plazo' : '—'}
                        placeholderTextColor={colors.textMuted}
                        editable={!guardando}
                      />
                      <TextInput
                        style={[styles.inputDias, styles.colDias, isPhone && styles.inputPhone]}
                        value={b.frecuencia}
                        onChangeText={(t) => editar(p.proveedorId, { frecuencia: t })}
                        keyboardType="decimal-pad"
                        placeholder={isPhone ? 'Frecuencia' : '—'}
                        placeholderTextColor={colors.textMuted}
                        editable={!guardando}
                      />
                      <TouchableOpacity
                        style={[styles.iconBtn, styles.colAccion, (!sucio || !!guardandoId) && styles.btnDisabled]}
                        onPress={() => {
                          void guardar(p);
                        }}
                        disabled={!sucio || !!guardandoId}
                        accessibilityLabel={`Guardar ${p.proveedorNombre || p.proveedorId}`}
                      >
                        {guardando ? (
                          <ActivityIndicator size="small" color={colors.accent} />
                        ) : (
                          <MaterialIcons name="save" size={20} color={sucio ? colors.accent : colors.borderStrong} />
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })
              )}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.overlay,
    padding: 16,
  },
  modal: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    width: '100%',
    maxWidth: 640,
    maxHeight: '90%',
  },
  modalPhone: { maxHeight: '100%', height: '100%', borderRadius: 0 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 10 },
  title: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  subtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: statusColors.danger.bg,
    borderRadius: radius.sm,
    padding: 8,
    marginBottom: 10,
  },
  errorText: { fontSize: 12, color: statusColors.danger.text, flex: 1 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: colors.textPrimary,
    marginBottom: 8,
  },
  tableHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingBottom: 4 },
  th: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  colNombre: { flex: 1, minWidth: 0 },
  colDias: { width: 110 },
  colAccion: { width: MIN_TOUCH },
  loadingWrap: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  lista: { maxHeight: 420 },
  vacio: { fontSize: 12, color: colors.textSecondary, paddingVertical: 12, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: colors.navActive,
  },
  rowPhone: { flexWrap: 'wrap' },
  nombrePhone: { flexBasis: '100%' },
  nombre: { fontSize: 13, fontWeight: '600', color: colors.textStrong },
  meta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  inputDias: {
    height: 36,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    paddingHorizontal: 8,
    fontSize: 13,
    textAlign: 'right',
    color: colors.textStrong,
  },
  inputPhone: { height: MIN_TOUCH },
  iconBtn: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center', alignItems: 'center' },
  btnDisabled: { opacity: 0.45 },
});
