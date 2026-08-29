/**
 * Campana global de avisos (cabecera). Contador por poll suave; panel con
 * lista reciente, marcar leídas y navegación según `entidad_ref`.
 */
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Pressable,
  ActivityIndicator,
  ScrollView,
  AppState,
  type AppStateStatus,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, iconSize, radius, shadowCard, SPACING, typography } from '../../constants/theme';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatCreadoEn } from '../../utils/formatFecha';
import type { Notificacion, TipoNotificacion, Vinculo } from '../../types/tasks';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

const POLL_MS = 60_000;
const LIMITE_LISTA = 30;

const ETIQUETA_TIPO: Record<TipoNotificacion, string> = {
  mencion: 'Mención',
  asignacion: 'Asignación',
  vencimiento: 'Vencimiento',
  compra_pendiente: 'Compra',
  acta_lista: 'Acta',
};

const ICONO_TIPO: Record<TipoNotificacion, IconName> = {
  mencion: 'alternate-email',
  asignacion: 'person-add',
  vencimiento: 'event',
  compra_pendiente: 'shopping-cart',
  acta_lista: 'description',
};

function extraerContador(data: Record<string, unknown>): number {
  for (const clave of ['total', 'count', 'no_leidas', 'noLeidas', 'contador'] as const) {
    const v = data[clave];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
      return Math.max(0, Math.floor(Number(v)));
    }
  }
  return 0;
}

function extraerItems(data: Record<string, unknown>): Notificacion[] {
  const bruto =
    data.items ?? data.notificaciones ?? data.notifications ?? data.data ?? null;
  if (!Array.isArray(bruto)) return [];
  return bruto.filter(
    (n): n is Notificacion =>
      !!n &&
      typeof n === 'object' &&
      typeof (n as Notificacion).id_notificacion === 'string',
  );
}

function rutaDesdeEntidad(ref?: Vinculo | null): string | null {
  if (!ref?.tipo || !ref.id) return null;
  const id = encodeURIComponent(ref.id);
  switch (ref.tipo) {
    case 'tarea':
      return `/proyectos/tarea/${id}`;
    case 'proyecto':
      return `/proyectos/${id}`;
    case 'reunion':
      return `/reuniones/${id}`;
    default:
      return null;
  }
}

function etiquetaTipo(tipo: string): string {
  if (tipo in ETIQUETA_TIPO) return ETIQUETA_TIPO[tipo as TipoNotificacion];
  return 'Aviso';
}

function iconoTipo(tipo: string): IconName {
  if (tipo in ICONO_TIPO) return ICONO_TIPO[tipo as TipoNotificacion];
  return 'notifications';
}

