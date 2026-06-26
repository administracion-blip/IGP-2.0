import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import { useLocalToast } from '../../components/Toast';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useMarketingLocales, valorEnLocal } from './LocalesContext';
import { formatId6 } from './lib/formatId6';
import { dmyToIso, finMesSiguienteDmy, inicioMesActualDmy, isoToDmy } from './lib/fechasUi';

type Cartel = {
  id_actuacion: string;
  nombre_artistico: string;
  fecha: string;
  hora_inicio: string;
  imagen_artista_url?: string | null;
  prompt: string;
};

type ModoRespuesta = 'idle' | 'individual' | 'agrupado';

export default function CartelesMusicoScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { locales } = useMarketingLocales();
  const { show: showToast, ToastView } = useLocalToast();

  const esGestor = hasPermiso('marketing.gestionar');

  const [idLocal, setIdLocal] = useState('');
  const [fechaInicio, setFechaInicio] = useState(inicioMesActualDmy());
  const [fechaFin, setFechaFin] = useState(finMesSiguienteDmy());
  /** Preferencia antes de generar: si está activo, el backend devuelve `prompt_agrupado`. */
  const [agruparConciertos, setAgruparConciertos] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [carteles, setCarteles] = useState<Cartel[]>([]);
  const [modoRespuesta, setModoRespuesta] = useState<ModoRespuesta>('idle');
  const [promptAgrupado, setPromptAgrupado] = useState('');
  const [fechasRespIso, setFechasRespIso] = useState<{ inicio: string; fin: string } | null>(null);

  const [creandoIdx, setCreandoIdx] = useState<number | null>(null);
  const [creandoAgrupado, setCreandoAgrupado] = useState(false);
  const [creadosIds, setCreadosIds] = useState<Set<string>>(new Set());
  const [propuestaAgrupadaCreada, setPropuestaAgrupadaCreada] = useState(false);

  useEffect(() => {
    if (!idLocal && locales.length === 1) {
      const id = formatId6(valorEnLocal(locales[0], 'id_Locales'));
      if (id) setIdLocal(id);
    }
  }, [locales, idLocal]);

  async function generar() {
    if (!idLocal) {
      setError('Selecciona un local.');
      return;
    }
    const isoIni = dmyToIso(fechaInicio.trim());
    const isoFin = dmyToIso(fechaFin.trim());
    if (!isoIni || !isoFin) {
      setError('Indica fechas válidas en formato DD/MM/AAAA.');
      return;
    }
    if (isoIni > isoFin) {
      setError('La fecha inicial debe ser anterior o igual a la final.');
      return;
    }

    setError(null);
    setLoading(true);
    setCarteles([]);
    setPromptAgrupado('');
    setFechasRespIso(null);
    setModoRespuesta('idle');
    setCreadosIds(new Set());
    setPropuestaAgrupadaCreada(false);

    try {
      const res = await apiFetch('/api/marketing/carteles-musico/generar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_local: idLocal,
          fecha_inicio: isoIni,
          fecha_fin: isoFin,
          agrupar_conciertos: agruparConciertos,
        }),
        timeoutMs: 90_000,
      });
      const data = (await res.json()) as {
        carteles?: Cartel[];
        prompt_agrupado?: string;
        agrupar_conciertos?: boolean;
        fecha_inicio?: string;
        fecha_fin?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'No se pudo generar');

      const lista = Array.isArray(data.carteles) ? data.carteles : [];
      setCarteles(lista);
      setModoRespuesta(data.agrupar_conciertos ? 'agrupado' : 'individual');
      setPromptAgrupado(String(data.prompt_agrupado ?? ''));
      if (data.fecha_inicio && data.fecha_fin) {
        setFechasRespIso({ inicio: data.fecha_inicio, fin: data.fecha_fin });
      }

      if (lista.length === 0) {
        showToast('Sin actuaciones', 'No hay actuaciones en este rango para este local.', 'info');
      } else if (data.agrupar_conciertos && !String(data.prompt_agrupado ?? '').trim()) {
        showToast('Sin prompt agrupado', 'Hay actuaciones pero no se generó el prompt agrupado.', 'warning');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error desconocido';
      setError(msg);
      showToast('Error', msg, 'error');
    } finally {
      setLoading(false);
    }
  }

  async function copiarPrompt(prompt: string) {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(prompt);
        showToast('Copiado', 'Prompt copiado al portapapeles.', 'success');
      } else {
        showToast('Selecciona el texto', 'Mantén pulsado el prompt para copiarlo.', 'info');
      }
    } catch {
      showToast('Error', 'No se pudo copiar.', 'error');
    }
  }

  async function crearPropuesta(cartel: Cartel, idx: number) {
    setCreandoIdx(idx);
    try {
      const desc = cartel.nombre_artistico
        ? `Cartel músico: ${cartel.nombre_artistico} — ${isoToDmy(cartel.fecha) || cartel.fecha}${cartel.hora_inicio ? ` ${cartel.hora_inicio}` : ''}`
        : `Cartel músico — ${isoToDmy(cartel.fecha) || cartel.fecha}`;
      const res = await apiFetch('/api/marketing/propuestas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_local: idLocal,
          tipo: 'Cartel Musico',
          redes: ['instagram', 'facebook'],
          fecha_sugerida: cartel.fecha,
          descripcion: desc,
          id_actuacion: cartel.id_actuacion,
          prompt_generado: cartel.prompt,
        }),
      });
      const data = (await res.json()) as { propuesta?: { id_propuesta: string }; error?: string };
      if (!res.ok || !data.propuesta) throw new Error(data.error || 'No se pudo crear la propuesta');
      setCreadosIds((prev) => new Set(prev).add(cartel.id_actuacion));
      showToast('Propuesta creada', 'Disponible en la lista.', 'success');
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error desconocido', 'error');
    } finally {
      setCreandoIdx(null);
    }
  }

  async function crearPropuestaAgrupada() {
    if (!promptAgrupado.trim() || !fechasRespIso) return;
    setCreandoAgrupado(true);
    try {
      const n = carteles.length;
      const desc = `Cartel músico agrupado: ${n} actuación(es), del ${isoToDmy(fechasRespIso.inicio)} al ${isoToDmy(fechasRespIso.fin)}`;
      const res = await apiFetch('/api/marketing/propuestas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_local: idLocal,
          tipo: 'Cartel Musico',
          redes: ['instagram', 'facebook'],
          fecha_sugerida: fechasRespIso.inicio,
          descripcion: desc,
          prompt_generado: promptAgrupado.trim(),
        }),
      });
      const data = (await res.json()) as { propuesta?: { id_propuesta: string }; error?: string };
      if (!res.ok || !data.propuesta) throw new Error(data.error || 'No se pudo crear la propuesta');
      setPropuestaAgrupadaCreada(true);
      showToast('Propuesta creada', 'Cartel agrupado guardado como pendiente.', 'success');
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error desconocido', 'error');
    } finally {
      setCreandoAgrupado(false);
    }
  }

  if (!esGestor) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
          </TouchableOpacity>
          <Text style={styles.title}>Carteles músico</Text>
        </View>
        <View style={styles.empty}>
          <MaterialIcons name="lock" size={32} color="#94a3b8" />
          <Text style={styles.emptyText}>Necesitas el permiso marketing.gestionar.</Text>
        </View>
      </View>
    );
  }

  const hayResultados = modoRespuesta !== 'idle' && (carteles.length > 0 || promptAgrupado.trim().length > 0);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <Text style={styles.title}>Carteles músico</Text>
      </View>

      <View style={styles.filtersWrap}>
        <View style={styles.field}>
          <SelectorDesplegable
            label="Local"
            icono="store"
            placeholder="Selecciona un local"
            tituloLista="Selecciona un local"
            iconoLista="store"
            valorId={idLocal}
            opciones={locales.map((l) => {
              const id = formatId6(valorEnLocal(l, 'id_Locales'));
              const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
              return { id, titulo: nombre || id || '—', icono: 'store' as const };
            })}
            onSeleccionar={setIdLocal}
          />
        </View>

        <View style={styles.row}>
          <View style={styles.field}>
            <Text style={styles.label}>Desde</Text>
            <InputFecha value={fechaInicio} onChange={setFechaInicio} format="dmy" placeholder="DD/MM/AAAA" style={styles.dateInput} />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Hasta</Text>
            <InputFecha value={fechaFin} onChange={setFechaFin} format="dmy" placeholder="DD/MM/AAAA" style={styles.dateInput} />
          </View>
        </View>

        <TouchableOpacity
          style={styles.toggleRow}
          onPress={() => setAgruparConciertos((v) => !v)}
          activeOpacity={0.7}
        >
          <MaterialIcons
            name={agruparConciertos ? 'check-box' : 'check-box-outline-blank'}
            size={22}
            color={agruparConciertos ? '#0ea5e9' : '#94a3b8'}
          />
          <View style={styles.toggleTextCol}>
            <Text style={styles.toggleTitle}>Agrupar conciertos</Text>
            <Text style={styles.toggleHint}>
              Si está activo, se genera un único prompt que incluye todas las actuaciones del rango. Si no, un prompt por actuación.
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryBtn, loading && styles.disabled]}
          onPress={generar}
          disabled={loading || !idLocal}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <MaterialIcons name="library-music" size={20} color="#fff" />}
          <Text style={styles.primaryBtnText}>{loading ? 'Generando…' : 'Generar carteles'}</Text>
        </TouchableOpacity>

        {error && (
          <View style={styles.errorBox}>
            <MaterialIcons name="error-outline" size={18} color="#f87171" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {!hayResultados && !loading ? (
          <View style={styles.empty}>
            <MaterialIcons name="library-music" size={32} color="#94a3b8" />
            <Text style={styles.emptyText}>
              Selecciona un local, opcionalmente agrupa conciertos, elige el rango en DD/MM/AAAA y pulsa Generar carteles.
            </Text>
          </View>
        ) : null}

        {modoRespuesta === 'agrupado' && promptAgrupado.trim() ? (
          <View style={[styles.card, styles.cardDestacada]}>
            <Text style={styles.cardBanner}>Prompt único (todo el rango)</Text>
            <Text style={styles.promptLabel}>Prompt sugerido</Text>
            <Text style={styles.promptText} selectable>
              {promptAgrupado}
            </Text>
            <View style={styles.cardActions}>
              <TouchableOpacity style={styles.smallBtn} onPress={() => copiarPrompt(promptAgrupado)}>
                <MaterialIcons name="content-copy" size={16} color="#0ea5e9" />
                <Text style={styles.smallBtnText}>Copiar prompt</Text>
              </TouchableOpacity>
              {propuestaAgrupadaCreada ? (
                <View style={[styles.smallBtn, styles.smallBtnSuccess]}>
                  <MaterialIcons name="check-circle" size={16} color="#10b981" />
                  <Text style={[styles.smallBtnText, styles.smallBtnSuccessText]}>Propuesta creada</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.smallBtn, styles.smallBtnPrimary, creandoAgrupado && styles.disabled]}
                  onPress={crearPropuestaAgrupada}
                  disabled={creandoAgrupado || carteles.length === 0}
                >
                  {creandoAgrupado ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <MaterialIcons name="add" size={16} color="#fff" />
                  )}
                  <Text style={[styles.smallBtnText, styles.smallBtnPrimaryText]}>
                    {creandoAgrupado ? 'Creando…' : 'Crear propuesta agrupada'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ) : null}

        {modoRespuesta === 'agrupado' && carteles.length > 0 ? (
          <View style={styles.incluidasWrap}>
            <Text style={styles.incluidasTitle}>Actuaciones incluidas ({carteles.length})</Text>
            {carteles.map((c, i) => (
              <View key={c.id_actuacion || `row-${c.fecha}-${i}`} style={styles.compactRow}>
                <Text style={styles.compactText}>
                  <Text style={styles.compactStrong}>{c.nombre_artistico || 'Artista sin nombre'}</Text>
                  {' · '}
                  {isoToDmy(c.fecha) || c.fecha}
                  {c.hora_inicio ? ` · ${c.hora_inicio}` : ''}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {modoRespuesta === 'individual'
          ? carteles.map((c, i) => {
              const yaCreado = creadosIds.has(c.id_actuacion);
              return (
                <View key={c.id_actuacion || `${c.fecha}-${i}`} style={styles.card}>
                  <View style={styles.cardHeader}>
                    {c.imagen_artista_url ? (
                      <Image source={{ uri: c.imagen_artista_url }} style={styles.avatar} />
                    ) : (
                      <View style={[styles.avatar, styles.avatarPlaceholder]}>
                        <MaterialIcons name="person" size={28} color="#94a3b8" />
                      </View>
                    )}
                    <View style={styles.cardHeaderText}>
                      <Text style={styles.artistName} numberOfLines={1}>
                        {c.nombre_artistico || 'Artista sin nombre'}
                      </Text>
                      <Text style={styles.dateLine}>
                        {isoToDmy(c.fecha) || c.fecha}
                        {c.hora_inicio ? ` · ${c.hora_inicio}` : ''}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.promptLabel}>Prompt sugerido</Text>
                  <Text style={styles.promptText} selectable>
                    {c.prompt}
                  </Text>

                  <View style={styles.cardActions}>
                    <TouchableOpacity style={styles.smallBtn} onPress={() => copiarPrompt(c.prompt)}>
                      <MaterialIcons name="content-copy" size={16} color="#0ea5e9" />
                      <Text style={styles.smallBtnText}>Copiar prompt</Text>
                    </TouchableOpacity>
                    {yaCreado ? (
                      <View style={[styles.smallBtn, styles.smallBtnSuccess]}>
                        <MaterialIcons name="check-circle" size={16} color="#10b981" />
                        <Text style={[styles.smallBtnText, styles.smallBtnSuccessText]}>Propuesta creada</Text>
                      </View>
                    ) : (
                      <TouchableOpacity
                        style={[styles.smallBtn, styles.smallBtnPrimary, creandoIdx === i && styles.disabled]}
                        onPress={() => crearPropuesta(c, i)}
                        disabled={creandoIdx === i}
                      >
                        {creandoIdx === i ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <MaterialIcons name="add" size={16} color="#fff" />
                        )}
                        <Text style={[styles.smallBtnText, styles.smallBtnPrimaryText]}>
                          {creandoIdx === i ? 'Creando…' : 'Crear propuesta'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            })
          : null}
      </ScrollView>
      {ToastView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  headerBtn: { padding: 6 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  filtersWrap: { padding: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  row: { flexDirection: 'row', gap: 10 },
  field: { flex: 1, gap: 6 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569' },
  dateInput: {
    fontSize: 13,
    paddingVertical: 8,
    paddingHorizontal: 10,
    color: '#334155',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  toggleTextCol: { flex: 1, gap: 4 },
  toggleTitle: { fontSize: 13, fontWeight: '600', color: '#334155' },
  toggleHint: { fontSize: 11, color: '#64748b', lineHeight: 16 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, backgroundColor: '#0ea5e9', borderRadius: 10 },
  primaryBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8 },
  errorText: { fontSize: 12, color: '#dc2626', flex: 1 },
  list: { flex: 1 },
  listContent: { padding: 12, gap: 12, paddingBottom: 24 },
  empty: { paddingVertical: 32, alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', padding: 12, gap: 10 },
  cardDestacada: { borderColor: '#7dd3fc', backgroundColor: '#f0f9ff' },
  cardBanner: { fontSize: 12, fontWeight: '700', color: '#0369a1', textTransform: 'uppercase', letterSpacing: 0.5 },
  incluidasWrap: { gap: 6, paddingBottom: 8 },
  incluidasTitle: { fontSize: 13, fontWeight: '600', color: '#475569' },
  compactRow: { paddingVertical: 8, paddingHorizontal: 10, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  compactText: { fontSize: 12, color: '#475569' },
  compactStrong: { fontWeight: '600', color: '#334155' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#f1f5f9' },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  cardHeaderText: { flex: 1, gap: 2 },
  artistName: { fontSize: 14, fontWeight: '700', color: '#334155' },
  dateLine: { fontSize: 12, color: '#64748b' },
  promptLabel: { fontSize: 11, fontWeight: '600', color: '#475569' },
  promptText: { fontSize: 12, color: '#475569', lineHeight: 18, padding: 10, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  cardActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  smallBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: '#bae6fd', borderRadius: 6, backgroundColor: '#f0f9ff' },
  smallBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  smallBtnPrimary: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  smallBtnPrimaryText: { color: '#fff' },
  smallBtnSuccess: { backgroundColor: '#d1fae5', borderColor: '#a7f3d0' },
  smallBtnSuccessText: { color: '#10b981' },
  disabled: { opacity: 0.6 },
});
