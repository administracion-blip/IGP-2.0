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
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };
type SaleCenter = { Id?: number; Nombre?: string; Local?: string; Activo?: boolean };

const TIPO_RETIRADA = 'retirada';
const TIPO_TRANSFERENCIA = 'transferencia';

const TIPO_META: Record<string, { label: string; icon: React.ComponentProps<typeof MaterialIcons>['name']; color: string; bg: string }> = {
  [TIPO_RETIRADA]: { label: 'Retirada de efectivo', icon: 'payments', color: '#b45309', bg: '#fffbeb' },
  [TIPO_TRANSFERENCIA]: { label: 'Transferencia prepago', icon: 'swap-horiz', color: '#0369a1', bg: '#f0f9ff' },
};

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
    };
  }, [movimientos]);

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
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para ver esta pantalla.</Text>
      </View>
    );
  }

  const tpvSeleccionado = !!(formLocal.trim() && formPosId);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={64}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.formMax}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <MaterialIcons name="arrow-back" size={22} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.title}>Movimientos de caja</Text>
          </View>
          <Text style={styles.lead}>
            Registra retiradas de efectivo y transferencias de prepago a cualquier hora. El arqueo del TPV los lee
            automáticamente: las retiradas se suman al efectivo y las transferencias son el prepago real.
          </Text>

          <View style={styles.filtrosRow}>
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
            <View style={styles.totalesRow}>
              <View style={[styles.totalCard, { backgroundColor: TIPO_META[TIPO_RETIRADA].bg }]}>
                <MaterialIcons name={TIPO_META[TIPO_RETIRADA].icon} size={18} color={TIPO_META[TIPO_RETIRADA].color} />
                <Text style={styles.totalCardLabel}>Retiradas</Text>
                <Text style={[styles.totalCardVal, { color: TIPO_META[TIPO_RETIRADA].color }]}>{formatMoneda(totales.retiradas)}</Text>
              </View>
              <View style={[styles.totalCard, { backgroundColor: TIPO_META[TIPO_TRANSFERENCIA].bg }]}>
                <MaterialIcons name={TIPO_META[TIPO_TRANSFERENCIA].icon} size={18} color={TIPO_META[TIPO_TRANSFERENCIA].color} />
                <Text style={styles.totalCardLabel}>Transferencias</Text>
                <Text style={[styles.totalCardVal, { color: TIPO_META[TIPO_TRANSFERENCIA].color }]}>{formatMoneda(totales.transferencias)}</Text>
              </View>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errBox}>
              <MaterialIcons name="error-outline" size={18} color="#dc2626" />
              <Text style={styles.errText}>{error}</Text>
            </View>
          ) : null}

          {tpvSeleccionado ? (
            <TouchableOpacity style={styles.addBtn} onPress={abrirNuevo} activeOpacity={0.8}>
              <MaterialIcons name="add" size={20} color="#fff" />
              <Text style={styles.addBtnText}>Añadir movimiento</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.hint}>Selecciona fecha, local y TPV para ver y registrar movimientos.</Text>
          )}

          {loading ? <ActivityIndicator style={{ marginVertical: 16 }} color="#0ea5e9" /> : null}

          {tpvSeleccionado && !loading ? (
            <View style={styles.listWrap}>
              {movimientos.length === 0 ? (
                <Text style={styles.empty}>No hay movimientos registrados para este TPV y jornada.</Text>
              ) : (
                movimientos.map((m) => {
                  const meta = TIPO_META[m.tipo] ?? TIPO_META[TIPO_RETIRADA];
                  return (
                    <View key={m.SK} style={styles.movCard}>
                      <View style={[styles.movIconWrap, { backgroundColor: meta.bg }]}>
                        <MaterialIcons name={meta.icon} size={20} color={meta.color} />
                      </View>
                      <View style={styles.movMain}>
                        <Text style={styles.movTipo}>{meta.label}</Text>
                        {m.concepto ? <Text style={styles.movConcepto} numberOfLines={2}>{m.concepto}</Text> : null}
                        <Text style={styles.movMeta}>
                          {m.hora ? `${m.hora} · ` : ''}{m.usuarioNombre || ''}
                        </Text>
                      </View>
                      <View style={styles.movRight}>
                        <Text style={[styles.movImporte, { color: meta.color }]}>{formatMoneda(Number(m.importe) || 0)}</Text>
                        <View style={styles.movActions}>
                          {m.justificanteKey ? (
                            <TouchableOpacity onPress={() => verJustificante(m.justificanteKey)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                              <MaterialIcons name="image" size={20} color="#0ea5e9" />
                            </TouchableOpacity>
                          ) : null}
                          <TouchableOpacity onPress={() => abrirEditar(m)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <MaterialIcons name="edit" size={20} color="#64748b" />
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => eliminarMovimiento(m)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <MaterialIcons name="delete-outline" size={20} color="#b91c1c" />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          ) : null}

          <View style={{ height: 32 }} />
        </View>
      </ScrollView>

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
                    <Text style={[styles.tipoBtnText, sel && { color: meta.color }]}>{meta.label}</Text>
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
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 40, alignItems: 'center' },
  formMax: { width: '100%', maxWidth: 640 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  lead: { fontSize: 13, color: '#64748b', marginBottom: 16, lineHeight: 20 },
  filtrosRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, marginBottom: 16 },
  filtrosColFecha: { flexGrow: 1, flexShrink: 1, minWidth: 132, maxWidth: 200 },
  filtrosColSelect: { flexGrow: 0, flexShrink: 1, minWidth: 140, maxWidth: 288, alignSelf: 'flex-start' },
  labelFiltros: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  inputFechaCompact: { fontSize: 13, paddingVertical: 8, paddingHorizontal: 10, minHeight: 40 },
  totalesRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  totalCard: { flex: 1, borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', padding: 12, gap: 4 },
  totalCardLabel: { fontSize: 11, fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 },
  totalCardVal: { fontSize: 18, fontWeight: '700' },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8, marginBottom: 12 },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, backgroundColor: '#0ea5e9', borderRadius: 10, marginBottom: 12,
  },
  addBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  hint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginTop: 8 },
  listWrap: { gap: 10 },
  empty: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', paddingVertical: 12 },
  movCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12,
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0',
  },
  movIconWrap: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  movMain: { flex: 1, minWidth: 0 },
  movTipo: { fontSize: 13, fontWeight: '700', color: '#334155' },
  movConcepto: { fontSize: 12, color: '#64748b', marginTop: 2 },
  movMeta: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  movRight: { alignItems: 'flex-end', gap: 6 },
  movImporte: { fontSize: 15, fontWeight: '700' },
  movActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
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
  tipoBtnText: { fontSize: 12, fontWeight: '600', color: '#94a3b8' },
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
  errorText: { padding: 16, color: '#b91c1c' },
});