export function CampanaNotificaciones() {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [noLeidas, setNoLeidas] = useState(0);
  const [items, setItems] = useState<Notificacion[]>([]);
  const [cargandoLista, setCargandoLista] = useState(false);
  const [marcando, setMarcando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const montadoRef = useRef(true);

  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
    };
  }, []);

  const refrescarContador = useCallback(async () => {
    try {
      // La campana no debe tumbar la sesión si el contador falla (401 auxiliar).
      const res = await apiFetch('/api/notificaciones/no-leidas', {
        skipUnauthorizedEmit: true,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!montadoRef.current) return;
      if (!res.ok) return;
      setNoLeidas(extraerContador(data));
    } catch (e) {
      console.warn('[notificaciones] contador', e);
    }
  }, []);

  const cargarLista = useCallback(async () => {
    setCargandoLista(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limite: String(LIMITE_LISTA) });
      const res = await apiFetch(`/api/notificaciones?${query.toString()}`, {
        skipUnauthorizedEmit: true,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!montadoRef.current) return;
      if (!res.ok) {
        setError(
          typeof data.error === 'string' && data.error
            ? data.error
            : 'No se pudieron cargar las notificaciones',
        );
        return;
      }
      setItems(extraerItems(data));
    } catch (e) {
      if (!montadoRef.current) return;
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      if (montadoRef.current) setCargandoLista(false);
    }
  }, []);

  useEffect(() => {
    void refrescarContador();
    pollRef.current = setInterval(() => {
      void refrescarContador();
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refrescarContador]);

  useEffect(() => {
    const onAppState = (estado: AppStateStatus) => {
      if (estado === 'active') void refrescarContador();
    };
    const sub = AppState.addEventListener('change', onAppState);

    let onFocus: (() => void) | undefined;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      onFocus = () => void refrescarContador();
      window.addEventListener('focus', onFocus);
    }

    return () => {
      sub.remove();
      if (onFocus && typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
      }
    };
  }, [refrescarContador]);

  const abrir = () => {
    setAbierto(true);
    void cargarLista();
    void refrescarContador();
  };

  const cerrar = () => setAbierto(false);

  const marcarLeidas = useCallback(
    async (cuerpo: { ids: string[] } | { todas: true }) => {
      setMarcando(true);
      try {
        const res = await apiFetch('/api/notificaciones/leer', {
          method: 'POST',
          body: JSON.stringify(cuerpo),
          skipUnauthorizedEmit: true,
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error || 'No se pudieron marcar como leídas');
          return false;
        }
        if ('todas' in cuerpo) {
          setItems((prev) =>
            prev.map((n) => (n.leida ? n : { ...n, leida: true, leida_en: new Date().toISOString() })),
          );
          setNoLeidas(0);
        } else {
          const ids = new Set(cuerpo.ids);
          setItems((prev) =>
            prev.map((n) =>
              ids.has(n.id_notificacion)
                ? { ...n, leida: true, leida_en: n.leida_en || new Date().toISOString() }
                : n,
            ),
          );
          setNoLeidas((c) => Math.max(0, c - ids.size));
        }
        void refrescarContador();
        return true;
      } catch (e) {
        setError(errorMessage(e, 'No se pudo marcar como leída'));
        return false;
      } finally {
        setMarcando(false);
      }
    },
    [refrescarContador],
  );

  const onTapItem = async (n: Notificacion) => {
    if (!n.leida) {
      await marcarLeidas({ ids: [n.id_notificacion] });
    }
    const ruta = rutaDesdeEntidad(n.entidad_ref);
    cerrar();
    if (ruta) router.push(ruta as never);
  };

  const badgeTexto = noLeidas > 99 ? '99+' : String(noLeidas);

  return (
    <>
      <TouchableOpacity
        onPress={abrir}
        style={styles.btn}
        accessibilityLabel={
          noLeidas > 0
            ? `Notificaciones, ${noLeidas} sin leer`
            : 'Notificaciones'
        }
      >
        <MaterialIcons name="notifications" size={iconSize.tab} color={colors.textSecondary} />
        {noLeidas > 0 ? (
          <View style={styles.badge} accessibilityElementsHidden>
            <Text style={styles.badgeTexto}>{badgeTexto}</Text>
          </View>
        ) : null}
      </TouchableOpacity>

      <Modal visible={abierto} transparent animationType="fade" onRequestClose={cerrar}>
        <Pressable style={styles.overlay} onPress={cerrar}>
          <Pressable style={styles.panel} onPress={() => {}}>
            <View style={styles.panelHeader}>
              <Text style={styles.panelTitulo}>Notificaciones</Text>
              <TouchableOpacity
                onPress={cerrar}
                style={styles.cerrarBtn}
                accessibilityLabel="Cerrar"
              >
                <MaterialIcons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {noLeidas > 0 ? (
              <TouchableOpacity
                style={styles.marcarTodas}
                onPress={() => void marcarLeidas({ todas: true })}
                disabled={marcando}
                accessibilityLabel="Marcar todas como leídas"
              >
                {marcando ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <>
                    <MaterialIcons name="done-all" size={16} color={colors.accent} />
                    <Text style={styles.marcarTodasTexto}>Marcar todas como leídas</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}

            {cargandoLista && items.length === 0 ? (
              <View style={styles.centro}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={styles.centroTexto}>Cargando…</Text>
              </View>
            ) : error && items.length === 0 ? (
              <View style={styles.centro}>
                <Text style={styles.errorTexto}>{error}</Text>
                <TouchableOpacity style={styles.reintentar} onPress={() => void cargarLista()}>
                  <Text style={styles.reintentarTexto}>Reintentar</Text>
                </TouchableOpacity>
              </View>
            ) : items.length === 0 ? (
              <View style={styles.centro}>
                <MaterialIcons name="notifications-none" size={28} color={colors.textMuted} />
                <Text style={styles.centroTexto}>No tienes notificaciones</Text>
              </View>
            ) : (
              <ScrollView
                style={styles.lista}
                contentContainerStyle={styles.listaContent}
                keyboardShouldPersistTaps="handled"
              >
                {error ? <Text style={styles.errorPie}>{error}</Text> : null}
                {items.map((n) => {
                  const sinLeer = !n.leida;
                  return (
                    <TouchableOpacity
                      key={n.id_notificacion}
                      style={[styles.item, sinLeer && styles.itemSinLeer]}
                      onPress={() => void onTapItem(n)}
                      activeOpacity={0.7}
                      accessibilityLabel={`${etiquetaTipo(n.tipo)}: ${n.titulo}`}
                    >
                      <View style={[styles.itemIcono, sinLeer && styles.itemIconoSinLeer]}>
                        <MaterialIcons
                          name={iconoTipo(n.tipo)}
                          size={18}
                          color={sinLeer ? colors.accent : colors.textMuted}
                        />
                      </View>
                      <View style={styles.itemCuerpo}>
                        <View style={styles.itemMeta}>
                          <Text style={styles.itemTipo}>{etiquetaTipo(n.tipo)}</Text>
                          <Text style={styles.itemFecha}>{formatCreadoEn(n.creado_en)}</Text>
                        </View>
                        <Text style={[styles.itemTitulo, sinLeer && styles.itemTituloSinLeer]} numberOfLines={2}>
                          {n.titulo}
                        </Text>
                        {n.cuerpo ? (
                          <Text style={styles.itemCuerpoTexto} numberOfLines={2}>
                            {n.cuerpo}
                          </Text>
                        ) : null}
                      </View>
                      {sinLeer ? <View style={styles.puntoSinLeer} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  btn: {
    position: 'relative',
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xs,
    borderRadius: radius.sm,
    marginRight: SPACING.xs,
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.surface,
  },
  badgeTexto: {
    fontSize: 10,
    fontWeight: '800',
    color: '#ffffff',
    lineHeight: 12,
  },
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 48,
    paddingRight: SPACING.sm,
    paddingLeft: SPACING.sm,
  },
  panel: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '78%',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadowCard(),
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  panelTitulo: {
    ...typography.subtitulo,
    fontSize: 15,
  },
  cerrarBtn: {
    minWidth: MIN_TOUCH - 8,
    minHeight: MIN_TOUCH - 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  marcarTodas: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    minHeight: MIN_TOUCH,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSubtle,
  },
  marcarTodasTexto: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
  },
  lista: { flexGrow: 0 },
  listaContent: { paddingBottom: SPACING.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    minHeight: MIN_TOUCH + 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  itemSinLeer: {
    backgroundColor: colors.accentMuted,
  },
  itemIcono: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  itemIconoSinLeer: {
    backgroundColor: '#bae6fd',
  },
  itemCuerpo: { flex: 1, minWidth: 0, gap: 2 },
  itemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  itemTipo: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  itemFecha: {
    fontSize: 11,
    color: colors.textMuted,
  },
  itemTitulo: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textPrimary,
    lineHeight: 18,
  },
  itemTituloSinLeer: {
    fontWeight: '700',
    color: '#0f172a',
  },
  itemCuerpoTexto: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 17,
  },
  puntoSinLeer: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    marginTop: 10,
  },
  centro: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 36,
    paddingHorizontal: 20,
  },
  centroTexto: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  errorTexto: {
    fontSize: 13,
    color: colors.danger,
    textAlign: 'center',
  },
  errorPie: {
    fontSize: 12,
    color: colors.danger,
    paddingHorizontal: SPACING.md,
    paddingTop: 8,
  },
  reintentar: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  reintentarTexto: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
  },
});
