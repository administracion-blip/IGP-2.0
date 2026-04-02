import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type Empleado = {
  pk: string;
  sk: string;
  employee_id: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  phone_number?: string;
  start_date?: string;
  terminated_on?: string;
  active?: boolean;
  company_id?: number;
  identifier?: string;
  gender?: string;
  synced_at?: string;
  [key: string]: unknown;
};

const COLUMNAS: { key: keyof Empleado | string; label: string; width: number }[] = [
  { key: 'employee_id', label: 'ID', width: 70 },
  { key: 'full_name', label: 'Nombre completo', width: 200 },
  { key: 'email', label: 'Email', width: 220 },
  { key: 'phone_number', label: 'Teléfono', width: 130 },
  { key: 'identifier', label: 'DNI / NIF', width: 120 },
  { key: 'start_date', label: 'Alta', width: 110 },
  { key: 'terminated_on', label: 'Baja', width: 110 },
  { key: 'active', label: 'Activo', width: 80 },
];

export default function PersonalScreen() {
  const router = useRouter();
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [filtro, setFiltro] = useState('');
  const [soloActivos, setSoloActivos] = useState(true);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/personal/employees`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error al obtener empleados');
      setEmpleados(data.employees ?? []);
    } catch (err: any) {
      setError(err.message ?? 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const sincronizar = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/personal/employees/sync`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error en sincronización');
      setSyncMsg(`Sincronizados ${data.synced ?? 0} empleados de ${data.total ?? 0}`);
      await cargar();
    } catch (err: any) {
      setError(err.message ?? 'Error de sincronización');
    } finally {
      setSyncing(false);
    }
  }, [cargar]);

  const filtrados = useMemo(() => {
    let list = empleados;
    if (soloActivos) list = list.filter((e) => e.active !== false);
    if (filtro.trim()) {
      const q = filtro.trim().toLowerCase();
      list = list.filter(
        (e) =>
          (e.full_name ?? '').toLowerCase().includes(q) ||
          (e.email ?? '').toLowerCase().includes(q) ||
          (e.identifier ?? '').toLowerCase().includes(q) ||
          String(e.employee_id).includes(q),
      );
    }
    return list;
  }, [empleados, filtro, soloActivos]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Personal</Text>
        <Text style={styles.subtitle}>Empleados sincronizados desde Factorial HR</Text>
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar por nombre, email, DNI…"
          placeholderTextColor="#94a3b8"
          value={filtro}
          onChangeText={setFiltro}
        />
        <TouchableOpacity
          style={[styles.filterChip, soloActivos && styles.filterChipActive]}
          onPress={() => setSoloActivos((v) => !v)}
        >
          <Text style={[styles.filterChipText, soloActivos && styles.filterChipTextActive]}>
            Solo activos
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.syncBtn, syncing && styles.syncBtnDisabled]}
          onPress={sincronizar}
          disabled={syncing}
        >
          {syncing ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <MaterialIcons name="sync" size={18} color="#fff" />
          )}
          <Text style={styles.syncBtnText}>{syncing ? 'Sincronizando…' : 'Sincronizar'}</Text>
        </TouchableOpacity>
      </View>

      {syncMsg && (
        <View style={styles.bannerOk}>
          <MaterialIcons name="check-circle" size={16} color="#0f766e" />
          <Text style={styles.bannerOkText}>{syncMsg}</Text>
        </View>
      )}
      {error && (
        <View style={styles.bannerError}>
          <MaterialIcons name="error-outline" size={16} color="#dc2626" />
          <Text style={styles.bannerErrorText}>{error}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.loadingText}>Cargando empleados…</Text>
        </View>
      ) : (
        <>
          <Text style={styles.countText}>
            {filtrados.length} empleado{filtrados.length !== 1 ? 's' : ''}
            {soloActivos ? ' activos' : ''}
          </Text>
          <ScrollView horizontal>
            <View>
              {/* Cabecera */}
              <View style={styles.headerRowTable}>
                {COLUMNAS.map((col) => (
                  <View key={col.key} style={[styles.headerCell, { width: col.width }]}>
                    <Text style={styles.headerCellText}>{col.label}</Text>
                  </View>
                ))}
              </View>

              {/* Filas */}
              <ScrollView style={styles.bodyScroll}>
                {filtrados.length === 0 && (
                  <View style={styles.emptyRow}>
                    <Text style={styles.emptyText}>
                      {empleados.length === 0
                        ? 'Sin datos. Pulsa "Sincronizar" para importar empleados.'
                        : 'Ningún empleado coincide con el filtro.'}
                    </Text>
                  </View>
                )}
                {filtrados.map((emp, idx) => (
                  <View
                    key={emp.employee_id}
                    style={[styles.dataRow, idx % 2 === 1 && styles.dataRowAlt]}
                  >
                    {COLUMNAS.map((col) => (
                      <View key={col.key} style={[styles.dataCell, { width: col.width }]}>
                        <Text style={styles.dataCellText} numberOfLines={1}>
                          {formatCellValue(col.key, emp[col.key])}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </ScrollView>
            </View>
          </ScrollView>
        </>
      )}
    </View>
  );
}

function formatCellValue(key: string, val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (key === 'active') return val ? 'Sí' : 'No';
  return String(val);
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#94a3b8', marginLeft: 4 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  searchInput: {
    flex: 1,
    minWidth: 200,
    height: 36,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  filterChipActive: { backgroundColor: '#dbeafe', borderColor: '#93c5fd' },
  filterChipText: { fontSize: 12, color: '#64748b' },
  filterChipTextActive: { color: '#1d4ed8', fontWeight: '600' },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  syncBtnDisabled: { opacity: 0.6 },
  syncBtnText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  bannerOk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 8,
    backgroundColor: '#ccfbf1',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#5eead4',
    marginBottom: 8,
  },
  bannerOkText: { fontSize: 13, color: '#0f766e', fontWeight: '500' },
  bannerError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 8,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    marginBottom: 8,
  },
  bannerErrorText: { fontSize: 13, color: '#dc2626' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  loadingText: { marginTop: 8, fontSize: 14, color: '#64748b' },
  countText: { fontSize: 12, color: '#64748b', marginBottom: 6 },
  headerRowTable: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 2,
    borderBottomColor: '#cbd5e1',
  },
  headerCell: { paddingVertical: 8, paddingHorizontal: 6 },
  headerCellText: { fontSize: 12, fontWeight: '700', color: '#475569' },
  bodyScroll: { flex: 1 },
  dataRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  dataRowAlt: { backgroundColor: '#f8fafc' },
  dataCell: { paddingVertical: 7, paddingHorizontal: 6 },
  dataCellText: { fontSize: 13, color: '#334155' },
  emptyRow: { padding: 24, alignItems: 'center' },
  emptyText: { fontSize: 14, color: '#94a3b8', fontStyle: 'italic' },
});
