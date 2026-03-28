import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { useAuth } from '../../contexts/AuthContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const LABELS = [
  { key: 'efectivo', teoricoKey: 'Efectivo', label: 'Efectivo', realField: 'efectivoReal' as const },
  { key: 'tarjeta', teoricoKey: 'Tarjeta', label: 'Tarjeta', realField: 'tarjetaReal' as const },
  { key: 'pendiente', teoricoKey: 'Pendiente de cobro', label: 'Pendiente de cobro', realField: 'pendienteCobroReal' as const },
  { key: 'prepago', teoricoKey: 'Prepago Transferencia', label: 'Prepago transferencia', realField: 'prepagoTransferenciaReal' as const },
  { key: 'agora', teoricoKey: 'AgoraPay', label: 'AgoraPay', realField: 'agoraPayReal' as const },
] as const;

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };

async function safeJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}`);
  }
}

function parseDateToYYYYMMDD(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      const date = new Date(y, mo - 1, d);
      if (date.getDate() === d && date.getMonth() === mo - 1 && date.getFullYear() === y) {
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function todayDmy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatMoneda(n: number): string {
  if (Number.isNaN(n)) return '—';
  const parts = n.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

function parseEuroInput(s: string): number {
  const n = parseFloat(String(s).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : 0;
}

type CompareResponse = {
  teorico: Record<string, number>;
  real: {
    efectivoReal: number;
    tarjetaReal: number;
    pendienteCobroReal: number;
    prepagoTransferenciaReal: number;
    agoraPayReal: number;
  };
  diff: Record<string, number>;
  /** Suma de diferencias (coincide con descuadreTotal guardado en Dynamo al guardar). */
  descuadreTotal?: number;
  closeoutsCount: number;
  error?: string;
};

export default function ArqueoCajaScreen() {
  const router = useRouter();
  const { hasPermiso, user } = useAuth();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [saleCenters, setSaleCenters] = useState<{ Id?: number; Nombre?: string; Local?: string; Activo?: boolean }[]>([]);

  const [businessDayDmy, setBusinessDayDmy] = useState(todayDmy);
  const [formLocal, setFormLocal] = useState('');
  const [formPosId, setFormPosId] = useState('');
  const [formPosName, setFormPosName] = useState('');

  const [efectivoReal, setEfectivoReal] = useState('');
  const [tarjetaReal, setTarjetaReal] = useState('');
  const [pendienteReal, setPendienteReal] = useState('');
  const [prepagoReal, setPrepagoReal] = useState('');
  const [agoraReal, setAgoraReal] = useState('');

  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [loadingCompare, setLoadingCompare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  const [localModalOpen, setLocalModalOpen] = useState(false);
  const [posModalOpen, setPosModalOpen] = useState(false);

  const businessDayIso = useMemo(() => parseDateToYYYYMMDD(businessDayDmy), [businessDayDmy]);

  const agoraCodeToNombre = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of locales) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) map[code] = nombre || '—';
    }
    return map;
  }, [locales]);

  const saleCentersPorLocal = useMemo(() => {
    if (!formLocal.trim()) return saleCenters.filter((sc) => sc.Activo !== false);
    const localName = String(agoraCodeToNombre[formLocal.trim()] ?? '').trim();
    return saleCenters.filter((sc) => {
      if (sc.Activo === false) return false;
      return String(sc.Local ?? '').trim() === localName;
    });
  }, [saleCenters, formLocal, agoraCodeToNombre]);

  useEffect(() => {
    fetch(`${API_URL}/api/locales`)
      .then((r) => safeJson<{ locales?: LocalItem[] }>(r))
      .then((d) => setLocales(d.locales || []))
      .catch(() => setLocales([]));
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/api/agora/sale-centers`)
      .then((r) => safeJson<{ saleCenters?: typeof saleCenters }>(r))
      .then((d) => setSaleCenters(d.saleCenters || []))
      .catch(() => setSaleCenters([]));
  }, []);

  useEffect(() => {
    if (formLocal && formPosId && !saleCentersPorLocal.some((sc) => String(sc.Id) === formPosId)) {
      setFormPosId('');
      setFormPosName('');
    }
  }, [formLocal, saleCentersPorLocal, formPosId]);

  const diffsEnVivo = useMemo(() => {
    if (!compare) return null;
    const t = compare.teorico;
    return {
      Efectivo: parseEuroInput(efectivoReal) - (t.Efectivo ?? 0),
      Tarjeta: parseEuroInput(tarjetaReal) - (t.Tarjeta ?? 0),
      'Pendiente de cobro': parseEuroInput(pendienteReal) - (t['Pendiente de cobro'] ?? 0),
      'Prepago Transferencia': parseEuroInput(prepagoReal) - (t['Prepago Transferencia'] ?? 0),
      AgoraPay: parseEuroInput(agoraReal) - (t.AgoraPay ?? 0),
    };
  }, [compare, efectivoReal, tarjetaReal, pendienteReal, prepagoReal, agoraReal]);

  const descuadreEnVivo = useMemo(() => {
    if (!diffsEnVivo) return null;
    let s = 0;
    for (const row of LABELS) s += diffsEnVivo[row.teoricoKey] ?? 0;
    return Math.round(s * 100) / 100;
  }, [diffsEnVivo]);

  const fetchCompare = useCallback(() => {
    if (!businessDayIso || !formLocal.trim() || !formPosId) {
      setCompare(null);
      return;
    }
    setLoadingCompare(true);
    setError(null);
    const q = new URLSearchParams({
      workplaceId: formLocal.trim(),
      businessDay: businessDayIso,
      posId: formPosId,
    });
    fetch(`${API_URL}/api/cajas/arqueos-reales/compare?${q}`)
      .then((r) => safeJson<CompareResponse & { error?: string }>(r))
      .then((data) => {
        if ((data as { error?: string }).error) {
          setError((data as { error: string }).error);
          setCompare(null);
          return;
        }
        setCompare(data);
        const r = data.real;
        setEfectivoReal(String(r.efectivoReal ?? ''));
        setTarjetaReal(String(r.tarjetaReal ?? ''));
        setPendienteReal(String(r.pendienteCobroReal ?? ''));
        setPrepagoReal(String(r.prepagoTransferenciaReal ?? ''));
        setAgoraReal(String(r.agoraPayReal ?? ''));
      })
      .catch((e) => {
        setError(e.message || 'Error al cargar comparativa');
        setCompare(null);
      })
      .finally(() => setLoadingCompare(false));
  }, [businessDayIso, formLocal, formPosId]);

  useEffect(() => {
    const t = setTimeout(fetchCompare, 300);
    return () => clearTimeout(t);
  }, [fetchCompare]);

  const guardar = async () => {
    if (!businessDayIso || !formLocal.trim() || !formPosId) {
      setError('Indica fecha, local y TPV');
      return;
    }
    setSaving(true);
    setError(null);
    setSaveOk(false);
    try {
      const body = {
        PK: formLocal.trim(),
        BusinessDay: businessDayIso,
        PosId: formPosId,
        PosName: formPosName,
        WorkplaceName: agoraCodeToNombre[formLocal.trim()] ?? formLocal,
        efectivoReal: efectivoReal.replace(',', '.'),
        tarjetaReal: tarjetaReal.replace(',', '.'),
        pendienteCobroReal: pendienteReal.replace(',', '.'),
        prepagoTransferenciaReal: prepagoReal.replace(',', '.'),
        agoraPayReal: agoraReal.replace(',', '.'),
        usuarioId: user?.id_usuario,
        usuarioNombre: user?.Nombre,
      };
      const res = await fetch(`${API_URL}/api/cajas/arqueos-reales`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await safeJson<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data.error) throw new Error(data.error || 'Error al guardar');
      setSaveOk(true);
      fetchCompare();
      setTimeout(() => setSaveOk(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const setters: Record<string, React.Dispatch<React.SetStateAction<string>>> = {
    efectivoReal: setEfectivoReal,
    tarjetaReal: setTarjetaReal,
    pendienteCobroReal: setPendienteReal,
    prepagoTransferenciaReal: setPrepagoReal,
    agoraPayReal: setAgoraReal,
  };

  const values: Record<string, string> = {
    efectivoReal,
    tarjetaReal,
    pendienteCobroReal: pendienteReal,
    prepagoTransferenciaReal: prepagoReal,
    agoraPayReal: agoraReal,
  };

  if (!hasPermiso('cierres.ver')) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para ver esta pantalla.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={64}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.formMax}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Arqueo de caja</Text>
        </View>

        <Text style={styles.lead}>
          Introduce los importes reales para contrastarlos con el cierre teórico (Ágora) del mismo día, local y TPV.
        </Text>

        <View style={styles.filtrosRow}>
          <View style={styles.filtrosColFecha}>
            <Text style={styles.labelFiltros}>Fecha negocio</Text>
            <InputFecha
              value={businessDayDmy}
              onChange={setBusinessDayDmy}
              format="dmy"
              placeholder="dd/mm/aaaa"
              style={styles.inputFechaCompact}
            />
          </View>
          <View style={styles.filtrosColSelect}>
            <Text style={styles.labelFiltros}>Local</Text>
            <TouchableOpacity
              style={styles.selectBtn}
              onPress={() => {
                setPosModalOpen(false);
                setLocalModalOpen(true);
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.selectText} numberOfLines={2}>
                {formLocal
                  ? `${agoraCodeToNombre[formLocal] || '—'} · id ${formLocal}`
                  : 'Seleccionar…'}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>
          <View style={styles.filtrosCol}>
            <Text style={styles.labelFiltros}>TPV</Text>
            <TouchableOpacity
              style={[styles.selectBtn, !formLocal && styles.selectDisabled]}
              onPress={() => {
                if (!formLocal) return;
                setLocalModalOpen(false);
                setPosModalOpen(true);
              }}
              disabled={!formLocal}
              activeOpacity={0.7}
            >
              <Text style={styles.selectText} numberOfLines={2}>
                {formPosId
                  ? `${formPosName || 'TPV'} · id ${formPosId}`
                  : 'Seleccionar…'}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>
        </View>

        <Modal visible={localModalOpen} transparent animationType="fade" onRequestClose={() => setLocalModalOpen(false)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setLocalModalOpen(false)}>
            <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.modalTitle}>Local</Text>
              <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {locales.map((loc) => {
                  const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                  if (!code) return null;
                  const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
                  return (
                    <TouchableOpacity
                      key={code}
                      style={[styles.modalRow, formLocal === code && styles.modalRowActive]}
                      onPress={() => {
                        setFormLocal(code);
                        setLocalModalOpen(false);
                      }}
                    >
                      <Text style={styles.modalRowLine} numberOfLines={2}>
                        <Text style={styles.modalRowName}>{nombre || '—'}</Text>
                        <Text style={styles.modalRowId}> · id {code}</Text>
                      </Text>
                      {formLocal === code ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TouchableOpacity style={styles.modalClose} onPress={() => setLocalModalOpen(false)}>
                <Text style={styles.modalCloseText}>Cerrar</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal visible={posModalOpen} transparent animationType="fade" onRequestClose={() => setPosModalOpen(false)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setPosModalOpen(false)}>
            <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.modalTitle}>TPV</Text>
              <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {saleCentersPorLocal.map((sc) => {
                  const id = sc.Id != null ? String(sc.Id) : '';
                  if (!id) return null;
                  const nom = String(sc.Nombre ?? '').trim() || `TPV ${id}`;
                  return (
                    <TouchableOpacity
                      key={id}
                      style={[styles.modalRow, formPosId === id && styles.modalRowActive]}
                      onPress={() => {
                        setFormPosId(id);
                        setFormPosName(nom);
                        setPosModalOpen(false);
                      }}
                    >
                      <Text style={styles.modalRowLine} numberOfLines={2}>
                        <Text style={styles.modalRowName}>{nom}</Text>
                        <Text style={styles.modalRowId}> · id {id}</Text>
                      </Text>
                      {formPosId === id ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TouchableOpacity style={styles.modalClose} onPress={() => setPosModalOpen(false)}>
                <Text style={styles.modalCloseText}>Cerrar</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>

        {loadingCompare && formLocal && formPosId && businessDayIso ? (
          <ActivityIndicator style={{ marginVertical: 12 }} color="#0ea5e9" />
        ) : null}

        {error ? (
          <View style={styles.errBox}>
            <MaterialIcons name="error-outline" size={18} color="#dc2626" />
            <Text style={styles.errText}>{error}</Text>
          </View>
        ) : null}

        {compare && businessDayIso && formPosId ? (
          <View style={styles.card}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>Teórico vs real</Text>
              {descuadreEnVivo != null ? (
                <View style={styles.descuadreBox}>
                  <Text style={styles.descuadreLabel}>Descuadre</Text>
                  <Text
                    style={[
                      styles.descuadreVal,
                      Math.abs(descuadreEnVivo) < 0.01 ? styles.diffOk : styles.diffBad,
                    ]}
                  >
                    {formatMoneda(descuadreEnVivo)}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.cardMeta}>
              Cierres teóricos encontrados: {compare.closeoutsCount}
            </Text>
            {LABELS.map((row) => {
              const t = compare.teorico[row.teoricoKey] ?? 0;
              const diff = diffsEnVivo ? diffsEnVivo[row.teoricoKey] ?? 0 : 0;
              const v = values[row.realField];
              return (
                <View key={row.key} style={styles.rowCompare}>
                  <Text style={styles.rowLabel}>{row.label}</Text>
                  <View style={styles.rowCols}>
                    <View style={styles.colTeo}>
                      <Text style={styles.colHdr}>Teórico</Text>
                      <Text style={styles.colVal}>{formatMoneda(t)}</Text>
                    </View>
                    <View style={styles.colReal}>
                      <Text style={styles.colHdr}>Real</Text>
                      <TextInput
                        style={styles.inputNum}
                        value={v}
                        onChangeText={setters[row.realField]}
                        keyboardType="decimal-pad"
                        placeholder="0,00"
                        placeholderTextColor="#94a3b8"
                      />
                    </View>
                    <View style={styles.colDiff}>
                      <Text style={styles.colHdr}>Dif.</Text>
                      <Text style={[styles.colVal, Math.abs(diff) < 0.01 ? styles.diffOk : styles.diffBad]}>
                        {formatMoneda(diff)}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          !loadingCompare &&
          formLocal &&
          formPosId &&
          businessDayIso && (
            <Text style={styles.hint}>Sin datos de comparativa. Revisa fecha y permisos de API.</Text>
          )
        )}

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDis]}
          onPress={guardar}
          disabled={saving || !businessDayIso || !formLocal || !formPosId}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <MaterialIcons name="save" size={20} color="#fff" />
              <Text style={styles.saveBtnText}>Guardar arqueo real</Text>
            </>
          )}
        </TouchableOpacity>
        {saveOk ? <Text style={styles.okText}>Guardado correctamente.</Text> : null}

        <View style={{ height: 32 }} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: {
    padding: 16,
    paddingBottom: 40,
    alignItems: 'center',
  },
  /** Formulario no a ancho completo en pantallas anchas */
  formMax: {
    width: '100%',
    maxWidth: 560,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  lead: { fontSize: 13, color: '#64748b', marginBottom: 16, lineHeight: 20 },
  filtrosRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 18,
  },
  /** Fecha: crece un poco en pantallas anchas, sin ocupar todo el ancho. */
  filtrosColFecha: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 132,
    maxWidth: 200,
  },
  /** Local / TPV: solo el ancho necesario (hasta un máximo). */
  filtrosColSelect: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 140,
    maxWidth: 288,
    alignSelf: 'flex-start',
  },
  labelFiltros: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  inputFechaCompact: {
    fontSize: 13,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 40,
  },
  selectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: '#fff',
    minHeight: 40,
  },
  selectDisabled: { opacity: 0.5 },
  selectText: { flexShrink: 1, fontSize: 13, color: '#334155', marginRight: 4, minWidth: 0 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    justifyContent: 'center',
    padding: 20,
    ...(Platform.OS === 'web' ? { zIndex: 9999 } as object : {}),
  },
  modalSheet: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#fff',
    borderRadius: 12,
    maxHeight: '80%',
    padding: 16,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 16px 48px rgba(0,0,0,0.2)', zIndex: 10000 } as object
      : { elevation: 12 }),
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginBottom: 12 },
  modalList: { maxHeight: 360 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    marginBottom: 4,
  },
  modalRowActive: { backgroundColor: '#f0f9ff', borderColor: '#bae6fd' },
  modalRowLine: { flex: 1, flexWrap: 'wrap' as const },
  modalRowName: { fontSize: 14, color: '#334155', fontWeight: '500' },
  modalRowId: { fontSize: 14, color: '#64748b' },
  modalClose: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  modalCloseText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
  errBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    marginTop: 12,
  },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  card: {
    marginTop: 16,
    padding: 14,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardTitleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 4,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#334155', flexShrink: 1 },
  descuadreBox: {
    alignItems: 'flex-end',
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  descuadreLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  descuadreVal: { fontSize: 15, fontWeight: '700' },
  cardMeta: { fontSize: 11, color: '#94a3b8', marginBottom: 12 },
  rowCompare: { marginBottom: 14, borderBottomWidth: 1, borderBottomColor: '#f1f5f9', paddingBottom: 12 },
  rowLabel: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 6 },
  rowCols: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  colTeo: { flex: 1, minWidth: 90 },
  colReal: { flex: 1, minWidth: 100 },
  colDiff: { width: 88 },
  colHdr: { fontSize: 10, color: '#94a3b8', marginBottom: 2, textTransform: 'uppercase' },
  colVal: { fontSize: 13, fontWeight: '600', color: '#334155' },
  inputNum: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  diffOk: { color: '#059669' },
  diffBad: { color: '#dc2626' },
  hint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginTop: 8 },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 20,
    paddingVertical: 14,
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
  },
  saveBtnDis: { opacity: 0.6 },
  saveBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  okText: { fontSize: 13, color: '#059669', marginTop: 10, textAlign: 'center' },
  errorText: { padding: 16, color: '#b91c1c' },
});
