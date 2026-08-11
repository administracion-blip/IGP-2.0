/**
 * Modal flotante 50/50 para registrar pagos de varias facturas de gasto (IN).
 * Izquierda: lote con checkboxes. Derecha: detalle del pago de la factura activa.
 * v1: sin compensación.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from './InputFecha';
import { DatosParaPago, type RegistrarPagoPayloadFactura } from './RegistrarPagoModal';
import {
  FORMAS_PAGO,
  formatMoneda,
  labelFormaPago,
  mapTipoReciboToFormaPago,
  resolveMetodoPagoParaEnvio,
} from '../utils/facturacion';
import { hoyISO } from '../utils/facturaFormLogic';
import { fechaEmisionFacturaAIso } from '../utils/formatFecha';
import {
  getTipoReciboFromEmpresasList,
  type EmpresaConTipoRecibo,
} from '../utils/empresaTipoRecibo';
import { resolverIbanBeneficiarioFactura } from '../lib/resolverIbanFactura';
import { buildConceptoRemesaFacturaRecibida } from '../lib/conceptoRemesa';
import type { FacturaListado } from '../types/factura';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { MIN_TOUCH } from '../constants/layout';

export type BorradorPagoFactura = {
  fecha: string;
  importe: string;
  metodo: string;
  metodoOtro: string;
  referencia: string;
  observaciones: string;
  fechaEditadaManual: boolean;
};

export function esFacturaPagableGasto(f: FacturaListado): boolean {
  const estado = f.estado || '';
  if (estado === 'anulada' || estado === 'pagada' || estado === 'borrador') return false;
  return Math.abs(Number(f.saldo_pendiente ?? 0)) > 0;
}

export function buildBorradorPagoInicial(
  f: FacturaListado,
  empresasCatalogo: EmpresaConTipoRecibo[],
): BorradorPagoFactura {
  const saldo = Number(f.saldo_pendiente ?? 0);
  const tipoRecibo = getTipoReciboFromEmpresasList(empresasCatalogo, f.empresa_id);
  const { clave, otroTexto } = mapTipoReciboToFormaPago(tipoRecibo);
  const hoy = hoyISO();
  const fechaFactura = fechaEmisionFacturaAIso(f.fecha_emision ?? '') ?? hoy;
  return {
    fecha: clave === 'tarjeta' ? fechaFactura : hoy,
    importe: String(Math.abs(saldo) || ''),
    metodo: clave,
    metodoOtro: clave === 'otro' ? otroTexto : '',
    referencia: '',
    observaciones: '',
    fechaEditadaManual: false,
  };
}

type Props = {
  visible: boolean;
  facturas: FacturaListado[];
  empresasCatalogo: EmpresaConTipoRecibo[];
  empresaPagadoraNombre: string;
  submitting?: boolean;
  onClose: () => void;
  onValidationError?: (titulo: string, mensaje: string) => void;
  onConfirm: (items: Array<{ id_factura: string; payload: RegistrarPagoPayloadFactura }>) => void;
};

const FORMAS_SIN_COMPENSACION = FORMAS_PAGO.filter((f) => f !== 'compensacion');

export function MultipagoFacturasModal({
  visible,
  facturas,
  empresasCatalogo,
  empresaPagadoraNombre,
  submitting = false,
  onClose,
  onValidationError,
  onConfirm,
}: Props) {
  const { height: winH } = useWindowDimensions();
  const { shouldStackPanels, isPhone } = useBreakpoint();

  const [incluidos, setIncluidos] = useState<Set<string>>(new Set());
  const [activaId, setActivaId] = useState<string | null>(null);
  const [borradores, setBorradores] = useState<Record<string, BorradorPagoFactura>>({});

  useEffect(() => {
    if (!visible) return;
    const nextBorradores: Record<string, BorradorPagoFactura> = {};
    for (const f of facturas) {
      nextBorradores[f.id_factura] = buildBorradorPagoInicial(f, empresasCatalogo);
    }
    setBorradores(nextBorradores);
    setIncluidos(new Set(facturas.map((f) => f.id_factura)));
    setActivaId(facturas[0]?.id_factura ?? null);
  }, [visible, facturas, empresasCatalogo]);

  const facturaPorId = useMemo(() => {
    const m = new Map<string, FacturaListado>();
    for (const f of facturas) m.set(f.id_factura, f);
    return m;
  }, [facturas]);

  const activa = activaId ? facturaPorId.get(activaId) ?? null : null;
  const borradorActivo = activaId ? borradores[activaId] : undefined;

  const facturasIncluidas = useMemo(
    () => facturas.filter((f) => incluidos.has(f.id_factura)),
    [facturas, incluidos],
  );

  const totalPendiente = useMemo(
    () => facturasIncluidas.reduce((acc, f) => acc + Math.abs(Number(f.saldo_pendiente ?? 0)), 0),
    [facturasIncluidas],
  );

  const totalAsignado = useMemo(
    () =>
      facturasIncluidas.reduce((acc, f) => {
        const raw = borradores[f.id_factura]?.importe ?? '';
        const n = parseFloat(String(raw).replace(',', '.'));
        return acc + (Number.isFinite(n) && n > 0 ? n : 0);
      }, 0),
    [facturasIncluidas, borradores],
  );

  const datosPagoActiva = useMemo(() => {
    if (!activa) return undefined;
    const { iban, ibanAlternativo } = resolverIbanBeneficiarioFactura(activa, empresasCatalogo);
    return {
      beneficiario: activa.empresa_nombre ?? '',
      iban,
      ibanAlternativo,
      concepto: buildConceptoRemesaFacturaRecibida({
        numeroFacturaProveedor: activa.numero_factura_proveedor,
        numeroFactura: activa.numero_factura,
        proveedorNombre: activa.empresa_nombre,
        observaciones: activa.observaciones,
      }),
    };
  }, [activa, empresasCatalogo]);

  const patchBorrador = (id: string, patch: Partial<BorradorPagoFactura>) => {
    setBorradores((prev) => {
      const base = prev[id];
      if (!base) return prev;
      return { ...prev, [id]: { ...base, ...patch } };
    });
  };

  const toggleIncluido = (id: string) => {
    setIncluidos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (activaId && !next.has(activaId)) {
        const primera = facturas.find((f) => next.has(f.id_factura));
        setActivaId(primera?.id_factura ?? null);
      }
      return next;
    });
  };

  const onSeleccionarMetodo = (fp: string) => {
    if (!activaId || !borradorActivo || !activa) return;
    const fechaFactura = fechaEmisionFacturaAIso(activa.fecha_emision ?? '') ?? hoyISO();
    const patch: Partial<BorradorPagoFactura> = {
      metodo: fp,
      metodoOtro: fp !== 'otro' ? '' : borradorActivo.metodoOtro,
    };
    if (!borradorActivo.fechaEditadaManual) {
      patch.fecha = fp === 'tarjeta' ? fechaFactura : hoyISO();
    }
    patchBorrador(activaId, patch);
  };

  const validarYConfirmar = () => {
    if (submitting) return;
    if (facturasIncluidas.length === 0) {
      onValidationError?.('Error', 'Incluye al menos una factura en el lote');
      return;
    }

    const items: Array<{ id_factura: string; payload: RegistrarPagoPayloadFactura }> = [];

    for (const f of facturasIncluidas) {
      const b = borradores[f.id_factura];
      if (!b) {
        onValidationError?.('Error', 'Falta el borrador de pago de una factura');
        return;
      }
      const etiqueta =
        f.numero_factura_proveedor?.trim() ||
        f.numero_factura?.trim() ||
        f.id_factura;

      const fechaIso = b.fecha.trim();
      if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
        onValidationError?.('Error', `Indica una fecha válida en «${etiqueta}»`);
        return;
      }

      const metodoEnvio = resolveMetodoPagoParaEnvio(b.metodo, b.metodoOtro);
      if (metodoEnvio == null) {
        onValidationError?.(
          'Error',
          `Describe el método de pago si eliges «Otro» en «${etiqueta}»`,
        );
        return;
      }

      const importeNum = parseFloat(String(b.importe).replace(',', '.'));
      if (isNaN(importeNum) || importeNum <= 0) {
        onValidationError?.('Error', `Indica un importe válido en «${etiqueta}»`);
        return;
      }

      const saldoAbs = Math.abs(Number(f.saldo_pendiente ?? 0));
      if (importeNum > saldoAbs + 0.001) {
        onValidationError?.(
          'Error',
          `El importe de «${etiqueta}» no puede superar el saldo (${formatMoneda(saldoAbs)})`,
        );
        return;
      }

      items.push({
        id_factura: f.id_factura,
        payload: {
          fecha: fechaIso,
          importe: importeNum,
          metodo_pago: metodoEnvio,
          referencia: b.referencia,
          observaciones: b.observaciones,
        },
      });
    }

    onConfirm(items);
  };

  const numSeleccionadas = facturas.length;
  const touchMin = isPhone ? { minHeight: MIN_TOUCH } : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => !submitting && onClose()}>
      <Pressable style={styles.overlay} onPress={() => !submitting && onClose()}>
        <Pressable
          style={[styles.wrap, { maxHeight: winH * 0.94 }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.card}>
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={styles.title}>Multipago</Text>
                <Text style={styles.subtitle}>
                  {numSeleccionadas} factura{numSeleccionadas === 1 ? '' : 's'} · Pendiente total{' '}
                  {formatMoneda(
                    facturas.reduce((a, f) => a + Math.abs(Number(f.saldo_pendiente ?? 0)), 0),
                  )}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onClose}
                disabled={submitting}
                hitSlop={10}
                accessibilityLabel="Cerrar"
                style={touchMin}
              >
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            <View style={[styles.body, shouldStackPanels && styles.bodyApilado]}>
              {/* Izquierda: listado */}
              <View style={[styles.panelLista, shouldStackPanels && styles.panelApilado]}>
                <Text style={styles.panelTitulo}>Facturas a pagar</Text>
                <ScrollView style={styles.listaScroll} keyboardShouldPersistTaps="handled">
                  {facturas.map((f) => {
                    const id = f.id_factura;
                    const incluido = incluidos.has(id);
                    const esActiva = activaId === id;
                    const saldo = Math.abs(Number(f.saldo_pendiente ?? 0));
                    const aAplicarRaw = borradores[id]?.importe ?? '';
                    const aAplicarNum = parseFloat(String(aAplicarRaw).replace(',', '.'));
                    const aAplicarTxt =
                      Number.isFinite(aAplicarNum) && aAplicarNum > 0
                        ? formatMoneda(aAplicarNum)
                        : '—';
                    const num =
                      f.numero_factura_proveedor?.trim() ||
                      f.numero_factura?.trim() ||
                      id;

                    return (
                      <TouchableOpacity
                        key={id}
                        style={[
                          styles.filaFactura,
                          esActiva && styles.filaFacturaActiva,
                          !incluido && styles.filaFacturaExcluida,
                          touchMin,
                        ]}
                        onPress={() => setActivaId(id)}
                        activeOpacity={0.7}
                      >
                        <TouchableOpacity
                          onPress={() => toggleIncluido(id)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={styles.checkHit}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: incluido }}
                        >
                          <MaterialIcons
                            name={incluido ? 'check-box' : 'check-box-outline-blank'}
                            size={22}
                            color={incluido ? '#0ea5e9' : '#94a3b8'}
                          />
                        </TouchableOpacity>
                        <View style={styles.filaFacturaBody}>
                          <Text style={styles.filaNum} numberOfLines={1}>
                            {num}
                          </Text>
                          <Text style={styles.filaProv} numberOfLines={1}>
                            {f.empresa_nombre || '—'}
                          </Text>
                          <View style={styles.filaMeta}>
                            <Text style={styles.filaMetaText}>Saldo {formatMoneda(saldo)}</Text>
                            <Text style={styles.filaMetaText}>A aplicar {aAplicarTxt}</Text>
                          </View>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              {/* Derecha: detalle */}
              <View style={[styles.panelDetalle, shouldStackPanels && styles.panelApilado]}>
                <Text style={styles.panelTitulo}>Detalle del pago</Text>
                <Text style={styles.empresaPagadora}>
                  Empresa pagadora: {empresaPagadoraNombre.trim() || '—'}
                </Text>

                {activa && borradorActivo ? (
                  <ScrollView
                    style={styles.detalleScroll}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.detalleScrollContent}
                  >
                    <Text style={styles.facturaActivaLabel} numberOfLines={2}>
                      {activa.numero_factura_proveedor?.trim() ||
                        activa.numero_factura?.trim() ||
                        activa.id_factura}
                      {activa.empresa_nombre ? ` · ${activa.empresa_nombre}` : ''}
                    </Text>

                    <DatosParaPago datosPago={datosPagoActiva} />

                    <View style={styles.field}>
                      <Text style={styles.label}>Fecha</Text>
                      <InputFecha
                        valueIso={borradorActivo.fecha}
                        onChangeIso={(v) =>
                          patchBorrador(activa.id_factura, { fecha: v, fechaEditadaManual: true })
                        }
                        placeholder="dd/mm/aaaa"
                        style={styles.input}
                      />
                    </View>

                    <View style={styles.field}>
                      <Text style={styles.label}>Método de pago</Text>
                      <View style={styles.pickerWrap}>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                          {FORMAS_SIN_COMPENSACION.map((fp) => (
                            <TouchableOpacity
                              key={fp}
                              style={[
                                styles.chip,
                                borradorActivo.metodo === fp && styles.chipActive,
                                touchMin,
                              ]}
                              onPress={() => onSeleccionarMetodo(fp)}
                            >
                              <Text
                                style={[
                                  styles.chipText,
                                  borradorActivo.metodo === fp && styles.chipTextActive,
                                ]}
                              >
                                {labelFormaPago(fp)}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    </View>

                    <View style={styles.field}>
                      <Text style={styles.label}>Importe (€)</Text>
                      <TextInput
                        style={styles.input}
                        value={borradorActivo.importe}
                        onChangeText={(v) => patchBorrador(activa.id_factura, { importe: v })}
                        keyboardType="decimal-pad"
                        placeholder="0.00"
                        placeholderTextColor="#94a3b8"
                      />
                    </View>

                    {borradorActivo.metodo === 'otro' ? (
                      <View style={styles.field}>
                        <Text style={styles.label}>Describe el método *</Text>
                        <TextInput
                          style={styles.input}
                          value={borradorActivo.metodoOtro}
                          onChangeText={(v) => patchBorrador(activa.id_factura, { metodoOtro: v })}
                          placeholder="Ej. Cheque, PayPal…"
                          placeholderTextColor="#94a3b8"
                        />
                      </View>
                    ) : null}

                    <View style={styles.field}>
                      <Text style={styles.label}>Referencia</Text>
                      <TextInput
                        style={styles.input}
                        value={borradorActivo.referencia}
                        onChangeText={(v) => patchBorrador(activa.id_factura, { referencia: v })}
                        placeholder="Nº transferencia, cheque…"
                        placeholderTextColor="#94a3b8"
                      />
                    </View>

                    <View style={styles.field}>
                      <Text style={styles.label}>Observaciones</Text>
                      <TextInput
                        style={[styles.input, styles.inputMultiline]}
                        value={borradorActivo.observaciones}
                        onChangeText={(v) =>
                          patchBorrador(activa.id_factura, { observaciones: v })
                        }
                        placeholder="Notas opcionales…"
                        placeholderTextColor="#94a3b8"
                        multiline
                        numberOfLines={2}
                      />
                    </View>
                  </ScrollView>
                ) : (
                  <View style={styles.detalleVacio}>
                    <Text style={styles.detalleVacioText}>Selecciona una factura del listado</Text>
                  </View>
                )}
              </View>
            </View>

            <View style={styles.footer}>
              <View style={styles.footerTotales}>
                <Text style={styles.footerTotalText}>
                  Asignado: <Text style={styles.footerTotalStrong}>{formatMoneda(totalAsignado)}</Text>
                </Text>
                <Text style={styles.footerTotalText}>
                  Pendiente:{' '}
                  <Text style={styles.footerTotalStrong}>{formatMoneda(totalPendiente)}</Text>
                </Text>
                <Text style={styles.footerIncluidas}>
                  {facturasIncluidas.length} incluida{facturasIncluidas.length === 1 ? '' : 's'}
                </Text>
              </View>
              <TouchableOpacity
                style={[
                  styles.btnConfirmar,
                  (submitting || facturasIncluidas.length === 0) && styles.btnConfirmarDisabled,
                  touchMin,
                ]}
                onPress={validarYConfirmar}
                disabled={submitting || facturasIncluidas.length === 0}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <MaterialIcons name="payments" size={18} color="#fff" />
                    <Text style={styles.btnConfirmarText}>Confirmar multipago</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  wrap: {
    width: '96%',
    maxWidth: 1100,
    flex: 1,
    alignSelf: 'center',
  },
  card: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerText: { flex: 1, paddingRight: 8 },
  title: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  subtitle: { marginTop: 2, fontSize: 12, color: '#64748b' },

  body: { flex: 1, flexDirection: 'row', minHeight: 0 },
  bodyApilado: { flexDirection: 'column' },
  panelLista: {
    flex: 1,
    minWidth: 0,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    padding: 12,
  },
  panelDetalle: {
    flex: 1,
    minWidth: 0,
    padding: 12,
    position: 'relative',
    zIndex: 2,
  },
  panelApilado: { borderRightWidth: 0, flex: 1 },
  panelTitulo: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  empresaPagadora: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0369a1',
    marginBottom: 10,
  },

  listaScroll: { flex: 1 },
  filaFactura: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    marginBottom: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  filaFacturaActiva: {
    borderColor: '#7dd3fc',
    backgroundColor: '#e0f2fe',
  },
  filaFacturaExcluida: { opacity: 0.55 },
  checkHit: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filaFacturaBody: { flex: 1, minWidth: 0 },
  filaNum: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  filaProv: { fontSize: 12, color: '#475569', marginTop: 2 },
  filaMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 6,
  },
  filaMetaText: { fontSize: 11, color: '#64748b', fontWeight: '500' },

  detalleScroll: { flex: 1 },
  detalleScrollContent: { paddingBottom: 8 },
  facturaActivaLabel: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 8,
  },
  detalleVacio: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  detalleVacioText: { fontSize: 13, color: '#94a3b8' },

  field: { marginBottom: 12 },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 4,
  },
  input: {
    fontSize: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    backgroundColor: '#fff',
    color: '#334155',
  },
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  pickerWrap: { flexDirection: 'row', alignItems: 'center' },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    marginRight: 6,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  chipText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  chipTextActive: { color: '#fff' },

  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  footerTotales: { flex: 1, gap: 2, minWidth: 180 },
  footerTotalText: { fontSize: 13, color: '#475569' },
  footerTotalStrong: { fontWeight: '700', color: '#0f172a' },
  footerIncluidas: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  btnConfirmar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#16a34a',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnConfirmarDisabled: { opacity: 0.5 },
  btnConfirmarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
