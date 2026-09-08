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
import { useBreakpoint } from '../hooks/useBreakpoint';
import { MIN_TOUCH } from '../constants/layout';
import { apiFetch } from '../utils/api';

const COLUMNAS: { key: string; label: string; width: number }[] = [
  { key: 'Id', label: 'ID', width: 88 },
  { key: 'Name', label: 'Nombre completo', width: 220 },
  { key: 'ButtonText', label: 'Alias (botón POS)', width: 210 },
  { key: 'Profile', label: 'Perfil', width: 150 },
  { key: 'Telephone', label: 'Teléfono', width: 140 },
  { key: 'Email', label: 'Email', width: 240 },
  { key: 'Activo', label: 'Activo', width: 88 },
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
  const { isPhone, shouldStackToolbar } = useBreakpoint();
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
        <TouchableOpacity
          onPress={() => router.replace('/base-datos')}
          style={[styles.backBtn, isPhone && styles.backBtnPhone]}
          accessibilityLabel="Volver"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Usuarios Ágora</Text>
          <Text style={styles.subtitle}>Maestro de usuarios sincronizados desde Ágora</Text>
        </View>
      </View>

      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStacked]}>
        <View style={[styles.searchWrap, shouldStackToolbar && styles.searchWrapStacked]}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor="#94a3b8"
          />
        </View>
        <View style={styles.toolbarActions}>
          {puedeSincronizar ? (
            <TouchableOpacity
              style={[styles.syncBtn, isPhone && styles.syncBtnPhone, sincronizando && styles.syncBtnDisabled]}
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
          <TouchableOpacity
            style={[styles.refreshBtn, isPhone && styles.refreshBtnPhone]}
            onPress={cargar}
            disabled={loading}
            accessibilityLabel="Actualizar"
          >
            {loading ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
            )}
          </TouchableOpacity>
        </View>
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
          <View style={styles.metaRow}>
            <Text style={styles.countText}>
              {usuariosFiltrados.length} usuario{usuariosFiltrados.length !== 1 ? 's' : ''}
            </Text>
            {lastSync != null ? (
              <Text style={styles.lastSync} numberOfLines={1}>
                Última sync: {new Date(lastSync).toLocaleString('es-ES')}
              </Text>
            ) : null}
          </View>
          <View style={erpListTableStyles.tableOuter}>
            <View style={erpListTableStyles.tableWrapper}>
              <ScrollView
                horizontal
                style={[erpListTableStyles.scroll, erpListTableStyles.scrollTable, erpListTableStyles.tableScrollLtr]}
                contentContainerStyle={erpListTableStyles.scrollContent}
                showsHorizontalScrollIndicator
              >
                <View style={[erpListTableStyles.table, styles.table]}>
                  <View style={[erpListTableStyles.rowHeader, styles.rowHeader]}>
                    {COLUMNAS.map((col) => (
                      <View key={col.key} style={[erpListTableStyles.cellHeader, styles.cellHeader, { width: col.width }]}>
                        <Text style={[erpListTableStyles.cellHeaderText, styles.cellHeaderText]} {...ERP_LIST_HEADER_TEXT_PROPS}>
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
                        <View key={String(u.Id ?? idx)} style={[erpListTableStyles.row, styles.row]}>
                          {COLUMNAS.map((col) => {
                            const raw = getValorCelda(u, col.key);
                            const esActivo = col.key === 'Activo';
                            const activo = u.Active !== false;
                            return (
                              <View
                                key={col.key}
                                style={[erpListTableStyles.cell, styles.cell, { width: col.width }]}
                              >
                                {esActivo ? (
                                  <View style={[styles.chipActivo, activo ? styles.chipActivoSi : styles.chipActivoNo]}>
                                    <Text
                                      style={[
                                        styles.chipActivoText,
                                        activo ? styles.chipActivoTextSi : styles.chipActivoTextNo,
                                      ]}
                                    >
                                      {raw}
                                    </Text>
                                  </View>
                                ) : (
                                  <Text style={[erpListTableStyles.cellText, styles.cellText]}>{raw}</Text>
                                )}
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
  container: { flex: 1, padding: 12, backgroundColor: '#f8fafc', minHeight: 0 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    padding: 0,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#eef1f5',
  },
  backBtnPhone: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
  },
  title: { fontSize: 20, fontWeight: '600', lineHeight: 26, color: '#0f172a' },
  subtitle: { fontSize: 12, fontWeight: '400', color: '#64748b', marginTop: 2 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  toolbarStacked: { flexDirection: 'column', alignItems: 'stretch' },
  toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
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
    backgroundColor: '#ffffff',
  },
  searchWrapStacked: { maxWidth: '100%', width: '100%', flexGrow: 1 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, fontWeight: '400', color: '#0f172a', paddingVertical: 0 },
  lastSync: {
    fontSize: 12,
    fontWeight: '400',
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
  syncBtnPhone: { minHeight: MIN_TOUCH },
  syncBtnDisabled: { opacity: 0.6 },
  syncBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  refreshBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#ffffff',
  },
  refreshBtnPhone: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
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
  bannerErrorText: { fontSize: 12, fontWeight: '400', color: '#dc2626', flex: 1 },
  retryLink: { fontSize: 12, fontWeight: '400', color: '#0ea5e9' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  loadingText: { marginTop: 8, fontSize: 12, fontWeight: '400', color: '#64748b' },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  countText: { fontSize: 12, fontWeight: '400', color: '#64748b' },
  table: { borderColor: '#eef1f5' },
  rowHeader: {
    backgroundColor: '#f8fafc',
    borderBottomColor: '#eef1f5',
  },
  cellHeader: { borderRightColor: '#eef1f5' },
  cellHeaderText: {
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 14,
    letterSpacing: 0.1,
    color: '#94a3b8',
    textTransform: 'none',
  },
  row: { borderBottomColor: '#eef1f5', backgroundColor: '#ffffff' },
  cell: { borderRightColor: '#eef1f5' },
  cellText: {
    fontSize: 12,
    fontWeight: '400',
    lineHeight: 16,
    color: '#475569',
  },
  chipActivo: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  chipActivoSi: { backgroundColor: '#d1fae5' },
  chipActivoNo: { backgroundColor: '#fee2e2' },
  chipActivoText: { fontSize: 12, fontWeight: '400', lineHeight: 16 },
  chipActivoTextSi: { color: '#047857' },
  chipActivoTextNo: { color: '#b91c1c' },
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
  resultadoSyncText: { color: '#0f766e', fontSize: 12, fontWeight: '400', flexShrink: 1 },
});
