import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../components/TablaBasica';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../utils/api';

const COLUMNAS = ['Id', 'Name', 'ButtonText', 'Profile', 'Telephone', 'Email', 'Activo'] as const;

const COL_LABELS: Record<string, string> = {
  Name: 'Nombre completo',
  ButtonText: 'Alias (botón POS)',
  Profile: 'Perfil',
  Telephone: 'Teléfono',
  Email: 'Email',
  Activo: 'Activo',
};

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

export default function UsuariosAgoraScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeSincronizar = hasPermiso('usuarios_agora.sincronizar');

  const [usuarios, setUsuarios] = useState<UsuarioAgora[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
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
        const v = String((u as Record<string, unknown>)[c] ?? '').toLowerCase();
        return v.includes(q);
      }),
    );
  }, [usuarios, filtroBusqueda]);

  const getValorCelda = useCallback((item: UsuarioAgora, col: string): string => {
    if (col === 'Activo') return item.Active === false ? 'No' : 'Sí';
    const v = (item as Record<string, unknown>)[col];
    if (v == null || v === '') return '';
    return String(v);
  }, []);

  const noop = useCallback(() => {}, []);

  return (
    <View style={styles.container}>
      <TablaBasica<UsuarioAgora>
        title="Usuarios Ágora"
        onBack={() => router.replace('/base-datos')}
        columnas={COLUMNAS.map((c) => COL_LABELS[c] ?? c)}
        datos={usuariosFiltrados}
        getValorCelda={(item, colLabel) => {
          const colKey = COLUMNAS.find((c) => (COL_LABELS[c] ?? c) === colLabel) ?? colLabel;
          return getValorCelda(item, colKey);
        }}
        loading={loading}
        error={error}
        onRetry={cargar}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        onCrear={noop}
        onEditar={noop}
        onBorrar={noop}
        hideToolbarActions
        emptyMessage="No hay usuarios Ágora. Pulsa Sincronizar para importar desde Ágora."
        extraToolbarRight={
          <View style={styles.toolbarRight}>
            {lastSync != null && (
              <Text style={styles.lastSync} numberOfLines={1}>
                Última sync: {new Date(lastSync).toLocaleString('es-ES')}
              </Text>
            )}
            {puedeSincronizar && (
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
                <Text style={styles.syncBtnText}>
                  {sincronizando ? 'Sincronizando…' : 'Sincronizar'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />

      {resultadoSync && (
        <View style={styles.resultadoSync}>
          <Text style={styles.resultadoSyncText}>{resultadoSync}</Text>
          <TouchableOpacity onPress={() => setResultadoSync(null)}>
            <MaterialIcons name="close" size={18} color="#0f766e" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginLeft: 8,
  },
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
    borderRadius: 6,
  },
  syncBtnDisabled: { opacity: 0.6 },
  syncBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
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
