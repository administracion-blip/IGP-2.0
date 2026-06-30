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
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Formas de pago</Text>
        <TouchableOpacity
          style={[styles.syncBtn, sincronizando && styles.btnDisabled]}
          onPress={sincronizar}
          disabled={sincronizando}
        >
          {sincronizando ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="sync" size={16} color="#0ea5e9" />
          )}
          <Text style={styles.syncBtnText}>Sincronizar con Ágora</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.subtitle}>
        Maestro sincronizado desde Ágora. Define a qué columna se agrupa cada forma (canónico) y si
        se cuenta físicamente en el arqueo de caja.
      </Text>

      {resultadoSync ? <Text style={styles.resultText}>{resultadoSync}</Text> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.loadingText}>Cargando formas de pago…</Text>
        </View>
      ) : formasOrdenadas.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>
            No hay formas de pago registradas. Pulsa “Sincronizar con Ágora” para cargarlas.
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
                  {guardando ? <ActivityIndicator size="small" color="#0ea5e9" /> : null}
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
                      trackColor={{ false: '#e2e8f0', true: '#86efac' }}
                      thumbColor={f.arquear !== false ? '#22c55e' : '#94a3b8'}
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

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, backgroundColor: '#f8fafc' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#1e293b', flex: 1 },
  subtitle: { fontSize: 12, color: '#64748b', marginBottom: 10, lineHeight: 17 },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  syncBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },
  btnDisabled: { opacity: 0.6 },
  resultText: { fontSize: 12, color: '#0f766e', marginBottom: 8 },
  errorText: { fontSize: 13, color: '#dc2626', marginBottom: 8 },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 13, color: '#64748b' },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyText: { fontSize: 13, color: '#94a3b8', textAlign: 'center', lineHeight: 19 },
  list: { flex: 1 },
  listContent: { paddingBottom: 32, gap: 10 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  cardTitle: { fontSize: 15, fontWeight: '600', color: '#1e293b' },
  idChip: { backgroundColor: '#f1f5f9', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  idChipText: { fontSize: 11, color: '#64748b', fontWeight: '600' },
  inactivoChip: { backgroundColor: '#fee2e2', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  inactivoChipText: { fontSize: 11, color: '#b91c1c', fontWeight: '600' },
  controlsRow: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 },
  controlField: { flex: 1, minWidth: 200 },
  controlFieldSmall: { width: 80 },
  controlFieldSwitch: { alignItems: 'center', gap: 4 },
  controlLabel: { fontSize: 10, fontWeight: '600', color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  selector: { marginBottom: 0 },
  ordenInput: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    color: '#334155',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    textAlign: 'center',
  },
});
