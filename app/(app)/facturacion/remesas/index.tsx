import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { apiFetch } from '../../../utils/api';
import { formatMoneda } from '../../../utils/facturacion';
import { formatFecha } from '../../../utils/formatFecha';
import {
  RegistrarPagoModal,
  type RegistrarPagoPayloadRemesa,
} from '../../../components/RegistrarPagoModal';
import { useLocalToast, detectToastType } from '../../../components/Toast';
import { useConfirmar } from '../../../hooks/useConfirmar';
import {
  CODE_REMESA_EJECUCION_PARCIAL,
  colorEstadoRemesa,
  FILTROS_ESTADO_REMESA,
  labelEstadoRemesa,
  lineasPendientesPagoRemesa,
  mensajeErrorAccionRemesa,
  resumenEjecucionParcial,
} from '../../../lib/remesas';
import type { Remesa, EstadoRemesa, FallidaEjecucionRemesa } from '../../../types/remesas';
import { hoyISO } from '../../../utils/facturaFormLogic';
import { SoftPulseBorderWrap } from '../../../components/ui/SoftPulseBorderWrap';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  shadow,
  statusColors,
  typography,
  SPACING,
} from '../../../constants/theme';

export default function RemesasIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackToolbar } = useBreakpoint();
  const puedeVer = hasPermiso('remesas.ver');
  const puedeGestionar = hasPermiso('remesas.gestionar');
  const puedeEjecutar = puedeGestionar && hasPermiso('facturacion.cobrar_pagar');

  const [items, setItems] = useState<Remesa[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<EstadoRemesa | 'todos'>('todos');
  const [remesaPago, setRemesaPago] = useState<Remesa | null>(null);
  const [accionando, setAccionando] = useState(false);
  const [errorEjecutar, setErrorEjecutar] = useState<string | null>(null);

  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();

  const refetch = useCallback(() => {
    if (!puedeVer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const q = filtroEstado !== 'todos' ? `?estado=${encodeURIComponent(filtroEstado)}` : '';
    apiFetch(`/api/remesas${q}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setItems(data.items || []);
      })
      .catch((e) => setError((e as Error).message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [filtroEstado, puedeVer]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const abrirModalPagar = (r: Remesa) => {
    setErrorEjecutar(null);
    setRemesaPago(r);
  };

  const ejecutarRemesa = async (payload: RegistrarPagoPayloadRemesa) => {
    if (!remesaPago) return;
    setAccionando(true);
    setErrorEjecutar(null);
    try {
      const res = await apiFetch(`/api/remesas/${remesaPago.remesaId}/ejecutar`, {
        method: 'POST',
        body: JSON.stringify({
          fecha: payload.fecha,
          metodo_pago: payload.metodo_pago,
          referencia: payload.referencia,
          observaciones: payload.observaciones,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === CODE_REMESA_EJECUCION_PARCIAL) {
        const fallidas: FallidaEjecucionRemesa[] = Array.isArray(data.fallidas) ? data.fallidas : [];
        const pagadas = Array.isArray(data.pagos) ? data.pagos.length : 0;
        const remesaRef = data.remesa ?? remesaPago;
        setRemesaPago(null);
        setAccionando(false);
        refetch();
        await confirmar('Remesa pagada parcialmente', resumenEjecucionParcial(remesaRef, pagadas, fallidas), {
          soloAceptar: true,
        });
        return;
      }
      if (!res.ok) throw new Error(mensajeErrorAccionRemesa(data, 'No se pudo ejecutar la remesa'));
      setRemesaPago(null);
      const n = Array.isArray(data.pagos) ? data.pagos.length : remesaPago.lineas?.length ?? 0;
      showToast('Remesa pagada', `Se han registrado ${n} pago(s) en las facturas.`, detectToastType('Remesa pagada', ''));
      refetch();
    } catch (e) {
      setErrorEjecutar((e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  if (!puedeVer) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>No tienes permiso para ver remesas de pago.</Text>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.pageContent}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.push('/facturacion' as never)}
            style={styles.backBtn}
            accessibilityLabel="Volver"
          >
            <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Remesas de pago</Text>
        </View>
        <Text style={styles.subtitle}>Agrupa facturas pendientes y genera el fichero para el banco</Text>

        <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStack]}>
          <View style={styles.toolbarSpacer} />
          <TouchableOpacity style={styles.btnSecondary} onPress={() => router.push('/facturacion/facturas-gasto' as never)}>
            <MaterialIcons name="description" size={18} color={colors.accent} />
            <Text style={styles.btnSecondaryText}>Ir a facturas recibidas</Text>
          </TouchableOpacity>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filtros}>
          {FILTROS_ESTADO_REMESA.map((f) => (
            <TouchableOpacity
              key={f.id}
              style={[styles.chip, filtroEstado === f.id && styles.chipActive]}
              onPress={() => setFiltroEstado(f.id)}
            >
              <Text style={[styles.chipText, filtroEstado === f.id && styles.chipTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {loading ? (
          <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 32 }} />
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <MaterialIcons name="account-balance" size={48} color={colors.textMuted} />
            <Text style={styles.emptyText}>No hay remesas{puedeGestionar ? '. Selecciona facturas en Facturas recibidas.' : '.'}</Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {items.map((r) => {
              const col = colorEstadoRemesa(r.estado);
              const mostrarPagar = puedeEjecutar && r.estado === 'Generada';
              const esBorrador = r.estado === 'Borrador';
              const numPendientesPago = lineasPendientesPagoRemesa(r).length;
              const contenido = (
                <>
                  <TouchableOpacity
                    onPress={() => router.push(`/facturacion/remesas/${r.remesaId}` as never)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.cardHeader}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{r.nombre}</Text>
                      <View style={[styles.badge, { backgroundColor: col.bg }]}>
                        <Text style={[styles.badgeText, { color: col.text }]}>{labelEstadoRemesa(r.estado)}</Text>
                      </View>
                    </View>
                    <Text style={styles.cardMeta}>{r.sociedadNombre}</Text>
                    <Text style={styles.cardMeta}>{r.lineas?.length || 0} facturas · {formatMoneda(r.importeTotal)}</Text>
                    {numPendientesPago > 0 ? (
                      <View style={styles.badgePendientes}>
                        <MaterialIcons name="warning-amber" size={14} color={colors.warning} />
                        <Text style={styles.badgePendientesText}>
                          Pagos pendientes: {numPendientesPago} {numPendientesPago === 1 ? 'factura' : 'facturas'}
                        </Text>
                      </View>
                    ) : null}
                    {r.creadoEn ? (
                      <Text style={styles.cardDate}>Creada {formatFecha(r.creadoEn.slice(0, 10))}</Text>
                    ) : null}
                  </TouchableOpacity>
                  {mostrarPagar ? (
                    <TouchableOpacity
                      style={[styles.btnSuccess, accionando && remesaPago?.remesaId === r.remesaId && styles.btnDisabled]}
                      onPress={() => abrirModalPagar(r)}
                      disabled={accionando}
                    >
                      {accionando && remesaPago?.remesaId === r.remesaId ? (
                        <ActivityIndicator size="small" color={colors.surface} />
                      ) : (
                        <Text style={styles.btnSuccessText}>Marcar como pagada</Text>
                      )}
                    </TouchableOpacity>
                  ) : null}
                </>
              );
              return esBorrador ? (
                <SoftPulseBorderWrap
                  key={r.remesaId}
                  preset="favoritos"
                  borderRadius={12}
                  style={styles.cardLaser}
                >
                  <View style={[styles.card, styles.cardBorrador]}>{contenido}</View>
                </SoftPulseBorderWrap>
              ) : (
                <View key={r.remesaId} style={styles.card}>{contenido}</View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {remesaPago ? (
        <RegistrarPagoModal
          visible={!!remesaPago}
          onClose={() => {
            if (!accionando) {
              setRemesaPago(null);
              setErrorEjecutar(null);
            }
          }}
          modo="remesa"
          initial={{
            fecha: hoyISO(),
            metodo: 'transferencia',
            referencia: `Remesa ${remesaPago.remesaId}`,
            observaciones: '',
          }}
          resumen={{
            numFacturas: remesaPago.lineas?.length || 0,
            importeTotal: remesaPago.importeTotal,
          }}
          submitting={accionando}
          errorExterno={errorEjecutar ?? undefined}
          onSubmit={ejecutarRemesa}
        />
      ) : null}
      {ToastView}
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface },
  scroll: { flex: 1 },
  pageContent: { padding: SPACING.lg, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACING.xl },
  denied: { fontFamily: fontFamily.regular, color: colors.textMuted, fontSize: fontSizes[16] },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.xs },
  backBtn: { padding: SPACING.xs },
  toolbar: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'flex-start', marginBottom: SPACING.lg, gap: SPACING.md },
  toolbarStack: { flexDirection: 'column', alignItems: 'stretch' },
  toolbarSpacer: { flex: 1 },
  title: { fontSize: 22, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, flex: 1 }, // 22: entre fontSizes[20] y [24]
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, marginBottom: SPACING.md },
  btnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 8, // entre radius.sm y radius.md,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  btnSecondaryText: { color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[14] },
  filtros: { marginBottom: SPACING.lg, maxHeight: 44 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: SPACING.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    marginRight: SPACING.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textPrimary, fontSize: fontSizes[13], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  chipTextActive: { color: colors.surface },
  error: { fontFamily: fontFamily.regular, color: statusColors.danger.text, marginTop: SPACING.lg },
  empty: { alignItems: 'center', marginTop: 48, gap: SPACING.md },
  emptyText: { fontFamily: fontFamily.regular, color: colors.textMuted, fontSize: fontSizes[16], textAlign: 'center' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: SPACING.lg,
    minWidth: Platform.OS === 'web' ? 280 : '100%',
    flexGrow: 1,
    flexBasis: 280,
    maxWidth: Platform.OS === 'web' ? 360 : '100%',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  cardLaser: {
    minWidth: Platform.OS === 'web' ? 280 : '100%',
    flexGrow: 1,
    flexBasis: 280,
    maxWidth: Platform.OS === 'web' ? 360 : '100%',
  },
  cardBorrador: {
    borderWidth: 0,
    width: '100%',
    minWidth: '100%',
    flexGrow: 0,
    flexBasis: 'auto',
    maxWidth: '100%',
    ...Platform.select({
      web: { boxShadow: 'none' as unknown as undefined },
      default: { elevation: 0, shadowOpacity: 0 },
    }),
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACING.sm, marginBottom: SPACING.sm },
  cardTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong, flex: 1 },
  badge: { paddingHorizontal: SPACING.sm, paddingVertical: 3, borderRadius: radius.sm },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  cardMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, marginBottom: 2 },
  cardDate: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: SPACING.sm },
  badgePendientes: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: SPACING.xs,
    marginTop: 6,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: statusColors.warning.bg,
  },
  badgePendientesText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.warning },
  btnSuccess: {
    marginTop: SPACING.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 8, // entre radius.sm y radius.md,
    backgroundColor: colors.success,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  btnSuccessText: { color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },
  btnDisabled: { opacity: 0.7 },
});
