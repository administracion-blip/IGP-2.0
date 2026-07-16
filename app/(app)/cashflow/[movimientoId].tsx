import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Linking,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { FirmaEnPantallaModal } from '../../components/FirmaEnPantallaModal';
import { useLocalToast } from '../../components/Toast';
import { buildFirmaFormData } from '../../utils/uploadFirmaPng';
import { apiFetch, errorMessage } from '../../utils/api';
import {
  type CashflowEstado,
  type CashflowMovimiento,
  ESTADO_CASHFLOW_META,
  CATEGORIA_CASHFLOW_LABEL,
  lineasMovimiento,
  formatImporteCashflow,
} from '../../types/cashflow';

const FIRMA_TIMEOUT_MS = 120_000;

function mensajeExitoFirma(estado: CashflowEstado): string {
  if (estado === 'Pendiente_validacion') {
    return 'Pendiente de validación por importe elevado.';
  }
  return 'El recibí se ha generado y guardado.';
}

function formatMoneda(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const parts = Math.abs(n).toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = n < 0 ? '-' : '';
  return `${sign}${intPart},${parts[1]} €`;
}

function fechaLarga(iso: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || '—';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function fechaHora(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function CashflowDetalleScreen() {
  const router = useRouter();
  const { movimientoId } = useLocalSearchParams<{ movimientoId: string }>();
  const id = typeof movimientoId === 'string' ? movimientoId : '';
  const { hasPermiso } = useAuth();

  const [mov, setMov] = useState<CashflowMovimiento | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalFirma, setModalFirma] = useState(false);
  const [firmaSubiendo, setFirmaSubiendo] = useState(false);
  const [accionando, setAccionando] = useState(false);
  const [motivoAnulacion, setMotivoAnulacion] = useState('');
  const [mostrarAnular, setMostrarAnular] = useState(false);

  const puedeRegistrar = hasPermiso('cashflow.registrar');
  const puedeValidar = hasPermiso('cashflow.validar');
  const { show: showToast, ToastView } = useLocalToast();

  const cargar = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/cashflow/${id}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo cargar el movimiento');
      setMov(d.movimiento as CashflowMovimiento);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar');
      setMov(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const enviarFirma = useCallback(
    async (base64Raw: string) => {
      if (!id) return;
      setFirmaSubiendo(true);
      setError(null);

      const confirmarFirmaGuardada = (movimiento: CashflowMovimiento) => {
        setMov(movimiento);
        setModalFirma(false);
        setError(null);
        showToast('Firmado correctamente', mensajeExitoFirma(movimiento.estado), 'success');
      };

      try {
        const formData = await buildFirmaFormData(base64Raw);
        const r = await apiFetch(`/api/cashflow/${id}/firmar`, {
          method: 'POST',
          body: formData,
          timeoutMs: FIRMA_TIMEOUT_MS,
        });
        const d = await r.json();
        if (!r.ok) {
          setError(d.error || 'No se pudo guardar la firma');
          return;
        }
        confirmarFirmaGuardada(d.movimiento as CashflowMovimiento);
      } catch (e) {
        try {
          const r = await apiFetch(`/api/cashflow/${id}`);
          const d = await r.json();
          const movimiento = r.ok ? (d.movimiento as CashflowMovimiento | undefined) : undefined;
          if (movimiento && movimiento.estado !== 'Pendiente_firma') {
            confirmarFirmaGuardada(movimiento);
            return;
          }
        } catch {
          /* ignorar fallo de comprobación */
        }
        setError(errorMessage(e, 'Error de red al guardar la firma'));
      } finally {
        setFirmaSubiendo(false);
      }
    },
    [id, showToast],
  );

  async function validar() {
    if (!id) return;
    setAccionando(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/cashflow/${id}/validar`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo validar');
      setMov(d.movimiento as CashflowMovimiento);
      showToast('Validado', 'El movimiento ha quedado validado.', 'success');
    } catch (e) {
      setError(errorMessage(e, 'Error al validar'));
    } finally {
      setAccionando(false);
    }
  }

  async function anular() {
    if (!id || !motivoAnulacion.trim()) {
      setError('Indica el motivo de anulación');
      return;
    }
    setAccionando(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/cashflow/${id}/anular`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo: motivoAnulacion.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo anular');
      setMov(d.movimiento as CashflowMovimiento);
      setMostrarAnular(false);
      showToast('Anulado', 'El movimiento se ha anulado correctamente.', 'success');
    } catch (e) {
      setError(errorMessage(e, 'Error al anular'));
    } finally {
      setAccionando(false);
    }
  }

  async function abrirRecibo() {
    if (!id) return;
    try {
      const r = await apiFetch(`/api/cashflow/${id}/recibo`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Recibo no disponible');
      if (d.url) {
        if (Platform.OS === 'web') window.open(d.url, '_blank');
        else await Linking.openURL(d.url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo abrir el recibo');
    }
  }

  if (!hasPermiso('cashflow.ver')) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para ver Cashflow.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#0ea5e9" size="large" />
      </View>
    );
  }

  if (!mov) {
    return (
      <View style={styles.container}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backLink}>
          <MaterialIcons name="arrow-back" size={20} color="#334155" />
          <Text style={styles.backLinkText}>Volver</Text>
        </TouchableOpacity>
        <Text style={styles.errorText}>{error || 'Movimiento no encontrado'}</Text>
      </View>
    );
  }

  const meta = ESTADO_CASHFLOW_META[mov.estado] ?? ESTADO_CASHFLOW_META.Pendiente_firma;
  const esPago = mov.tipo === 'pago';
  const lineas = lineasMovimiento(mov);
  const tituloFirma = esPago
    ? `Firma de ${mov.contraparte?.nombre || 'contraparte'}`
    : 'Firma del encargado que recibe';
  const subtituloFirma = esPago
    ? 'La contraparte (músico, proveedor…) debe firmar el recibí.'
    : 'El encargado del local firma confirmando la recepción del cobro.';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.formMax}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <MaterialIcons name="arrow-back" size={22} color="#334155" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Movimiento cashflow</Text>
              <Text style={styles.subtitle}>{mov.localNombre || mov.localId}</Text>
            </View>
            <View style={[styles.estadoBadge, { backgroundColor: meta.bg }]}>
              <Text style={[styles.estadoText, { color: meta.color }]}>{meta.label}</Text>
            </View>
          </View>

          <View style={styles.importeCard}>
            <Text style={styles.importeLabel}>{esPago ? 'Pago' : 'Cobro'}</Text>
            <Text style={[styles.importeVal, esPago ? styles.importePago : styles.importeCobro]}>
              {formatImporteCashflow(mov.importe, mov.tipo)}
            </Text>
            {mov.numeroRecibo ? <Text style={styles.reciboNum}>Recibo {mov.numeroRecibo}</Text> : null}
          </View>

          {lineas.length > 0 ? (
            <View style={styles.lineasCard}>
              <Text style={styles.lineasTitle}>Detalle de conceptos</Text>
              {lineas.map((ln, i) => (
                <View key={`${ln.descripcion}-${i}`} style={styles.lineaRow}>
                  <Text style={styles.lineaDesc} numberOfLines={2}>{ln.descripcion}</Text>
                  <Text style={styles.lineaImp}>{formatMoneda(ln.importe)}</Text>
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.infoGrid}>
            <InfoRow icon="event" label="Fecha jornada" value={fechaLarga(mov.fecha)} />
            {mov.empresaNombre ? <InfoRow icon="business" label="Sociedad" value={mov.empresaNombre} /> : null}
            <InfoRow icon="category" label="Categoría" value={CATEGORIA_CASHFLOW_LABEL[mov.categoria] ?? mov.categoria} />
            <InfoRow icon="person" label="Contraparte" value={mov.contraparte?.nombre || '—'} />
            {mov.contraparte?.nif ? <InfoRow icon="badge" label="NIF/CIF" value={mov.contraparte.nif} /> : null}
            {mov.contraparte?.telefono ? <InfoRow icon="phone" label="Teléfono" value={mov.contraparte.telefono} /> : null}
            {mov.tipo === 'cobro' ? (
              <InfoRow
                icon="account-balance"
                label="Destino"
                value={mov.destinoCobro === 'reparto_socios' ? 'Reparto entre socios' : 'Ingreso en banco'}
              />
            ) : null}
            {mov.emailsCopia?.length ? (
              <InfoRow icon="mail" label="Emails copia" value={mov.emailsCopia.join(', ')} />
            ) : null}
            {mov.creadoPorNombre ? <InfoRow icon="person-outline" label="Registrado por" value={mov.creadoPorNombre} /> : null}
            {mov.creadoEn ? <InfoRow icon="schedule" label="Registrado el" value={fechaHora(mov.creadoEn)} /> : null}
            {mov.firmadoPorNombre ? <InfoRow icon="draw" label="Firmado por" value={mov.firmadoPorNombre} /> : null}
            {mov.validadoPor ? <InfoRow icon="verified" label="Validado por" value={mov.validadoPor} /> : null}
            {mov.anulacion?.motivo ? (
              <InfoRow icon="block" label="Anulación" value={`${mov.anulacion.motivo}${mov.anulacion.usuarioEmail ? ` (${mov.anulacion.usuarioEmail})` : ''}`} />
            ) : null}
          </View>

          {error ? (
            <View style={styles.errBox}>
              <MaterialIcons name="error-outline" size={18} color="#dc2626" />
              <Text style={styles.errText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.acciones}>
            {mov.estado === 'Pendiente_firma' && puedeRegistrar ? (
              <TouchableOpacity style={styles.btnPrimary} onPress={() => setModalFirma(true)}>
                <MaterialIcons name="draw" size={20} color="#fff" />
                <Text style={styles.btnPrimaryText}>Firmar recibí</Text>
              </TouchableOpacity>
            ) : null}

            {mov.numeroRecibo ? (
              <TouchableOpacity style={styles.btnSecondary} onPress={abrirRecibo}>
                <MaterialIcons name="picture-as-pdf" size={20} color="#0369a1" />
                <Text style={styles.btnSecondaryText}>Ver PDF recibí</Text>
              </TouchableOpacity>
            ) : null}

            {mov.estado === 'Pendiente_validacion' && puedeValidar ? (
              <TouchableOpacity style={styles.btnSuccess} onPress={validar} disabled={accionando}>
                {accionando ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <MaterialIcons name="verified" size={20} color="#fff" />
                    <Text style={styles.btnPrimaryText}>Validar movimiento</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}

            {mov.estado !== 'Anulado' && puedeValidar ? (
              mostrarAnular ? (
                <View style={styles.anularBox}>
                  <Text style={styles.label}>Motivo de anulación</Text>
                  <TextInput
                    style={styles.input}
                    value={motivoAnulacion}
                    onChangeText={setMotivoAnulacion}
                    placeholder="Indica el motivo"
                    multiline
                  />
                  <View style={styles.anularRow}>
                    <TouchableOpacity style={styles.btnGhost} onPress={() => setMostrarAnular(false)}>
                      <Text style={styles.btnGhostText}>Cancelar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.btnDanger} onPress={anular} disabled={accionando}>
                      <Text style={styles.btnPrimaryText}>Confirmar anulación</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity style={styles.btnDangerOutline} onPress={() => setMostrarAnular(true)}>
                  <MaterialIcons name="block" size={18} color="#b91c1c" />
                  <Text style={styles.btnDangerText}>Anular</Text>
                </TouchableOpacity>
              )
            ) : null}
          </View>

          <View style={{ height: 40 }} />
        </View>
      </ScrollView>

      <FirmaEnPantallaModal
        visible={modalFirma}
        onClose={() => setModalFirma(false)}
        onConfirm={enviarFirma}
        uploading={firmaSubiendo}
        title={tituloFirma}
        subtitle={subtituloFirma}
      />
      {ToastView}
    </View>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  value: string;
}) {
  return (
    <View style={styles.infoRow}>
      <MaterialIcons name={icon} size={18} color="#64748b" />
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc', position: 'relative' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { padding: 16, alignItems: 'center' },
  formMax: { width: '100%', maxWidth: 640 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b' },
  estadoBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  estadoText: { fontSize: 12, fontWeight: '700' },
  importeCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    alignItems: 'center',
    marginBottom: 14,
  },
  importeLabel: { fontSize: 12, color: '#64748b', fontWeight: '600', textTransform: 'uppercase' },
  importeVal: { fontSize: 28, fontWeight: '800', marginTop: 4 },
  importePago: { color: '#b91c1c' },
  importeCobro: { color: '#15803d' },
  reciboNum: { fontSize: 12, color: '#64748b', marginTop: 6 },
  lineasCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 14,
  },
  lineasTitle: { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 8 },
  lineaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  lineaDesc: { flex: 1, fontSize: 13, color: '#475569' },
  lineaImp: { fontSize: 13, fontWeight: '700', color: '#334155' },
  infoGrid: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', padding: 12, marginBottom: 14 },
  infoRow: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  infoLabel: { fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', fontWeight: '600' },
  infoValue: { fontSize: 14, color: '#334155', marginTop: 2 },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8, marginBottom: 12 },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  acciones: { gap: 10 },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0ea5e9',
    paddingVertical: 14,
    borderRadius: 8,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  btnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#e0f2fe',
    paddingVertical: 12,
    borderRadius: 8,
  },
  btnSecondaryText: { color: '#0369a1', fontWeight: '700', fontSize: 14 },
  btnSuccess: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#16a34a',
    paddingVertical: 14,
    borderRadius: 8,
  },
  btnDangerOutline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fff',
  },
  btnDangerText: { color: '#b91c1c', fontWeight: '700' },
  anularBox: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#fecaca', padding: 12 },
  label: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 60,
    marginBottom: 10,
    backgroundColor: '#fff',
  },
  anularRow: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  btnGhost: { paddingVertical: 10, paddingHorizontal: 14 },
  btnGhostText: { color: '#64748b', fontWeight: '600' },
  btnDanger: { backgroundColor: '#dc2626', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 16 },
  backLinkText: { fontSize: 14, color: '#334155' },
  errorText: { padding: 16, color: '#b91c1c' },
});
