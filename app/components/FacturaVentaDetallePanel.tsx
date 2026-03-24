import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Modal,
  Pressable,
  Linking,
  Alert,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  calcularLinea,
  formatMoneda,
  CONDICIONES_PAGO,
  FORMAS_PAGO,
  labelFormaPago,
  type Factura,
} from '../utils/facturacion';
import { dmyToIso, hydrateLineasDesdeFactura, isoToDmy, lineasPayloadForApi } from '../utils/facturaFormLogic';
import { useFacturaFormLogic } from '../hooks/useFacturaFormLogic';
import { ResumenTotales } from './ResumenTotales';
import { InputFecha } from './InputFecha';
import { textoFechaContabilizacionGasto } from '../utils/formatFecha';
import { BadgeEstado } from './BadgeEstado';

/** Anchos fijos por columna (cabecera + filas en el mismo ScrollView) — sin flexGrow para que coincidan con los inputs */
const LINEA_W_IDX = 22;
const LINEA_W_DEL = 28;
const LINEA_W_CONCEPTO = 200;
const LINEA_W_NUM = 50;
const LINEA_W_NUM_SM = 42;
const LINEA_W_TOTALES = 120;

type AdjuntoItem = {
  id: string;
  nombre: string;
  tipo?: string;
  size?: number;
  url?: string;
  subido_en?: string;
  subido_por?: string;
};

/** Campos extra que devuelve GET factura y usa el PDF */
type EmpresaCatalogo = {
  id_empresa?: string;
  Nombre?: string;
  Cif?: string;
};

type FacturaApi = Factura & {
  emisor_direccion?: string;
  emisor_cp?: string;
  emisor_municipio?: string;
  emisor_provincia?: string;
  emisor_email?: string;
  empresa_direccion?: string;
  empresa_cp?: string;
  empresa_municipio?: string;
  empresa_provincia?: string;
  empresa_email?: string;
  verifactu_hash?: string;
};

type Props = {
  apiUrl: string;
  facturaId: string | null;
  /** IN = recibida (gasto), OUT = emitida (venta) */
  tipoFactura?: 'IN' | 'OUT';
  puedeEditar: boolean;
  usuarioId?: string;
  usuarioNombre?: string;
  onGuardado: () => void;
  onAbrirCompleto: (id: string) => void;
};

