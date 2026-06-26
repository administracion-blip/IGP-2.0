/**
 * Top (Cajas)
 * Rankings por rango de fechas:
 *   - Ventas por local (todos los locales con registros)
 *   - Consecución de objetivos: real / comparativa * 100 (todos los locales con registros)
 *   - Top 10 camareros por importe (Waiter en Ágora)
 *   - Top 10 clientes por importe (excluye CONSUMO por defecto)
 *
 * Fuente: GET /api/cajas/top (cacheado 2 min en backend).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Pressable,
  Switch,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import { generarPdfTop, pdfTopFileSlug } from './pdfTop';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };

type TopLocalRow = {
  rank: number;
  workplaceId: string;
  nombre: string;
  total: number;
};
type TopObjetivoRow = {
  rank: number;
  workplaceId: string;
  nombre: string;
  real: number;
  comparativa: number;
  variacionPct: number | null;
};
type TopCamareroRow = {
  rank: number;
  userId: string;
  userName: string;
  amount: number;
  tickets: number;
};
type TopClienteRow = {
  rank: number;
  customerId: string;
  customerName: string;
  amount: number;
  tickets: number;
  consumo?: boolean;
};

type TopResponse = {
  dateFrom: string;
  dateTo: string;
  workplaceIds: string[];
  incluirConsumo: boolean;
  limit: number;
  locales: TopLocalRow[];
  objetivos: TopObjetivoRow[];
  camareros: TopCamareroRow[];
  clientes: TopClienteRow[];
  cachedAt: string;
  fromCache: boolean;
  error?: string;
};

function todayDmy() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function parseDateToYYYYMMDD(input: string): string | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const date = new Date(y, mo - 1, d);
    if (date.getDate() === d && date.getMonth() === mo - 1 && date.getFullYear() === y) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function formatMoneda(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0,00 €';
  const parts = value.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

/** Formatea variación interanual con signo explícito: +67,4 %, −12,9 %, 0,0 %. */
function formatVariacionPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value).toFixed(1).replace('.', ',');
  if (value > 0) return `+${abs} %`;
  if (value < 0) return `−${abs} %`;
  return `0,0 %`;
}

