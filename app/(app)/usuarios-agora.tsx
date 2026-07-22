import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import {
  ERP_LIST_HEADER_TEXT_PROPS,
  erpListTableStyles,
} from '../constants/erpListTableStyles';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../utils/api';

const COLUMNAS: { key: string; label: string; width: number }[] = [
  { key: 'Id', label: 'ID', width: 70 },
  { key: 'Name', label: 'Nombre completo', width: 180 },
  { key: 'ButtonText', label: 'Alias (botón POS)', width: 140 },
  { key: 'Profile', label: 'Perfil', width: 120 },
  { key: 'Telephone', label: 'Teléfono', width: 120 },
  { key: 'Email', label: 'Email', width: 200 },
  { key: 'Activo', label: 'Activo', width: 72 },
];

type UsuarioAgora = {
  Id?: number | string;
  Name?: string;
  FullName?: string;
  ButtonText?: string;
  Profile?: string;
  Color?: string;
  Telephone?: string;
  Email?: string;
  Active?: boolean;
  Priority?: number;
  Nif?: string;
};

function getValorCelda(item: UsuarioAgora, col: string): string {
  if (col === 'Activo') return item.Active === false ? 'No' : 'Sí';
  const v = (item as Record<string, unknown>)[col];
  if (v == null || v === '') return '—';
  return String(v);
}

