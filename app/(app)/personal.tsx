import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  Pressable,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import {
  ERP_LIST_HEADER_TEXT_PROPS,
  erpListTableStyles,
} from '../constants/erpListTableStyles';
import { useAuth } from '../contexts/AuthContext';
import { fotoGeneralUrl, tallaDeActivo, unidadesDeActivo } from '../lib/activos';
import { apiFetch, errorMessage } from '../utils/api';
import type { CustodiaEmpleado } from '../types/activos';

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
  { key: 'prendas', label: 'Prendas', width: 110 },
  { key: 'email', label: 'Email', width: 220 },
  { key: 'phone_number', label: 'Teléfono', width: 130 },
  { key: 'identifier', label: 'DNI / NIF', width: 120 },
  { key: 'start_date', label: 'Alta', width: 110 },
  { key: 'terminated_on', label: 'Baja', width: 110 },
  { key: 'active', label: 'Activo', width: 80 },
];

export default function PersonalScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeVerPrendas = hasPermiso('activos.ver');
  const puedeDevolver = hasPermiso('activos.editar');
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [filtro, setFiltro] = useState('');
  const [soloActivos, setSoloActivos] = useState(true);
  const [custodias, setCustodias] = useState<Record<string, CustodiaEmpleado>>({});
  const [desglose, setDesglose] = useState<CustodiaEmpleado | null>(null);
  const [selDev, setSelDev] = useState<Record<string, boolean>>({});
  const [cantDev, setCantDev] = useState<Record<string, string>>({});
  const [devolviendo, setDevolviendo] = useState(false);
  const [errorDev, setErrorDev] = useState<string | null>(null);

  const cargarCustodias = useCallback(async () => {
    if (!puedeVerPrendas) {
      setCustodias({});
      return;
    }
    try {
      const res = await apiFetch('/api/activos/custodia');
      const data = (await res.json()) as { custodias?: CustodiaEmpleado[]; error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudieron cargar las prendas');
      const mapa: Record<string, CustodiaEmpleado> = {};
      for (const c of data.custodias || []) mapa[String(c.employee_id)] = c;
      setCustodias(mapa);
    } catch {
      setCustodias({});
    }
  }, [puedeVerPrendas]);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/personal/employees');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error al obtener empleados');
      setEmpleados(data.employees ?? []);
      await cargarCustodias();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Error de conexión'));
    } finally {
      setLoading(false);
    }
  }, [cargarCustodias]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const sincronizar = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    setError(null);
    try {
      const res = await apiFetch('/api/personal/employees/sync', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Error en sincronización');
      setSyncMsg(`Sincronizados ${data.synced ?? 0} empleados de ${data.total ?? 0}`);
      await cargar();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Error de sincronización'));
    } finally {
      setSyncing(false);
    }
  }, [cargar]);

  const columnasVisibles = useMemo(
    () => (puedeVerPrendas ? COLUMNAS : COLUMNAS.filter((c) => c.key !== 'prendas')),
    [puedeVerPrendas],
  );

  const abrirDesglose = (emp: Empleado) => {
    const c = custodias[String(emp.employee_id)];
    if (!c || c.cantidad < 1) return;
    const sel: Record<string, boolean> = {};
    const cant: Record<string, string> = {};
    for (const a of c.activos) {
      sel[a.asset_id] = false;
      cant[a.asset_id] = String(unidadesDeActivo(a));
    }
    setSelDev(sel);
    setCantDev(cant);
    setErrorDev(null);
    setDesglose(c);
  };

  const confirmarDevolucion = async () => {
    if (!desglose) return;
    const lineas = desglose.activos
      .filter((a) => selDev[a.asset_id])
      .map((a) => ({
        asset_id: a.asset_id,
        cantidad: a.granularidad === 'lote' ? parseInt(cantDev[a.asset_id], 10) || 1 : 1,
      }));
    if (!lineas.length) {
      setErrorDev('Marca qué devuelve');
      return;
    }
    setDevolviendo(true);
    setErrorDev(null);
    try {
      const res = await apiFetch('/api/activos/devoluciones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: desglose.employee_id, lineas }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo devolver');
      setDesglose(null);
      await cargarCustodias();
    } catch (err: unknown) {
      setErrorDev(errorMessage(err, 'No se pudo devolver'));
    } finally {
      setDevolviendo(false);
    }
  };

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
          <View style={erpListTableStyles.tableOuter}>
            <View style={erpListTableStyles.tableWrapper}>
              <ScrollView
                horizontal
                style={[erpListTableStyles.scroll, erpListTableStyles.scrollTable, erpListTableStyles.tableScrollLtr]}
                contentContainerStyle={erpListTableStyles.scrollContent}
                showsHorizontalScrollIndicator
              >
                <View style={erpListTableStyles.table}>
                  <View style={erpListTableStyles.rowHeader}>
                    {columnasVisibles.map((col) => (
                      <View key={col.key} style={[erpListTableStyles.cellHeader, { width: col.width }]}>
                        <Text style={erpListTableStyles.cellHeaderText} {...ERP_LIST_HEADER_TEXT_PROPS}>
                          {col.label}
                        </Text>
                      </View>
                    ))}
                  </View>

                  <ScrollView
                    style={erpListTableStyles.tableBodyScroll}
                    contentContainerStyle={erpListTableStyles.tableBodyContent}
                    showsVerticalScrollIndicator
                    nestedScrollEnabled
                  >
                    {filtrados.length === 0 ? (
                      <View style={erpListTableStyles.row}>
                        <View style={erpListTableStyles.cellEmpty}>
                          <Text style={erpListTableStyles.cellEmptyText}>
                            {empleados.length === 0
                              ? 'Sin datos. Pulsa «Sincronizar» para importar empleados.'
                              : 'Ningún empleado coincide con el filtro.'}
                          </Text>
                        </View>
                      </View>
                    ) : (
                      filtrados.map((emp) => (
                        <View key={emp.employee_id} style={erpListTableStyles.row}>
                          {columnasVisibles.map((col) => {
                            if (col.key === 'prendas') {
                              const c = custodias[String(emp.employee_id)];
                              const n = c?.cantidad || 0;
                              const txt = n === 0 ? '—' : n === 1 ? '1 prenda' : `${n} prendas`;
                              return (
                                <View key={col.key} style={[erpListTableStyles.cell, { width: col.width }]}>
                                  {n > 0 ? (
                                    <TouchableOpacity onPress={() => abrirDesglose(emp)}>
                                      <Text style={[erpListTableStyles.cellText, styles.prendasLink]}>{txt}</Text>
                                    </TouchableOpacity>
                                  ) : (
                                    <Text style={erpListTableStyles.cellText}>{txt}</Text>
                                  )}
                                </View>
                              );
                            }
                            const raw = formatCellValue(String(col.key), emp[col.key as keyof Empleado]);
                            const esActivo = col.key === 'active';
                            const activoStyles =
                              esActivo && emp.active !== false
                                ? { backgroundColor: '#d1fae5', color: '#047857', fontWeight: '600' as const }
                                : esActivo
                                  ? { backgroundColor: '#fee2e2', color: '#b91c1c', fontWeight: '600' as const }
                                  : null;
                            return (
                              <View
                                key={col.key}
                                style={[
                                  erpListTableStyles.cell,
                                  { width: col.width },
                                  activoStyles && { backgroundColor: activoStyles.backgroundColor, borderRadius: 6 },
                                ]}
                              >
                                <Text
                                  style={[
                                    erpListTableStyles.cellText,
                                    activoStyles && { color: activoStyles.color, fontWeight: activoStyles.fontWeight },
                                  ]}
                                >
                                  {raw}
                                </Text>
                              </View>
                            );
                          })}
                        </View>
                      ))
                    )}
                  </ScrollView>
                </View>
              </ScrollView>
            </View>
          </View>
        </>
      )}

      <Modal visible={Boolean(desglose)} transparent animationType="fade" onRequestClose={() => setDesglose(null)}>
        <Pressable style={styles.modalFondo} onPress={() => !devolviendo && setDesglose(null)}>
          <Pressable style={styles.modalCaja} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitulo}>{desglose?.employee_nombre || 'Prendas'}</Text>
            <Text style={styles.modalSub}>
              {desglose?.cantidad === 1 ? '1 prenda asignada' : `${desglose?.cantidad || 0} prendas asignadas`}.
              {puedeDevolver ? ' Marca lo que devuelve.' : ''}
            </Text>
            <ScrollView style={styles.modalLista}>
              {(desglose?.activos || []).map((a) => {
                const talla = tallaDeActivo(a);
                const on = Boolean(selDev[a.asset_id]);
                const thumb = fotoGeneralUrl(a);
                const fotoLabel = `Foto de ${a.nombre_modelo || a.etiqueta_legible}`;
                return (
                  <View key={a.asset_id} style={styles.modalFila}>
                    {puedeDevolver ? (
                      <TouchableOpacity onPress={() => setSelDev((p) => ({ ...p, [a.asset_id]: !p[a.asset_id] }))}>
                        <MaterialIcons
                          name={on ? 'check-box' : 'check-box-outline-blank'}
                          size={22}
                          color={on ? '#0ea5e9' : '#94a3b8'}
                        />
                      </TouchableOpacity>
                    ) : null}
                    {thumb ? (
                      <Image
                        source={{ uri: thumb }}
                        style={styles.modalThumb}
                        resizeMode="cover"
                        accessibilityLabel={fotoLabel}
                      />
                    ) : (
                      <View
                        style={[styles.modalThumb, styles.modalThumbVacio]}
                        accessibilityLabel={fotoLabel}
                      >
                        <MaterialIcons name="image" size={20} color="#94a3b8" />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.modalEtiqueta}>{a.etiqueta_legible}</Text>
                      <Text style={styles.modalMeta} numberOfLines={1}>
                        {[a.marca, a.nombre_modelo].filter(Boolean).join(' ')}
                        {talla ? ` · ${talla}` : ''}
                        {a.granularidad !== 'lote' ? ' · 1 ud.' : ''}
                      </Text>
                    </View>
                    {a.granularidad === 'lote' && puedeDevolver ? (
                      <TextInput
                        style={styles.modalCant}
                        value={cantDev[a.asset_id] || '1'}
                        onChangeText={(t) => setCantDev((p) => ({ ...p, [a.asset_id]: t.replace(/[^\d]/g, '') }))}
                        keyboardType="number-pad"
                        editable={on}
                      />
                    ) : (
                      <Text style={styles.modalUd}>
                        {a.granularidad === 'lote' ? `${unidadesDeActivo(a)} ud.` : '1 ud.'}
                      </Text>
                    )}
                  </View>
                );
              })}
            </ScrollView>
            {errorDev ? <Text style={styles.modalError}>{errorDev}</Text> : null}
            <View style={styles.modalAcciones}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setDesglose(null)} disabled={devolviendo}>
                <Text style={styles.modalCancelTxt}>Cerrar</Text>
              </TouchableOpacity>
              {puedeDevolver ? (
                <TouchableOpacity
                  style={[styles.modalOk, devolviendo && { opacity: 0.6 }]}
                  onPress={() => void confirmarDevolucion()}
                  disabled={devolviendo}
                >
                  {devolviendo ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.modalOkTxt}>Devolver marcadas</Text>
                  )}
                </TouchableOpacity>
              ) : null}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function formatCellValue(key: string, val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (key === 'active') return val ? 'Sí' : 'No';
  return String(val);
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, backgroundColor: '#fff', minHeight: 0 },
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
  prendasLink: { color: '#0369a1', fontWeight: '700', textDecorationLine: 'underline' },
  modalFondo: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  modalCaja: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    maxHeight: '88%',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  modalTitulo: { fontSize: 18, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  modalSub: { fontSize: 13, color: '#64748b', marginBottom: 12 },
  modalLista: { maxHeight: 320, marginBottom: 8 },
  modalFila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalThumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
  },
  modalThumbVacio: { alignItems: 'center', justifyContent: 'center' },
  modalEtiqueta: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  modalMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  modalCant: {
    width: 52,
    height: 40,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    textAlign: 'center',
    fontWeight: '700',
    color: '#0f172a',
  },
  modalUd: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  modalError: { color: '#dc2626', marginBottom: 8, fontSize: 13 },
  modalAcciones: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  modalCancel: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancelTxt: { fontWeight: '700', color: '#64748b' },
  modalOk: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalOkTxt: { color: '#fff', fontWeight: '700' },
});
