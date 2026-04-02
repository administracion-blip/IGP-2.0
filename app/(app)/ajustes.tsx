import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  TextInput,
  Switch,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type SyncConfig = {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  endpoint: string;
  permiso: string;
  descripcion: string;
  bodyBuilder?: () => Record<string, unknown>;
};

const SYNC_ITEMS: SyncConfig[] = [
  {
    id: 'agora_productos',
    label: 'Productos Agora',
    icon: 'inventory-2',
    endpoint: '/api/agora/products/sync',
    permiso: 'ajustes.sincronizaciones.agora_productos',
    descripcion: 'Sincroniza productos desde Agora al sistema local',
    bodyBuilder: () => ({ force: true }),
  },
  {
    id: 'compras_proveedor',
    label: 'Compras a Proveedor',
    icon: 'local-shipping',
    endpoint: '/api/agora/purchases/sync',
    permiso: 'ajustes.sincronizaciones.compras_proveedor',
    descripcion: 'Importa albaranes de entrada desde Agora (últimos 60 días)',
  },
  {
    id: 'closeouts',
    label: 'Cierres de Caja',
    icon: 'point-of-sale',
    endpoint: '/api/agora/closeouts/sync',
    permiso: 'ajustes.sincronizaciones.closeouts',
    descripcion: 'Sincroniza cierres de caja desde Agora',
  },
  {
    id: 'almacenes',
    label: 'Almacenes',
    icon: 'warehouse',
    endpoint: '/api/agora/warehouses/sync',
    permiso: 'ajustes.sincronizaciones.almacenes',
    descripcion: 'Sincroniza almacenes desde Agora',
  },
  {
    id: 'empleados_factorial',
    label: 'Empleados',
    icon: 'badge',
    endpoint: '/api/personal/employees/sync',
    permiso: 'ajustes.sincronizaciones.empleados',
    descripcion: 'Sincroniza empleados desde Factorial HR',
  },
];

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS: Record<string, string> = {
  mon: 'L', tue: 'M', wed: 'X', thu: 'J', fri: 'V', sat: 'S', sun: 'D',
};

type SyncState = {
  syncing: boolean;
  result: string | null;
  error: string | null;
  lastSync: string | null;
  enabled: boolean;
  days: string[];
  times: string[];
  frequencyMinutes: number | null;
  startTime: string | null;
  endTime: string | null;
};

type AjusteItem = {
  PK: string;
  SK: string;
  Nombre?: string;
  UltimaSync?: string;
  Estado?: string;
  Resultado?: string;
  Enabled?: boolean;
  Days?: string[];
  Times?: string[];
  FrequencyMinutes?: number | null;
  StartTime?: string | null;
  EndTime?: string | null;
  updatedAt?: string;
};

const defaultState = (): SyncState => ({
  syncing: false,
  result: null,
  error: null,
  lastSync: null,
  enabled: false,
  days: [],
  times: [],
  frequencyMinutes: null,
  startTime: null,
  endTime: null,
});

