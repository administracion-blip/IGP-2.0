import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };

type LocalEfectivo = {
  workplaceId: string;
  nombre: string;
  empresaNombre: string;
  billetes: number;
  monedas: number;
  sinDesglose: number;
  retiradas: number;
  aIngresar: number;
  arqueosSinConteo: number;
};

type Sociedad = {
  empresa: string;
  iban: string;
  totalBilletes: number;
  totalMonedas: number;
  totalSinDesglose: number;
  totalRetiradas: number;
  totalAIngresar: number;
  locales: LocalEfectivo[];
};

type TotalGeneral = {
  billetes: number;
  monedas: number;
  sinDesglose: number;
  retiradas: number;
  aIngresar: number;
};

type EfectivoResponse = {
  dateFrom: string;
  dateTo: string;
  sociedades: Sociedad[];
  totalGeneral: TotalGeneral;
  error?: string;
};

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

function formatMoneda(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const parts = Math.abs(n).toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = n < 0 ? '-' : '';
  return `${sign}${intPart},${parts[1]} €`;
}

export default function EfectivoIngresarScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ dateFrom?: string; dateTo?: string; workplaceId?: string }>();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackPanels } = useBreakpoint();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [fromIso, setFromIso] = useState(
    () => (typeof params.dateFrom === 'string' && params.dateFrom) || fechaJornadaNegocioIso(),
  );
  const [toIso, setToIso] = useState(
    () => (typeof params.dateTo === 'string' && params.dateTo) || fechaJornadaNegocioIso(),
  );
  const [localFiltro, setLocalFiltro] = useState(typeof params.workplaceId === 'string' ? params.workplaceId : '');

  const [data, setData] = useState<EfectivoResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Id incremental de la última petición (para descartar respuestas tardías). */
  const reqIdRef = useRef(0);

  const localesPermitidos = useMemo(
    () =>
      locales
        .map((l) => ({
          code: String(l.agoraCode ?? l.AgoraCode ?? '').trim(),
          nombre: String(l.nombre ?? l.Nombre ?? '').trim(),
        }))
        .filter((l) => l.code && localPermitido(l.nombre)),
    [locales, localPermitido],
  );

  useEffect(() => {
    apiFetch('/api/locales')
      .then((r) => safeJson<{ locales?: LocalItem[] }>(r))
      .then((d) => setLocales(d.locales || []))
      .catch(() => setLocales([]));
  }, []);

  const fetchEfectivo = useCallback(() => {
    const codes = localFiltro ? [localFiltro] : localesPermitidos.map((l) => l.code);
    if (!fromIso || !toIso || codes.length === 0) {
      setData(null);
      return;
    }
    // Guard de respuestas obsoletas: evita que una petición lenta machaque a la última.
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ dateFrom: fromIso, dateTo: toIso, workplaceIds: codes.join(',') });
    apiFetch(`/api/cajas/efectivo-ingresar?${q}`)
      .then((r) => safeJson<EfectivoResponse>(r))
      .then((d) => {
        if (reqIdRef.current !== myId) return;
        if ((d as { error?: string }).error) throw new Error((d as { error: string }).error);
        setData(d);
      })
      .catch((e) => {
        if (reqIdRef.current !== myId) return;
        setError(e instanceof Error ? e.message : 'Error al calcular el efectivo a ingresar');
        setData(null);
      })
      .finally(() => {
        if (reqIdRef.current === myId) setLoading(false);
      });
  }, [fromIso, toIso, localFiltro, localesPermitidos]);

  useEffect(() => {
    const t = setTimeout(fetchEfectivo, 300);
    return () => clearTimeout(t);
  }, [fetchEfectivo]);

  if (!hasPermiso('cierres.ver')) {
    return (
      <View style={styles.flex}>
        <Text style={styles.errorText}>No tienes permiso para ver esta pantalla.</Text>
      </View>
    );
  }

  const total = data?.totalGeneral;
  const sociedades = data?.sociedades || [];

  return (
    <View style={styles.flex}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.formMax}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <MaterialIcons name="arrow-back" size={22} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.title}>Efectivo a ingresar</Text>
          </View>
          <Text style={styles.lead}>
            Total de efectivo a ingresar en banco por sociedad y local en el rango elegido. Incluye el efectivo
            contado en los arqueos más las retiradas (que también se ingresan y cuentan como billetes).
          </Text>

          <View style={[styles.filtrosRow, shouldStackPanels && styles.filtrosCol]}>
            <View style={styles.filtroCol}>
              <Text style={styles.labelFiltros}>Desde</Text>
              <InputFecha valueIso={fromIso} onChangeIso={setFromIso} placeholder="dd/mm/aaaa" style={styles.inputFechaCompact} />
            </View>
            <View style={styles.filtroCol}>
              <Text style={styles.labelFiltros}>Hasta</Text>
              <InputFecha valueIso={toIso} onChangeIso={setToIso} placeholder="dd/mm/aaaa" style={styles.inputFechaCompact} />
            </View>
            <View style={styles.filtroColWide}>
              <Text style={styles.labelFiltros}>Local</Text>
              <SelectorDesplegable
                icono="store"
                iconoLista="store"
                tituloLista="Local"
                placeholder="Todos mis locales"
                buscador
                buscadorPlaceholder="Buscar local…"
                valorId={localFiltro}
                opciones={[
                  { id: '', titulo: 'Todos mis locales', icono: 'apps' as const },
                  ...localesPermitidos.map((l) => ({ id: l.code, titulo: l.nombre || '—', subtitulo: `id ${l.code}`, icono: 'store' as const })),
                ]}
                onSeleccionar={(id) => setLocalFiltro(id)}
              />
            </View>
          </View>

          {error ? (
            <View style={styles.errBox}>
              <MaterialIcons name="error-outline" size={18} color="#dc2626" />
              <Text style={styles.errText}>{error}</Text>
            </View>
          ) : null}

          {loading ? <ActivityIndicator style={{ marginVertical: 16 }} color="#0ea5e9" /> : null}

          {/* Total general */}
          {!loading && total ? (
            <View style={styles.totalCard}>
              <View style={styles.totalHeadRow}>
                <MaterialIcons name="account-balance" size={20} color="#15803d" />
                <Text style={styles.totalHeadLabel}>Total a ingresar</Text>
                <Text style={styles.totalHeadVal}>{formatMoneda(total.aIngresar)}</Text>
              </View>
              <View style={styles.totalChips}>
                <View style={[styles.chip, styles.chipBilletes]}>
                  <MaterialIcons name="note" size={14} color="#0f766e" />
                  <Text style={styles.chipText}>Billetes {formatMoneda(total.billetes)}</Text>
                </View>
                <View style={[styles.chip, styles.chipMonedas]}>
                  <MaterialIcons name="lens" size={12} color="#b45309" />
                  <Text style={styles.chipText}>Monedas {formatMoneda(total.monedas)}</Text>
                </View>
                {total.retiradas > 0 ? (
                  <View style={[styles.chip, styles.chipRetiradas]}>
                    <MaterialIcons name="payments" size={14} color="#7c3aed" />
                    <Text style={styles.chipText}>Retiradas {formatMoneda(total.retiradas)}</Text>
                  </View>
                ) : null}
              </View>
              {total.sinDesglose > 0 ? (
                <Text style={styles.sinDesgloseNote}>
                  {formatMoneda(total.sinDesglose)} sin desglose de billetes/monedas (arqueos sin conteo detallado).
                </Text>
              ) : null}
            </View>
          ) : null}

          {!loading && sociedades.length === 0 && !error ? (
            <Text style={styles.hint}>No hay efectivo a ingresar en el rango y locales seleccionados.</Text>
          ) : null}

          {/* Por sociedad */}
          {!loading
            ? sociedades.map((s) => (
                <View key={`${s.empresa}-${s.iban}`} style={styles.socCard}>
                  <View style={styles.socHeader}>
                    <View style={styles.socHeadMain}>
                      <MaterialIcons name="business" size={18} color="#334155" />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.socNombre} numberOfLines={1}>{s.empresa}</Text>
                        {s.iban ? (
                          <Text style={styles.socIban} numberOfLines={1}>{s.iban}</Text>
                        ) : (
                          <Text style={styles.socIbanFalta}>Sin IBAN en la ficha de la empresa</Text>
                        )}
                      </View>
                    </View>
                    <Text style={styles.socTotal}>{formatMoneda(s.totalAIngresar)}</Text>
                  </View>

                  <View style={styles.socChips}>
                    <Text style={styles.socChipBilletes}>Billetes {formatMoneda(s.totalBilletes)}</Text>
                    <Text style={styles.socChipMonedas}>Monedas {formatMoneda(s.totalMonedas)}</Text>
                    {s.totalRetiradas > 0 ? (
                      <Text style={styles.socChipRet}>Retiradas {formatMoneda(s.totalRetiradas)}</Text>
                    ) : null}
                  </View>

                  {/* Tabla de locales */}
                  <View style={styles.tablaHead}>
                    <Text style={styles.thLocal}>Local</Text>
                    <Text style={styles.thNum}>Billetes</Text>
                    <Text style={styles.thNum}>Monedas</Text>
                    <Text style={styles.thNum}>A ingresar</Text>
                  </View>
                  {s.locales.map((l) => (
                    <View key={l.workplaceId} style={styles.tablaRow}>
                      <View style={styles.tdLocalWrap}>
                        <Text style={styles.tdLocal} numberOfLines={1}>{l.nombre}</Text>
                        {l.retiradas > 0 ? (
                          <Text style={styles.tdLocalSub}>incluye {formatMoneda(l.retiradas)} de retiradas</Text>
                        ) : null}
                        {l.arqueosSinConteo > 0 ? (
                          <Text style={styles.tdLocalWarn}>{l.arqueosSinConteo} sin desglose</Text>
                        ) : null}
                      </View>
                      <Text style={styles.tdNum}>{formatMoneda(l.billetes)}</Text>
                      <Text style={styles.tdNum}>{formatMoneda(l.monedas)}</Text>
                      <Text style={[styles.tdNum, styles.tdNumFuerte]}>{formatMoneda(l.aIngresar)}</Text>
                    </View>
                  ))}
                </View>
              ))
            : null}

          <View style={{ height: 40 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#f8fafc' },
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 40, alignItems: 'center' },
  formMax: { width: '100%', maxWidth: 900 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { flex: 1, fontSize: 18, fontWeight: '700', color: '#334155' },
  lead: { fontSize: 13, color: '#64748b', marginBottom: 16, lineHeight: 20 },
  filtrosRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, marginBottom: 14 },
  filtrosCol: { flexDirection: 'column' },
  filtroCol: { flexGrow: 1, flexShrink: 1, minWidth: 120, maxWidth: 200 },
  filtroColWide: { flexGrow: 1, flexShrink: 1, minWidth: 160, maxWidth: 320 },
  labelFiltros: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  inputFechaCompact: { fontSize: 13, paddingVertical: 8, paddingHorizontal: 10, minHeight: 40 },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8, marginBottom: 12 },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  hint: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', marginTop: 8 },

  totalCard: { backgroundColor: '#f0fdf4', borderRadius: 12, borderWidth: 1, borderColor: '#bbf7d0', padding: 16, marginBottom: 16 },
  totalHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  totalHeadLabel: { flex: 1, fontSize: 15, fontWeight: '700', color: '#166534' },
  totalHeadVal: { fontSize: 22, fontWeight: '800', color: '#15803d' },
  totalChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1 },
  chipBilletes: { backgroundColor: '#f0fdfa', borderColor: '#99f6e4' },
  chipMonedas: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  chipRetiradas: { backgroundColor: '#f5f3ff', borderColor: '#ddd6fe' },
  chipText: { fontSize: 12, fontWeight: '700', color: '#334155' },
  sinDesgloseNote: { fontSize: 11, color: '#92400e', marginTop: 10, fontStyle: 'italic' },

  socCard: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', padding: 14, marginBottom: 12 },
  socHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  socHeadMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  socNombre: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  socIban: { fontSize: 12, color: '#0369a1', marginTop: 1 },
  socIbanFalta: { fontSize: 11, color: '#b45309', marginTop: 1, fontStyle: 'italic' },
  socTotal: { fontSize: 17, fontWeight: '800', color: '#15803d' },
  socChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  socChipBilletes: { fontSize: 12, fontWeight: '600', color: '#0f766e' },
  socChipMonedas: { fontSize: 12, fontWeight: '600', color: '#b45309' },
  socChipRet: { fontSize: 12, fontWeight: '600', color: '#7c3aed' },

  tablaHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  thLocal: { flex: 1, fontSize: 10, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase' },
  thNum: { width: 88, fontSize: 10, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', textAlign: 'right' },
  tablaRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#f8fafc' },
  tdLocalWrap: { flex: 1, minWidth: 0 },
  tdLocal: { fontSize: 13, color: '#334155', fontWeight: '600' },
  tdLocalSub: { fontSize: 10, color: '#7c3aed', marginTop: 1 },
  tdLocalWarn: { fontSize: 10, color: '#b45309', marginTop: 1 },
  tdNum: { width: 88, fontSize: 13, color: '#475569', textAlign: 'right' },
  tdNumFuerte: { fontWeight: '700', color: '#15803d' },
  errorText: { padding: 16, color: '#b91c1c' },
});
