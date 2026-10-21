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
import { MIN_TOUCH } from '../constants/layout';
import { useAuth } from '../contexts/AuthContext';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../constants/theme';
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
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Personal</Text>
        <Text style={styles.subtitle}>Empleados sincronizados desde Factorial HR</Text>
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar por nombre, email, DNI…"
          placeholderTextColor={colors.textMuted}
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
            <ActivityIndicator size="small" color={colors.surface} />
          ) : (
            <MaterialIcons name="sync" size={18} color={colors.surface} />
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
          <MaterialIcons name="error-outline" size={16} color={colors.danger} />
          <Text style={styles.bannerErrorText}>{error}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
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
                                ? { backgroundColor: '#d1fae5', color: '#047857', fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight }
                                : esActivo
                                  ? { backgroundColor: statusColors.danger.bg, color: statusColors.danger.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight }
                                  : null;
                            return (
                              <View
                                key={col.key}
                                style={[
                                  erpListTableStyles.cell,
                                  { width: col.width },
                                  activoStyles && { backgroundColor: activoStyles.backgroundColor, borderRadius: radius.sm },
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
                          color={on ? colors.accent : colors.textMuted}
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
                        <MaterialIcons name="image" size={20} color={colors.textMuted} />
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
                    <ActivityIndicator color={colors.surface} />
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

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, backgroundColor: colors.surface, minHeight: 0 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.navActive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, marginLeft: SPACING.xs },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  searchInput: {
    flex: 1,
    minWidth: 200,
    height: 36,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: 10,
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    color: colors.textPrimary,
    backgroundColor: colors.bg,
  },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.xl,
    backgroundColor: colors.navActive,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: { backgroundColor: '#dbeafe', borderColor: '#93c5fd' },
  filterChipText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  filterChipTextActive: { color: '#1d4ed8', fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: RADIO_MEDIO,
  },
  syncBtnDisabled: { opacity: 0.6 },
  syncBtnText: { fontSize: fontSizes[13], color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  bannerOk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: SPACING.sm,
    backgroundColor: '#ccfbf1',
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#5eead4',
    marginBottom: SPACING.sm,
  },
  bannerOkText: { fontSize: fontSizes[13], color: '#0f766e', fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  bannerError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: SPACING.sm,
    backgroundColor: statusColors.danger.bg,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#fecaca',
    marginBottom: SPACING.sm,
  },
  bannerErrorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.danger },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  loadingText: { marginTop: SPACING.sm, fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted },
  countText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginBottom: 6 },
  prendasLink: { color: statusColors.info.text, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, textDecorationLine: 'underline' },
  /** Más oscuro que colors.overlay. */
  modalFondo: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  modalCaja: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: SPACING.lg,
    maxHeight: '88%',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  modalTitulo: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginBottom: SPACING.xs },
  modalSub: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, marginBottom: SPACING.md },
  modalLista: { maxHeight: 320, marginBottom: SPACING.sm },
  modalFila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalThumb: {
    width: 48,
    height: 48,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.border,
  },
  modalThumbVacio: { alignItems: 'center', justifyContent: 'center' },
  modalEtiqueta: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  modalMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },
  modalCant: {
    width: 52,
    height: 40,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: RADIO_MEDIO,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight,
    color: colors.textStrong,
  },
  modalUd: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  modalError: { color: colors.danger, marginBottom: SPACING.sm, fontFamily: fontFamily.regular, fontSize: fontSizes[13] },
  modalAcciones: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.sm, marginTop: SPACING.sm },
  modalCancel: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancelTxt: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted },
  modalOk: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 14,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalOkTxt: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
});
