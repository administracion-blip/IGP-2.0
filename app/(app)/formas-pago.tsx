import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SelectorDesplegable } from '../components/SelectorDesplegable';
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
import { apiFetch } from '../utils/api';

/** Canónicos históricos a los que se puede agrupar una forma de pago. */
const CANONICOS = [
  'Efectivo',
  'Tarjeta',
  'Pendiente de cobro',
  'Prepago Transferencia',
  'AgoraPay',
];

type FormaPago = {
  agoraId?: number;
  nombre?: string;
  canonico?: string | null;
  arquear?: boolean;
  activo?: boolean;
  orden?: number;
  primeraDeteccion?: string;
  ultimaSync?: string;
};

async function safeJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}`);
  }
  return JSON.parse(text) as T;
}

export default function FormasPagoScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeEditar = hasPermiso('formas_pago.editar') || hasPermiso('cierres.ver');
  const puedeSincronizar = hasPermiso('formas_pago.editar') || hasPermiso('ajustes.sincronizaciones.closeouts');

  const [formas, setFormas] = useState<FormaPago[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [resultadoSync, setResultadoSync] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const cargar = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/api/agora/formas-pago')
      .then((res) => safeJson<{ formas?: FormaPago[]; error?: string }>(res))
      .then((data) => {
        if (data.error) setError(data.error);
        setFormas(Array.isArray(data.formas) ? data.formas : []);
      })
      .catch((e) => setError(e?.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const sincronizar = useCallback(async () => {
    if (sincronizando) return;
    setSincronizando(true);
    setResultadoSync(null);
    try {
      const res = await apiFetch('/api/agora/payment-methods/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await safeJson<{
        ok?: boolean;
        error?: string;
        totalFetched?: number;
        added?: number;
        updated?: number;
        nuevas?: { agoraId: number; nombre: string }[];
      }>(res);
      if (!res.ok || data.error) {
        setResultadoSync(data.error || `Error ${res.status}`);
      } else {
        const nuevasTxt =
          data.nuevas && data.nuevas.length > 0
            ? ` · Nuevas: ${data.nuevas.map((n) => n.nombre).join(', ')}`
            : '';
        setResultadoSync(
          `OK: ${data.totalFetched ?? 0} recibidas, ${data.added ?? 0} nuevas, ${data.updated ?? 0} actualizadas.${nuevasTxt}`,
        );
        cargar();
      }
    } catch (e) {
      setResultadoSync(e instanceof Error ? e.message : 'Error al sincronizar');
    } finally {
      setSincronizando(false);
    }
  }, [cargar, sincronizando]);

  const actualizarForma = useCallback(
    async (agoraId: number, patch: Partial<FormaPago>) => {
      const sk = String(agoraId);
      setSavingId(sk);
      setError(null);
      // Optimista: aplica el cambio en local de inmediato.
      setFormas((prev) => prev.map((f) => (String(f.agoraId) === sk ? { ...f, ...patch } : f)));
      try {
        const res = await apiFetch(`/api/agora/formas-pago/${encodeURIComponent(sk)}`, {
          method: 'PUT',
          body: JSON.stringify(patch),
        });
        const data = await safeJson<{ ok?: boolean; error?: string; forma?: FormaPago }>(res);
        if (!res.ok || data.error) throw new Error(data.error || 'Error al guardar');
        if (data.forma) {
          setFormas((prev) => prev.map((f) => (String(f.agoraId) === sk ? { ...f, ...data.forma } : f)));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al guardar');
        cargar();
      } finally {
        setSavingId(null);
      }
    },
    [cargar],
  );

  const formasOrdenadas = useMemo(
    () =>
      [...formas].sort(
        (a, b) => (Number(a.orden ?? 99) - Number(b.orden ?? 99)) ||
          String(a.nombre || '').localeCompare(String(b.nombre || '')),
      ),
    [formas],
  );

  if (!hasPermiso('cierres.ver')) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para ver esta pantalla.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Formas de pago</Text>
        {puedeSincronizar ? (
          <TouchableOpacity
            style={[styles.syncBtn, sincronizando && styles.btnDisabled]}
            onPress={sincronizar}
            disabled={sincronizando}
          >
            {sincronizando ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <MaterialIcons name="sync" size={16} color={colors.accent} />
            )}
            <Text style={styles.syncBtnText}>Sincronizar con Ágora</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.subtitle}>
        Maestro sincronizado desde Ágora. Define a qué columna se agrupa cada forma (canónico) y si
        se cuenta físicamente en el arqueo de caja.
      </Text>

      {resultadoSync ? <Text style={styles.resultText}>{resultadoSync}</Text> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>Cargando formas de pago…</Text>
        </View>
      ) : formasOrdenadas.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>
            No hay formas de pago registradas.
            {puedeSincronizar ? ' Pulsa “Sincronizar con Ágora” para cargarlas.' : ''}
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {formasOrdenadas.map((f) => {
            const sk = String(f.agoraId);
            const guardando = savingId === sk;
            return (
              <View key={sk} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.cardTitleWrap}>
                    <Text style={styles.cardTitle}>{f.nombre || `Forma ${sk}`}</Text>
                    <View style={styles.idChip}>
                      <Text style={styles.idChipText}>ID {sk}</Text>
                    </View>
                    {f.activo === false ? (
                      <View style={styles.inactivoChip}>
                        <Text style={styles.inactivoChipText}>Inactiva</Text>
                      </View>
                    ) : null}
                  </View>
                  {guardando ? <ActivityIndicator size="small" color={colors.accent} /> : null}
                </View>

                <View style={styles.controlsRow}>
                  <View style={styles.controlField}>
                    <Text style={styles.controlLabel}>Agrupar en (canónico)</Text>
                    <SelectorDesplegable
                      style={styles.selector}
                      icono="account-balance-wallet"
                      tituloLista="Agrupar en"
                      placeholder="Sin agrupar (usa su nombre)"
                      disabled={!puedeEditar}
                      valorId={f.canonico ?? ''}
                      opciones={[
                        { id: '', titulo: 'Sin agrupar (usa su nombre)' },
                        ...CANONICOS.map((c) => ({ id: c, titulo: c })),
                      ]}
                      onSeleccionar={(id) =>
                        actualizarForma(Number(f.agoraId), { canonico: id || null })
                      }
                    />
                  </View>

                  <View style={styles.controlFieldSmall}>
                    <Text style={styles.controlLabel}>Orden</Text>
                    <TextInput
                      style={styles.ordenInput}
                      defaultValue={String(f.orden ?? 99)}
                      keyboardType="number-pad"
                      editable={puedeEditar}
                      onEndEditing={(e) => {
                        const n = parseInt(e.nativeEvent.text.replace(/\D/g, ''), 10);
                        if (Number.isFinite(n) && n !== Number(f.orden ?? 99)) {
                          actualizarForma(Number(f.agoraId), { orden: n });
                        }
                      }}
                    />
                  </View>

                  <View style={styles.controlFieldSwitch}>
                    <Text style={styles.controlLabel}>Se arquea</Text>
                    <Switch
                      value={f.arquear !== false}
                      disabled={!puedeEditar}
                      onValueChange={(val) => actualizarForma(Number(f.agoraId), { arquear: val })}
                      trackColor={{ false: colors.border, true: '#86efac' }}
                      thumbColor={f.arquear !== false ? '#22c55e' : colors.textMuted}
                    />
                  </View>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: SPACING.md, backgroundColor: colors.bg },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  backBtn: { padding: SPACING.xs },
  title: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, flex: 1 },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginBottom: 10, lineHeight: 17 },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: SPACING.md,
    backgroundColor: colors.surface,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  syncBtnText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  btnDisabled: { opacity: 0.6 },
  resultText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: '#0f766e', marginBottom: SPACING.sm },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.danger, marginBottom: SPACING.sm },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: SPACING.md },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACING.xl },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
  list: { flex: 1 },
  listContent: { paddingBottom: 32, gap: 10 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.md },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexShrink: 1 },
  cardTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong },
  idChip: { backgroundColor: colors.navActive, borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 2 },
  idChipText: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  inactivoChip: { backgroundColor: statusColors.danger.bg, borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 2 },
  inactivoChipText: { fontSize: typography.etiqueta.fontSize, color: statusColors.danger.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  controlsRow: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: SPACING.md },
  controlField: { flex: 1, minWidth: 200 },
  controlFieldSmall: { width: 80 },
  controlFieldSwitch: { alignItems: 'center', gap: SPACING.xs },
  controlLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: SPACING.xs, textTransform: 'uppercase', letterSpacing: 0.3 },
  selector: { marginBottom: 0 },
  ordenInput: {
    backgroundColor: colors.surface,
    borderRadius: RADIO_MEDIO,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    fontVariant: ['tabular-nums'],
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    textAlign: 'center',
  },
});
