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
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../../constants/theme';
import { apiFetch } from '../../../utils/api';
import { formatMoneda } from '../../../utils/facturacion';
import { formatFecha } from '../../../utils/formatFecha';
import {
  RegistrarPagoModal,
  type RegistrarPagoPayloadRemesa,
} from '../../../components/RegistrarPagoModal';
import { useLocalToast, detectToastType } from '../../../components/Toast';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { descargarAdjuntoFacturaRecibida } from '../../../lib/descargarAdjuntoFactura';
import { CollapsibleSection } from '../../../components/CollapsibleSection';
import {
  CODE_REMESA_EJECUCION_PARCIAL,
  colorEstadoRemesa,
  etiquetaAutorDescarte,
  etiquetaFacturaRemesa,
  labelEstadoRemesa,
  lineasPendientesPagoRemesa,
  mensajeErrorAccionRemesa,
  resumenEjecucionParcial,
  slugNombreArchivoRemesa,
} from '../../../lib/remesas';
import type { FallidaEjecucionRemesa, LineaRemesa, Remesa } from '../../../types/remesas';
import { hoyISO } from '../../../utils/facturaFormLogic';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(binary);
  // @ts-expect-error Buffer en entornos Node/web embebido
  return Buffer.from(bytes).toString('base64');
}