export function FacturaVentaDetallePanel({
  apiUrl,
  facturaId,
  tipoFactura = 'OUT',
  puedeEditar,
  usuarioId,
  usuarioNombre,
  onGuardado,
  onAbrirCompleto,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const facturaForm = useFacturaFormLogic({
    modo: 'editar',
    loading,
    initialFechaEmision: '',
  });
  const {
    fechaEmision,
    setFechaEmision,
    fechaVencimiento,
    setFechaVencimiento,
    condicionesPago,
    setCondicionesPago,
    formaPago,
    setFormaPago,
    lineas,
    setLineas,
    totales,
    updateLinea,
    addLinea,
    removeLinea,
    markHydrationFromApi,
  } = facturaForm;

  const [estado, setEstado] = useState('');
  const [numeroFactura, setNumeroFactura] = useState('');
  const [serie, setSerie] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [emisorId, setEmisorId] = useState('');
  const [emisorNombre, setEmisorNombre] = useState('');
  const [emisorCif, setEmisorCif] = useState('');
  const [empresaId, setEmpresaId] = useState('');
  const [empresaNombre, setEmpresaNombre] = useState('');
  const [empresaCif, setEmpresaCif] = useState('');
  const [numFacturaProveedor, setNumFacturaProveedor] = useState('');
  const [fechaContabilizacionIso, setFechaContabilizacionIso] = useState('');
  const [contabilizadoPor, setContabilizadoPor] = useState('');
  const [creadoEn, setCreadoEn] = useState('');
  const [version, setVersion] = useState(1);
  const [adjuntos, setAdjuntos] = useState<AdjuntoItem[]>([]);
  const [adjuntosLoading, setAdjuntosLoading] = useState(false);
  const [modalAdjuntos, setModalAdjuntos] = useState(false);
  const [modalCondicionesOpen, setModalCondicionesOpen] = useState(false);
  const [modalFormaPagoOpen, setModalFormaPagoOpen] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  const [emisorDireccion, setEmisorDireccion] = useState('');
  const [emisorCp, setEmisorCp] = useState('');
  const [emisorMunicipio, setEmisorMunicipio] = useState('');
  const [emisorProvincia, setEmisorProvincia] = useState('');
  const [emisorEmail, setEmisorEmail] = useState('');
  const [empresaDireccion, setEmpresaDireccion] = useState('');
  const [empresaCp, setEmpresaCp] = useState('');
  const [empresaMunicipio, setEmpresaMunicipio] = useState('');
  const [empresaProvincia, setEmpresaProvincia] = useState('');
  const [empresaEmail, setEmpresaEmail] = useState('');
  const [numeroCorrelativo, setNumeroCorrelativo] = useState(0);
  const [totalCobrado, setTotalCobrado] = useState(0);
  const [saldoPendiente, setSaldoPendiente] = useState(0);
  const [esRectificativa, setEsRectificativa] = useState(false);
  const [facturaRectificadaId, setFacturaRectificadaId] = useState('');
  const [motivoRectificacion, setMotivoRectificacion] = useState('');
  const [verifactuHash, setVerifactuHash] = useState('');
  const [empresasCatalogo, setEmpresasCatalogo] = useState<EmpresaCatalogo[]>([]);

  const esIn = tipoFactura === 'IN';
  const lblEmisor = esIn ? 'Empresa (grupo)' : 'Emisor';
  const lblEmpresa = esIn ? 'Proveedor' : 'Receptor';

  const esEditable = puedeEditar && (estado === 'borrador' || estado === 'pendiente_revision');

  useEffect(() => {
    if (!apiUrl) return;
    fetch(`${apiUrl}/api/empresas`)
      .then((r) => r.json())
      .then((d) => setEmpresasCatalogo(Array.isArray(d.empresas) ? d.empresas : []))
      .catch(() => setEmpresasCatalogo([]));
  }, [apiUrl]);

  /** Si el nombre coincide con una fila de `empresas`, rellena CIF e id desde la tabla */
  const sincronizarEmisorConCatalogo = useCallback(() => {
    const n = emisorNombre.trim().toLowerCase();
    if (!n || empresasCatalogo.length === 0) return;
    const e = empresasCatalogo.find((x) => (x.Nombre || '').trim().toLowerCase() === n);
    if (e) {
      setEmisorId(String(e.id_empresa ?? ''));
      setEmisorCif(String(e.Cif ?? '').trim());
    }
  }, [emisorNombre, empresasCatalogo]);

  const cargar = useCallback(async () => {
    if (!facturaId) return;
    setLoading(true);
    setError(null);
    setAdjuntos([]);
    setAdjuntosLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/facturacion/facturas/${facturaId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar');
      const f = (data.factura ?? data) as FacturaApi;
      markHydrationFromApi();
      setEstado(f.estado ?? '');
      setNumeroFactura(f.numero_factura ?? '');
      setSerie(f.serie ?? '');
      setFechaEmision(isoToDmy(f.fecha_emision ?? ''));
      setFechaVencimiento(isoToDmy(f.fecha_vencimiento ?? ''));
      setCondicionesPago(f.condiciones_pago ?? 'contado');
      setFormaPago(f.forma_pago ?? 'transferencia');
      setObservaciones(f.observaciones ?? '');
      setEmisorId(f.emisor_id ?? '');
      setEmisorNombre(f.emisor_nombre ?? '');
      setEmisorCif(f.emisor_cif ?? '');
      setEmisorDireccion(f.emisor_direccion ?? '');
      setEmisorCp(f.emisor_cp ?? '');
      setEmisorMunicipio(f.emisor_municipio ?? '');
      setEmisorProvincia(f.emisor_provincia ?? '');
      setEmisorEmail(f.emisor_email ?? '');
      setEmpresaId(f.empresa_id ?? '');
      setEmpresaNombre(f.empresa_nombre ?? '');
      setEmpresaCif(f.empresa_cif ?? '');
      setEmpresaDireccion(f.empresa_direccion ?? '');
      setEmpresaCp(f.empresa_cp ?? '');
      setEmpresaMunicipio(f.empresa_municipio ?? '');
      setEmpresaProvincia(f.empresa_provincia ?? '');
      setEmpresaEmail(f.empresa_email ?? '');
      setNumeroCorrelativo(typeof f.numero === 'number' ? f.numero : 0);
      setTotalCobrado(Number(f.total_cobrado ?? 0));
      setSaldoPendiente(Number(f.saldo_pendiente ?? 0));
      setEsRectificativa(!!f.es_rectificativa);
      setFacturaRectificadaId(f.factura_rectificada_id ?? '');
      setMotivoRectificacion(f.motivo_rectificacion ?? '');
      setVerifactuHash(f.verifactu_hash ?? '');
      setNumFacturaProveedor(f.numero_factura_proveedor ?? '');
      setFechaContabilizacionIso(String(f.fecha_contabilizacion ?? '').trim());
      setContabilizadoPor(String(f.contabilizado_por ?? '').trim());
      setCreadoEn(String(f.creado_en ?? '').trim());
      setVersion(f.version ?? 1);
      setLineas(hydrateLineasDesdeFactura(f, data.lineas));

      fetch(`${apiUrl}/api/facturacion/facturas/${facturaId}/adjuntos`)
        .then((r) => r.json())
        .then((d) => setAdjuntos(Array.isArray(d.adjuntos) ? d.adjuntos : []))
        .catch(() => setAdjuntos([]))
        .finally(() => setAdjuntosLoading(false));
    } catch (e: unknown) {
      setAdjuntos([]);
      setAdjuntosLoading(false);
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, facturaId, markHydrationFromApi]);

  useEffect(() => {
    if (!facturaId) {
      setError(null);
      return;
    }
    cargar();
  }, [facturaId, cargar]);

  /** Misma lógica que «Previsualizar PDF» en ficha completa (`factura-detalle.tsx`). Solo emitidas (OUT). */
  const previsualizarPDF = useCallback(async () => {
    if (Platform.OS !== 'web') {
      Alert.alert('PDF', 'La previsualización de PDF solo está disponible en versión web.');
      return;
    }
    if (!facturaId || esIn) return;
    setPdfLoading(true);
    try {
      const { generarPDFFactura } = await import('./FacturaPDF');
      const emisorData = {
        nombre: emisorNombre,
        cif: emisorCif,
        direccion: emisorDireccion,
        cp: emisorCp,
        municipio: emisorMunicipio,
        provincia: emisorProvincia,
        email: emisorEmail,
      };
      const clienteData = {
        nombre: empresaNombre,
        cif: empresaCif,
        direccion: empresaDireccion,
        cp: empresaCp,
        municipio: empresaMunicipio,
        provincia: empresaProvincia,
        email: empresaEmail,
      };
      const facturaData = {
        id_factura: numeroFactura || facturaId,
        tipo: tipoFactura,
        serie,
        numero: numeroCorrelativo,
        estado,
        fecha_emision: dmyToIso(fechaEmision) || fechaEmision,
        fecha_vencimiento: fechaVencimiento ? dmyToIso(fechaVencimiento) || fechaVencimiento : undefined,
        condiciones_pago: condicionesPago,
        forma_pago: formaPago,
        observaciones: observaciones || undefined,
        numero_factura_proveedor: numFacturaProveedor || undefined,
        base_imponible: totales.base_imponible,
        total_iva: totales.total_iva,
        total_retencion: totales.total_retencion,
        total_factura: totales.total_factura,
        total_cobrado: totalCobrado,
        saldo_pendiente: saldoPendiente,
        es_rectificativa: esRectificativa,
        factura_rectificada_id: facturaRectificadaId || undefined,
        motivo_rectificacion: motivoRectificacion || undefined,
        verifactu_hash: verifactuHash || undefined,
      };
      const doc = generarPDFFactura(emisorData, clienteData, facturaData, lineas);
      const blobUrl = doc.output('bloburl');
      const w = globalThis as unknown as { open?: (u: string, t?: string) => void };
      w.open?.(String(blobUrl), '_blank');
    } catch (e: unknown) {
      Alert.alert('Error PDF', e instanceof Error ? e.message : 'No se pudo generar la previsualización');
    } finally {
      setPdfLoading(false);
    }
  }, [
    facturaId,
    esIn,
    emisorNombre,
    emisorCif,
    emisorDireccion,
    emisorCp,
    emisorMunicipio,
    emisorProvincia,
    emisorEmail,
    empresaNombre,
    empresaCif,
    empresaDireccion,
    empresaCp,
    empresaMunicipio,
    empresaProvincia,
    empresaEmail,
    numeroFactura,
    tipoFactura,
    serie,
    numeroCorrelativo,
    estado,
    fechaEmision,
    fechaVencimiento,
    condicionesPago,
    formaPago,
    observaciones,
    numFacturaProveedor,
    totales,
    lineas,
    totalCobrado,
    saldoPendiente,
    esRectificativa,
    facturaRectificadaId,
    motivoRectificacion,
    verifactuHash,
  ]);

  const guardar = async () => {
    if (!facturaId || !esEditable) return;
    if (!empresaNombre.trim()) {
      setError('Indica el receptor (nombre)');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const lineasPayload = lineasPayloadForApi(lineas);
      const t = totales;
      const body: Record<string, unknown> = {
        tipo: tipoFactura,
        serie,
        estado,
        emisor_id: emisorId || null,
        emisor_nombre: emisorNombre,
        emisor_cif: emisorCif,
        empresa_id: empresaId,
        empresa_nombre: empresaNombre,
        empresa_cif: empresaCif,
        fecha_emision: dmyToIso(fechaEmision),
        fecha_vencimiento: dmyToIso(fechaVencimiento),
        condiciones_pago: condicionesPago,
        forma_pago: formaPago,
        observaciones,
        lineas: lineasPayload,
        base_imponible: t.base_imponible,
        total_iva: t.total_iva,
        total_retencion: t.total_retencion,
        total_factura: t.total_factura,
        desglose_iva: t.desglose_iva,
        desglose_retencion: t.desglose_retencion,
        usuario_id: usuarioId,
        usuario_nombre: usuarioNombre,
        version,
      };
      if (esIn) {
        body.numero_factura_proveedor = numFacturaProveedor;
        body.fecha_contabilizacion = fechaContabilizacionIso || null;
      }
      const res = await fetch(`${apiUrl}/api/facturacion/facturas/${facturaId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      setVersion((v) => v + 1);
      onGuardado();
      await cargar();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setSaving(false);
    }
  };

  if (!facturaId) {
    return (
      <View style={styles.placeholder}>
        <MaterialIcons name="touch-app" size={40} color="#cbd5e1" />
        <Text style={styles.placeholderText}>Selecciona una factura en la tabla para ver y editar el detalle aquí.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" color="#0ea5e9" />
        <Text style={styles.muted}>Cargando detalle…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scrollFlex} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.num} numberOfLines={1}>{numeroFactura || '—'}</Text>
          <Text style={styles.serie} numberOfLines={1}>{serie ? `Serie ${serie}` : ''}</Text>
        </View>
        <BadgeEstado estado={estado} />
      </View>

      <TouchableOpacity style={styles.linkFull} onPress={() => onAbrirCompleto(facturaId)} accessibilityLabel="Abrir ficha completa">
        <MaterialIcons name="open-in-new" size={16} color="#0ea5e9" />
        <Text style={styles.linkFullText}>Abrir ficha completa</Text>
      </TouchableOpacity>

      <View style={styles.actionsRow}>
        {!esIn ? (
          <TouchableOpacity
            style={[styles.pdfBtn, pdfLoading && styles.pdfBtnDis]}
            onPress={previsualizarPDF}
            disabled={pdfLoading}
            accessibilityLabel="Previsualizar PDF"
          >
            {pdfLoading ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="visibility" size={16} color="#0ea5e9" />
            )}
            <Text style={styles.pdfBtnText}>{pdfLoading ? 'Generando…' : 'Previsualizar PDF'}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.adjuntosBtnCompact, !adjuntosLoading && adjuntos.length === 0 && styles.adjuntosBtnMuted]}
          onPress={() => setModalAdjuntos(true)}
          disabled={adjuntosLoading}
          accessibilityLabel="Ver archivos adjuntos"
        >
          {adjuntosLoading ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="attach-file" size={16} color={adjuntos.length === 0 ? '#94a3b8' : '#0ea5e9'} />
          )}
          <Text style={[styles.adjuntosBtnTextCompact, adjuntos.length === 0 && styles.adjuntosBtnTextMuted]}>
            {adjuntosLoading ? 'Adjuntos…' : `Adjuntos${adjuntos.length ? ` (${adjuntos.length})` : ''}`}
          </Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errBox}>
          <Text style={styles.errText}>{error}</Text>
        </View>
      ) : null}

      <Text style={styles.secTitle}>Datos generales</Text>
      <View style={styles.fechaRow}>
        <View style={styles.fechaCol}>
          <Text style={styles.label}>Fecha emisión</Text>
          <InputFecha
            value={fechaEmision}
            onChange={setFechaEmision}
            format="dmy"
            editable={esEditable}
            style={[styles.input, styles.inputFechaEnFila]}
          />
        </View>
        <View style={styles.fechaCol}>
          <Text style={styles.label}>Vencimiento</Text>
          <InputFecha
            value={fechaVencimiento}
            onChange={setFechaVencimiento}
            format="dmy"
            editable={esEditable}
            style={[styles.input, styles.inputFechaEnFila]}
          />
        </View>
      </View>

      <View style={styles.fechaRow}>
        <View style={styles.fechaCol}>
          <Text style={styles.label}>{lblEmisor}</Text>
          <TextInput
            style={[styles.input, styles.inputFechaEnFila, !esEditable && styles.inputDisabled]}
            value={emisorNombre}
            onChangeText={setEmisorNombre}
            onBlur={sincronizarEmisorConCatalogo}
            editable={esEditable}
            placeholder={esIn ? 'Empresa del grupo' : 'Nombre'}
          />
        </View>
        <View style={styles.empresaColCif}>
          <Text style={styles.label}>{esIn ? 'CIF empresa' : 'CIF/NIF'}</Text>
          <TextInput
            style={[styles.input, styles.inputFechaEnFila, !esEditable && styles.inputDisabled]}
            value={emisorCif}
            onChangeText={setEmisorCif}
            editable={esEditable}
            placeholder="CIF/NIF"
            autoCapitalize="characters"
          />
        </View>
      </View>
      <View style={styles.fechaRow}>
        <View style={styles.fechaCol}>
          <Text style={styles.label}>{lblEmpresa}</Text>
          <TextInput
            style={[styles.input, styles.inputFechaEnFila, !esEditable && styles.inputDisabled]}
            value={empresaNombre}
            onChangeText={setEmpresaNombre}
            editable={esEditable}
            placeholder={esIn ? 'Proveedor' : 'Cliente'}
          />
        </View>
        <View style={styles.empresaColCif}>
          <Text style={styles.label}>{esIn ? 'CIF proveedor' : 'CIF/NIF'}</Text>
          <TextInput
            style={[styles.input, styles.inputFechaEnFila, !esEditable && styles.inputDisabled]}
            value={empresaCif}
            onChangeText={setEmpresaCif}
            editable={esEditable}
            placeholder="CIF/NIF"
          />
        </View>
      </View>
      {esIn ? (
        <>
          <Text style={styles.label}>Nº factura proveedor</Text>
          <TextInput
            style={[styles.input, !esEditable && styles.inputDisabled]}
            value={numFacturaProveedor}
            onChangeText={setNumFacturaProveedor}
            editable={esEditable}
            placeholder="—"
          />
          <Text style={styles.label}>Fecha contabilización</Text>
          <TextInput
            style={[styles.input, styles.inputDisabled]}
            value={textoFechaContabilizacionGasto({
              fechaContabilizacion: fechaContabilizacionIso,
              contabilizadoPor,
              creadoEn,
            })}
            editable={false}
            multiline
            placeholder="—"
            placeholderTextColor="#94a3b8"
          />
        </>
      ) : null}

      <View style={styles.condFormaRow}>
        <View style={styles.condFormaCol}>
          <Text style={styles.label}>Condiciones</Text>
          {esEditable ? (
            <TouchableOpacity style={styles.selectBtn} onPress={() => setModalCondicionesOpen(true)} activeOpacity={0.7}>
              <Text style={styles.selectBtnText} numberOfLines={1}>
                {condicionesPago}
              </Text>
              <MaterialIcons name="expand-more" size={22} color="#64748b" />
            </TouchableOpacity>
          ) : (
            <Text style={styles.ro}>{condicionesPago}</Text>
          )}
        </View>
        <View style={styles.condFormaCol}>
          <Text style={styles.label}>Forma de pago</Text>
          {esEditable ? (
            <TouchableOpacity style={styles.selectBtn} onPress={() => setModalFormaPagoOpen(true)} activeOpacity={0.7}>
              <Text style={styles.selectBtnText} numberOfLines={1}>
                {labelFormaPago(formaPago)}
              </Text>
              <MaterialIcons name="expand-more" size={22} color="#64748b" />
            </TouchableOpacity>
          ) : (
            <Text style={styles.ro}>{labelFormaPago(formaPago)}</Text>
          )}
        </View>
      </View>

      <Modal visible={modalCondicionesOpen} transparent animationType="fade" onRequestClose={() => setModalCondicionesOpen(false)}>
        <Pressable style={styles.modalAdjOverlay} onPress={() => setModalCondicionesOpen(false)}>
          <Pressable style={styles.modalPickerCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalPickerTitle}>Condiciones de pago</Text>
            <ScrollView style={styles.modalPickerList} keyboardShouldPersistTaps="handled">
              {CONDICIONES_PAGO.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.modalPickerRow, condicionesPago === c && styles.modalPickerRowActive]}
                  onPress={() => {
                    setCondicionesPago(c);
                    setModalCondicionesOpen(false);
                  }}
                >
                  <Text style={[styles.modalPickerRowText, condicionesPago === c && styles.modalPickerRowTextActive]}>{c}</Text>
                  {condicionesPago === c ? <MaterialIcons name="check" size={20} color="#0369a1" /> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={modalFormaPagoOpen} transparent animationType="fade" onRequestClose={() => setModalFormaPagoOpen(false)}>
        <Pressable style={styles.modalAdjOverlay} onPress={() => setModalFormaPagoOpen(false)}>
          <Pressable style={styles.modalPickerCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalPickerTitle}>Forma de pago</Text>
            <ScrollView style={styles.modalPickerList} keyboardShouldPersistTaps="handled">
              {FORMAS_PAGO.map((c) => (
                <TouchableOpacity
                  key={c}
                  style={[styles.modalPickerRow, formaPago === c && styles.modalPickerRowActive]}
                  onPress={() => {
                    setFormaPago(c);
                    setModalFormaPagoOpen(false);
                  }}
                >
                  <Text style={[styles.modalPickerRowText, formaPago === c && styles.modalPickerRowTextActive]}>{labelFormaPago(c)}</Text>
                  {formaPago === c ? <MaterialIcons name="check" size={20} color="#0369a1" /> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Text style={styles.label}>Observaciones</Text>
      <TextInput
        style={[styles.textArea, !esEditable && styles.inputDisabled]}
        value={observaciones}
        onChangeText={setObservaciones}
        editable={esEditable}
        multiline
        placeholder="—"
      />

      <Text style={styles.secTitle}>Líneas</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.lineaTableScroll} nestedScrollEnabled>
        <View style={styles.lineaTableColumn}>
          <View style={styles.lineaHeadersCard}>
            <View style={styles.lineaOneRow}>
              <View style={styles.lineaHdrBoxIdx}>
                <Text style={[styles.lineaIdx, styles.lineaHdrCell]} numberOfLines={1}>
                  Nº
                </Text>
              </View>
              {esEditable && lineas.length > 1 ? <View style={styles.lineaHdrDelSpacer} /> : null}
              <View style={styles.lineaHdrBoxDesc}>
                <Text style={styles.lineaHdrConceptText} numberOfLines={2}>
                  Concepto
                </Text>
              </View>
              <View style={styles.lineaHdrBoxNum}>
                <Text style={styles.lineaHdrNumLabel} numberOfLines={1}>
                  Cant.
                </Text>
              </View>
              <View style={styles.lineaHdrBoxNum}>
                <Text style={styles.lineaHdrNumLabel} numberOfLines={1}>
                  Precio
                </Text>
              </View>
              <View style={styles.lineaHdrBoxNumSm}>
                <Text style={styles.lineaHdrNumLabelSm} numberOfLines={1}>
                  Dto %
                </Text>
              </View>
              <View style={styles.lineaHdrBoxNumSm}>
                <Text style={styles.lineaHdrNumLabelSm} numberOfLines={1}>
                  IVA %
                </Text>
              </View>
              <View style={styles.lineaHdrBoxNumSm}>
                <Text style={styles.lineaHdrNumLabelSm} numberOfLines={1}>
                  Ret %
                </Text>
              </View>
              <View style={styles.lineaHdrBoxTotals}>
                <Text style={styles.lineaHdrTotalsText} numberOfLines={2}>
                  Base → Total
                </Text>
              </View>
            </View>
          </View>
          {lineas.map((linea, idx) => {
            const calc = calcularLinea(linea);
            return (
              <View key={idx} style={styles.lineaCard}>
                <View style={styles.lineaOneRow}>
                  <View style={styles.lineaHdrBoxIdx}>
                    <Text style={styles.lineaIdx}>#{idx + 1}</Text>
                  </View>
                  {esEditable && lineas.length > 1 ? (
                    <TouchableOpacity onPress={() => removeLinea(idx)} hitSlop={8} style={styles.lineaDel}>
                      <MaterialIcons name="close" size={16} color="#94a3b8" />
                    </TouchableOpacity>
                  ) : null}
                  <TextInput
                    style={[styles.inputDescLine, !esEditable && styles.inputDisabled]}
                    value={linea.descripcion}
                    onChangeText={(v) => updateLinea(idx, 'descripcion', v)}
                    editable={esEditable}
                    placeholder="Concepto"
                  />
                  <TextInput
                    style={[styles.inNum, !esEditable && styles.inputDisabled]}
                    value={String(linea.cantidad)}
                    onChangeText={(v) => updateLinea(idx, 'cantidad', v)}
                    keyboardType="decimal-pad"
                    editable={esEditable}
                    placeholder="Cant"
                  />
                  <TextInput
                    style={[styles.inNum, !esEditable && styles.inputDisabled]}
                    value={String(linea.precio_unitario)}
                    onChangeText={(v) => updateLinea(idx, 'precio_unitario', v)}
                    keyboardType="decimal-pad"
                    editable={esEditable}
                    placeholder="€"
                  />
                  <TextInput
                    style={[styles.inNumSm, !esEditable && styles.inputDisabled]}
                    value={String(linea.descuento_pct)}
                    onChangeText={(v) => updateLinea(idx, 'descuento_pct', v)}
                    keyboardType="decimal-pad"
                    editable={esEditable}
                    placeholder="Dto"
                  />
                  <TextInput
                    style={[styles.inNumSm, !esEditable && styles.inputDisabled]}
                    value={String(linea.tipo_iva)}
                    onChangeText={(v) => updateLinea(idx, 'tipo_iva', v)}
                    keyboardType="decimal-pad"
                    editable={esEditable}
                    placeholder="IVA"
                  />
                  <TextInput
                    style={[styles.inNumSm, !esEditable && styles.inputDisabled]}
                    value={String(linea.retencion_pct)}
                    onChangeText={(v) => updateLinea(idx, 'retencion_pct', v)}
                    keyboardType="decimal-pad"
                    editable={esEditable}
                    placeholder="Ret"
                  />
                  <View style={styles.lineaHdrBoxTotals}>
                    <Text style={styles.lineaTotals} numberOfLines={1}>
                      {formatMoneda(calc.base_linea)} → {formatMoneda(calc.total_linea)}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
      {esEditable ? (
        <TouchableOpacity style={styles.addLine} onPress={addLinea}>
          <MaterialIcons name="add" size={18} color="#0ea5e9" />
          <Text style={styles.addLineTxt}>Añadir línea</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.secTitle}>Totales</Text>
      <ResumenTotales
        base_imponible={totales.base_imponible}
        total_iva={totales.total_iva}
        total_retencion={totales.total_retencion}
        total_factura={totales.total_factura}
        desglose_iva={totales.desglose_iva}
        desglose_retencion={totales.desglose_retencion}
        compact
      />

      {esEditable && puedeEditar ? (
        <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDis]} onPress={guardar} disabled={saving}>
          {saving ? <ActivityIndicator color="#fff" size="small" /> : <MaterialIcons name="save" size={18} color="#fff" />}
          <Text style={styles.saveBtnTxt}>{saving ? 'Guardando…' : 'Guardar cambios'}</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.hintReadonly}>
          {estado !== 'borrador' && estado !== 'pendiente_revision'
            ? 'Factura emitida o cerrada: la edición solo está disponible en la ficha completa si aplica.'
            : 'Sin permiso de edición.'}
        </Text>
      )}

      <Modal visible={modalAdjuntos} transparent animationType="fade" onRequestClose={() => setModalAdjuntos(false)}>
        <Pressable style={styles.modalAdjOverlay} onPress={() => setModalAdjuntos(false)}>
          <Pressable style={styles.modalAdjCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalAdjHeader}>
              <Text style={styles.modalAdjTitle}>Archivos adjuntos</Text>
              <TouchableOpacity onPress={() => setModalAdjuntos(false)} hitSlop={12} accessibilityLabel="Cerrar">
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            {adjuntos.length === 0 ? (
              <Text style={styles.modalAdjEmpty}>No hay archivos adjuntos en esta factura.</Text>
            ) : (
              <ScrollView style={styles.modalAdjList} keyboardShouldPersistTaps="handled">
                {adjuntos.map((adj) => (
                  <TouchableOpacity
                    key={adj.id}
                    style={styles.modalAdjRow}
                    onPress={() => {
                      if (adj.url) {
                        if (Platform.OS === 'web') {
                          const w = globalThis as unknown as { open?: (u: string, t?: string) => void };
                          w.open?.(adj.url, '_blank');
                        } else {
                          Linking.openURL(adj.url);
                        }
                      }
                    }}
                    disabled={!adj.url}
                  >
                    <MaterialIcons
                      name={adj.tipo?.includes('pdf') ? 'picture-as-pdf' : adj.tipo?.startsWith('image') ? 'image' : 'insert-drive-file'}
                      size={18}
                      color={adj.tipo?.includes('pdf') ? '#dc2626' : '#0ea5e9'}
                    />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={styles.modalAdjNombre} numberOfLines={2}>{adj.nombre}</Text>
                      <Text style={styles.modalAdjMeta}>
                        {adj.subido_por ? `${adj.subido_por} · ` : ''}
                        {adj.subido_en ? new Date(adj.subido_en).toLocaleDateString('es-ES') : ''}
                        {adj.size != null ? ` · ${((adj.size || 0) / 1024).toFixed(0)} KB` : ''}
                      </Text>
                    </View>
                    {adj.url ? (
                      <MaterialIcons name="open-in-new" size={18} color="#0ea5e9" />
                    ) : (
                      <Text style={styles.modalAdjSinUrl}>Sin enlace</Text>
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollFlex: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 32 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  muted: { fontSize: 12, color: '#94a3b8' },
  placeholder: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, gap: 10 },
  placeholderText: { fontSize: 13, color: '#94a3b8', textAlign: 'center', maxWidth: 260 },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, gap: 8 },
  num: { fontSize: 16, fontWeight: '700', color: '#334155' },
  serie: { fontSize: 11, color: '#64748b' },
  linkFull: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  linkFullText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  pdfBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 8,
    backgroundColor: '#fff',
    alignSelf: 'flex-start',
  },
  pdfBtnDis: { opacity: 0.7 },
  pdfBtnText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  adjuntosBtnCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  adjuntosBtnMuted: { backgroundColor: '#f8fafc', borderColor: '#e2e8f0' },
  adjuntosBtnTextCompact: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  adjuntosBtnTextMuted: { color: '#64748b', fontWeight: '500' },
  modalAdjOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalAdjCard: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  modalAdjHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  modalAdjTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  modalAdjEmpty: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', paddingVertical: 12 },
  modalAdjList: { maxHeight: 320 },
  modalAdjRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 8,
    backgroundColor: '#fafafa',
  },
  modalAdjNombre: { fontSize: 13, fontWeight: '600', color: '#334155' },
  modalAdjMeta: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  modalAdjSinUrl: { fontSize: 10, color: '#94a3b8' },
  errBox: { backgroundColor: '#fef2f2', padding: 8, borderRadius: 8, marginBottom: 8 },
  errText: { fontSize: 12, color: '#b91c1c' },
  secTitle: { fontSize: 13, fontWeight: '700', color: '#475569', marginTop: 8, marginBottom: 6 },
  label: { fontSize: 11, color: '#64748b', marginBottom: 2 },
  /** Fecha emisión + vencimiento en una fila (panel estrecho: se apilan con flexWrap) */
  fechaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 8 },
  fechaCol: { flex: 1, minWidth: 140 },
  /** Columna CIF en la misma fila que razón social (más estrecha) */
  empresaColCif: { width: 148, minWidth: 120, maxWidth: 200, flexShrink: 0 },
  inputFechaEnFila: { marginBottom: 0, alignSelf: 'stretch' },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'web' ? 8 : 6,
    fontSize: 13,
    color: '#334155',
    marginBottom: 8,
    backgroundColor: '#fff',
  },
  inputDisabled: { backgroundColor: '#f8fafc', color: '#64748b' },
  textArea: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    minHeight: 56,
    fontSize: 13,
    textAlignVertical: 'top',
    marginBottom: 8,
  },
  ro: { fontSize: 13, color: '#334155', marginBottom: 8 },
  /** Condiciones + forma de pago en una fila, cada una desplegable */
  condFormaRow: { flexDirection: 'row', gap: 10, marginBottom: 8, alignItems: 'flex-start' },
  condFormaCol: { flex: 1, minWidth: 120 },
  selectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'web' ? 8 : 6,
    backgroundColor: '#fff',
  },
  selectBtnText: { flex: 1, fontSize: 13, color: '#334155', marginRight: 4 },
  modalPickerCard: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '75%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  modalPickerTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 12 },
  modalPickerList: { maxHeight: 280 },
  modalPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  modalPickerRowActive: { backgroundColor: '#f0f9ff', borderRadius: 8, paddingHorizontal: 8, borderBottomWidth: 0 },
  modalPickerRowText: { fontSize: 14, color: '#334155', flex: 1 },
  modalPickerRowTextActive: { color: '#0369a1', fontWeight: '600' },
  chips: { marginBottom: 8, maxHeight: 36 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', marginRight: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipTxt: { fontSize: 11, color: '#64748b' },
  chipTxtOn: { color: '#0369a1', fontWeight: '600' },
  /** Un solo scroll horizontal: cabecera + filas comparten el mismo ancho de columnas */
  lineaTableScroll: { flexGrow: 0 },
  lineaTableColumn: { flexDirection: 'column', gap: 6, paddingBottom: 4 },
  lineaHeadersCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
  },
  lineaHdrCell: { color: '#64748b', fontWeight: '600' },
  /** Misma anchura que el botón borrar de fila para alinear cabecera y datos */
  lineaHdrDelSpacer: { width: LINEA_W_DEL, minHeight: 32, justifyContent: 'center' as const },
  /** Caja alineada con `#` / número de línea (mismo ancho que lineaIdx) */
  lineaHdrBoxIdx: {
    width: LINEA_W_IDX,
    minHeight: 32,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  /** Misma anchura fija que `inputDescLine` */
  lineaHdrBoxDesc: {
    width: LINEA_W_CONCEPTO,
    minHeight: 32,
    paddingHorizontal: 6,
    paddingVertical: 5,
    justifyContent: 'center' as const,
  },
  lineaHdrConceptText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'left',
  },
  /** Mismos márgenes que `inNum` (placeholder centrado) */
  lineaHdrBoxNum: {
    width: LINEA_W_NUM,
    minHeight: 32,
    paddingHorizontal: 4,
    paddingVertical: 5,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  lineaHdrNumLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'center',
    width: '100%',
  },
  /** Mismos márgenes que `inNumSm` */
  lineaHdrBoxNumSm: {
    width: LINEA_W_NUM_SM,
    minHeight: 32,
    paddingHorizontal: 2,
    paddingVertical: 5,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  lineaHdrNumLabelSm: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'center',
    width: '100%',
  },
  /** Misma anchura fija que la columna de importes */
  lineaHdrBoxTotals: {
    width: LINEA_W_TOTALES,
    minHeight: 32,
    paddingVertical: 5,
    justifyContent: 'center' as const,
    alignItems: 'flex-end' as const,
  },
  lineaHdrTotalsText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    textAlign: 'right',
    width: '100%',
  },
  lineaCard: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fafafa' },
  lineaOneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
    gap: 4,
  },
  lineaIdx: { fontSize: 10, fontWeight: '700', color: '#94a3b8', textAlign: 'center', width: '100%' },
  lineaDel: { width: LINEA_W_DEL, minHeight: 32, justifyContent: 'center' as const, alignItems: 'center' as const },
  inputDescLine: {
    width: LINEA_W_CONCEPTO,
    minHeight: 32,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 5,
    fontSize: 12,
    backgroundColor: '#fff',
  },
  inNum: {
    width: LINEA_W_NUM,
    minHeight: 32,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 5,
    fontSize: 11,
    textAlign: 'center',
    backgroundColor: '#fff',
  },
  inNumSm: {
    width: LINEA_W_NUM_SM,
    minHeight: 32,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 2,
    paddingVertical: 5,
    fontSize: 11,
    textAlign: 'center',
    backgroundColor: '#fff',
  },
  lineaTotals: { fontSize: 10, color: '#64748b', textAlign: 'right', width: '100%' },
  addLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12 },
  addLineTxt: { fontSize: 13, color: '#0ea5e9', fontWeight: '600' },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0ea5e9',
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 12,
  },
  saveBtnDis: { opacity: 0.7 },
  saveBtnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  hintReadonly: { fontSize: 11, color: '#94a3b8', marginTop: 8, fontStyle: 'italic' },
});
