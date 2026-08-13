import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { apiFetch } from '../../../utils/api';
import { formatId6 } from '../../../utils/idFormat';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { InputFecha } from '../../../components/InputFecha';
import { estiloCampoFechaCompacto } from '../../../components/RangoFechas';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';

type LocalApi = {
  id_Locales?: string | number;
  Id_Locales?: string | number;
  nombre?: string;
  Nombre?: string;
};

type TipoEntrada = {
  tipoId: string;
  nombre: string;
  agoraSettingsId?: number;
  activo?: boolean;
};

type ModoValidez = 'default' | 'validUntil' | 'rango';

export default function NuevaEntradaScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ localId?: string }>();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackPanels, isPhone } = useBreakpoint();

  const puedeCrear = hasPermiso('entradas.crear');

  const [locales, setLocales] = useState<{ id: string; nombre: string }[]>([]);
  const [tipos, setTipos] = useState<TipoEntrada[]>([]);
  const [localId, setLocalId] = useState(params.localId ? formatId6(params.localId) : '');
  const [tipoId, setTipoId] = useState('');
  const [code, setCode] = useState('');
  const [clienteNombre, setClienteNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [modoValidez, setModoValidez] = useState<ModoValidez>('default');
  const [validUntil, setValidUntil] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [loadingTipos, setLoadingTipos] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!puedeCrear) return;
    apiFetch('/api/locales')
      .then((r) => r.json())
      .then((data) => {
        const all: LocalApi[] = data.locales || [];
        const list = all
          .map((l) => ({
            id: formatId6(l.id_Locales ?? l.Id_Locales),
            nombre: String(l.nombre ?? l.Nombre ?? '').trim(),
          }))
          .filter((l) => l.nombre && localPermitido(l.nombre))
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        setLocales(list);
        setLocalId((prev) => {
          if (prev && list.some((l) => l.id === prev)) return prev;
          if (list.length === 1) return list[0].id;
          return prev;
        });
      })
      .catch(() => setLocales([]));
  }, [puedeCrear, localPermitido]);

  const cargarTipos = useCallback(() => {
    if (!localId) {
      setTipos([]);
      setTipoId('');
      return;
    }
    setLoadingTipos(true);
    apiFetch(`/api/entradas/tipos?localId=${encodeURIComponent(localId)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'No se pudieron cargar los tipos');
        const items: TipoEntrada[] = Array.isArray(data.items) ? data.items : [];
        const activos = items.filter((t) => t.activo !== false);
        setTipos(activos);
        setTipoId((prev) => (activos.some((t) => t.tipoId === prev) ? prev : ''));
      })
      .catch(() => {
        setTipos([]);
        setTipoId('');
      })
      .finally(() => setLoadingTipos(false));
  }, [localId]);

  useEffect(() => {
    cargarTipos();
  }, [cargarTipos]);

  const opcionesLocal = useMemo(
    () => locales.map((l) => ({ id: l.id, titulo: l.nombre })),
    [locales],
  );
  const opcionesTipo = useMemo(
    () =>
      tipos.map((t) => ({
        id: t.tipoId,
        titulo: t.nombre,
        subtitulo: t.agoraSettingsId != null ? `Ágora #${t.agoraSettingsId}` : undefined,
      })),
    [tipos],
  );

  const crear = async () => {
    setError(null);
    if (!localId) {
      setError('Selecciona un local');
      return;
    }
    if (!tipoId) {
      setError('Selecciona un tipo de entrada');
      return;
    }
    if (modoValidez === 'validUntil' && !validUntil) {
      setError('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }
    if (modoValidez === 'rango') {
      if (!validFrom || !validTo) {
        setError('Indica una fecha válida (dd/mm/aaaa)');
        return;
      }
      if (validFrom > validTo) {
        setError('La fecha desde no puede ser posterior a la fecha hasta');
        return;
      }
    }

    const body: Record<string, unknown> = {
      localId,
      tipoId,
      clienteNombre: clienteNombre.trim() || undefined,
      telefono: telefono.trim() || undefined,
    };
    if (code.trim()) body.code = code.trim();
    if (modoValidez === 'validUntil') body.validUntil = validUntil;
    if (modoValidez === 'rango') {
      body.validFrom = validFrom;
      body.validTo = validTo;
    }

    setGuardando(true);
    try {
      const r = await apiFetch('/api/entradas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'No se pudo crear la entrada');
      const sync = String(data.agoraSyncStatus || '').toUpperCase();
      if (sync === 'ERROR') {
        setError(
          data.agoraSyncError
            || 'Entrada guardada, pero falló la sincronización con Ágora. Revisa el listado y reintenta.',
        );
        // Ir al listado tras un momento para poder reintentar
        setTimeout(() => {
          router.replace(`/rrpp/entradas?localId=${localId}` as never);
        }, 1800);
        return;
      }
      router.replace(`/rrpp/entradas?localId=${localId}` as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear');
    } finally {
      setGuardando(false);
    }
  };

  if (!puedeCrear) {
    return (
      <View style={styles.locked}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.lockedText}>No tienes permiso para crear entradas.</Text>
        <TouchableOpacity style={styles.backLink} onPress={() => router.back()}>
          <Text style={styles.backLinkText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/rrpp/entradas' as never)}
          style={styles.backBtn}
          accessibilityLabel="Volver al listado"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Nueva entrada</Text>
          <Text style={styles.subtitle}>Emite un cupón y sincronízalo con Ágora</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.form, shouldStackPanels && styles.formCompact]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.grid, styles.gridOnTop, shouldStackPanels && styles.gridStack]}>
          <View style={styles.field}>
            <Text style={styles.label}>Local *</Text>
            <SelectorDesplegable
              placeholder="Seleccionar local"
              icono="store"
              opciones={opcionesLocal}
              valorId={localId || null}
              onSeleccionar={(id) => {
                setLocalId(id);
                setTipoId('');
              }}
              tituloLista="Locales"
              buscador
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Tipo *</Text>
            <SelectorDesplegable
              placeholder={loadingTipos ? 'Cargando tipos…' : 'Seleccionar tipo'}
              icono="confirmation-number"
              opciones={opcionesTipo}
              valorId={tipoId || null}
              onSeleccionar={setTipoId}
              tituloLista="Tipos de entrada"
              loading={loadingTipos}
              disabled={!localId || loadingTipos}
              vacioTexto={localId ? 'No hay tipos activos en este local' : 'Elige un local primero'}
            />
          </View>
        </View>

        <View style={[styles.grid, styles.gridBelow, shouldStackPanels && styles.gridStack]}>
          <View style={styles.field}>
            <Text style={styles.label}>Código (opcional)</Text>
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={setCode}
              placeholder="Se genera automáticamente si se deja vacío"
              placeholderTextColor="#94a3b8"
              autoCapitalize="characters"
              editable={!guardando}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Nombre cliente</Text>
            <TextInput
              style={styles.input}
              value={clienteNombre}
              onChangeText={setClienteNombre}
              placeholder="Nombre"
              placeholderTextColor="#94a3b8"
              editable={!guardando}
            />
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Teléfono</Text>
          <TextInput
            style={styles.input}
            value={telefono}
            onChangeText={setTelefono}
            placeholder="+34 600 000 000"
            placeholderTextColor="#94a3b8"
            keyboardType="phone-pad"
            editable={!guardando}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Validez</Text>
          <View style={styles.chipsRow}>
            {(
              [
                { id: 'default', label: 'Por defecto Ágora' },
                { id: 'validUntil', label: 'Hasta fecha' },
                { id: 'rango', label: 'Rango' },
              ] as const
            ).map((m) => (
              <TouchableOpacity
                key={m.id}
                style={[styles.chip, modoValidez === m.id && styles.chipSelected]}
                onPress={() => setModoValidez(m.id)}
                disabled={guardando}
              >
                <Text style={[styles.chipText, modoValidez === m.id && styles.chipTextSelected]}>
                  {m.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {modoValidez === 'validUntil' ? (
          <View style={styles.field}>
            <Text style={styles.label}>Válida hasta</Text>
            <InputFecha
              compact
              valueIso={validUntil}
              onChangeIso={setValidUntil}
              style={estiloCampoFechaCompacto}
            />
          </View>
        ) : null}

        {modoValidez === 'rango' ? (
          <View style={[styles.grid, shouldStackPanels && styles.gridStack]}>
            <View style={styles.field}>
              <Text style={styles.label}>Desde</Text>
              <InputFecha
                compact
                valueIso={validFrom}
                onChangeIso={setValidFrom}
                style={estiloCampoFechaCompacto}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Hasta</Text>
              <InputFecha
                compact
                valueIso={validTo}
                onChangeIso={setValidTo}
                style={estiloCampoFechaCompacto}
              />
            </View>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.btnCrear, (guardando || isPhone) && null, isPhone && { minHeight: MIN_TOUCH }]}
          onPress={crear}
          disabled={guardando}
        >
          {guardando ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <MaterialIcons name="add-circle-outline" size={20} color="#fff" />
              <Text style={styles.btnCrearText}>Crear entrada</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff', padding: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 2 },
  form: { paddingBottom: 40, gap: 14, maxWidth: 720 },
  formCompact: { maxWidth: '100%' },
  grid: { flexDirection: 'row', gap: 12 },
  gridOnTop: { position: 'relative', zIndex: 30 },
  gridBelow: { position: 'relative', zIndex: 0 },
  gridStack: { flexDirection: 'column' },
  field: { flex: 1, gap: 6, position: 'relative', zIndex: 1 },
  label: { fontSize: 13, fontWeight: '600', color: '#334155' },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  chipSelected: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipText: { fontSize: 13, color: '#64748b', fontWeight: '600' },
  chipTextSelected: { color: '#0369a1' },
  error: { color: '#dc2626', fontSize: 13 },
  btnCrear: {
    marginTop: 8,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    minWidth: 180,
    justifyContent: 'center',
  },
  btnCrearText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  locked: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
    backgroundColor: '#fff',
  },
  lockedText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },
  backLink: { marginTop: 8, padding: 10 },
  backLinkText: { color: '#0ea5e9', fontWeight: '600' },
});