function fechaHoraDescarte(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatFecha(iso.slice(0, 10));
  return `${formatFecha(iso.slice(0, 10))} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
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
  const [viendoDocId, setViendoDocId] = useState<string | null>(null);
  const [quitandoId, setQuitandoId] = useState<string | null>(null);
  const [fallidasEjecucion, setFallidasEjecucion] = useState<FallidaEjecucionRemesa[]>([]);
  const [motivoDescarte, setMotivoDescarte] = useState('');
  const [descartandoId, setDescartandoId] = useState<string | null>(null);

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
      const nombreSlug = slugNombreArchivoRemesa(remesa.sociedadNombre);
      const cif = String(remesa.sociedadCif || 'remesa').replace(/[^A-Za-z0-9]/g, '');
      const fileName = m?.[1] || `remesa-${nombreSlug}-${cif}.xlsx`;

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
      const pagadas = Array.isArray(data.pagos) ? data.pagos.length : 0;
      if (res.status === 409 && data.code === CODE_REMESA_EJECUCION_PARCIAL) {
        const fallidas: FallidaEjecucionRemesa[] = Array.isArray(data.fallidas) ? data.fallidas : [];
        setModalPagoRemesa(false);
        setFallidasEjecucion(fallidas);
        if (data.remesa) {
          setRemesa(data.remesa);
          setLineasEdit(data.remesa.lineas || []);
        }
        setAccionando(false);
        await confirmar('Remesa pagada parcialmente', resumenEjecucionParcial(data.remesa ?? remesa, pagadas, fallidas), {
          soloAceptar: true,
        });
        refetch();
        return;
      }
      if (!res.ok) throw new Error(mensajeErrorAccionRemesa(data, 'No se pudo ejecutar la remesa'));
      setModalPagoRemesa(false);
      setFallidasEjecucion([]);
      setRemesa(data.remesa);
      setLineasEdit(data.remesa?.lineas || remesa.lineas || []);
      const n = Array.isArray(data.pagos) ? pagadas : remesa.lineas?.length ?? 0;
      alertMsg('Remesa pagada', `Se han registrado ${n} pago(s) en las facturas.`);
    } catch (e) {
      setErrorEjecutar((e as Error).message);
    } finally {
      setAccionando(false);
    }
  };

  /** Sin `facturaId` descarta todas las pendientes. No registra pagos. */
  const descartarPendientes = async (facturaId?: string) => {
    if (!remesa) return;
    const n = facturaId ? 1 : lineasPendientesPagoRemesa(remesa).length;
    if (n === 0) return;
    const motivo = motivoDescarte.trim();
    const ok = await confirmar(
      facturaId ? 'Descartar pago pendiente' : 'Descartar pagos pendientes',
      (facturaId
        ? `«${etiquetaFacturaRemesa(remesa, facturaId)}» dejará de estar pendiente en esta remesa.`
        : `${n} factura(s) dejarán de estar pendientes en esta remesa.`)
        + ' No se registra ningún pago: podrán pagarse por otra vía (pago manual, conciliación…).'
        + (motivo ? `\n\nMotivo: ${motivo}` : '\n\nPuedes indicar un motivo en el recuadro de pagos pendientes antes de confirmar.'),
      { confirmarLabel: 'Descartar', variant: 'danger' },
    );
    if (!ok) return;
    setAccionando(true);
    setDescartandoId(facturaId ?? 'todas');
    try {
      const res = await apiFetch(`/api/remesas/${remesa.remesaId}/descartar-pendientes`, {
        method: 'POST',
        body: JSON.stringify({
          ...(facturaId && { facturaIds: [facturaId] }),
          ...(motivo && { motivo }),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(mensajeErrorAccionRemesa(data, 'No se pudieron descartar los pendientes'));
      setRemesa(data.remesa);
      setLineasEdit(data.remesa?.lineas || remesa.lineas || []);
      setMotivoDescarte('');
      const descartadas = Array.isArray(data.descartadas) ? data.descartadas.length : n;
      alertMsg('Pendientes descartados', `${descartadas} factura(s) ya no están pendientes en la remesa.`);
    } catch (e) {
      alertMsg('Error', (e as Error).message);
      refetch();
    } finally {
      setAccionando(false);
      setDescartandoId(null);
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

  const verDocumento = async (idFactura: string) => {
    setViendoDocId(idFactura);
    let win: Window | null = null;
    if (Platform.OS === 'web') {
      try {
        win = window.open('about:blank', '_blank');
      } catch {
        win = null;
      }
    }
    try {
      const res = await apiFetch(`/api/facturacion/facturas/${encodeURIComponent(idFactura)}/adjuntos`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al cargar adjuntos');
      const adjuntos = data.adjuntos ?? [];
      if (adjuntos.length === 0) {
        if (win) win.close();
        showToast('Sin documento', 'Esta factura no tiene documento adjunto', 'warning');
        return;
      }
      const adj = adjuntos[0] as { id: string; url?: string };
      if (win && adj.url) {
        win.location.href = adj.url;
        return;
      }
      if (adj.url && Platform.OS !== 'web') {
        await Linking.openURL(adj.url);
        return;
      }
      if (win) win.close();
      await descargarAdjuntoFacturaRecibida(idFactura, adj.id);
    } catch (e) {
      if (win) win.close();
      showToast('Error', (e as Error).message || 'No se pudo abrir el documento', 'error');
    } finally {
      setViendoDocId(null);
    }
  };

  const quitarFactura = async (idFactura: string) => {
    if (!remesa || !puedeGestionar) return;
    if (!['Borrador', 'Generada'].includes(remesa.estado)) return;

    if (lineasEdit.length === 1) {
      const okAnular = await confirmar(
        'Última factura',
        'Es la última factura. ¿Anular toda la remesa? La factura no se borra del sistema.',
        { confirmarLabel: 'Anular remesa', variant: 'danger' },
      );
      if (!okAnular) return;
      setQuitandoId(idFactura);
      setAccionando(true);
      try {
        const res = await apiFetch(`/api/remesas/${remesa.remesaId}/anular`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al anular');
        setRemesa(data.remesa);
        setLineasEdit(data.remesa.lineas || []);
        showToast('Anulada', 'Remesa anulada correctamente', 'success');
      } catch (e) {
        showToast('Error', (e as Error).message, 'error');
      } finally {
        setQuitandoId(null);
        setAccionando(false);
      }
      return;
    }

    const esGenerada = remesa.estado === 'Generada';
    const ok = await confirmar(
      'Quitar factura',
      esGenerada
        ? '¿Sacar esta factura de la remesa? Se reabrirá la remesa a Borrador. La factura no se borra del sistema.'
        : '¿Sacar esta factura de la remesa? La factura no se borra del sistema.',
      { confirmarLabel: 'Quitar', variant: 'danger' },
    );
    if (!ok) return;

    setQuitandoId(idFactura);
    setAccionando(true);
    let reabrioOk = false;
    try {
      if (esGenerada) {
        const resReabrir = await apiFetch(`/api/remesas/${remesa.remesaId}`, {
          method: 'PATCH',
          body: JSON.stringify({ accion: 'reabrir' }),
        });
        const dataReabrir = await resReabrir.json();
        if (resReabrir.ok) {
          reabrioOk = true;
          setRemesa(dataReabrir.remesa);
          setLineasEdit(dataReabrir.remesa.lineas || []);
        } else {
          const msgReabrir = String(dataReabrir.error || '').toLowerCase();
          const pareceNoReabrable =
            msgReabrir.includes('solo se puede reabrir') ||
            msgReabrir.includes('no se puede reabrir') ||
            (msgReabrir.includes('reabrir') && msgReabrir.includes('generada'));

          const resCheck = await apiFetch(`/api/remesas/${remesa.remesaId}`);
          const dataCheck = await resCheck.json().catch(() => ({} as { remesa?: Remesa }));
          if (dataCheck.remesa) {
            setRemesa(dataCheck.remesa);
            setLineasEdit(dataCheck.remesa.lineas || []);
          }
          // Ya en Borrador u error de “no se puede reabrir” → intentar quitar igual
          if (dataCheck.remesa?.estado !== 'Borrador' && !pareceNoReabrable) {
            throw new Error(dataReabrir.error || 'Error al reabrir');
          }
        }
      }

      const res = await apiFetch(`/api/remesas/${remesa.remesaId}`, {
        method: 'PATCH',
        body: JSON.stringify({ quitarFacturaIds: [idFactura] }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (reabrioOk) {
          showToast(
            'Atención',
            'La remesa se reabrió pero no se pudo quitar la factura. Puedes quitarla ahora en borrador.',
            'warning',
          );
          return;
        }
        throw new Error(data.error || 'Error al quitar la factura');
      }
      setRemesa(data.remesa);
      setLineasEdit(data.remesa.lineas || []);
      showToast('Hecho', 'Factura quitada de la remesa', 'success');
    } catch (e) {
      showToast('Error', (e as Error).message, 'error');
    } finally {
      setQuitandoId(null);
      setAccionando(false);
    }
  };

  const updateLinea = (id: string, patch: Partial<LineaRemesa>) => {
    setLineasEdit((prev) => prev.map((l) => (l.id_factura === id ? { ...l, ...patch } : l)));
  };

  const renderHeader = (titulo: string, estado?: Remesa['estado']) => (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Volver">
        <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
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
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      </View>
    );
  }

  if (error || !remesa) {
    return (
      <View style={styles.container}>
        {renderHeader('Remesa de pago')}
        <View style={styles.centered}>
          <MaterialIcons name="error-outline" size={40} color={colors.danger} />
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
  const puedeQuitarLinea = puedeGestionar && ['Borrador', 'Generada'].includes(remesa.estado);
  const envioLabel = remesa.fechaEjecucion
    ? formatFecha(remesa.fechaEjecucion)
    : 'Ahora';
  const pendientesPago = lineasPendientesPagoRemesa(remesa);
  const idsPendientesPago = new Set(pendientesPago);
  const importePendientePago = (remesa.lineas || [])
    .filter((l) => idsPendientesPago.has(String(l.id_factura)))
    .reduce((s, l) => s + (Number(l.importe) || 0), 0);
  const motivoFallida = new Map(fallidasEjecucion.map((f) => [String(f.id_factura), f.error]));

  return (
    <View style={styles.container}>
      {renderHeader(remesa.nombre, remesa.estado)}

      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStack]}>
        <View style={styles.kpiRow}>
          <KpiCard label="Ordenante" value={remesa.sociedadNombre || '—'} />
          <KpiCard label="CIF" value={remesa.sociedadCif || '—'} />
          <KpiCard label="Cuenta" value={remesa.cuentaOrdenante || '—'} />
          <KpiCard label={remesa.fechaEjecucion ? 'Ejecución' : 'Envío'} value={envioLabel} color={colors.accent} />
          <KpiCard label="Total remesa" value={formatMoneda(remesa.importeTotal)} color={colors.success} />
          <KpiCard label="Líneas" value={String(lineasEdit.length)} />
        </View>

        <View style={[styles.actions, shouldStackToolbar && styles.actionsStack]}>
          {puedeGestionar && remesa.estado !== 'Ejecutada' && remesa.estado !== 'Anulada' ? (
            <TouchableOpacity style={styles.btnPrimary} onPress={descargarFichero} disabled={accionando}>
              <MaterialIcons name="download" size={16} color={colors.surface} />
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
          {puedeEjecutar && pendientesPago.length > 0 ? (
            <TouchableOpacity style={styles.btnWarning} onPress={abrirModalPagar} disabled={accionando}>
              <MaterialIcons name="replay" size={16} color={colors.surface} />
              <Text style={styles.btnSuccessText}>Reintentar pagos pendientes</Text>
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

        {pendientesPago.length > 0 ? (
          <View style={styles.avisoPendientes}>
            <View style={styles.avisoPendientesHeader}>
              <MaterialIcons name="warning-amber" size={18} color={colors.warning} />
              <Text style={styles.avisoPendientesTitulo}>
                Pagos pendientes: {pendientesPago.length} {pendientesPago.length === 1 ? 'factura' : 'facturas'}
                {' · '}{formatMoneda(importePendientePago)}
              </Text>
            </View>
            {pendientesPago.map((id) => (
              <Text key={id} style={styles.avisoPendientesLinea}>
                • {etiquetaFacturaRemesa(remesa, id)}
                {motivoFallida.get(id) ? `: ${motivoFallida.get(id)}` : ''}
              </Text>
            ))}
            <Text style={styles.avisoPendientesHint}>
              {puedeEjecutar
                ? 'Al reintentar solo se pagan estas facturas; las ya pagadas no se duplican. '
                  + 'Mientras sigan pendientes no se pueden pagar por otra vía: si ya se han resuelto fuera de la remesa, descártalas.'
                : 'Un usuario con permiso de pagos debe reintentar o descartar estos pagos.'}
            </Text>
            {puedeEjecutar ? (
              <View style={[styles.descartarRow, shouldStackToolbar && styles.descartarRowStack]}>
                <TextInput
                  style={styles.inputMotivoDescarte}
                  value={motivoDescarte}
                  onChangeText={(t) => setMotivoDescarte(t.slice(0, 300))}
                  placeholder="Motivo del descarte (opcional)"
                  placeholderTextColor={statusColors.warning.text}
                  editable={!accionando}
                />
                <TouchableOpacity
                  style={styles.btnDescartar}
                  onPress={() => descartarPendientes()}
                  disabled={accionando}
                >
                  {descartandoId === 'todas' ? (
                    <ActivityIndicator size="small" color={statusColors.warning.text} />
                  ) : (
                    <MaterialIcons name="playlist-remove" size={16} color={statusColors.warning.text} />
                  )}
                  <Text style={styles.btnDescartarText}>Descartar pendientes</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : null}

        <Text style={styles.toolbarHint}>
          Revisa importes y conceptos de cada línea antes de descargar el fichero bancario.
          {remesa.estado === 'Borrador' ? ' En borrador puedes editar y guardar cambios.' : ''}
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {lineasEdit.length === 0 ? (
          <View style={styles.emptyWrap}>
            <MaterialIcons name="receipt-long" size={40} color={colors.borderStrong} />
            <Text style={styles.emptyText}>No hay líneas en esta remesa.</Text>
          </View>
        ) : (
          lineasEdit.map((l) => {
            const pendiente = l.saldoPendiente ?? l.importeMaximo ?? 0;
            const importeOk = (l.importe ?? 0) > 0 && (l.importe ?? 0) <= pendiente;
            const semColor = importeOk ? colors.success : colors.warning;
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
                    {idsPendientesPago.has(String(l.id_factura)) ? (
                      puedeEjecutar ? (
                        <TouchableOpacity
                          style={[styles.badgePendientePago, styles.badgePendientePagoAccion]}
                          onPress={() => descartarPendientes(String(l.id_factura))}
                          disabled={accionando}
                          hitSlop={8}
                          accessibilityLabel="Descartar pago pendiente de esta factura"
                        >
                          <Text style={styles.badgePendientePagoText}>Pago pendiente</Text>
                          {descartandoId === String(l.id_factura) ? (
                            <ActivityIndicator size="small" color={colors.warning} />
                          ) : (
                            <MaterialIcons name="close" size={14} color={colors.warning} />
                          )}
                        </TouchableOpacity>
                      ) : (
                        <View style={styles.badgePendientePago}>
                          <Text style={styles.badgePendientePagoText}>Pago pendiente</Text>
                        </View>
                      )
                    ) : null}
                  </View>
                  <View style={styles.cardActions}>
                    <TouchableOpacity
                      style={styles.cardActionBtn}
                      onPress={() => verDocumento(l.id_factura)}
                      disabled={viendoDocId === l.id_factura}
                      accessibilityLabel="Ver documento"
                    >
                      {viendoDocId === l.id_factura ? (
                        <ActivityIndicator size="small" color={colors.textPrimary} />
                      ) : (
                        <MaterialIcons name="visibility" size={18} color={colors.textPrimary} />
                      )}
                      <Text style={styles.cardActionText}>Ver</Text>
                    </TouchableOpacity>
                    {puedeQuitarLinea ? (
                      <TouchableOpacity
                        style={[styles.cardActionBtn, styles.cardActionBtnDanger]}
                        onPress={() => quitarFactura(l.id_factura)}
                        disabled={accionando || quitandoId === l.id_factura}
                        accessibilityLabel="Quitar de la remesa"
                      >
                        {quitandoId === l.id_factura ? (
                          <ActivityIndicator size="small" color={colors.danger} />
                        ) : (
                          <MaterialIcons name="remove-circle-outline" size={18} color={colors.danger} />
                        )}
                        <Text style={[styles.cardActionText, styles.cardActionTextDanger]}>Quitar</Text>
                      </TouchableOpacity>
                    ) : null}
                    <Text style={[styles.cardImporte, { color: semColor }]}>
                      {formatMoneda(pendiente)}
                    </Text>
                  </View>
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

        {remesa.pendientesDescartadas && remesa.pendientesDescartadas.length > 0 ? (
          <View style={styles.historialDescartes}>
            <CollapsibleSection title={`Pendientes descartadas (${remesa.pendientesDescartadas.length})`}>
              {[...remesa.pendientesDescartadas].reverse().map((d, i) => (
                <View key={`${d.id_factura}-${d.en}-${i}`} style={styles.descarteItem}>
                  <Text style={styles.descarteFactura} numberOfLines={1}>
                    {etiquetaFacturaRemesa(remesa, d.id_factura)}
                  </Text>
                  <Text style={styles.descarteMeta}>
                    {etiquetaAutorDescarte(d)} · {fechaHoraDescarte(d.en)}
                  </Text>
                  {d.motivo ? <Text style={styles.descarteMotivo}>{d.motivo}</Text> : null}
                </View>
              ))}
            </CollapsibleSection>
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
        resumen={
          pendientesPago.length > 0
            ? { numFacturas: pendientesPago.length, importeTotal: importePendientePago }
            : { numFacturas: lineasEdit.length, importeTotal: remesa.importeTotal }
        }
        submitting={accionando}
        errorExterno={errorEjecutar ?? undefined}
        onSubmit={ejecutarRemesa}
      />
      {ToastView}
      {ConfirmarView}
    </View>
  );
}

/** Radio 8: entre `radius.sm` (6) y `radius.md` (10). No hay token. */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACING.xl, gap: SPACING.md },
  muted: { fontFamily: fontFamily.regular, color: colors.textMuted, fontSize: fontSizes[14] },
  error: { fontFamily: fontFamily.regular, color: colors.danger, fontSize: fontSizes[14], textAlign: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: SPACING.md,
  },
  backBtn: { padding: SPACING.xs },
  headerTitle: { flex: 1, fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  badgeHeader: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  badgeHeaderText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },

  toolbar: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  toolbarStack: { gap: 10 },
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 100,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase' },
  kpiValue: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontVariant: ['tabular-nums'], color: colors.textStrong, marginTop: 2 },
  toolbarHint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, lineHeight: 16 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  actionsStack: { flexDirection: 'column', alignItems: 'stretch' },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: RADIO_MEDIO,
  },
  btnPrimaryText: { color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },
  btnOutline: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
  },
  btnOutlineText: { color: colors.accentPressed, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },
  btnSuccess: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.success,
    alignItems: 'center',
  },
  btnSuccessText: { color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },
  btnWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.warning,
  },
  avisoPendientes: {
    backgroundColor: statusColors.warning.bg,
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderLeftWidth: 4,
    borderLeftColor: colors.warning,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.xs,
  },
  avisoPendientesHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  avisoPendientesTitulo: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: '#92400e', flexShrink: 1 },
  avisoPendientesLinea: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: '#78350f', lineHeight: 18 },
  avisoPendientesHint: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: '#92400e', marginTop: 2 },
  badgePendientePago: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: statusColors.warning.bg,
  },
  badgePendientePagoText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.warning },
  badgePendientePagoAccion: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  descartarRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.xs },
  descartarRowStack: { flexDirection: 'column', alignItems: 'stretch' },
  inputMotivoDescarte: {
    flex: 1,
    minHeight: 38,
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: 10,
    paddingVertical: SPACING.sm,
    backgroundColor: colors.surface,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textStrong,
  },
  btnDescartar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: 14,
    paddingVertical: SPACING.sm,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
  },
  btnDescartarText: { color: statusColors.warning.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },
  historialDescartes: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingBottom: 10 },
  descarteItem: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.navActive, gap: 2 },
  descarteFactura: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  descarteMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  descarteMotivo: { fontSize: fontSizes[12], color: colors.textPrimary, fontStyle: 'italic' },
  btnDanger: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: RADIO_MEDIO,
    backgroundColor: statusColors.danger.bg,
    borderWidth: 1,
    borderColor: '#fecaca',
    alignItems: 'center',
  },
  btnDangerText: { color: colors.danger, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },

  list: { flex: 1 },
  listContent: { padding: SPACING.md, gap: 10, paddingBottom: 32 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: SPACING.md },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center' },

  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
    gap: SPACING.sm,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.md, borderWidth: 1 },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  dotSem: { width: 8, height: 8, borderRadius: radius.sm, flexShrink: 0 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  cardActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    minHeight: 30,
  },
  cardActionBtnDanger: {
    borderColor: '#fecaca',
    backgroundColor: statusColors.danger.bg,
  },
  cardActionText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  cardActionTextDanger: { color: colors.danger },
  cardImporte: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontVariant: ['tabular-nums'] },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary },
  cardEditBody: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.navActive,
    backgroundColor: '#fafafa',
  },
  editField: { minWidth: 140 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    padding: 10,
    backgroundColor: colors.surface,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textStrong,
    minHeight: 40,
  },
  inputConcepto: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    padding: 10,
    backgroundColor: colors.surface,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textStrong,
    minHeight: 56,
    textAlignVertical: 'top',
  },
  inputDisabled: { backgroundColor: colors.navActive, color: colors.textMuted },

  excluidasSection: { marginTop: SPACING.sm, gap: SPACING.sm },
  sectionTitle: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 },
  excluidaCard: {
    backgroundColor: '#fff7ed',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#fed7aa',
    overflow: 'hidden',
  },
  excluidaMotivo: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: '#9a3412', lineHeight: 18 },
});