async function safeJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}: ${res.statusText || 'Servidor no disponible'}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}: ${res.statusText || 'Servidor no disponible'}`);
  }
}

export default function TopScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeExportar = hasPermiso('top.exportar');

  const [fechaDesdeInput, setFechaDesdeInput] = useState<string>(todayDmy());
  const [fechaHastaInput, setFechaHastaInput] = useState<string>(todayDmy());
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [filtroLocales, setFiltroLocales] = useState<string[]>([]);
  const [localesOpen, setLocalesOpen] = useState(false);
  const [incluirConsumo, setIncluirConsumo] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TopResponse | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    apiFetch('/api/locales')
      .then((res) => safeJson<{ locales?: LocalItem[] }>(res))
      .then((d) => setLocales(d.locales || []))
      .catch(() => setLocales([]));
  }, []);

  const localesOrdenados = useMemo(() => {
    return [...locales].sort((a, b) => {
      const na = String(a.nombre ?? a.Nombre ?? a.agoraCode ?? a.AgoraCode ?? '').trim();
      const nb = String(b.nombre ?? b.Nombre ?? b.agoraCode ?? b.AgoraCode ?? '').trim();
      return na.localeCompare(nb, 'es', { sensitivity: 'base' });
    });
  }, [locales]);

  const agoraCodeToNombre = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of locales) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) map[code] = nombre || '—';
    }
    return map;
  }, [locales]);

  const toggleLocal = (code: string) => {
    setFiltroLocales((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const consultar = useCallback(async (opts?: { refresh?: boolean }) => {
    const isoFrom = parseDateToYYYYMMDD(fechaDesdeInput);
    const isoTo = parseDateToYYYYMMDD(fechaHastaInput);
    if (!isoFrom || !isoTo) {
      setError('Fechas no válidas (dd/mm/yyyy)');
      return;
    }
    if (isoFrom > isoTo) {
      setError('La fecha "Desde" debe ser anterior o igual a "Hasta"');
      return;
    }
    const MAX_DAYS = filtroLocales.length === 1 ? 365 : 31;
    const msDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.round(
      (new Date(isoTo + 'T12:00:00').getTime() - new Date(isoFrom + 'T12:00:00').getTime()) / msDay,
    ) + 1;
    if (diffDays > MAX_DAYS) {
      setError(
        filtroLocales.length === 1
          ? `Rango máximo permitido: ${MAX_DAYS} días`
          : `Rango máximo permitido: ${MAX_DAYS} días con ${filtroLocales.length === 0 ? 'todos los locales' : `${filtroLocales.length} locales`}. Selecciona 1 solo local para ampliar hasta 365 días.`,
      );
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('dateFrom', isoFrom);
      params.set('dateTo', isoTo);
      if (filtroLocales.length > 0) params.set('workplaceIds', filtroLocales.join(','));
      params.set('incluirConsumo', incluirConsumo ? '1' : '0');
      if (opts?.refresh) params.set('refresh', '1');
      const res = await apiFetch(`/api/cajas/top?${params.toString()}`, { timeoutMs: 180_000 });
      const json = await safeJson<TopResponse>(res);
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (e) {
      const msg =
        e instanceof Error && /abort/i.test(e.message)
          ? 'La consulta tardó demasiado. Reduce el rango de fechas o el número de locales seleccionados.'
          : e instanceof Error ? e.message : 'Error de conexión';
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fechaDesdeInput, fechaHastaInput, filtroLocales, incluirConsumo]);

  const exportarPdf = useCallback(async () => {
    if (!data) return;
    setExporting(true);
    try {
      const doc = await generarPdfTop(data, {
        titulo: 'Top — Cajas',
        incluirConsumo: data.incluirConsumo,
      });
      const slug = pdfTopFileSlug(data.dateFrom, data.dateTo, data.workplaceIds.map((c) => agoraCodeToNombre[c] ?? c));
      const filename = `${slug}.pdf`;
      if (Platform.OS === 'web') {
        doc.save(filename);
      } else {
        const dataUri = doc.output('datauristring');
        const base64 = dataUri.split(',')[1] ?? '';
        const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
        const fileUri = `${cacheDir}${filename}`;
        await FileSystemLegacy.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: filename });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error generando PDF');
    } finally {
      setExporting(false);
    }
  }, [data, agoraCodeToNombre]);

  const totales = useMemo(() => {
    if (!data) return null;
    const totalLocales = data.locales.reduce((s, r) => s + (r.total || 0), 0);
    const totalCam = data.camareros.reduce((s, r) => s + (r.amount || 0), 0);
    const totalCli = data.clientes.reduce((s, r) => s + (r.amount || 0), 0);
    return { totalLocales, totalCam, totalCli };
  }, [data]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.replace('/cajas')}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Top</Text>
        <Text style={styles.subtitle}>· Ventas, objetivos, camareros y clientes</Text>
      </View>

      <View style={[styles.queryBlock, localesOpen && styles.queryBlockElevated]}>
        <Text style={styles.queryBlockTitle}>Consulta</Text>

        <View style={[styles.queryRow, styles.queryRowFilters]}>
          <View style={styles.dateWrap}>
            <Text style={styles.dateLabel}>Desde</Text>
            <InputFecha
              value={fechaDesdeInput}
              onChange={setFechaDesdeInput}
              format="dmy"
              placeholder="dd/mm/yyyy"
              style={styles.dateInput}
              editable={!loading}
            />
          </View>
          <View style={styles.dateWrap}>
            <Text style={styles.dateLabel}>Hasta</Text>
            <InputFecha
              value={fechaHastaInput}
              onChange={setFechaHastaInput}
              format="dmy"
              placeholder="dd/mm/yyyy"
              style={styles.dateInput}
              editable={!loading}
            />
          </View>

          <View style={styles.dateWrap}>
            <Text style={styles.dateLabel}>Locales</Text>
            <View style={[styles.builderDropdownWrap, localesOpen && styles.builderDropdownWrapOpen]}>
              <TouchableOpacity
                style={styles.builderDropdownTrigger}
                onPress={() => setLocalesOpen((v) => !v)}
                disabled={loading}
              >
                <Text style={styles.builderDropdownText} numberOfLines={1}>
                  {filtroLocales.length === 0
                    ? 'Todos'
                    : filtroLocales.length === 1
                      ? (agoraCodeToNombre[filtroLocales[0]] ?? filtroLocales[0])
                      : `${filtroLocales.length} locales`}
                </Text>
                <MaterialIcons name={localesOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
              </TouchableOpacity>
              {localesOpen && (
                <>
                  <Pressable style={styles.ddOverlay} onPress={() => setLocalesOpen(false)} />
                  <View style={styles.builderDropdownList}>
                    <TouchableOpacity
                      style={[styles.builderDropdownOption, filtroLocales.length === 0 && styles.builderDropdownOptionSelected]}
                      onPress={() => setFiltroLocales([])}
                    >
                      <Text style={[styles.builderDropdownOptionText, filtroLocales.length === 0 && styles.builderDropdownOptionTextSelected]}>
                        Todos
                      </Text>
                      {filtroLocales.length === 0 ? <MaterialIcons name="check" size={14} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                    <View style={styles.ddDivider} />
                    <ScrollView style={styles.builderDropdownScroll} nestedScrollEnabled>
                      {localesOrdenados.map((loc) => {
                        const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                        if (!code) return null;
                        const nombre = String(loc.nombre ?? loc.Nombre ?? code).trim();
                        const selected = filtroLocales.includes(code);
                        return (
                          <TouchableOpacity
                            key={code}
                            style={[styles.builderDropdownOption, styles.builderDropdownOptionWithCheck, selected && styles.builderDropdownOptionSelected]}
                            onPress={() => toggleLocal(code)}
                          >
                            <View style={styles.ddCheckbox}>
                              {selected ? <MaterialIcons name="check-box" size={14} color="#0ea5e9" /> : <MaterialIcons name="check-box-outline-blank" size={14} color="#cbd5e1" />}
                            </View>
                            <Text style={[styles.builderDropdownOptionText, selected && styles.builderDropdownOptionTextSelected]} numberOfLines={1}>
                              {nombre}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                </>
              )}
            </View>
          </View>

          <View style={styles.consumoToggleWrap}>
            <Text style={styles.dateLabel}>Incluir CONSUMO</Text>
            <Switch
              value={incluirConsumo}
              onValueChange={setIncluirConsumo}
              trackColor={{ false: '#cbd5e1', true: '#bae6fd' }}
              thumbColor={incluirConsumo ? '#0ea5e9' : '#f1f5f9'}
              disabled={loading}
            />
          </View>
        </View>

        <View style={[styles.queryRow, styles.queryRowActions]}>
          <TouchableOpacity
            style={[styles.btnPrimary, loading && styles.btnDisabled]}
            onPress={() => consultar()}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <MaterialIcons name="search" size={16} color="#fff" />
                <Text style={styles.btnPrimaryText}>Consultar</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnSecondary, (!data || loading) && styles.btnDisabled]}
            onPress={() => consultar({ refresh: true })}
            disabled={!data || loading}
          >
            <MaterialIcons name="refresh" size={16} color="#0ea5e9" />
            <Text style={styles.btnSecondaryText}>Refrescar</Text>
          </TouchableOpacity>
          {puedeExportar && (
            <TouchableOpacity
              style={[styles.btnSecondary, (!data || exporting) && styles.btnDisabled]}
              onPress={exportarPdf}
              disabled={!data || exporting}
            >
              {exporting ? <ActivityIndicator color="#0ea5e9" size="small" /> : <MaterialIcons name="picture-as-pdf" size={16} color="#0ea5e9" />}
              <Text style={styles.btnSecondaryText}>Descargar PDF</Text>
            </TouchableOpacity>
          )}
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {data?.fromCache ? (
          <Text style={styles.cacheNote}>
            Resultado de caché ({new Date(data.cachedAt).toLocaleTimeString('es-ES')}). Usa "Refrescar" para forzar nueva consulta.
          </Text>
        ) : null}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {!data ? (
          <View style={styles.emptyWrap}>
            <MaterialIcons name="emoji-events" size={36} color="#94a3b8" />
            <Text style={styles.emptyText}>Selecciona un rango y pulsa Consultar.</Text>
          </View>
        ) : (
          <>
            <SectionTopLocales filas={data.locales} total={totales?.totalLocales ?? 0} />
            <SectionTopObjetivos filas={data.objetivos} />
            <SectionTopCamareros filas={data.camareros} total={totales?.totalCam ?? 0} />
            <SectionTopClientes filas={data.clientes} total={totales?.totalCli ?? 0} incluirConsumo={data.incluirConsumo} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

// =========================================================================
// Secciones (tablas)
// =========================================================================

function TableHeader({ cols }: { cols: { label: string; width: number; align?: 'left' | 'right' }[] }) {
  return (
    <View style={styles.thead}>
      {cols.map((c, i) => (
        <View key={i} style={[styles.thCell, { width: c.width }, c.align === 'right' && styles.thCellRight]}>
          <Text style={[styles.thText, c.align === 'right' && styles.thTextRight]} numberOfLines={1}>{c.label}</Text>
        </View>
      ))}
    </View>
  );
}

function SectionTitle({ icon, title, subtitle }: { icon: React.ComponentProps<typeof MaterialIcons>['name']; title: string; subtitle?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <MaterialIcons name={icon} size={18} color="#0ea5e9" />
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.sectionSubtitle}>· {subtitle}</Text> : null}
    </View>
  );
}

function SectionTopLocales({ filas, total }: { filas: TopLocalRow[]; total: number }) {
  const cols = [
    { label: '#', width: 38 },
    { label: 'Local', width: 240 },
    { label: 'Importe', width: 120, align: 'right' as const },
  ];
  return (
    <View style={styles.sectionBlock}>
      <SectionTitle icon="storefront" title="Top ventas por local" subtitle={`${filas.length} locales con registros`} />
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <TableHeader cols={cols} />
          {filas.length === 0 ? (
            <Text style={styles.emptyRowText}>Sin registros en el rango.</Text>
          ) : (
            <>
              {filas.map((r) => (
                <View key={r.workplaceId} style={styles.tr}>
                  <View style={[styles.td, { width: cols[0].width }]}><Text style={styles.tdText}>{r.rank}</Text></View>
                  <View style={[styles.td, { width: cols[1].width }]}><Text style={styles.tdText} numberOfLines={1}>{r.nombre}</Text></View>
                  <View style={[styles.td, styles.tdRight, { width: cols[2].width }]}><Text style={styles.tdTextNum}>{formatMoneda(r.total)}</Text></View>
                </View>
              ))}
              <View style={[styles.tr, styles.trTotal]}>
                <View style={[styles.td, { width: cols[0].width }]}><Text style={styles.tdTextTotal}>—</Text></View>
                <View style={[styles.td, { width: cols[1].width }]}><Text style={styles.tdTextTotal}>TOTAL</Text></View>
                <View style={[styles.td, styles.tdRight, { width: cols[2].width }]}><Text style={styles.tdTextTotal}>{formatMoneda(total)}</Text></View>
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function SectionTopObjetivos({ filas }: { filas: TopObjetivoRow[] }) {
  const cols = [
    { label: '#', width: 38 },
    { label: 'Local', width: 220 },
    { label: 'Real', width: 110, align: 'right' as const },
    { label: 'Comparativa', width: 120, align: 'right' as const },
    { label: 'Variación', width: 100, align: 'right' as const },
  ];
  return (
    <View style={styles.sectionBlock}>
      <SectionTitle icon="flag" title="Top consecución de objetivos" subtitle={`${filas.length} locales · variación interanual (real vs año anterior)`} />
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <TableHeader cols={cols} />
          {filas.length === 0 ? (
            <Text style={styles.emptyRowText}>Sin registros en el rango.</Text>
          ) : (
            filas.map((r) => {
              const pct = r.variacionPct;
              const colorTxt =
                pct == null ? '#64748b'
                : pct > 0 ? '#15803d'
                : pct < 0 ? '#b91c1c'
                : '#92400e';
              return (
                <View key={r.workplaceId} style={styles.tr}>
                  <View style={[styles.td, { width: cols[0].width }]}><Text style={styles.tdText}>{r.rank}</Text></View>
                  <View style={[styles.td, { width: cols[1].width }]}><Text style={styles.tdText} numberOfLines={1}>{r.nombre}</Text></View>
                  <View style={[styles.td, styles.tdRight, { width: cols[2].width }]}><Text style={styles.tdTextNum}>{formatMoneda(r.real)}</Text></View>
                  <View style={[styles.td, styles.tdRight, { width: cols[3].width }]}><Text style={styles.tdTextNum}>{formatMoneda(r.comparativa)}</Text></View>
                  <View style={[styles.td, styles.tdRight, { width: cols[4].width }]}><Text style={[styles.tdTextNum, { color: colorTxt, fontWeight: '600' }]}>{formatVariacionPct(pct)}</Text></View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function SectionTopCamareros({ filas, total }: { filas: TopCamareroRow[]; total: number }) {
  const cols = [
    { label: '#', width: 38 },
    { label: 'Camarero', width: 220 },
    { label: 'Tickets', width: 80, align: 'right' as const },
    { label: 'Importe', width: 120, align: 'right' as const },
  ];
  return (
    <View style={styles.sectionBlock}>
      <SectionTitle icon="person" title="Top 10 ventas por camarero" />
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <TableHeader cols={cols} />
          {filas.length === 0 ? (
            <Text style={styles.emptyRowText}>Sin registros en el rango.</Text>
          ) : (
            <>
              {filas.map((r) => (
                <View key={r.userId} style={styles.tr}>
                  <View style={[styles.td, { width: cols[0].width }]}><Text style={styles.tdText}>{r.rank}</Text></View>
                  <View style={[styles.td, { width: cols[1].width }]}><Text style={styles.tdText} numberOfLines={1}>{r.userName}</Text></View>
                  <View style={[styles.td, styles.tdRight, { width: cols[2].width }]}><Text style={styles.tdTextNum}>{r.tickets}</Text></View>
                  <View style={[styles.td, styles.tdRight, { width: cols[3].width }]}><Text style={styles.tdTextNum}>{formatMoneda(r.amount)}</Text></View>
                </View>
              ))}
              <View style={[styles.tr, styles.trTotal]}>
                <View style={[styles.td, { width: cols[0].width }]}><Text style={styles.tdTextTotal}>—</Text></View>
                <View style={[styles.td, { width: cols[1].width }]}><Text style={styles.tdTextTotal}>TOTAL TOP 10</Text></View>
                <View style={[styles.td, styles.tdRight, { width: cols[2].width }]}><Text style={styles.tdTextTotal}>—</Text></View>
                <View style={[styles.td, styles.tdRight, { width: cols[3].width }]}><Text style={styles.tdTextTotal}>{formatMoneda(total)}</Text></View>
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function SectionTopClientes({
  filas,
  total,
  incluirConsumo,
}: {
  filas: TopClienteRow[];
  total: number;
  incluirConsumo: boolean;
}) {
  const cols = [
    { label: '#', width: 38 },
    { label: 'Cliente', width: 240 },
    { label: 'Tickets', width: 80, align: 'right' as const },
    { label: 'Importe', width: 120, align: 'right' as const },
  ];
  return (
    <View style={styles.sectionBlock}>
      <SectionTitle
        icon="emoji-people"
        title="Top 10 ventas por cliente"
        subtitle={incluirConsumo ? 'CONSUMO incluido' : 'CONSUMO excluido'}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <TableHeader cols={cols} />
          {filas.length === 0 ? (
            <Text style={styles.emptyRowText}>Sin registros en el rango.</Text>
          ) : (
            <>
              {filas.map((r) => (
                <View key={r.customerId} style={styles.tr}>
                  <View style={[styles.td, { width: cols[0].width }]}><Text style={styles.tdText}>{r.rank}</Text></View>
                  <View style={[styles.td, { width: cols[1].width }]}>
                    <Text style={styles.tdText} numberOfLines={1}>
                      {r.customerName}
                      {r.consumo ? <Text style={styles.tdConsumoTag}>  · CONSUMO</Text> : null}
                    </Text>
                  </View>
                  <View style={[styles.td, styles.tdRight, { width: cols[2].width }]}><Text style={styles.tdTextNum}>{r.tickets}</Text></View>
                  <View style={[styles.td, styles.tdRight, { width: cols[3].width }]}><Text style={styles.tdTextNum}>{formatMoneda(r.amount)}</Text></View>
                </View>
              ))}
              <View style={[styles.tr, styles.trTotal]}>
                <View style={[styles.td, { width: cols[0].width }]}><Text style={styles.tdTextTotal}>—</Text></View>
                <View style={[styles.td, { width: cols[1].width }]}><Text style={styles.tdTextTotal}>TOTAL TOP 10</Text></View>
                <View style={[styles.td, styles.tdRight, { width: cols[2].width }]}><Text style={styles.tdTextTotal}>—</Text></View>
                <View style={[styles.td, styles.tdRight, { width: cols[3].width }]}><Text style={styles.tdTextTotal}>{formatMoneda(total)}</Text></View>
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

// =========================================================================
// Estilos
// =========================================================================

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  backBtn: { padding: 4, borderRadius: 6 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b' },

  queryBlock: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    marginBottom: 10,
    gap: 8,
    zIndex: 5,
  },
  queryBlockElevated: { zIndex: 50 },
  queryBlockTitle: { fontSize: 12, fontWeight: '600', color: '#64748b', textTransform: 'uppercase' },
  queryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' },
  queryRowFilters: { zIndex: 20 },
  queryRowActions: { zIndex: 10 },

  dateWrap: { gap: 4, minWidth: 130 },
  dateLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  dateInput: {
    minWidth: 130,
    backgroundColor: '#fff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    color: '#0f172a',
  },

  builderDropdownWrap: { position: 'relative', minWidth: 180 },
  builderDropdownWrapOpen: { zIndex: 100 },
  builderDropdownTrigger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minWidth: 180, backgroundColor: '#fff', borderColor: '#e2e8f0', borderWidth: 1,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, gap: 6,
  },
  builderDropdownText: { fontSize: 13, color: '#0f172a', flexShrink: 1 },
  ddOverlay: { position: 'absolute', top: -1000, left: -1000, width: 5000, height: 5000 },
  builderDropdownList: {
    position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 220, maxHeight: 320,
    backgroundColor: '#fff', borderColor: '#e2e8f0', borderWidth: 1, borderRadius: 8,
    shadowColor: '#0f172a', shadowOpacity: 0.08, shadowRadius: 8, elevation: 5, zIndex: 100,
  },
  builderDropdownScroll: { maxHeight: 280 },
  builderDropdownOption: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 7, gap: 6,
  },
  builderDropdownOptionWithCheck: { gap: 8 },
  builderDropdownOptionSelected: { backgroundColor: '#f0f9ff' },
  builderDropdownOptionText: { fontSize: 13, color: '#334155', flex: 1 },
  builderDropdownOptionTextSelected: { color: '#0ea5e9', fontWeight: '600' },
  ddCheckbox: { width: 16, alignItems: 'center', justifyContent: 'center' },
  ddDivider: { height: 1, backgroundColor: '#e2e8f0' },

  consumoToggleWrap: { gap: 6, minWidth: 140 },

  btnPrimary: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#0ea5e9',
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, gap: 6,
  },
  btnPrimaryText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  btnSecondary: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff',
    borderColor: '#bae6fd', borderWidth: 1,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, gap: 6,
  },
  btnSecondaryText: { color: '#0ea5e9', fontSize: 13, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },

  errorText: { color: '#b91c1c', fontSize: 12, marginTop: 4 },
  cacheNote: { color: '#64748b', fontSize: 11, marginTop: 4, fontStyle: 'italic' },

  body: { flex: 1 },
  bodyContent: { paddingBottom: 24, gap: 12 },

  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 10 },
  emptyText: { color: '#64748b', fontSize: 13 },

  sectionBlock: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#f1f5f9', borderBottomWidth: 1, borderBottomColor: '#e2e8f0',
  },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  sectionSubtitle: { fontSize: 12, color: '#64748b' },

  thead: { flexDirection: 'row', backgroundColor: '#f8fafc', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  thCell: { paddingHorizontal: 8, paddingVertical: 7, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  thCellRight: { alignItems: 'flex-end' },
  thText: { fontSize: 12, fontWeight: '700', color: '#475569' },
  thTextRight: { textAlign: 'right' },

  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f1f5f9', backgroundColor: '#fff' },
  trTotal: { backgroundColor: '#f8fafc' },
  td: { paddingHorizontal: 8, paddingVertical: 6, borderRightWidth: 1, borderRightColor: '#f1f5f9', justifyContent: 'center' },
  tdRight: { alignItems: 'flex-end' },
  tdText: { fontSize: 12.5, color: '#0f172a' },
  tdTextNum: { fontSize: 12.5, color: '#0f172a', fontVariant: ['tabular-nums'] },
  tdTextTotal: { fontSize: 12.5, color: '#0f172a', fontWeight: '700' },
  tdConsumoTag: { fontSize: 10, color: '#0e7490', fontWeight: '400' },
  emptyRowText: { paddingHorizontal: 12, paddingVertical: 10, color: '#64748b', fontSize: 12, fontStyle: 'italic' },
});
