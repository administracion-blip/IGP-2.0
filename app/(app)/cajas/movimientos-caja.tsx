import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Modal,
  Pressable,
  Image,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };
type SaleCenter = { Id?: number; Nombre?: string; Local?: string; Activo?: boolean };

const TIPO_RETIRADA = 'retirada';
const TIPO_TRANSFERENCIA = 'transferencia';

const TIPO_META: Record<string, { label: string; icon: React.ComponentProps<typeof MaterialIcons>['name']; color: string; bg: string; border: string }> = {
  [TIPO_RETIRADA]: { label: 'Retirada', icon: 'payments', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  [TIPO_TRANSFERENCIA]: { label: 'Transferencia', icon: 'swap-horiz', color: '#075985', bg: '#e0f2fe', border: '#7dd3fc' },
};

const CHIP_TIPO_PASTEL: Record<
  'todos' | typeof TIPO_RETIRADA | typeof TIPO_TRANSFERENCIA,
  { bg: string; bgSel: string; border: string; borderSel: string; text: string }
> = {
  todos: { bg: '#f8fafc', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#475569' },
  [TIPO_RETIRADA]: { bg: '#fffbeb', bgSel: '#fde68a', border: '#fde68a', borderSel: '#fcd34d', text: '#92400e' },
  [TIPO_TRANSFERENCIA]: { bg: '#e0f2fe', bgSel: '#bae6fd', border: '#bae6fd', borderSel: '#7dd3fc', text: '#075985' },
};

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

type Movimiento = {
  PK: string;
  SK: string;
  id?: string;
  BusinessDay?: string;
  PosId?: string;
  PosName?: string;
  tipo: string;
  importe: number;
  concepto?: string;
  justificanteKey?: string;
  hora?: string;
  creadoEn?: string;
  usuarioNombre?: string;
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
  const parts = n.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

function parseEuroInput(s: string): number {
  const n = parseFloat(String(s).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function obtenerUriImagen(source: 'library' | 'camera'): Promise<string | null> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return null;
    const res = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (res.canceled || !res.assets?.[0]?.uri) return null;
    return res.assets[0].uri;
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.85,
  });
  if (res.canceled || !res.assets?.[0]?.uri) return null;
  return res.assets[0].uri;
}

async function appendImagen(form: FormData, uri: string) {
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    const blob = await res.blob();
    form.append('imagen', blob, 'justificante.jpg');
  } else {
    form.append('imagen', { uri, name: 'justificante.jpg', type: 'image/jpeg' } as unknown as Blob);
  }
}

export default function MovimientosCajaScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ workplaceId?: string; posId?: string; posName?: string; businessDay?: string }>();
  const { hasPermiso, user } = useAuth();
  const { shouldStackToolbar } = useBreakpoint();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [saleCenters, setSaleCenters] = useState<SaleCenter[]>([]);

  const [businessDayIso, setBusinessDayIso] = useState(
    () => (typeof params.businessDay === 'string' && params.businessDay) || fechaJornadaNegocioIso(),
  );
  const [formLocal, setFormLocal] = useState(typeof params.workplaceId === 'string' ? params.workplaceId : '');
  const [formPosId, setFormPosId] = useState(typeof params.posId === 'string' ? params.posId : '');
  const [formPosName, setFormPosName] = useState(typeof params.posName === 'string' ? params.posName : '');

  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal de alta/edición
  const [modalOpen, setModalOpen] = useState(false);
  const [editSK, setEditSK] = useState<string | null>(null);
  const [tipo, setTipo] = useState(TIPO_RETIRADA);
  const [importe, setImporte] = useState('');
  const [concepto, setConcepto] = useState('');
  const [hora, setHora] = useState('');
  const [justificanteKey, setJustificanteKey] = useState('');
  const [justificanteUri, setJustificanteUri] = useState('');
  const [subiendoJustif, setSubiendoJustif] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const [filtroTipo, setFiltroTipo] = useState<'todos' | typeof TIPO_RETIRADA | typeof TIPO_TRANSFERENCIA>('todos');

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
    return saleCenters.filter((sc) => sc.Activo !== false && String(sc.Local ?? '').trim() === localName);
  }, [saleCenters, formLocal, agoraCodeToNombre]);

  useEffect(() => {
    apiFetch('/api/locales')
      .then((r) => safeJson<{ locales?: LocalItem[] }>(r))
      .then((d) => setLocales(d.locales || []))
      .catch(() => setLocales([]));
    apiFetch('/api/agora/sale-centers')
      .then((r) => safeJson<{ saleCenters?: SaleCenter[] }>(r))
      .then((d) => setSaleCenters(d.saleCenters || []))
      .catch(() => setSaleCenters([]));
  }, []);

  useEffect(() => {
    if (formLocal && formPosId && saleCentersPorLocal.length > 0 && !saleCentersPorLocal.some((sc) => String(sc.Id) === formPosId)) {
      setFormPosId('');
      setFormPosName('');
    }
  }, [formLocal, saleCentersPorLocal, formPosId]);

  const fetchMovimientos = useCallback(() => {
    if (!businessDayIso || !formLocal.trim() || !formPosId) {
      setMovimientos([]);
      return;
    }
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ workplaceId: formLocal.trim(), businessDay: businessDayIso, posId: formPosId });
    apiFetch(`/api/cajas/movimientos?${q}`)
      .then((r) => safeJson<{ movimientos?: Movimiento[]; error?: string }>(r))
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setMovimientos(Array.isArray(d.movimientos) ? d.movimientos : []);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Error al cargar movimientos');
        setMovimientos([]);
      })
      .finally(() => setLoading(false));
  }, [businessDayIso, formLocal, formPosId]);

  useEffect(() => {
    const t = setTimeout(fetchMovimientos, 250);
    return () => clearTimeout(t);
  }, [fetchMovimientos]);

  const totales = useMemo(() => {
    let retiradas = 0;
    let transferencias = 0;
    for (const m of movimientos) {
      if (m.tipo === TIPO_RETIRADA) retiradas += Number(m.importe) || 0;
      else if (m.tipo === TIPO_TRANSFERENCIA) transferencias += Number(m.importe) || 0;
    }
    return {
      retiradas: Math.round(retiradas * 100) / 100,
      transferencias: Math.round(transferencias * 100) / 100,
      total: movimientos.length,
    };
  }, [movimientos]);

  const conteoPorTipo = useMemo(() => ({
    todos: movimientos.length,
    [TIPO_RETIRADA]: movimientos.filter((m) => m.tipo === TIPO_RETIRADA).length,
    [TIPO_TRANSFERENCIA]: movimientos.filter((m) => m.tipo === TIPO_TRANSFERENCIA).length,
  }), [movimientos]);

  const movimientosFiltrados = useMemo(() => {
    if (filtroTipo === 'todos') return movimientos;
    return movimientos.filter((m) => m.tipo === filtroTipo);
  }, [movimientos, filtroTipo]);

  const resetForm = useCallback(() => {
    setEditSK(null);
    setTipo(TIPO_RETIRADA);
    setImporte('');
    setConcepto('');
    setHora('');
    setJustificanteKey('');
    setJustificanteUri('');
  }, []);

  const abrirNuevo = useCallback(() => {
    if (!formLocal.trim() || !formPosId) {
      setError('Selecciona local y TPV antes de añadir un movimiento.');
      return;
    }
    resetForm();
    setModalOpen(true);
  }, [formLocal, formPosId, resetForm]);

  const abrirEditar = useCallback((m: Movimiento) => {
    setEditSK(m.SK);
    setTipo(m.tipo);
    setImporte(String(m.importe ?? '').replace('.', ','));
    setConcepto(m.concepto ?? '');
    setHora(m.hora ?? '');
    setJustificanteKey(m.justificanteKey ?? '');
    setJustificanteUri('');
    setModalOpen(true);
    if (m.justificanteKey) {
      apiFetch(`/api/cajas/movimientos/justificante-url?key=${encodeURIComponent(m.justificanteKey)}`)
        .then((r) => safeJson<{ url?: string }>(r))
        .then((d) => { if (d.url) setJustificanteUri(d.url); })
        .catch(() => {});
    }
  }, []);

  const subirJustificante = useCallback(async (source: 'library' | 'camera') => {
    const uri = await obtenerUriImagen(source);
    if (!uri) return;
    setJustificanteUri(uri);
    setSubiendoJustif(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('workplaceId', formLocal.trim());
      form.append('businessDay', businessDayIso);
      await appendImagen(form, uri);
      const res = await apiFetch('/api/cajas/movimientos/justificante', { method: 'POST', body: form });
      const data = await safeJson<{ ok?: boolean; key?: string; url?: string; error?: string }>(res);
      if (!res.ok || data.error || !data.key) throw new Error(data.error || 'Error al subir el justificante');
      setJustificanteKey(data.key);
      if (data.url) setJustificanteUri(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al subir el justificante');
      setJustificanteUri('');
    } finally {
      setSubiendoJustif(false);
    }
  }, [formLocal, businessDayIso]);

  const guardarMovimiento = useCallback(async () => {
    const imp = parseEuroInput(importe);
    if (!(imp > 0)) {
      setError('Indica un importe mayor que 0.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        workplaceId: formLocal.trim(),
        businessDay: businessDayIso,
        posId: formPosId,
        posName: formPosName,
        workplaceName: agoraCodeToNombre[formLocal.trim()] ?? formLocal,
        tipo,
        importe: String(importe).replace(',', '.'),
        concepto,
        hora,
        justificanteKey,
        usuarioId: user?.id_usuario,
        usuarioNombre: user?.Nombre,
      };
      if (editSK) body.SK = editSK;
      const res = await apiFetch('/api/cajas/movimientos', {
        method: editSK ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      const data = await safeJson<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data.error) throw new Error(data.error || 'Error al guardar el movimiento');
      setModalOpen(false);
      resetForm();
      fetchMovimientos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar el movimiento');
    } finally {
      setSaving(false);
    }
  }, [importe, formLocal, businessDayIso, formPosId, formPosName, agoraCodeToNombre, tipo, concepto, hora, justificanteKey, editSK, user, resetForm, fetchMovimientos]);

  const eliminarMovimiento = useCallback(async (m: Movimiento) => {
    setError(null);
    try {
      const q = new URLSearchParams({ PK: m.PK, SK: m.SK });
      const res = await apiFetch(`/api/cajas/movimientos?${q}`, { method: 'DELETE' });
      const data = await safeJson<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data.error) throw new Error(data.error || 'Error al eliminar');
      fetchMovimientos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar el movimiento');
    }
  }, [fetchMovimientos]);

  const verJustificante = useCallback(async (key?: string) => {
    if (!key) return;
    try {
      const r = await apiFetch(`/api/cajas/movimientos/justificante-url?key=${encodeURIComponent(key)}`);
      const d = await safeJson<{ url?: string }>(r);
      if (d.url) setLightboxUri(d.url);
    } catch { /* noop */ }
  }, []);

  if (!hasPermiso('cierres.ver')) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.errorText}>No tienes permiso para ver esta pantalla.</Text>
      </View>
    );
  }

  const tpvSeleccionado = !!(formLocal.trim() && formPosId);
  const localNombre = agoraCodeToNombre[formLocal.trim()] || formLocal;
  const chipKeys: ('todos' | typeof TIPO_RETIRADA | typeof TIPO_TRANSFERENCIA)[] = ['todos', TIPO_RETIRADA, TIPO_TRANSFERENCIA];
  const chipLabels: Record<string, string> = {
    todos: 'Todos',
    [TIPO_RETIRADA]: 'Retiradas',
    [TIPO_TRANSFERENCIA]: 'Transferencias',
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={64}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Movimientos de caja</Text>
        {tpvSeleccionado ? (
          <TouchableOpacity style={styles.createBtn} onPress={abrirNuevo} activeOpacity={0.8}>
            <MaterialIcons name="add" size={16} color="#fff" />
            <Text style={styles.createBtnText}>Nuevo</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        <View style={[styles.filtrosRow, shouldStackToolbar && styles.filtrosRowStack]}>
          <View style={styles.filtrosColFecha}>
            <Text style={styles.labelFiltros}>Fecha negocio</Text>
            <InputFecha valueIso={businessDayIso} onChangeIso={setBusinessDayIso} placeholder="dd/mm/aaaa" style={styles.inputFechaCompact} />
          </View>
          <View style={styles.filtrosColSelect}>
            <Text style={styles.labelFiltros}>Local</Text>
            <SelectorDesplegable
              icono="store"
              iconoLista="store"
              tituloLista="Local"
              placeholder="Seleccionar…"
              buscador
              buscadorPlaceholder="Buscar local…"
              valorId={formLocal}
              opciones={locales
                .map((loc) => ({
                  code: String(loc.agoraCode ?? loc.AgoraCode ?? '').trim(),
                  nombre: String(loc.nombre ?? loc.Nombre ?? '').trim(),
                }))
                .filter((l) => l.code)
                .map((l) => ({ id: l.code, titulo: l.nombre || '—', subtitulo: `id ${l.code}`, icono: 'store' as const }))}
              onSeleccionar={(code) => setFormLocal(code)}
            />
          </View>
          <View style={styles.filtrosColSelect}>
            <Text style={styles.labelFiltros}>TPV</Text>
            <SelectorDesplegable
              icono="point-of-sale"
              iconoLista="point-of-sale"
              tituloLista="TPV"
              placeholder="Seleccionar…"
              disabled={!formLocal}
              vacioTexto="No hay TPVs activos para este local."
              valorId={formPosId}
              opciones={saleCentersPorLocal.map((sc) => {
                const id = sc.Id != null ? String(sc.Id) : '';
                const nom = String(sc.Nombre ?? '').trim() || `TPV ${id}`;
                return { id, titulo: nom, subtitulo: `id ${id}`, icono: 'point-of-sale' as const };
              })}
              onSeleccionar={(id) => {
                const sc = saleCentersPorLocal.find((s) => String(s.Id) === id);
                setFormPosId(id);
                setFormPosName(String(sc?.Nombre ?? '').trim() || `TPV ${id}`);
              }}
            />
          </View>
        </View>

        {tpvSeleccionado ? (
          <>
            <View style={styles.chipRowEstado}>
              {chipKeys.map((key) => {
                const pastel = CHIP_TIPO_PASTEL[key];
                const sel = filtroTipo === key;
                const n = conteoPorTipo[key] ?? 0;
                return (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.estadoChip,
                      {
                        backgroundColor: sel ? pastel.bgSel : pastel.bg,
                        borderColor: sel ? pastel.borderSel : pastel.border,
                      },
                    ]}
                    onPress={() => setFiltroTipo(key)}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.estadoChipText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                      {chipLabels[key]}
                    </Text>
                    <View style={[styles.estadoChipCount, sel && styles.estadoChipCountSel]}>
                      <Text style={[styles.estadoChipCountText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                        {n}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.kpiRow}>
              <KpiCard label="Retiradas" value={formatMoneda(totales.retiradas)} color="#d97706" />
              <KpiCard label="Transferencias" value={formatMoneda(totales.transferencias)} color="#0ea5e9" />
              <KpiCard label="Movimientos" value={String(totales.total)} />
            </View>
          </>
        ) : null}

        <Text style={styles.lead}>
          Retiradas y transferencias de prepago. El arqueo del TPV las lee automáticamente.
        </Text>
      </View>

      {error ? (
        <View style={styles.errorBar}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      {!tpvSeleccionado ? (
        <View style={styles.emptyWrap}>
          <MaterialIcons name="point-of-sale" size={40} color="#cbd5e1" />
          <Text style={styles.emptyText}>Selecciona fecha, local y TPV para ver y registrar movimientos.</Text>
        </View>
      ) : loading ? (
        <View style={styles.center}><ActivityIndicator color="#0ea5e9" /></View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
          {tpvSeleccionado ? (
            <View style={styles.contextBar}>
              <Text style={styles.contextText} numberOfLines={1}>
                {localNombre} · {formPosName || `TPV ${formPosId}`}
              </Text>
            </View>
          ) : null}

          {movimientosFiltrados.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="receipt-long" size={40} color="#cbd5e1" />
              <Text style={styles.emptyText}>
                {movimientos.length === 0
                  ? 'No hay movimientos registrados para este TPV y jornada.'
                  : 'No hay movimientos con este filtro.'}
              </Text>
            </View>
          ) : (
            movimientosFiltrados.map((m) => {
              const meta = TIPO_META[m.tipo] ?? TIPO_META[TIPO_RETIRADA];
              return (
                <View key={m.SK} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardTitleWrap}>
                      <MaterialIcons name={meta.icon} size={16} color={meta.color} />
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {m.tipo === TIPO_RETIRADA ? 'Retirada de efectivo' : 'Transferencia prepago'}
                      </Text>
                      <View style={[styles.badge, { backgroundColor: meta.bg, borderColor: meta.border }]}>
                        <Text style={[styles.badgeText, { color: meta.color }]}>{meta.label}</Text>
                      </View>
                    </View>
                    <View style={styles.cardActions}>
                      {m.justificanteKey ? (
                        <TouchableOpacity style={styles.cardActionBtn} onPress={() => verJustificante(m.justificanteKey)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <MaterialIcons name="image" size={18} color="#0ea5e9" />
                        </TouchableOpacity>
                      ) : null}
                      <TouchableOpacity style={styles.cardActionBtn} onPress={() => abrirEditar(m)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <MaterialIcons name="edit" size={18} color="#64748b" />
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.cardActionBtn} onPress={() => eliminarMovimiento(m)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <MaterialIcons name="delete-outline" size={18} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  </View>
                  <View style={styles.cardBody}>
                    <View style={styles.cardField}>
                      <Text style={styles.cardFieldLabel}>Importe</Text>
                      <Text style={[styles.cardFieldValue, { fontWeight: '700', color: meta.color }]}>
                        {formatMoneda(Number(m.importe) || 0)}
                      </Text>
                    </View>
                    {m.hora ? (
                      <View style={styles.cardField}>
                        <Text style={styles.cardFieldLabel}>Hora</Text>
                        <Text style={styles.cardFieldValue}>{m.hora}</Text>
                      </View>
                    ) : null}
                    {m.usuarioNombre ? (
                      <View style={styles.cardField}>
                        <Text style={styles.cardFieldLabel}>Usuario</Text>
                        <Text style={styles.cardFieldValue} numberOfLines={1}>{m.usuarioNombre}</Text>
                      </View>
                    ) : null}
                    {m.concepto ? (
                      <View style={[styles.cardField, { minWidth: 160, flex: 1 }]}>
                        <Text style={styles.cardFieldLabel}>Concepto</Text>
                        <Text style={styles.cardFieldValue} numberOfLines={2}>{m.concepto}</Text>
                      </View>
                    ) : null}
                    {m.justificanteKey ? (
                      <View style={styles.cardField}>
                        <Text style={styles.cardFieldLabel}>Justificante</Text>
                        <Text style={[styles.cardFieldValue, { color: '#0ea5e9' }]}>Adjunto</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setModalOpen(false)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editSK ? 'Editar movimiento' : 'Nuevo movimiento'}</Text>
              <TouchableOpacity onPress={() => setModalOpen(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <MaterialIcons name="close" size={24} color="#64748b" />
              </TouchableOpacity>
            </View>

            <Text style={styles.fieldLabel}>Tipo</Text>
            <View style={styles.tipoRow}>
              {[TIPO_RETIRADA, TIPO_TRANSFERENCIA].map((t) => {
                const meta = TIPO_META[t];
                const sel = tipo === t;
                return (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tipoBtn, sel && { borderColor: meta.color, backgroundColor: meta.bg }]}
                    onPress={() => setTipo(t)}
                    activeOpacity={0.8}
                  >
                    <MaterialIcons name={meta.icon} size={18} color={sel ? meta.color : '#94a3b8'} />
                    <Text style={[styles.tipoBtnText, sel && { color: meta.color }]}>
                      {t === TIPO_RETIRADA ? 'Retirada de efectivo' : 'Transferencia prepago'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>Importe (€)</Text>
            <TextInput
              style={styles.input}
              value={importe}
              onChangeText={setImporte}
              keyboardType="decimal-pad"
              placeholder="0,00"
              placeholderTextColor="#94a3b8"
            />

            <View style={styles.field2}>
              <View style={styles.field2Col}>
                <Text style={styles.fieldLabel}>Hora (opcional)</Text>
                <TextInput
                  style={styles.input}
                  value={hora}
                  onChangeText={setHora}
                  placeholder="hh:mm"
                  placeholderTextColor="#94a3b8"
                  maxLength={5}
                />
              </View>
            </View>

            <Text style={styles.fieldLabel}>Concepto (opcional)</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={concepto}
              onChangeText={setConcepto}
              placeholder={tipo === TIPO_RETIRADA ? 'Motivo de la retirada…' : 'Detalle de la transferencia…'}
              placeholderTextColor="#94a3b8"
              multiline
            />

            <Text style={styles.fieldLabel}>Justificante (opcional)</Text>
            <View style={styles.justifRow}>
              {Platform.OS !== 'web' ? (
                <TouchableOpacity style={styles.justifBtn} onPress={() => subirJustificante('camera')} disabled={subiendoJustif}>
                  <MaterialIcons name="photo-camera" size={20} color="#0369a1" />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.justifBtn} onPress={() => subirJustificante('library')} disabled={subiendoJustif}>
                <MaterialIcons name="photo-library" size={20} color="#0369a1" />
              </TouchableOpacity>
              {subiendoJustif ? <ActivityIndicator size="small" color="#0ea5e9" /> : null}
              {justificanteUri ? (
                <TouchableOpacity onPress={() => setLightboxUri(justificanteUri)} activeOpacity={0.85}>
                  <Image source={{ uri: justificanteUri }} style={styles.justifThumb} resizeMode="cover" />
                </TouchableOpacity>
              ) : justificanteKey ? (
                <Text style={styles.justifOk}>Justificante adjunto</Text>
              ) : (
                <Text style={styles.justifHint}>Adjunta foto del recibo / transferencia</Text>
              )}
            </View>

            <TouchableOpacity
              style={[styles.saveBtn, (saving || subiendoJustif) && styles.saveBtnDis]}
              onPress={guardarMovimiento}
              disabled={saving || subiendoJustif}
            >
              {saving ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <MaterialIcons name="save" size={20} color="#fff" />
                  <Text style={styles.saveBtnText}>{editSK ? 'Guardar cambios' : 'Registrar movimiento'}</Text>
                </>
              )}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={lightboxUri != null} transparent animationType="fade" onRequestClose={() => setLightboxUri(null)}>
        <View style={styles.lightboxWrap}>
          <TouchableOpacity style={styles.lightboxClose} onPress={() => setLightboxUri(null)} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}>
            <MaterialIcons name="close" size={28} color="#f8fafc" />
          </TouchableOpacity>
          <Pressable style={styles.lightboxInner} onPress={() => setLightboxUri(null)}>
            {lightboxUri ? <Image source={{ uri: lightboxUri }} style={styles.lightboxImg} resizeMode="contain" /> : null}
          </Pressable>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { padding: 40, alignItems: 'center', gap: 8 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12, paddingHorizontal: 24 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },

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
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  createBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  toolbar: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  filtrosRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8 },
  filtrosRowStack: { flexDirection: 'column' },
  filtrosColFecha: { flexGrow: 1, flexShrink: 1, minWidth: 132, maxWidth: 200 },
  filtrosColSelect: { flexGrow: 1, flexShrink: 1, minWidth: 140, maxWidth: 280 },
  labelFiltros: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  inputFechaCompact: { fontSize: 13, paddingVertical: 8, paddingHorizontal: 10, minHeight: 40 },

  chipRowEstado: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  estadoChipText: { fontSize: 11, fontWeight: '600' },
  estadoChipTextSel: { fontWeight: '800' },
  estadoChipCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(15,23,42,0.06)',
    alignItems: 'center',
  },
  estadoChipCountSel: { backgroundColor: 'rgba(15,23,42,0.10)' },
  estadoChipCountText: { fontSize: 10, fontWeight: '700' },

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 100,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  kpiValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginTop: 2 },

  lead: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },

  errorBar: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { fontSize: 12, color: '#dc2626' },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 32, maxWidth: 720, width: '100%', alignSelf: 'center' },
  contextBar: {
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  contextText: { fontSize: 11, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  cardActionBtn: { padding: 6 },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontSize: 13, color: '#334155' },

  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'center', padding: 20,
    ...(Platform.OS === 'web' ? { zIndex: 9999 } as object : {}),
  },
  modalSheet: {
    alignSelf: 'center', width: '100%', maxWidth: 460, backgroundColor: '#fff', borderRadius: 12,
    maxHeight: '90%', padding: 18,
    ...(Platform.OS === 'web' ? { boxShadow: '0 16px 48px rgba(0,0,0,0.2)', zIndex: 10000 } as object : { elevation: 12 }),
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', flex: 1, marginRight: 8 },
  fieldLabel: { fontSize: 11, fontWeight: '600', color: '#64748b', marginBottom: 6, marginTop: 10, textTransform: 'uppercase', letterSpacing: 0.3 },
  tipoRow: { flexDirection: 'row', gap: 8 },
  tipoBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#f8fafc',
  },
  tipoBtnText: { fontSize: 11, fontWeight: '600', color: '#94a3b8', textAlign: 'center' },
  input: {
    borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10,
    fontSize: 15, color: '#334155', backgroundColor: '#f8fafc',
  },
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  field2: { flexDirection: 'row', gap: 10 },
  field2Col: { flex: 1 },
  justifRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  justifBtn: { padding: 10, borderRadius: 10, backgroundColor: '#f0f9ff', borderWidth: 1, borderColor: '#bae6fd' },
  justifThumb: { width: 44, height: 44, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  justifHint: { fontSize: 12, color: '#94a3b8', flexShrink: 1 },
  justifOk: { fontSize: 12, color: '#059669', fontWeight: '600' },
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 18, paddingVertical: 14, backgroundColor: '#0ea5e9', borderRadius: 10,
  },
  saveBtnDis: { opacity: 0.6 },
  saveBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  lightboxWrap: { flex: 1, backgroundColor: 'rgba(15,23,42,0.92)', justifyContent: 'center', padding: 12 },
  lightboxClose: { position: 'absolute', top: Platform.OS === 'ios' ? 48 : 24, right: 16, zIndex: 2, padding: 8 },
  lightboxInner: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  lightboxImg: { width: '100%', height: '100%', maxHeight: 720 },
});
