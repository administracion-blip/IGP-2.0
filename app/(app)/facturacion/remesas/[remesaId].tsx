import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
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
import { colorEstadoRemesa, labelEstadoRemesa } from '../../../lib/remesas';
import type { LineaRemesa, Remesa } from '../../../types/remesas';
import { hoyISO } from '../../../utils/facturaFormLogic';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(binary);
  // @ts-expect-error Buffer en entornos Node/web embebido
  return Buffer.from(bytes).toString('base64');
}

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export default function RemesaDetalleScreen() {
  const { remesaId } = useLocalSearchParams<{ remesaId: string }>();
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackToolbar } = useBreakpoint();
  const puedeVer = hasPermiso('remesas.ver');
  const puedeGestionar = hasPermiso('remesas.gestionar');
  const puedeEjecutar = puedeGestionar && hasPermiso('facturacion.cobrar_pagar');

  const [remesa, setRemesa] = useState<Remesa | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accionando, setAccionando] = useState(false);
  const [modalPagoRemesa, setModalPagoRemesa] = useState(false);
  const [errorEjecutar, setErrorEjecutar] = useState<string | null>(null);
  const [lineasEdit, setLineasEdit] = useState<LineaRemesa[]>([]);

  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();
  const alertMsg = useCallback(
    (titulo: string, msg: string) => {
      showToast(titulo, msg, detectToastType(titulo, msg));
    },
    [showToast],
  );

  const refetch = useCallback(() => {
    if (!remesaId || !puedeVer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch(`/api/remesas/${remesaId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        const r = data.remesa as Remesa;
        setRemesa(r);
        setLineasEdit(r.lineas || []);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [remesaId, puedeVer]);

  useFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  const guardarLineas = async () => {
    if (!remesa || remesa.estado !== 'Borrador') return;
    setAccionando(true);
    try {
      const res = await apiFetch(`/api/remesas/${remesa.remesaId}`, {
        method: 'PATCH',
        body: JSON.stringify({ lineas: lineasEdit }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      setRemesa(data.remesa);
      setLineasEdit(data.remesa.lineas || []);
    } catch (e) {
      alertMsg('Error', (e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  const descargarFichero = async () => {
    if (!remesa) return;
    setAccionando(true);
    try {
      const res = await apiFetch(`/api/remesas/${remesa.remesaId}/fichero`, { timeoutMs: 0 });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Error al generar fichero');
      }
      const buffer = await res.arrayBuffer();
      const disp = res.headers.get('Content-Disposition') || '';
      const m = disp.match(/filename="?([^"]+)"?/);
      const fileName = m?.[1] || `remesa-${remesa.sociedadCif}.xlsx`;

      if (Platform.OS === 'web') {
        const blob = new Blob([buffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = arrayBufferToBase64(buffer);
        const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
        const fileUri = `${cacheDir}${fileName}`;
        await FileSystemLegacy.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: fileName,
        });
      }
      refetch();
    } catch (e) {
      alertMsg('Error', (e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  const revalidar = async () => {
    if (!remesa) return;
    setAccionando(true);
    try {
      const res = await apiFetch(`/api/remesas/${remesa.remesaId}/revalidar`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRemesa(data.remesa);
      setLineasEdit(data.remesa.lineas || []);
      if (data.excluidas?.length) {
        alertMsg(
          'Revalidación',
          `${data.excluidas.length} factura(s) excluida(s). Revisa el detalle.`,
        );
      }
    } catch (e) {
      alertMsg('Error', (e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  const abrirModalPagar = () => {
    if (!remesa) return;
    setErrorEjecutar(null);
    setModalPagoRemesa(true);
  };

  const ejecutarRemesa = async (payload: RegistrarPagoPayloadRemesa) => {
    if (!remesa) return;
    setAccionando(true);
    setErrorEjecutar(null);
    try {
      const res = await apiFetch(`/api/remesas/${remesa.remesaId}/ejecutar`, {
        method: 'POST',
        body: JSON.stringify({
          fecha: payload.fecha,
          metodo_pago: payload.metodo_pago,
          referencia: payload.referencia,
          observaciones: payload.observaciones,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setModalPagoRemesa(false);
      setRemesa(data.remesa);
      const n = Array.isArray(data.pagos) ? data.pagos.length : remesa.lineas?.length ?? 0;
      alertMsg('Remesa pagada', `Se han registrado ${n} pago(s) en las facturas.`);
    } catch (e) {
      setErrorEjecutar((e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  const reabrir = async () => {
    if (!remesa) return;
    const ok = await confirmar('Reabrir remesa', 'Volverá a estado Borrador para editar.', {
      confirmarLabel: 'Reabrir',
    });
    if (!ok) return;
    setAccionando(true);
    try {
      const res = await apiFetch(`/api/remesas/${remesa.remesaId}`, {
        method: 'PATCH',
        body: JSON.stringify({ accion: 'reabrir' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRemesa(data.remesa);
      setLineasEdit(data.remesa.lineas || []);
    } catch (e) {
      alertMsg('Error', (e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  const anular = async () => {
    if (!remesa) return;
    const ok = await confirmar('Anular remesa', '¿Seguro? No se modificarán las facturas.', {
      confirmarLabel: 'Anular',
      variant: 'danger',
    });
    if (!ok) return;
    setAccionando(true);
    try {
      const res = await apiFetch(`/api/remesas/${remesa.remesaId}/anular`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRemesa(data.remesa);
      alertMsg('Anulada', 'Remesa anulada correctamente');
    } catch (e) {
      alertMsg('Error', (e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  const updateLinea = (id: string, patch: Partial<LineaRemesa>) => {
    setLineasEdit((prev) => prev.map((l) => (l.id_factura === id ? { ...l, ...patch } : l)));
  };

  const renderHeader = (titulo: string, estado?: Remesa['estado']) => (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Volver">
        <MaterialIcons name="arrow-back" size={22} color="#334155" />
      </TouchableOpacity>
      <Text style={styles.headerTitle} numberOfLines={2}>{titulo}</Text>
      {estado ? (
        <View style={[styles.badgeHeader, { backgroundColor: colorEstadoRemesa(estado).bg, borderColor: colorEstadoRemesa(estado).text + '44' }]}>
          <Text style={[styles.badgeHeaderText, { color: colorEstadoRemesa(estado).text }]}>
            {labelEstadoRemesa(estado)}
          </Text>
        </View>
      ) : null}
    </View>
  );

  if (!puedeVer) {
    return (
      <View style={styles.container}>
        {renderHeader('Remesa de pago')}
        <View style={styles.centered}>
          <Text style={styles.muted}>Sin permiso remesas.ver</Text>
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.container}>
        {renderHeader('Remesa de pago')}
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      </View>
    );
  }

  if (error || !remesa) {
    return (
      <View style={styles.container}>
        {renderHeader('Remesa de pago')}
        <View style={styles.centered}>
          <MaterialIcons name="error-outline" size={40} color="#fca5a5" />
          <Text style={styles.error}>{error || 'Remesa no encontrada'}</Text>
          <TouchableOpacity style={styles.btnOutline} onPress={() => router.back()}>
            <Text style={styles.btnOutlineText}>Volver</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const col = colorEstadoRemesa(remesa.estado);
  const editable = remesa.estado === 'Borrador' && puedeGestionar;
  const envioLabel = remesa.fechaEjecucion
    ? formatFecha(remesa.fechaEjecucion)
    : 'Ahora';

  return (
    <View style={styles.container}>
      {renderHeader(remesa.nombre, remesa.estado)}

      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStack]}>
        <View style={styles.kpiRow}>
          <KpiCard label="Ordenante" value={remesa.sociedadNombre || '—'} />
          <KpiCard label="CIF" value={remesa.sociedadCif || '—'} />
          <KpiCard label="Cuenta" value={remesa.cuentaOrdenante || '—'} />
          <KpiCard label={remesa.fechaEjecucion ? 'Ejecución' : 'Envío'} value={envioLabel} color="#0ea5e9" />
          <KpiCard label="Total remesa" value={formatMoneda(remesa.importeTotal)} color="#16a34a" />
          <KpiCard label="Líneas" value={String(lineasEdit.length)} />
        </View>

        <View style={[styles.actions, shouldStackToolbar && styles.actionsStack]}>
          {puedeGestionar && remesa.estado !== 'Ejecutada' && remesa.estado !== 'Anulada' ? (
            <TouchableOpacity style={styles.btnPrimary} onPress={descargarFichero} disabled={accionando}>
              <MaterialIcons name="download" size={16} color="#fff" />
              <Text style={styles.btnPrimaryText}>Descargar fichero BBVA</Text>
            </TouchableOpacity>
          ) : null}
          {puedeGestionar && ['Borrador', 'Generada'].includes(remesa.estado) ? (
            <TouchableOpacity style={styles.btnOutline} onPress={revalidar} disabled={accionando}>
              <Text style={styles.btnOutlineText}>Revalidar</Text>
            </TouchableOpacity>
          ) : null}
          {editable ? (
            <TouchableOpacity style={styles.btnOutline} onPress={guardarLineas} disabled={accionando}>
              <Text style={styles.btnOutlineText}>Guardar cambios</Text>
            </TouchableOpacity>
          ) : null}
          {puedeEjecutar && remesa.estado === 'Generada' ? (
            <TouchableOpacity style={styles.btnSuccess} onPress={abrirModalPagar} disabled={accionando}>
              <Text style={styles.btnSuccessText}>Marcar como pagada</Text>
            </TouchableOpacity>
          ) : null}
          {puedeGestionar && remesa.estado === 'Generada' ? (
            <TouchableOpacity style={styles.btnOutline} onPress={reabrir} disabled={accionando}>
              <Text style={styles.btnOutlineText}>Reabrir</Text>
            </TouchableOpacity>
          ) : null}
          {puedeGestionar && ['Borrador', 'Generada'].includes(remesa.estado) ? (
            <TouchableOpacity style={styles.btnDanger} onPress={anular} disabled={accionando}>
              <Text style={styles.btnDangerText}>Anular</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <Text style={styles.toolbarHint}>
          Revisa importes y conceptos de cada línea antes de descargar el fichero bancario.
          {remesa.estado === 'Borrador' ? ' En borrador puedes editar y guardar cambios.' : ''}
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {lineasEdit.length === 0 ? (
          <View style={styles.emptyWrap}>
            <MaterialIcons name="receipt-long" size={40} color="#cbd5e1" />
            <Text style={styles.emptyText}>No hay líneas en esta remesa.</Text>
          </View>
        ) : (
          lineasEdit.map((l) => {
            const pendiente = l.saldoPendiente ?? l.importeMaximo ?? 0;
            const importeOk = (l.importe ?? 0) > 0 && (l.importe ?? 0) <= pendiente;
            const semColor = importeOk ? '#16a34a' : '#d97706';
            return (
              <View key={l.id_factura} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.cardTitleWrap}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{l.proveedorNombre || '—'}</Text>
                    <View style={[styles.badge, { backgroundColor: col.bg, borderColor: col.text + '55' }]}>
                      <Text style={[styles.badgeText, { color: col.text }]}>
                        {formatMoneda(l.importe ?? 0)}
                      </Text>
                    </View>
                    <View style={[styles.dotSem, { backgroundColor: semColor }]} />
                  </View>
                  <Text style={[styles.cardImporte, { color: semColor }]}>
                    {formatMoneda(pendiente)}
                  </Text>
                </View>

                <View style={styles.cardBody}>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Factura</Text>
                    <Text style={styles.cardFieldValue} numberOfLines={1}>
                      {l.numero_factura_proveedor || l.numero_factura || '—'}
                    </Text>
                  </View>
                  <View style={[styles.cardField, { minWidth: 160, flex: 1 }]}>
                    <Text style={styles.cardFieldLabel}>IBAN</Text>
                    <Text style={styles.cardFieldValue} numberOfLines={1}>{l.ibanBeneficiario || '—'}</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Total</Text>
                    <Text style={styles.cardFieldValue}>{formatMoneda(l.totalFactura ?? 0)}</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Pagado</Text>
                    <Text style={styles.cardFieldValue}>{formatMoneda(l.totalPagado ?? 0)}</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Pendiente</Text>
                    <Text style={styles.cardFieldValue}>{formatMoneda(pendiente)}</Text>
                  </View>
                </View>

                <View style={styles.cardEditBody}>
                  <View style={styles.editField}>
                    <Text style={styles.cardFieldLabel}>Importe remesa</Text>
                    <TextInput
                      style={[styles.input, !editable && styles.inputDisabled]}
                      value={String(l.importe)}
                      editable={editable}
                      keyboardType="decimal-pad"
                      onChangeText={(t) => {
                        const n = parseFloat(t.replace(',', '.')) || 0;
                        const max = l.importeMaximo ?? l.saldoPendiente ?? n;
                        updateLinea(l.id_factura, { importe: Math.min(n, max) });
                      }}
                    />
                  </View>
                  <View style={[styles.editField, { flex: 1 }]}>
                    <Text style={styles.cardFieldLabel}>Concepto</Text>
                    <TextInput
                      style={[styles.inputConcepto, !editable && styles.inputDisabled]}
                      value={l.concepto}
                      editable={editable}
                      multiline
                      onChangeText={(t) => updateLinea(l.id_factura, { concepto: t.slice(0, 140) })}
                    />
                  </View>
                </View>
              </View>
            );
          })
        )}

        {remesa.excluidas && remesa.excluidas.length > 0 ? (
          <View style={styles.excluidasSection}>
            <Text style={styles.sectionTitle}>Excluidas ({remesa.excluidas.length})</Text>
            {remesa.excluidas.map((ex) => (
              <View key={ex.id_factura} style={styles.excluidaCard}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{ex.proveedorNombre || ex.id_factura}</Text>
                </View>
                <View style={styles.cardBody}>
                  <Text style={styles.excluidaMotivo}>{ex.motivo}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <RegistrarPagoModal
        visible={modalPagoRemesa}
        onClose={() => {
          if (!accionando) {
            setModalPagoRemesa(false);
            setErrorEjecutar(null);
          }
        }}
        modo="remesa"
        initial={{
          fecha: hoyISO(),
          metodo: 'transferencia',
          referencia: `Remesa ${remesa.remesaId}`,
          observaciones: '',
        }}
        resumen={{
          numFacturas: lineasEdit.length,
          importeTotal: remesa.importeTotal,
        }}
        submitting={accionando}
        errorExterno={errorEjecutar ?? undefined}
        onSubmit={ejecutarRemesa}
      />
      {ToastView}
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },
  muted: { color: '#64748b', fontSize: 14 },
  error: { color: '#dc2626', fontSize: 14, textAlign: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },
  badgeHeader: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  badgeHeaderText: { fontSize: 11, fontWeight: '700' },

  toolbar: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  toolbarStack: { gap: 10 },
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 100,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  kpiValue: { fontSize: 13, fontWeight: '700', color: '#0f172a', marginTop: 2 },
  toolbarHint: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  actionsStack: { flexDirection: 'column', alignItems: 'stretch' },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnOutline: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
  },
  btnOutlineText: { color: '#0284c7', fontWeight: '600', fontSize: 13 },
  btnSuccess: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#16a34a',
    alignItems: 'center',
  },
  btnSuccessText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnDanger: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    alignItems: 'center',
  },
  btnDangerText: { color: '#dc2626', fontWeight: '600', fontSize: 13 },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 32 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  dotSem: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardImporte: { fontSize: 13, fontWeight: '700' },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontSize: 13, color: '#334155' },
  cardEditBody: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    backgroundColor: '#fafafa',
  },
  editField: { minWidth: 140 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    backgroundColor: '#fff',
    fontSize: 14,
    color: '#0f172a',
    minHeight: 40,
  },
  inputConcepto: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    backgroundColor: '#fff',
    fontSize: 13,
    color: '#0f172a',
    minHeight: 56,
    textAlignVertical: 'top',
  },
  inputDisabled: { backgroundColor: '#f1f5f9', color: '#64748b' },

  excluidasSection: { marginTop: 8, gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 },
  excluidaCard: {
    backgroundColor: '#fff7ed',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fed7aa',
    overflow: 'hidden',
  },
  excluidaMotivo: { fontSize: 13, color: '#9a3412', lineHeight: 18 },
});