export default function UsuariosAgoraScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeSincronizar = hasPermiso('usuarios_agora.sincronizar');

  const [usuarios, setUsuarios] = useState<UsuarioAgora[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [sincronizando, setSincronizando] = useState(false);
  const [resultadoSync, setResultadoSync] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const cargar = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/api/agora/users')
      .then((res) => res.json())
      .then((data: { usuarios?: UsuarioAgora[]; error?: string; lastSync?: string | null }) => {
        if (data.error) setError(data.error);
        setUsuarios(Array.isArray(data.usuarios) ? data.usuarios : []);
        setLastSync(data.lastSync ?? null);
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
      const res = await apiFetch('/api/agora/users/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResultadoSync(data?.error || `Error ${res.status}`);
      } else if (data.skipped) {
        setResultadoSync(data.message || 'Sincronización reciente.');
      } else {
        setResultadoSync(
          `OK: ${data.fetched ?? 0} fetched, ${data.added ?? 0} nuevos, ${data.updated ?? 0} actualizados, ${data.unchanged ?? 0} sin cambios.`,
        );
        cargar();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setResultadoSync(msg);
    } finally {
      setSincronizando(false);
    }
  }, [cargar, sincronizando]);

  const usuariosFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return usuarios;
    return usuarios.filter((u) =>
      COLUMNAS.some((c) => {
        const v = String((u as Record<string, unknown>)[c.key] ?? '').toLowerCase();
        return v.includes(q);
      }),
    );
  }, [usuarios, filtroBusqueda]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.replace('/base-datos')} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Usuarios Ágora</Text>
          <Text style={styles.subtitle}>Maestro de usuarios sincronizados desde Ágora</Text>
        </View>
      </View>

      <View style={styles.toolbar}>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor="#94a3b8"
          />
        </View>
        {lastSync != null ? (
          <Text style={styles.lastSync} numberOfLines={1}>
            Última sync: {new Date(lastSync).toLocaleString('es-ES')}
          </Text>
        ) : null}
        {puedeSincronizar ? (
          <TouchableOpacity
            style={[styles.syncBtn, sincronizando && styles.syncBtnDisabled]}
            onPress={sincronizar}
            disabled={sincronizando}
            activeOpacity={0.8}
          >
            {sincronizando ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="sync" size={18} color="#fff" />
            )}
            <Text style={styles.syncBtnText}>{sincronizando ? 'Sincronizando…' : 'Sincronizar'}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={styles.refreshBtn} onPress={cargar} disabled={loading} accessibilityLabel="Actualizar">
          {loading ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
          )}
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.bannerError}>
          <MaterialIcons name="error-outline" size={16} color="#dc2626" />
          <Text style={styles.bannerErrorText}>{error}</Text>
          <TouchableOpacity onPress={cargar}>
            <Text style={styles.retryLink}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading && usuarios.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.loadingText}>Cargando usuarios Ágora…</Text>
        </View>
      ) : (
        <>
          <Text style={styles.countText}>
            {usuariosFiltrados.length} usuario{usuariosFiltrados.length !== 1 ? 's' : ''}
          </Text>
          <View style={erpListTableStyles.tableOuter}>
            <View style={erpListTableStyles.tableWrapper}>
              <ScrollView
                horizontal
                style={[erpListTableStyles.scroll, erpListTableStyles.scrollTable, erpListTableStyles.tableScrollLtr]}
                contentContainerStyle={erpListTableStyles.scrollContent}
                showsHorizontalScrollIndicator
              >
                <View style={erpListTableStyles.table}>
                  <View style={erpListTableStyles.rowHeader}>
                    {COLUMNAS.map((col) => (
                      <View key={col.key} style={[erpListTableStyles.cellHeader, { width: col.width }]}>
                        <Text style={erpListTableStyles.cellHeaderText} {...ERP_LIST_HEADER_TEXT_PROPS}>
                          {col.label}
                        </Text>
                      </View>
                    ))}
                  </View>

                  <ScrollView
                    style={erpListTableStyles.tableBodyScroll}
                    contentContainerStyle={erpListTableStyles.tableBodyContent}
                    showsVerticalScrollIndicator
                    nestedScrollEnabled
                  >
                    {usuariosFiltrados.length === 0 ? (
                      <View style={erpListTableStyles.row}>
                        <View style={erpListTableStyles.cellEmpty}>
                          <Text style={erpListTableStyles.cellEmptyText}>
                            {usuarios.length === 0
                              ? 'No hay usuarios Ágora. Pulsa «Sincronizar» para importar desde Ágora.'
                              : 'Ningún usuario coincide con el filtro.'}
                          </Text>
                        </View>
                      </View>
                    ) : (
                      usuariosFiltrados.map((u, idx) => (
                        <View key={String(u.Id ?? idx)} style={erpListTableStyles.row}>
                          {COLUMNAS.map((col) => {
                            const raw = getValorCelda(u, col.key);
                            const esActivo = col.key === 'Activo';
                            const activo = u.Active !== false;
                            const activoStyles =
                              esActivo && activo
                                ? { backgroundColor: '#d1fae5', color: '#047857', fontWeight: '600' as const }
                                : esActivo
                                  ? { backgroundColor: '#fee2e2', color: '#b91c1c', fontWeight: '600' as const }
                                  : null;
                            return (
                              <View
                                key={col.key}
                                style={[
                                  erpListTableStyles.cell,
                                  { width: col.width },
                                  activoStyles && {
                                    backgroundColor: activoStyles.backgroundColor,
                                    borderRadius: 6,
                                  },
                                ]}
                              >
                                <Text
                                  style={[
                                    erpListTableStyles.cellText,
                                    activoStyles && {
                                      color: activoStyles.color,
                                      fontWeight: activoStyles.fontWeight,
                                    },
                                  ]}
                                >
                                  {raw}
                                </Text>
                              </View>
                            );
                          })}
                        </View>
                      ))
                    )}
                  </ScrollView>
                </View>
              </ScrollView>
            </View>
          </View>
        </>
      )}

      {resultadoSync ? (
        <View style={styles.resultadoSync}>
          <Text style={styles.resultadoSyncText}>{resultadoSync}</Text>
          <TouchableOpacity onPress={() => setResultadoSync(null)}>
            <MaterialIcons name="close" size={18} color="#0f766e" />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, backgroundColor: '#fff', minHeight: 0 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  searchWrap: {
    flex: 1,
    minWidth: 160,
    flexDirection: 'row',
    alignItems: 'center',
    height: 36,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    backgroundColor: '#f8fafc',
  },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 13, color: '#334155', paddingVertical: 0 },
  lastSync: {
    fontSize: 12,
    color: '#64748b',
    ...(Platform.OS === 'web' ? { whiteSpace: 'nowrap' as unknown as 'normal' } : {}),
  },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  syncBtnDisabled: { opacity: 0.6 },
  syncBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  refreshBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
  },
  bannerError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    marginBottom: 8,
  },
  bannerErrorText: { fontSize: 13, color: '#dc2626', flex: 1 },
  retryLink: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  loadingText: { marginTop: 8, fontSize: 14, color: '#64748b' },
  countText: { fontSize: 12, color: '#64748b', marginBottom: 6 },
  resultadoSync: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#ccfbf1',
    borderColor: '#5eead4',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    maxWidth: 480,
  },
  resultadoSyncText: { color: '#0f766e', fontSize: 13, flexShrink: 1 },
});
