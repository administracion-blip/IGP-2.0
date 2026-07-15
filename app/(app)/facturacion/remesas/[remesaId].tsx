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
  Alert,
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
      Alert.alert('Error', (e as Error).message);
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
      Alert.alert('Error', (e as Error).message);
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
        Alert.alert('Revalidación', `${data.excluidas.length} factura(s) excluida(s). Revisa el detalle.`);
      }
    } catch (e) {
      Alert.alert('Error', (e as Error).message);
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
      Alert.alert('Remesa pagada', `Se han registrado ${n} pago(s) en las facturas.`);
    } catch (e) {
      setErrorEjecutar((e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  const reabrir = async () => {
    if (!remesa) return;
    Alert.alert('Reabrir remesa', 'Volverá a estado Borrador para editar.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Reabrir',
        onPress: async () => {
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
            Alert.alert('Error', (e as Error).message);
          } finally {
            setAccionando(false);
          }
        },
      },
    ]);
  };

  const anular = async () => {
    if (!remesa) return;
    Alert.alert('Anular remesa', '¿Seguro? No se modificarán las facturas.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Anular',
        style: 'destructive',
        onPress: async () => {
          setAccionando(true);
          try {
            const res = await apiFetch(`/api/remesas/${remesa.remesaId}/anular`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            setRemesa(data.remesa);
          } catch (e) {
            Alert.alert('Error', (e as Error).message);
          } finally {
            setAccionando(false);
          }
        },
      },
    ]);
  };

  const updateLinea = (id: string, patch: Partial<LineaRemesa>) => {
    setLineasEdit((prev) => prev.map((l) => (l.id_factura === id ? { ...l, ...patch } : l)));
  };

  if (!puedeVer) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Sin permiso remesas.ver</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0ea5e9" />
      </View>
    );
  }

  if (error || !remesa) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error || 'Remesa no encontrada'}</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.link}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const col = colorEstadoRemesa(remesa.estado);
  const editable = remesa.estado === 'Borrador' && puedeGestionar;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.pageContent}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{remesa.nombre}</Text>
          <View style={[styles.badge, { backgroundColor: col.bg, alignSelf: 'flex-start' }]}>
            <Text style={[styles.badgeText, { color: col.text }]}>{labelEstadoRemesa(remesa.estado)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Ordenante</Text>
        <Text style={styles.meta}>{remesa.sociedadNombre} · {remesa.sociedadCif}</Text>
        <Text style={styles.meta}>Cuenta: {remesa.cuentaOrdenante}</Text>
        {remesa.fechaEjecucion ? (
          <Text style={styles.meta}>Fecha ejecución banco: {formatFecha(remesa.fechaEjecucion)}</Text>
        ) : (
          <Text style={styles.meta}>Envío: Ahora</Text>
        )}
        <Text style={styles.metaStrong}>Total: {formatMoneda(remesa.importeTotal)}</Text>
      </View>

      <View style={[styles.actions, shouldStackToolbar && styles.actionsStack]}>
        {puedeGestionar && remesa.estado !== 'Ejecutada' && remesa.estado !== 'Anulada' ? (
          <TouchableOpacity style={styles.btnPrimary} onPress={descargarFichero} disabled={accionando}>
            <MaterialIcons name="download" size={18} color="#fff" />
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

      <Text style={styles.sectionTitle}>Líneas ({lineasEdit.length})</Text>
      {lineasEdit.map((l) => (
        <View key={l.id_factura} style={styles.lineaCard}>
          <Text style={styles.lineaProv}>{l.proveedorNombre}</Text>
          <Text style={styles.lineaMeta}>
            {l.numero_factura_proveedor || l.numero_factura} · IBAN {l.ibanBeneficiario}
          </Text>
          <Text style={styles.lineaMeta}>
            Total {formatMoneda(l.totalFactura ?? 0)} · Pagado {formatMoneda(l.totalPagado ?? 0)} · Pendiente {formatMoneda(l.saldoPendiente ?? l.importeMaximo ?? 0)}
          </Text>
          <View style={styles.lineaRow}>
            <Text style={styles.label}>Importe remesa</Text>
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
          <View style={styles.lineaRow}>
            <Text style={styles.label}>Concepto</Text>
            <TextInput
              style={[styles.inputConcepto, !editable && styles.inputDisabled]}
              value={l.concepto}
              editable={editable}
              multiline
              onChangeText={(t) => updateLinea(l.id_factura, { concepto: t.slice(0, 140) })}
            />
          </View>
        </View>
      ))}

      {remesa.excluidas && remesa.excluidas.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Excluidas</Text>
          {remesa.excluidas.map((ex) => (
            <View key={ex.id_factura} style={styles.excluidaCard}>
              <Text style={styles.lineaProv}>{ex.proveedorNombre || ex.id_factura}</Text>
              <Text style={styles.excluidaMotivo}>{ex.motivo}</Text>
            </View>
          ))}
        </>
      ) : null}

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#e2e8f0' },
  pageContent: { padding: 16, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  muted: { color: '#64748b' },
  error: { color: '#b91c1c', marginBottom: 12 },
  link: { color: '#0ea5e9', fontWeight: '600' },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 16 },
  backBtn: { padding: 4, marginTop: 2 },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, marginTop: 6 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  panel: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#e2e8f0' },
  panelTitle: { fontSize: 13, fontWeight: '600', color: '#64748b', marginBottom: 8 },
  meta: { fontSize: 14, color: '#334155', marginBottom: 4 },
  metaStrong: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginTop: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  actionsStack: { flexDirection: 'column' },
  btnPrimary: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#0ea5e9', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  btnPrimaryText: { color: '#fff', fontWeight: '600' },
  btnOutline: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff' },
  btnOutlineText: { color: '#475569', fontWeight: '600' },
  btnSuccess: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#16a34a' },
  btnSuccessText: { color: '#fff', fontWeight: '600' },
  btnDanger: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: '#fee2e2' },
  btnDangerText: { color: '#b91c1c', fontWeight: '600' },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: '#0f172a', marginBottom: 10 },
  lineaCard: { backgroundColor: '#fff', borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#e2e8f0' },
  lineaProv: { fontSize: 15, fontWeight: '600', color: '#0f172a' },
  lineaMeta: { fontSize: 12, color: '#64748b', marginTop: 4 },
  lineaRow: { marginTop: 10 },
  label: { fontSize: 12, color: '#64748b', marginBottom: 4 },
  input: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 10, backgroundColor: '#f8fafc', fontSize: 15 },
  inputConcepto: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, padding: 10, backgroundColor: '#f8fafc', fontSize: 13, minHeight: 56 },
  inputDisabled: { backgroundColor: '#f1f5f9', color: '#64748b' },
  excluidaCard: { backgroundColor: '#fff7ed', borderRadius: 8, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#fed7aa' },
  excluidaMotivo: { fontSize: 13, color: '#9a3412', marginTop: 4 },
});
