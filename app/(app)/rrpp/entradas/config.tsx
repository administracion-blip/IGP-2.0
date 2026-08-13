import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Switch,
  Modal,
  Pressable,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { apiFetch } from '../../../utils/api';
import { formatId6 } from '../../../utils/idFormat';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';

type LocalApi = {
  id_Locales?: string | number;
  Id_Locales?: string | number;
  nombre?: string;
  Nombre?: string;
};

type ConfigPublic = {
  localId?: string | null;
  agoraBaseUrl?: string;
  enabled?: boolean;
  hasToken?: boolean;
};

type TipoEntrada = {
  tipoId: string;
  nombre: string;
  agoraSettingsId?: number;
  activo?: boolean;
  whatsappPlantilla?: string | null;
};

export default function EntradasConfigScreen() {
  const router = useRouter();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackPanels, isPhone } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const puedeConfigurar = hasPermiso('entradas.configurar');

  const [locales, setLocales] = useState<{ id: string; nombre: string }[]>([]);
  const [localId, setLocalId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [tokenNuevo, setTokenNuevo] = useState('');
  const [tipos, setTipos] = useState<TipoEntrada[]>([]);
  const [loading, setLoading] = useState(false);
  const [guardandoCfg, setGuardandoCfg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [modalTipo, setModalTipo] = useState(false);
  const [editTipo, setEditTipo] = useState<TipoEntrada | null>(null);
  const [formNombre, setFormNombre] = useState('');
  const [formSettingsId, setFormSettingsId] = useState('');
  const [formActivo, setFormActivo] = useState(true);
  const [guardandoTipo, setGuardandoTipo] = useState(false);
  const [errorTipo, setErrorTipo] = useState<string | null>(null);

  useEffect(() => {
    if (!puedeConfigurar) return;
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
        if (list.length === 1) setLocalId(list[0].id);
      })
      .catch(() => setLocales([]));
  }, [puedeConfigurar, localPermitido]);

  const cargar = useCallback(async () => {
    if (!localId) {
      setBaseUrl('');
      setEnabled(false);
      setHasToken(false);
      setTokenNuevo('');
      setTipos([]);
      return;
    }
    setLoading(true);
    setError(null);
    setOkMsg(null);
    try {
      const [rCfg, rTipos] = await Promise.all([
        apiFetch(`/api/entradas/config/${encodeURIComponent(localId)}`),
        apiFetch(`/api/entradas/tipos?localId=${encodeURIComponent(localId)}`),
      ]);
      const cfg: ConfigPublic = await rCfg.json().catch(() => ({}));
      const tiposData = await rTipos.json().catch(() => ({}));
      if (!rCfg.ok) throw new Error((cfg as { error?: string }).error || 'Error al cargar config');
      if (!rTipos.ok) throw new Error(tiposData.error || 'Error al cargar tipos');
      setBaseUrl(String(cfg.agoraBaseUrl || ''));
      setEnabled(cfg.enabled === true);
      setHasToken(cfg.hasToken === true);
      setTokenNuevo('');
      setTipos(Array.isArray(tiposData.items) ? tiposData.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar');
      setTipos([]);
    } finally {
      setLoading(false);
    }
  }, [localId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const guardarConfig = async () => {
    if (!localId) return;
    setGuardandoCfg(true);
    setError(null);
    setOkMsg(null);
    try {
      const body: Record<string, unknown> = {
        agoraBaseUrl: baseUrl.trim(),
        enabled,
      };
      // Write-only: solo enviar token si el usuario escribió uno nuevo
      if (tokenNuevo.trim()) body.agoraApiToken = tokenNuevo.trim();

      const r = await apiFetch(`/api/entradas/config/${encodeURIComponent(localId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'No se pudo guardar la configuración');
      setBaseUrl(String(data.agoraBaseUrl || ''));
      setEnabled(data.enabled === true);
      setHasToken(data.hasToken === true);
      setTokenNuevo('');
      setOkMsg('Configuración guardada');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardandoCfg(false);
    }
  };

  const abrirNuevoTipo = () => {
    setEditTipo(null);
    setFormNombre('');
    setFormSettingsId('');
    setFormActivo(true);
    setErrorTipo(null);
    setModalTipo(true);
  };

  const abrirEditarTipo = (t: TipoEntrada) => {
    setEditTipo(t);
    setFormNombre(t.nombre || '');
    setFormSettingsId(t.agoraSettingsId != null ? String(t.agoraSettingsId) : '');
    setFormActivo(t.activo !== false);
    setErrorTipo(null);
    setModalTipo(true);
  };

  const guardarTipo = async () => {
    if (!localId) return;
    const nombre = formNombre.trim();
    const settingsId = Number(formSettingsId);
    if (!nombre) {
      setErrorTipo('El nombre es obligatorio');
      return;
    }
    if (!Number.isFinite(settingsId) || settingsId <= 0) {
      setErrorTipo('agoraSettingsId debe ser un número positivo');
      return;
    }
    setGuardandoTipo(true);
    setErrorTipo(null);
    try {
      if (editTipo) {
        const r = await apiFetch(
          `/api/entradas/tipos/${encodeURIComponent(localId)}/${encodeURIComponent(editTipo.tipoId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nombre,
              agoraSettingsId: settingsId,
              activo: formActivo,
            }),
          },
        );
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'No se pudo actualizar el tipo');
      } else {
        const r = await apiFetch('/api/entradas/tipos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localId,
            nombre,
            agoraSettingsId: settingsId,
            activo: formActivo,
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'No se pudo crear el tipo');
      }
      setModalTipo(false);
      await cargar();
    } catch (e) {
      setErrorTipo(e instanceof Error ? e.message : 'Error al guardar tipo');
    } finally {
      setGuardandoTipo(false);
    }
  };

  const borrarTipo = async (t: TipoEntrada) => {
    if (!localId) return;
    const ok = await confirmar(
      'Eliminar tipo',
      `¿Eliminar el tipo «${t.nombre}»?`,
      { confirmarLabel: 'Eliminar', variant: 'danger' },
    );
    if (!ok) return;
    try {
      const r = await apiFetch(
        `/api/entradas/tipos/${encodeURIComponent(localId)}/${encodeURIComponent(t.tipoId)}`,
        { method: 'DELETE' },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'No se pudo eliminar');
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar tipo');
    }
  };

  const opcionesLocal = useMemo(
    () => locales.map((l) => ({ id: l.id, titulo: l.nombre })),
    [locales],
  );

  if (!puedeConfigurar) {
    return (
      <View style={styles.locked}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.lockedText}>No tienes permiso para configurar entradas.</Text>
        <TouchableOpacity style={styles.backLink} onPress={() => router.push('/rrpp' as never)}>
          <Text style={styles.backLinkText}>Volver a RRPP</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {ConfirmarView}
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/rrpp' as never)}
          style={styles.backBtn}
          accessibilityLabel="Volver a RRPP"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Configuración Ágora</Text>
          <Text style={styles.subtitle}>URL, token y tipos de entrada por local</Text>
        </View>
      </View>

      <View style={[styles.localRow, { zIndex: 40, position: 'relative' }]}>
        <SelectorDesplegable
          label="Local"
          placeholder="Seleccionar local"
          icono="store"
          opciones={opcionesLocal}
          valorId={localId || null}
          onSeleccionar={setLocalId}
          tituloLista="Locales"
          buscador
          style={{ flex: 1, maxWidth: 360 }}
        />
      </View>

      {!localId ? (
        <Text style={styles.hint}>Selecciona un local para configurar.</Text>
      ) : loading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color="#0ea5e9" />
      ) : (
        <ScrollView
          style={{ zIndex: 0, position: 'relative' }}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Conexión Ágora</Text>
            <View style={styles.field}>
              <Text style={styles.label}>URL base (agoraBaseUrl)</Text>
              <TextInput
                style={styles.input}
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://…"
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!guardandoCfg}
              />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.label}>Habilitado</Text>
              <Switch
                value={enabled}
                onValueChange={setEnabled}
                disabled={guardandoCfg}
                trackColor={{ false: '#e2e8f0', true: '#0ea5e9' }}
                thumbColor="#fff"
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Token API</Text>
              <TextInput
                style={styles.input}
                value={tokenNuevo}
                onChangeText={setTokenNuevo}
                placeholder={hasToken ? '•••••••• (dejar vacío para conservar)' : 'Pegar token nuevo'}
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                editable={!guardandoCfg}
              />
              <Text style={styles.help}>
                {hasToken
                  ? 'Hay un token guardado. Escribe uno nuevo solo si quieres reemplazarlo. Nunca se muestra el valor actual.'
                  : 'Aún no hay token. Introduce uno para habilitar la sincronización.'}
              </Text>
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {okMsg ? <Text style={styles.ok}>{okMsg}</Text> : null}
            <TouchableOpacity
              style={[styles.btnPrimary, isPhone && { minHeight: MIN_TOUCH }]}
              onPress={guardarConfig}
              disabled={guardandoCfg}
            >
              {guardandoCfg ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnPrimaryText}>Guardar configuración</Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Tipos de entrada</Text>
              <TouchableOpacity
                style={[styles.btnSecondary, isPhone && { minHeight: MIN_TOUCH }]}
                onPress={abrirNuevoTipo}
              >
                <MaterialIcons name="add" size={18} color="#0ea5e9" />
                <Text style={styles.btnSecondaryText}>Nuevo tipo</Text>
              </TouchableOpacity>
            </View>

            {tipos.length === 0 ? (
              <Text style={styles.hint}>No hay tipos definidos para este local.</Text>
            ) : (
              tipos.map((t) => (
                <View key={t.tipoId} style={[styles.tipoRow, shouldStackPanels && styles.tipoRowStack]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.tipoNombre} numberOfLines={1}>
                      {t.nombre}
                      {t.activo === false ? ' (inactivo)' : ''}
                    </Text>
                    <Text style={styles.tipoMeta}>
                      agoraSettingsId: {t.agoraSettingsId ?? '—'}
                    </Text>
                  </View>
                  <View style={styles.tipoActions}>
                    <TouchableOpacity
                      style={styles.iconBtn}
                      onPress={() => abrirEditarTipo(t)}
                      accessibilityLabel="Editar tipo"
                    >
                      <MaterialIcons name="edit" size={18} color="#334155" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.iconBtn}
                      onPress={() => borrarTipo(t)}
                      accessibilityLabel="Eliminar tipo"
                    >
                      <MaterialIcons name="delete-outline" size={18} color="#dc2626" />
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      )}

      <Modal visible={modalTipo} transparent animationType="fade" onRequestClose={() => setModalTipo(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => !guardandoTipo && setModalTipo(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={styles.modalBox} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.modalTitle}>{editTipo ? 'Editar tipo' : 'Nuevo tipo'}</Text>
              <View style={styles.field}>
                <Text style={styles.label}>Nombre *</Text>
                <TextInput
                  style={styles.input}
                  value={formNombre}
                  onChangeText={setFormNombre}
                  placeholder="Ej. Entrada general"
                  placeholderTextColor="#94a3b8"
                  editable={!guardandoTipo}
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>agoraSettingsId *</Text>
                <TextInput
                  style={styles.input}
                  value={formSettingsId}
                  onChangeText={setFormSettingsId}
                  placeholder="ID numérico en Ágora"
                  placeholderTextColor="#94a3b8"
                  keyboardType="number-pad"
                  editable={!guardandoTipo}
                />
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.label}>Activo</Text>
                <Switch
                  value={formActivo}
                  onValueChange={setFormActivo}
                  disabled={guardandoTipo}
                  trackColor={{ false: '#e2e8f0', true: '#0ea5e9' }}
                  thumbColor="#fff"
                />
              </View>
              {errorTipo ? <Text style={styles.error}>{errorTipo}</Text> : null}
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={styles.btnCancel}
                  onPress={() => setModalTipo(false)}
                  disabled={guardandoTipo}
                >
                  <Text style={styles.btnCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.btnPrimary}
                  onPress={guardarTipo}
                  disabled={guardandoTipo}
                >
                  {guardandoTipo ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.btnPrimaryText}>Guardar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff', padding: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
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
  localRow: { marginBottom: 12 },
  scroll: { paddingBottom: 40, gap: 14 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    gap: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  field: { gap: 6 },
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
  help: { fontSize: 12, color: '#94a3b8', lineHeight: 16 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  btnPrimary: {
    alignSelf: 'flex-start',
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 140,
    alignItems: 'center',
  },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  btnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnSecondaryText: { color: '#0369a1', fontWeight: '700', fontSize: 13 },
  hint: { fontSize: 13, color: '#94a3b8', marginTop: 8 },
  error: { color: '#dc2626', fontSize: 13 },
  ok: { color: '#16a34a', fontSize: 13, fontWeight: '600' },
  tipoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  tipoRowStack: { alignItems: 'flex-start' },
  tipoNombre: { fontSize: 14, fontWeight: '600', color: '#0f172a' },
  tipoMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  tipoActions: { flexDirection: 'row', gap: 4 },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalBox: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  btnCancel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  btnCancelText: { color: '#64748b', fontWeight: '600' },
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
