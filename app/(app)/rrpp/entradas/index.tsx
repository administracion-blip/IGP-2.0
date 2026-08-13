import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { apiFetch } from '../../../utils/api';
import { formatId6 } from '../../../utils/idFormat';
import { formatCreadoEn } from '../../../utils/formatFecha';
import { TablaBasica } from '../../../components/TablaBasica';
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

type Entrada = {
  entradaId: string;
  localId: string;
  code?: string;
  tipoNombre?: string;
  clienteNombre?: string | null;
  telefono?: string | null;
  agoraSyncStatus?: string;
  agoraSyncError?: string | null;
  whatsappStatus?: string;
  creadoEn?: string;
  anulado?: boolean;
};

const COLUMNAS = ['Código', 'Tipo', 'Cliente', 'Sync Ágora', 'WhatsApp', 'Fecha', 'Acciones'];

const SYNC_FILTROS: { id: string; label: string }[] = [
  { id: '', label: 'Todos' },
  { id: 'PENDING', label: 'Pendiente' },
  { id: 'SYNCED', label: 'Sincronizado' },
  { id: 'ERROR', label: 'Error' },
  { id: 'SYNCING', label: 'Sincronizando' },
];

function syncBadgeStyle(status: string): { bg: string; fg: string; label: string } {
  const s = String(status || '').toUpperCase();
  if (s === 'SYNCED') return { bg: '#dcfce7', fg: '#16a34a', label: 'Sincronizado' };
  if (s === 'ERROR') return { bg: '#fee2e2', fg: '#dc2626', label: 'Error' };
  if (s === 'PENDING') return { bg: '#fef9c3', fg: '#ca8a04', label: 'Pendiente' };
  if (s === 'SYNCING') return { bg: '#e0f2fe', fg: '#0284c7', label: 'Sincronizando' };
  return { bg: '#f1f5f9', fg: '#64748b', label: s || '—' };
}

function whatsappLabel(status: string | undefined): string {
  const s = String(status || '').toUpperCase();
  if (s === 'STUB_LINK') return 'Enlace';
  if (s === 'SENT') return 'Enviado';
  if (s === 'ERROR') return 'Error';
  if (s === 'NONE' || !s) return '—';
  return s;
}