export default function AjustesScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { width: winWidth } = useWindowDimensions();

  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>(() => {
    const initial: Record<string, SyncState> = {};
    SYNC_ITEMS.forEach((s) => { initial[s.id] = defaultState(); });
    return initial;
  });

  const [loadingAjustes, setLoadingAjustes] = useState(true);

  // --- Modal de configuración ---
  const [configModalId, setConfigModalId] = useState<string | null>(null);
  const [cfgEnabled, setCfgEnabled] = useState(false);
  const [cfgDays, setCfgDays] = useState<string[]>([]);
  const [cfgTimes, setCfgTimes] = useState<string[]>([]);
  const [cfgNewTime, setCfgNewTime] = useState('');
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgTimeError, setCfgTimeError] = useState<string | null>(null);

  const cargarEstados = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/ajustes?categoria=sincronizaciones`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.items)) {
        setSyncStates((prev) => {
          const next = { ...prev };
          for (const item of data.items as AjusteItem[]) {
            const id = item.SK;
            if (next[id]) {
              next[id] = {
                ...next[id],
                lastSync: item.UltimaSync || item.updatedAt || null,
                result: item.Resultado || null,
                error: item.Estado === 'error' ? (item.Resultado || 'Error desconocido') : null,
                enabled: item.Enabled ?? false,
                days: Array.isArray(item.Days) ? item.Days : [],
                times: Array.isArray(item.Times) ? item.Times : [],
                frequencyMinutes: item.FrequencyMinutes ?? null,
                startTime: item.StartTime ?? null,
                endTime: item.EndTime ?? null,
              };
            }
          }
          return next;
        });
      }
    } catch (_) {}
    setLoadingAjustes(false);
  }, []);

  useEffect(() => { cargarEstados(); }, [cargarEstados]);

  const ejecutarSync = useCallback(async (item: SyncConfig) => {
    setSyncStates((prev) => ({
      ...prev,
      [item.id]: { ...prev[item.id], syncing: true, result: null, error: null },
    }));

    try {
      const body = item.bodyBuilder ? item.bodyBuilder() : {};
      const res = await fetch(`${API_URL}${item.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      let resultMsg = '';
      if (data.skipped) {
        resultMsg = data.message || 'Sincronización omitida (reciente)';
      } else if (data.added != null || data.updated != null || data.unchanged != null) {
        resultMsg = `Añadidos: ${data.added ?? 0} | Actualizados: ${data.updated ?? 0} | Sin cambios: ${data.unchanged ?? 0}`;
      } else if (data.totalUpserted != null) {
        resultMsg = `Registros sincronizados: ${data.totalUpserted}`;
      } else if (data.totalFetched != null) {
        resultMsg = `Registros obtenidos: ${data.totalFetched} | Guardados: ${data.totalUpserted ?? 0}`;
      } else if (data.upserted != null) {
        resultMsg = `Sincronizados: ${data.upserted}`;
      } else {
        resultMsg = data.ok ? 'Sincronización completada' : (data.error || 'Error desconocido');
      }

      const ahora = new Date().toISOString();
      setSyncStates((prev) => ({
        ...prev,
        [item.id]: {
          ...prev[item.id],
          syncing: false,
          result: resultMsg,
          error: data.ok ? null : (data.error || 'Error'),
          lastSync: data.ok ? ahora : prev[item.id].lastSync,
        },
      }));

      try {
        await fetch(`${API_URL}/api/ajustes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            PK: 'sincronizaciones',
            SK: item.id,
            Nombre: item.label,
            UltimaSync: ahora,
            Estado: data.ok ? 'ok' : 'error',
            Resultado: resultMsg,
          }),
        });
      } catch (_) {}
    } catch (err: any) {
      setSyncStates((prev) => ({
        ...prev,
        [item.id]: {
          ...prev[item.id],
          syncing: false,
          result: null,
          error: err?.message || 'Error de conexión',
        },
      }));
    }
  }, []);

  // --- Config modal helpers ---
  const abrirConfig = useCallback((id: string) => {
    const st = syncStates[id] ?? defaultState();
    setCfgEnabled(st.enabled);
    setCfgDays([...st.days]);
    setCfgTimes([...st.times].sort());
    setCfgNewTime('');
    setCfgTimeError(null);
    setConfigModalId(id);
  }, [syncStates]);

  const toggleDay = useCallback((day: string) => {
    setCfgDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  }, []);

  const addTime = useCallback(() => {
    const t = cfgNewTime.trim();
    if (!/^\d{2}:\d{2}$/.test(t)) {
      setCfgTimeError('Formato: HH:MM');
      return;
    }
    const [hh, mm] = t.split(':').map(Number);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      setCfgTimeError('Hora inválida');
      return;
    }
    if (cfgTimes.includes(t)) {
      setCfgTimeError('Ya existe');
      return;
    }
    setCfgTimes((prev) => [...prev, t].sort());
    setCfgNewTime('');
    setCfgTimeError(null);
  }, [cfgNewTime, cfgTimes]);

  const removeTime = useCallback((t: string) => {
    setCfgTimes((prev) => prev.filter((x) => x !== t));
  }, []);

  const guardarConfig = useCallback(async () => {
    if (!configModalId) return;
    setCfgSaving(true);
    try {
      await fetch(`${API_URL}/api/ajustes/sincronizaciones/${configModalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Enabled: cfgEnabled,
          Days: cfgDays,
          Times: cfgTimes,
        }),
      });
      setSyncStates((prev) => ({
        ...prev,
        [configModalId]: {
          ...prev[configModalId],
          enabled: cfgEnabled,
          days: [...cfgDays],
          times: [...cfgTimes],
        },
      }));
      setConfigModalId(null);
    } catch (_) {}
    setCfgSaving(false);
  }, [configModalId, cfgEnabled, cfgDays, cfgTimes]);

  function formatFechaHora(iso: string | null): string {
    if (!iso) return 'Nunca';
    try {
      const d = new Date(iso);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
    } catch { return iso; }
  }

  const visibleItems = SYNC_ITEMS.filter((s) => hasPermiso(s.permiso));
  const configItem = configModalId ? SYNC_ITEMS.find((s) => s.id === configModalId) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={20} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Ajustes</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialIcons name="sync" size={18} color="#0369a1" />
            <Text style={styles.sectionTitle}>Sincronizaciones</Text>
          </View>
          <Text style={styles.sectionDesc}>
            Gestiona las sincronizaciones de datos con sistemas externos (Agora).
          </Text>

          {loadingAjustes ? (
            <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
          ) : visibleItems.length === 0 ? (
            <Text style={styles.emptyText}>No tienes permisos para ninguna sincronización</Text>
          ) : (
            <View style={styles.cardsGrid}>
              {visibleItems.map((item) => {
                const st = syncStates[item.id] ?? defaultState();
                return (
                  <View key={item.id} style={[styles.card, { minWidth: winWidth < 500 ? '100%' as any : 260, maxWidth: winWidth < 500 ? '100%' as any : 360 }]}>
                    {/* Cabecera */}
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, st.error ? styles.cardIconError : st.result ? styles.cardIconOk : styles.cardIconDefault]}>
                        <MaterialIcons name={item.icon} size={20} color={st.error ? '#dc2626' : st.result ? '#059669' : '#0369a1'} />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>{item.label}</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>{item.descripcion}</Text>
                      </View>
                      <TouchableOpacity onPress={() => abrirConfig(item.id)} style={styles.cardConfigBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <MaterialIcons name="settings" size={18} color="#94a3b8" />
                      </TouchableOpacity>
                    </View>

                    {/* Estado enabled + última sync */}
                    <View style={styles.cardStatusRow}>
                      <View style={[styles.statusBadge, st.enabled ? styles.statusBadgeOn : styles.statusBadgeOff]}>
                        <View style={[styles.statusDot, st.enabled ? styles.statusDotOn : styles.statusDotOff]} />
                        <Text style={[styles.statusText, st.enabled ? styles.statusTextOn : styles.statusTextOff]}>
                          {st.enabled ? 'Automático' : 'Manual'}
                        </Text>
                      </View>
                      <View style={styles.cardMetaRow}>
                        <MaterialIcons name="schedule" size={11} color="#94a3b8" />
                        <Text style={styles.cardMetaText}>{formatFechaHora(st.lastSync)}</Text>
                      </View>
                    </View>

                    {/* Días y horas programadas (solo si enabled) */}
                    {st.enabled && (st.days.length > 0 || st.times.length > 0) && (
                      <View style={styles.scheduleRow}>
                        {st.days.length > 0 && (
                          <View style={styles.daysPreview}>
                            {DAY_KEYS.map((dk) => (
                              <View key={dk} style={[styles.dayChipSmall, st.days.includes(dk) && styles.dayChipSmallActive]}>
                                <Text style={[styles.dayChipSmallText, st.days.includes(dk) && styles.dayChipSmallTextActive]}>
                                  {DAY_LABELS[dk]}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                        {st.times.length > 0 && (
                          <Text style={styles.timesPreview} numberOfLines={1}>
                            {st.times.join(' · ')}
                          </Text>
                        )}
                      </View>
                    )}

                    {/* Resultado / Error */}
                    {st.result && !st.error && (
                      <View style={styles.resultBox}>
                        <MaterialIcons name="check-circle" size={12} color="#059669" />
                        <Text style={styles.resultText} numberOfLines={2}>{st.result}</Text>
                      </View>
                    )}
                    {st.error && (
                      <View style={styles.errorBox}>
                        <MaterialIcons name="error-outline" size={12} color="#dc2626" />
                        <Text style={styles.errorText} numberOfLines={2}>{st.error}</Text>
                      </View>
                    )}

                    {/* Botón sync */}
                    <TouchableOpacity
                      style={[styles.syncBtn, st.syncing && styles.syncBtnDisabled]}
                      onPress={() => ejecutarSync(item)}
                      disabled={st.syncing}
                      activeOpacity={0.7}
                    >
                      {st.syncing ? (
                        <>
                          <ActivityIndicator size="small" color="#fff" />
                          <Text style={styles.syncBtnText}>Sincronizando…</Text>
                        </>
                      ) : (
                        <>
                          <MaterialIcons name="sync" size={15} color="#fff" />
                          <Text style={styles.syncBtnText}>Sincronizar</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      {/* ─── Modal de configuración ─── */}
      <Modal visible={!!configModalId} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setConfigModalId(null)}>
          <Pressable style={[styles.modalBox, { maxWidth: Math.min(winWidth - 32, 440) }]} onPress={() => {}}>
            {/* Header modal */}
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                {configItem && <MaterialIcons name={configItem.icon} size={20} color="#0369a1" />}
                <Text style={styles.modalTitle} numberOfLines={1}>
                  {configItem?.label ?? 'Configuración'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setConfigModalId(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={20} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
              {/* Activación */}
              <View style={styles.cfgSection}>
                <View style={styles.cfgRowBetween}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cfgLabel}>Sincronización automática</Text>
                    <Text style={styles.cfgHint}>Ejecutar en los días y horas configurados</Text>
                  </View>
                  <Switch
                    value={cfgEnabled}
                    onValueChange={setCfgEnabled}
                    trackColor={{ false: '#cbd5e1', true: '#7dd3fc' }}
                    thumbColor={cfgEnabled ? '#0ea5e9' : '#94a3b8'}
                    style={Platform.OS === 'web' ? { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] } : undefined}
                  />
                </View>
              </View>

              {/* Días de ejecución */}
              <View style={[styles.cfgSection, !cfgEnabled && styles.cfgDisabled]}>
                <Text style={styles.cfgLabel}>Días de ejecución</Text>
                <View style={styles.daysRow}>
                  {DAY_KEYS.map((dk) => {
                    const active = cfgDays.includes(dk);
                    return (
                      <TouchableOpacity
                        key={dk}
                        style={[styles.dayChip, active && styles.dayChipActive]}
                        onPress={() => cfgEnabled && toggleDay(dk)}
                        activeOpacity={cfgEnabled ? 0.7 : 1}
                      >
                        <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                          {DAY_LABELS[dk]}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Horas de ejecución */}
              <View style={[styles.cfgSection, !cfgEnabled && styles.cfgDisabled]}>
                <Text style={styles.cfgLabel}>Horas de ejecución</Text>
                <Text style={styles.cfgHint}>La sincronización se ejecutará a cada hora programada</Text>

                {cfgTimes.length > 0 && (
                  <View style={styles.timesList}>
                    {cfgTimes.map((t) => (
                      <View key={t} style={styles.timeChip}>
                        <MaterialIcons name="access-time" size={13} color="#0369a1" />
                        <Text style={styles.timeChipText}>{t}</Text>
                        <TouchableOpacity
                          onPress={() => cfgEnabled && removeTime(t)}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          style={styles.timeChipRemove}
                        >
                          <MaterialIcons name="close" size={13} color="#94a3b8" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}

                <View style={styles.addTimeRow}>
                  <TextInput
                    style={styles.addTimeInput}
                    value={cfgNewTime}
                    onChangeText={(v) => {
                      setCfgNewTime(v);
                      setCfgTimeError(null);
                    }}
                    placeholder="HH:MM"
                    placeholderTextColor="#94a3b8"
                    maxLength={5}
                    keyboardType="numbers-and-punctuation"
                    editable={cfgEnabled}
                    onSubmitEditing={addTime}
                    {...(Platform.OS === 'web' ? {
                      onKeyPress: (e: any) => { if (e.nativeEvent?.key === 'Enter') addTime(); },
                    } : {})}
                  />
                  <TouchableOpacity
                    style={[styles.addTimeBtn, !cfgEnabled && { opacity: 0.5 }]}
                    onPress={addTime}
                    disabled={!cfgEnabled}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name="add" size={16} color="#fff" />
                    <Text style={styles.addTimeBtnText}>Añadir</Text>
                  </TouchableOpacity>
                </View>
                {cfgTimeError && <Text style={styles.cfgError}>{cfgTimeError}</Text>}
              </View>
            </ScrollView>

            {/* Footer modal */}
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setConfigModalId(null)}>
                <Text style={styles.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSaveBtn} onPress={guardarConfig} disabled={cfgSaving} activeOpacity={0.7}>
                {cfgSaving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalSaveText}>Guardar</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  sectionDesc: { fontSize: 12, color: '#64748b', marginBottom: 16 },
  emptyText: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', paddingVertical: 20 },

  /* Grid responsive */
  cardsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  card: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 10,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  cardIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIconDefault: { backgroundColor: '#e0f2fe' },
  cardIconOk: { backgroundColor: '#d1fae5' },
  cardIconError: { backgroundColor: '#fee2e2' },
  cardInfo: { flex: 1, gap: 2 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  cardDesc: { fontSize: 10, color: '#64748b', lineHeight: 14 },
  cardConfigBtn: { padding: 2 },

  /* Estado badge */
  cardStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusBadgeOn: { backgroundColor: '#ecfdf5' },
  statusBadgeOff: { backgroundColor: '#f1f5f9' },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusDotOn: { backgroundColor: '#10b981' },
  statusDotOff: { backgroundColor: '#94a3b8' },
  statusText: { fontSize: 10, fontWeight: '600' },
  statusTextOn: { color: '#059669' },
  statusTextOff: { color: '#64748b' },

  cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  cardMetaText: { fontSize: 10, color: '#94a3b8' },

  /* Schedule preview */
  scheduleRow: { gap: 4 },
  daysPreview: { flexDirection: 'row', gap: 3 },
  dayChipSmall: {
    width: 20,
    height: 20,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
  },
  dayChipSmallActive: { backgroundColor: '#dbeafe' },
  dayChipSmallText: { fontSize: 9, fontWeight: '600', color: '#94a3b8' },
  dayChipSmallTextActive: { color: '#1d4ed8' },
  timesPreview: { fontSize: 10, color: '#64748b', fontWeight: '500' },

  /* Result / Error */
  resultBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#f0fdf4',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  resultText: { fontSize: 10, color: '#065f46', flex: 1 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { fontSize: 10, color: '#991b1b', flex: 1 },

  /* Sync button */
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  syncBtnDisabled: { opacity: 0.6 },
  syncBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },

  /* ─── Modal ─── */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },

  /* Config sections */
  cfgSection: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  cfgDisabled: { opacity: 0.45 },
  cfgRowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  cfgLabel: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  cfgHint: { fontSize: 11, color: '#64748b', marginTop: 1 },
  cfgError: { fontSize: 11, color: '#dc2626', marginTop: 2 },

  /* Days selector */
  daysRow: { flexDirection: 'row', gap: 6 },
  dayChip: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
  },
  dayChipActive: {
    backgroundColor: '#dbeafe',
    borderColor: '#3b82f6',
  },
  dayChipText: { fontSize: 13, fontWeight: '700', color: '#94a3b8' },
  dayChipTextActive: { color: '#1d4ed8' },

  /* Times list */
  timesList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  timeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#e0f2fe',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  timeChipText: { fontSize: 13, fontWeight: '600', color: '#0369a1' },
  timeChipRemove: { marginLeft: 2 },

  /* Add time */
  addTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  addTimeInput: {
    flex: 1,
    height: 36,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  addTimeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addTimeBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },

  /* Modal footer */
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  modalCancelText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  modalSaveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
    minWidth: 80,
    alignItems: 'center',
  },
  modalSaveText: { fontSize: 13, fontWeight: '600', color: '#fff' },
});