export default function EntradasListadoScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ localId?: string }>();
  const { hasPermiso, localPermitido } = useAuth();
  const { isPhone } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const puedeVer = hasPermiso('entradas.ver');
  const puedeCrear = hasPermiso('entradas.crear');
  const puedeWhatsapp = hasPermiso('entradas.enviar_whatsapp');
  const puedeReintentar = hasPermiso('entradas.reintentar_agora');
  const puedeAnular = hasPermiso('entradas.anular');

  const [locales, setLocales] = useState<{ id: string; nombre: string }[]>([]);
  const [localId, setLocalId] = useState(() =>
    params.localId ? formatId6(String(params.localId)) : '',
  );
  const [syncFiltro, setSyncFiltro] = useState('');
  const [items, setItems] = useState<Entrada[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [accionId, setAccionId] = useState<string | null>(null);
  const [accionError, setAccionError] = useState<string | null>(null);

  useEffect(() => {
    if (params.localId) setLocalId(formatId6(String(params.localId)));
  }, [params.localId]);

  useEffect(() => {
    if (!puedeVer) return;
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
  }, [puedeVer, localPermitido]);

  const cargar = useCallback(() => {
    if (!puedeVer || !localId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    setSelectedRowIndex(null);
    const params = new URLSearchParams({ localId });
    if (syncFiltro) params.set('agoraSyncStatus', syncFiltro);
    apiFetch(`/api/entradas?${params.toString()}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'No se pudieron cargar las entradas');
        setItems(Array.isArray(data.items) ? data.items : []);
      })
      .catch((e: Error) => {
        setError(e.message || 'Error al cargar');
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, [puedeVer, localId, syncFiltro]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const datos = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return items;
    return items.filter((e) => {
      const blob = [
        e.code,
        e.tipoNombre,
        e.clienteNombre,
        e.telefono,
        e.agoraSyncStatus,
        e.whatsappStatus,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }, [items, filtroBusqueda]);

  const getValorCelda = useCallback((item: Entrada, col: string): string => {
    switch (col) {
      case 'Código':
        return item.anulado ? `${item.code || '—'} (anulada)` : item.code || '—';
      case 'Tipo':
        return item.tipoNombre || '—';
      case 'Cliente':
        return item.clienteNombre || item.telefono || '—';
      case 'Sync Ágora':
        return syncBadgeStyle(item.agoraSyncStatus || '').label;
      case 'WhatsApp':
        return whatsappLabel(item.whatsappStatus);
      case 'Fecha':
        return formatCreadoEn(item.creadoEn);
      case 'Acciones':
        return '';
      default:
        return '';
    }
  }, []);

  const ejecutarAccion = useCallback(
    async (entrada: Entrada, tipo: 'reintentar' | 'whatsapp' | 'anular') => {
      setAccionError(null);
      setAccionId(`${entrada.entradaId}:${tipo}`);
      try {
        if (tipo === 'anular') {
          const ok = await confirmar(
            'Anular entrada',
            `¿Anular la entrada ${entrada.code || ''}? Esta acción no se puede deshacer desde aquí.`,
            { confirmarLabel: 'Anular', variant: 'danger' },
          );
          if (!ok) return;
        }

        const path =
          tipo === 'reintentar'
            ? `/api/entradas/${entrada.localId}/${entrada.entradaId}/reintentar-agora`
            : tipo === 'whatsapp'
              ? `/api/entradas/${entrada.localId}/${entrada.entradaId}/enviar-whatsapp`
              : `/api/entradas/${entrada.localId}/${entrada.entradaId}/anular`;

        const r = await apiFetch(path, { method: 'POST' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'No se pudo completar la acción');

        if (tipo === 'whatsapp' && data.waUrl) {
          await Linking.openURL(String(data.waUrl)).catch(() => {
            setAccionError('No se pudo abrir WhatsApp. Copia el enlace manualmente si hace falta.');
          });
        }
        cargar();
      } catch (e) {
        setAccionError(e instanceof Error ? e.message : 'Error en la acción');
      } finally {
        setAccionId(null);
      }
    },
    [cargar, confirmar],
  );

  const renderCell = useCallback(
    (item: Entrada, col: string, defaultText: string) => {
      if (col === 'Sync Ágora') {
        const badge = syncBadgeStyle(item.agoraSyncStatus || '');
        return (
          <View style={[styles.badge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.badgeText, { color: badge.fg }]} numberOfLines={1}>
              {badge.label}
            </Text>
          </View>
        );
      }
      if (col === 'Acciones') {
        const busy = accionId?.startsWith(`${item.entradaId}:`);
        const anulada = item.anulado === true;
        const sync = String(item.agoraSyncStatus || '').toUpperCase();
        return (
          <View style={styles.accionesRow}>
            {puedeReintentar && !anulada && (sync === 'ERROR' || sync === 'PENDING') ? (
              <TouchableOpacity
                style={[styles.accionBtn, styles.accionBtnWarn]}
                onPress={() => ejecutarAccion(item, 'reintentar')}
                disabled={!!busy}
                accessibilityLabel="Reintentar Ágora"
              >
                {busy && accionId === `${item.entradaId}:reintentar` ? (
                  <ActivityIndicator size="small" color="#92400e" />
                ) : (
                  <MaterialIcons name="sync" size={18} color="#92400e" />
                )}
              </TouchableOpacity>
            ) : null}
            {puedeWhatsapp && !anulada ? (
              <TouchableOpacity
                style={[styles.accionBtn, styles.accionBtnWa]}
                onPress={() => ejecutarAccion(item, 'whatsapp')}
                disabled={!!busy}
                accessibilityLabel="Enviar WhatsApp"
              >
                {busy && accionId === `${item.entradaId}:whatsapp` ? (
                  <ActivityIndicator size="small" color="#166534" />
                ) : (
                  <MaterialIcons name="chat" size={18} color="#166534" />
                )}
              </TouchableOpacity>
            ) : null}
            {puedeAnular && !anulada ? (
              <TouchableOpacity
                style={[styles.accionBtn, styles.accionBtnDanger]}
                onPress={() => ejecutarAccion(item, 'anular')}
                disabled={!!busy}
                accessibilityLabel="Anular entrada"
              >
                {busy && accionId === `${item.entradaId}:anular` ? (
                  <ActivityIndicator size="small" color="#991b1b" />
                ) : (
                  <MaterialIcons name="block" size={18} color="#991b1b" />
                )}
              </TouchableOpacity>
            ) : null}
            {anulada ? <Text style={styles.anuladaHint}>Anulada</Text> : null}
          </View>
        );
      }
      if (item.anulado && col === 'Código') {
        return (
          <Text style={styles.codigoAnulado} numberOfLines={1}>
            {defaultText}
          </Text>
        );
      }
      return null;
    },
    [accionId, ejecutarAccion, puedeAnular, puedeReintentar, puedeWhatsapp],
  );

  if (!puedeVer) {
    return (
      <View style={styles.locked}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.lockedText}>No tienes permiso para ver entradas.</Text>
        <TouchableOpacity style={styles.backLink} onPress={() => router.push('/rrpp' as never)}>
          <Text style={styles.backLinkText}>Volver a RRPP</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const opcionesLocal = locales.map((l) => ({ id: l.id, titulo: l.nombre }));

  return (
    <View style={styles.container}>
      {ConfirmarView}
      <TablaBasica
        title="Entradas online"
        onBack={() => router.push('/rrpp' as never)}
        columnas={COLUMNAS}
        datos={datos}
        getValorCelda={getValorCelda}
        renderCell={renderCell}
        getRowKey={(item) => item.entradaId}
        getRowStyle={(item) => (item.anulado ? styles.rowAnulada : undefined)}
        loading={loading}
        error={error}
        onRetry={cargar}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        hideToolbarActions
        emptyMessage={localId ? 'No hay entradas en este local' : 'Selecciona un local'}
        emptyFilterMessage="Ninguna entrada coincide con la búsqueda"
        extraToolbarLeft={
          <View style={[styles.filtrosRow, isPhone && styles.filtrosStack]}>
            <SelectorDesplegable
              compact
              sinIconoTrigger
              label={undefined}
              placeholder="Local"
              icono="store"
              opciones={opcionesLocal}
              valorId={localId || null}
              onSeleccionar={setLocalId}
              tituloLista="Locales"
              style={styles.filtroLocal}
              buscador
            />
            <SelectorDesplegable
              compact
              sinIconoTrigger
              placeholder="Sync Ágora"
              opciones={SYNC_FILTROS.map((f) => ({ id: f.id || '__all__', titulo: f.label }))}
              valorId={syncFiltro || '__all__'}
              onSeleccionar={(id) => setSyncFiltro(id === '__all__' ? '' : id)}
              tituloLista="Estado sync"
              style={styles.filtroSync}
            />
          </View>
        }
        extraToolbarRight={
          puedeCrear ? (
            <TouchableOpacity
              style={[styles.btnNueva, isPhone && { minHeight: MIN_TOUCH }]}
              onPress={() =>
                router.push(
                  (localId ? `/rrpp/entradas/nueva?localId=${localId}` : '/rrpp/entradas/nueva') as never,
                )
              }
              accessibilityLabel="Nueva entrada"
            >
              <MaterialIcons name="add" size={20} color="#fff" />
              <Text style={styles.btnNuevaText}>Nueva entrada</Text>
            </TouchableOpacity>
          ) : null
        }
        onCrear={() => {}}
        onEditar={() => {}}
        onBorrar={() => {}}
      />
      {accionError ? (
        <View style={styles.accionErrorBar}>
          <Text style={styles.accionErrorText}>{accionError}</Text>
          <TouchableOpacity onPress={() => setAccionError(null)}>
            <MaterialIcons name="close" size={18} color="#991b1b" />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
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
  filtrosRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    position: 'relative',
    zIndex: 30,
    ...(Platform.OS !== 'web' ? { elevation: 8 } : null),
  },
  filtrosStack: { flexDirection: 'column', alignItems: 'stretch', width: '100%' },
  filtroLocal: { minWidth: 160, maxWidth: 220 },
  filtroSync: { minWidth: 140, maxWidth: 180 },
  btnNueva: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnNuevaText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  accionesRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  accionBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  accionBtnWarn: { backgroundColor: '#fef3c7', borderColor: '#fcd34d' },
  accionBtnWa: { backgroundColor: '#dcfce7', borderColor: '#86efac' },
  accionBtnDanger: { backgroundColor: '#fee2e2', borderColor: '#fca5a5' },
  anuladaHint: { fontSize: 11, color: '#94a3b8', fontWeight: '600' },
  codigoAnulado: { color: '#94a3b8', textDecorationLine: 'line-through', fontSize: 13 },
  rowAnulada: { opacity: 0.65 },
  accionErrorBar: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: '#fee2e2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  accionErrorText: { flex: 1, color: '#991b1b', fontSize: 13 },
});
