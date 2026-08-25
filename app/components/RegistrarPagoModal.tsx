import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useBreakpoint } from '../hooks/useBreakpoint';
import {
  FORMAS_PAGO,
  formatMoneda,
  labelFormaPago,
  resolveMetodoPagoParaEnvio,
  type FacturaExcesoDisponible,
} from '../utils/facturacion';
import { hoyISO } from '../utils/facturaFormLogic';
import { formatFechaPagoRow } from '../utils/formatFecha';
import { copyToClipboard } from '../utils/clipboard';
import { apiFetch, errorMessage } from '../utils/api';
import { SelectorDesplegableMulti } from './SelectorDesplegableMulti';
import {
  type FacturaCompensableRow,
  maxImporteCompensacion,
} from '../lib/compensacionFactura';

export type RegistrarPagoInitial = {
  fecha?: string;
  metodo?: string;
  metodoOtro?: string;
  referencia?: string;
  observaciones?: string;
  importe?: string;
};

export type RegistrarPagoPayloadFactura = {
  fecha: string;
  importe: number;
  metodo_pago: string;
  referencia: string;
  observaciones: string;
  /** Obligatorio si metodo_pago === 'compensacion' */
  facturas_compensar?: string[];
};

export type RegistrarPagoPayloadRemesa = {
  fecha: string;
  metodo_pago: string;
  referencia: string;
  observaciones: string;
};

type BaseProps = {
  visible: boolean;
  onClose: () => void;
  initial?: RegistrarPagoInitial;
  submitting?: boolean;
  errorExterno?: string;
  onValidationError?: (titulo: string, mensaje: string) => void;
  /** Sustituye el título por defecto («Registrar pago/cobro»). */
  tituloPersonalizado?: string;
  /** Sustituye el texto del botón principal. */
  textoBotonPersonalizado?: string;
  /** Sociedad del grupo que paga (solo lectura, bajo el título). */
  empresaPagadoraNombre?: string;
  /** Fecha de emisión de la factura (solo lectura, junto a la empresa pagadora). */
  fechaFactura?: string;
};

export type DatosPagoInfo = {
  beneficiario: string;
  /** Cuenta predeterminada de la empresa en el maestro (ver `resolverIbanFactura`). */
  iban: string;
  concepto: string;
};

type FacturaProps = BaseProps & {
  modo: 'factura';
  variant: 'pago' | 'cobro';
  fechaReferenciaTarjeta?: string;
  datosPago?: DatosPagoInfo;
  /** Gasto IN: permite forma de pago «Compensación». */
  habilitarCompensacion?: boolean;
  facturaId?: string;
  saldoOrigen?: number;
  /** Panel a la derecha del formulario (ver PanelMovimientosFactura). Al llegar, el modal se ensancha a dos columnas. */
  panelLateral?: ReactNode;
  /**
   * El panel lateral tiene una conciliación en vuelo. Conciliar ya registra el
   * pago, así que mientras dure no se puede enviar el formulario (duplicaría el
   * pago) ni cerrar el modal (desmontaría el panel y se perdería la respuesta).
   */
  bloqueadoPorPanel?: boolean;
  /**
   * Factura IN ya `pagada`: el importe se registrará como exceso.
   * No muestra banner de aplicar excesos de otras facturas.
   */
  avisoSobrepago?: boolean;
  /**
   * Destino IN con saldo: al abrir, GET excesos-disponibles y banner para aplicar.
   */
  habilitarAplicacionExceso?: boolean;
  /** Tras POST aplicacion-exceso con éxito (padre recarga / cierra). */
  onAplicacionExcesoSuccess?: () => void;
  onSubmit: (payload: RegistrarPagoPayloadFactura) => void;
};

type RemesaProps = BaseProps & {
  modo: 'remesa';
  resumen: { numFacturas: number; importeTotal: number };
  onSubmit: (payload: RegistrarPagoPayloadRemesa) => void;
};

export type RegistrarPagoModalProps = FacturaProps | RemesaProps;

function FilaCopiable({
  label,
  valor,
  compact = true,
  multiline = false,
}: {
  label: string;
  valor: string;
  compact?: boolean;
  multiline?: boolean;
}) {
  const [copiado, setCopiado] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vacio = !valor || !valor.trim();

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const onCopiar = async () => {
    if (vacio) return;
    const ok = await copyToClipboard(valor);
    if (!ok) return;
    setCopiado(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopiado(false), 1500);
  };

  const btnStyle = compact ? styles.filaCopiableBtnCompact : styles.filaCopiableBtn;

  return (
    <View style={compact ? styles.filaCopiableCompact : styles.filaCopiable}>
      {compact ? (
        <Text
          style={styles.filaCopiableInline}
          numberOfLines={multiline ? 2 : 1}
        >
          <Text style={styles.filaCopiableLabelInline}>{label}: </Text>
          <Text style={[styles.filaCopiableValorInline, vacio && styles.filaCopiableValorVacio]}>
            {vacio ? '—' : valor}
          </Text>
        </Text>
      ) : (
        <View style={styles.filaCopiableTexto}>
          <Text style={styles.filaCopiableLabel}>{label}</Text>
          <Text
            style={[styles.filaCopiableValor, vacio && styles.filaCopiableValorVacio]}
            numberOfLines={multiline ? 2 : 1}
          >
            {vacio ? '—' : valor}
          </Text>
        </View>
      )}
      <TouchableOpacity
        onPress={onCopiar}
        disabled={vacio}
        style={btnStyle}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        accessibilityRole="button"
        accessibilityState={{ disabled: vacio }}
        accessibilityLabel={`Copiar ${label}`}
      >
        <MaterialIcons
          name={copiado ? 'check' : 'content-copy'}
          size={compact ? 15 : 16}
          color={vacio ? '#cbd5e1' : copiado ? '#16a34a' : '#64748b'}
        />
      </TouchableOpacity>
    </View>
  );
}

/** Bloque de solo lectura con los datos para realizar el pago (con copiar). */
export function DatosParaPago({
  datosPago,
  compact = true,
}: {
  datosPago?: DatosPagoInfo;
  compact?: boolean;
}) {
  if (!datosPago) return null;
  return (
    <View style={compact ? styles.datosPagoBoxCompact : styles.datosPagoBox}>
      <Text style={compact ? styles.datosPagoTituloCompact : styles.datosPagoTitulo}>
        Datos para el pago
      </Text>
      <FilaCopiable compact={compact} label="Beneficiario" valor={datosPago.beneficiario} />
      <FilaCopiable compact={compact} label="IBAN" valor={datosPago.iban} />
      {!datosPago.iban.trim() ? (
        <Text style={styles.datosPagoAviso}>
          Sin cuenta bancaria válida en la ficha de la empresa: revísala antes de pagar.
        </Text>
      ) : null}
      <FilaCopiable compact={compact} label="Concepto" valor={datosPago.concepto} multiline />
    </View>
  );
}

export function RegistrarPagoModal(props: RegistrarPagoModalProps) {
  const {
    visible,
    onClose,
    initial,
    submitting = false,
    errorExterno,
    onValidationError,
    tituloPersonalizado,
    textoBotonPersonalizado,
    empresaPagadoraNombre,
    fechaFactura,
    modo,
  } = props;

  const variant = props.modo === 'factura' ? props.variant : 'pago';
  const fechaReferenciaTarjeta =
    props.modo === 'factura' ? props.fechaReferenciaTarjeta : undefined;
  const datosPago = props.modo === 'factura' ? props.datosPago : undefined;
  const habilitarCompensacion =
    props.modo === 'factura' && props.variant === 'pago' && !!props.habilitarCompensacion;
  const facturaId = props.modo === 'factura' ? props.facturaId : undefined;
  const saldoOrigen = props.modo === 'factura' ? props.saldoOrigen : undefined;
  const resumen = props.modo === 'remesa' ? props.resumen : undefined;
  const panelLateral = props.modo === 'factura' ? props.panelLateral : undefined;
  const bloqueadoPorPanel = props.modo === 'factura' && !!props.bloqueadoPorPanel;
  const avisoSobrepago = props.modo === 'factura' && !!props.avisoSobrepago;
  const habilitarAplicacionExceso =
    props.modo === 'factura'
    && props.variant === 'pago'
    && !!props.habilitarAplicacionExceso
    && !avisoSobrepago;
  const onAplicacionExcesoSuccess =
    props.modo === 'factura' ? props.onAplicacionExcesoSuccess : undefined;

  const { height: winH } = useWindowDimensions();
  const { shouldStackPanels } = useBreakpoint();
  /** Sin panel el modal se queda exactamente como estaba (520 px, una columna). */
  const conPanel = modo === 'factura' && !!panelLateral;
  const apilado = conPanel && shouldStackPanels;

  const [fecha, setFecha] = useState(hoyISO());
  const [importe, setImporte] = useState('');
  const [metodo, setMetodo] = useState('transferencia');
  const [metodoOtro, setMetodoOtro] = useState('');
  const [fechaEditadaManual, setFechaEditadaManual] = useState(false);
  const [referencia, setReferencia] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [compensables, setCompensables] = useState<FacturaCompensableRow[]>([]);
  const [compensablesLoading, setCompensablesLoading] = useState(false);
  const [compensablesError, setCompensablesError] = useState('');
  const [facturasCompensar, setFacturasCompensar] = useState<string[]>([]);
  const [excesosDisponibles, setExcesosDisponibles] = useState<FacturaExcesoDisponible[]>([]);
  const [excesosLoading, setExcesosLoading] = useState(false);
  const [excesoSeleccionadoId, setExcesoSeleccionadoId] = useState<string | null>(null);
  const [excesoBannerIgnorado, setExcesoBannerIgnorado] = useState(false);
  const [aplicandoExceso, setAplicandoExceso] = useState(false);
  const [excesoError, setExcesoError] = useState('');

  const esCompensacion = metodo === 'compensacion';
  const saldoDestino = Math.abs(Number(saldoOrigen) || 0);
  const excesoSeleccionado = useMemo(
    () => excesosDisponibles.find((e) => e.id_factura === excesoSeleccionadoId) ?? null,
    [excesosDisponibles, excesoSeleccionadoId],
  );
  const importeAplicarExceso = useMemo(() => {
    if (!excesoSeleccionado) return 0;
    const exceso = Number(excesoSeleccionado.exceso_pendiente) || 0;
    return Math.round(Math.min(exceso, saldoDestino) * 100) / 100;
  }, [excesoSeleccionado, saldoDestino]);
  const mostrarBannerExceso =
    habilitarAplicacionExceso
    && !excesoBannerIgnorado
    && !esCompensacion
    && saldoDestino > 0.001
    && (excesosLoading || excesosDisponibles.length > 0);

  const formasDisponibles = useMemo(() => {
    let formas = FORMAS_PAGO as readonly string[];
    if (!habilitarCompensacion || avisoSobrepago) {
      formas = formas.filter((f) => f !== 'compensacion');
    }
    return formas;
  }, [habilitarCompensacion, avisoSobrepago]);

  const maxComp = useMemo(
    () => maxImporteCompensacion(Number(saldoOrigen) || 0, compensables, facturasCompensar),
    [saldoOrigen, compensables, facturasCompensar],
  );

  const openedRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;

    setFechaEditadaManual(false);
    setFecha(initial?.fecha ?? hoyISO());
    setMetodo(initial?.metodo ?? 'transferencia');
    setMetodoOtro(initial?.metodoOtro ?? '');
    setReferencia(initial?.referencia ?? '');
    setObservaciones(initial?.observaciones ?? '');
    if (modo === 'factura') {
      setImporte(initial?.importe ?? '');
    }
    setFacturasCompensar([]);
    setCompensables([]);
    setCompensablesError('');
    setExcesosDisponibles([]);
    setExcesoSeleccionadoId(null);
    setExcesoBannerIgnorado(false);
    setExcesoError('');
    setAplicandoExceso(false);
  }, [visible, initial, modo]);

  useEffect(() => {
    if (!visible || !habilitarAplicacionExceso || !facturaId || saldoDestino <= 0.001) {
      return;
    }
    let cancel = false;
    setExcesosLoading(true);
    setExcesoError('');
    void (async () => {
      try {
        const r = await apiFetch(`/api/facturacion/facturas/${facturaId}/excesos-disponibles`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'No se pudieron cargar excesos');
        if (cancel) return;
        const list: FacturaExcesoDisponible[] = Array.isArray(data.facturas) ? data.facturas : [];
        setExcesosDisponibles(list);
        setExcesoSeleccionadoId(list[0]?.id_factura ?? null);
      } catch (e) {
        if (!cancel) {
          setExcesosDisponibles([]);
          setExcesoSeleccionadoId(null);
          setExcesoError(errorMessage(e, 'Error al cargar excesos'));
        }
      } finally {
        if (!cancel) setExcesosLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [visible, habilitarAplicacionExceso, facturaId, saldoDestino]);

  useEffect(() => {
    if (!visible || !esCompensacion || !habilitarCompensacion || !facturaId) {
      return;
    }
    let cancel = false;
    setCompensablesLoading(true);
    setCompensablesError('');
    void (async () => {
      try {
        const r = await apiFetch(`/api/facturacion/facturas/${facturaId}/compensables`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'No se pudieron cargar facturas');
        if (!cancel) {
          setCompensables(Array.isArray(data.facturas) ? data.facturas : []);
        }
      } catch (e) {
        if (!cancel) {
          setCompensables([]);
          setCompensablesError(errorMessage(e, 'Error al cargar compensables'));
        }
      } finally {
        if (!cancel) setCompensablesLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [visible, esCompensacion, habilitarCompensacion, facturaId]);

  useEffect(() => {
    if (!esCompensacion || facturasCompensar.length === 0) return;
    if (maxComp > 0) {
      setImporte(String(maxComp));
    }
  }, [esCompensacion, facturasCompensar, maxComp]);

  const fechaParaMetodoTarjeta = () => {
    if (modo === 'remesa') return hoyISO();
    const ref = fechaReferenciaTarjeta?.trim();
    if (ref && /^\d{4}-\d{2}-\d{2}$/.test(ref)) return ref;
    return hoyISO();
  };

  const onSeleccionarMetodo = (fp: string) => {
    setMetodo(fp);
    if (fp !== 'otro') setMetodoOtro('');
    if (fp !== 'compensacion') {
      setFacturasCompensar([]);
    }
    if (fechaEditadaManual) return;
    setFecha(fp === 'tarjeta' ? fechaParaMetodoTarjeta() : hoyISO());
  };

  const mostrarError = (titulo: string, mensaje: string) => {
    if (onValidationError) onValidationError(titulo, mensaje);
  };

  const handleAplicarExceso = async () => {
    if (!facturaId || !excesoSeleccionado || importeAplicarExceso <= 0) return;
    if (bloqueadoPorPanel || aplicandoExceso || submitting) return;
    const fechaIso = fecha.trim();
    if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
      mostrarError('Error', 'Indica una fecha válida');
      return;
    }
    setAplicandoExceso(true);
    setExcesoError('');
    try {
      const r = await apiFetch(`/api/facturacion/facturas/${facturaId}/pagos/aplicacion-exceso`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_factura_exceso: excesoSeleccionado.id_factura,
          importe: importeAplicarExceso,
          fecha: fechaIso,
          observaciones: observaciones.trim() || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'No se pudo aplicar el exceso');
      onAplicacionExcesoSuccess?.();
    } catch (e) {
      const msg = errorMessage(e, 'Error al aplicar el exceso');
      setExcesoError(msg);
      mostrarError('Error', msg);
    } finally {
      setAplicandoExceso(false);
    }
  };

  const handleSubmit = () => {
    // La conciliación del panel registra el pago por su cuenta: enviar también
    // esto lo duplicaría, y la idempotencia del backend no cubre ese caso.
    if (bloqueadoPorPanel) return;

    const fechaIso = fecha.trim();
    if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
      mostrarError('Error', 'Indica una fecha válida');
      return;
    }

    const metodoEnvio = resolveMetodoPagoParaEnvio(metodo, metodoOtro);
    if (metodoEnvio == null) {
      mostrarError('Error', 'Describe el método de pago si eliges «Otro»');
      return;
    }

    if (modo === 'factura') {
      const importeNum = parseFloat(String(importe).replace(',', '.'));
      if (isNaN(importeNum) || importeNum <= 0) {
        mostrarError('Error', 'Indica fecha e importe válidos');
        return;
      }
      if (metodoEnvio === 'compensacion') {
        if (!habilitarCompensacion || !facturaId) {
          mostrarError('Error', 'Compensación no disponible en este contexto');
          return;
        }
        if (facturasCompensar.length === 0) {
          mostrarError('Error', 'Selecciona al menos una factura a compensar');
          return;
        }
        if (maxComp <= 0) {
          mostrarError(
            'Error',
            'No hay importe compensable con las facturas seleccionadas (deben tener saldo de signo opuesto)',
          );
          return;
        }
        if (maxComp > 0 && importeNum > maxComp + 0.001) {
          mostrarError('Error', `El importe no puede superar ${maxComp.toFixed(2)} €`);
          return;
        }
      }
      props.onSubmit({
        fecha: fechaIso,
        importe: importeNum,
        metodo_pago: metodoEnvio,
        referencia: esCompensacion ? '' : referencia,
        observaciones,
        ...(metodoEnvio === 'compensacion' ? { facturas_compensar: facturasCompensar } : {}),
      });
      return;
    }

    props.onSubmit({
      fecha: fechaIso,
      metodo_pago: metodoEnvio,
      referencia,
      observaciones,
    });
  };

  const titulo =
    tituloPersonalizado ??
    (modo === 'remesa'
      ? 'Registrar pago de remesa'
      : `Registrar ${variant === 'cobro' ? 'cobro' : 'pago'}`);

  const textoBoton =
    textoBotonPersonalizado ??
    (modo === 'remesa'
      ? 'Confirmar pagos'
      : `Guardar ${variant === 'cobro' ? 'cobro' : 'pago'}`);

  const formulario = (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={[styles.modalScroll, conPanel && styles.modalScrollPanel]}
      contentContainerStyle={styles.modalScrollContent}
      showsVerticalScrollIndicator={false}
    >
      <DatosParaPago datosPago={esCompensacion ? undefined : datosPago} />

      {avisoSobrepago ? (
        <View style={styles.avisoSobrepagoBox}>
          <MaterialIcons name="info-outline" size={16} color="#b45309" />
          <Text style={styles.avisoSobrepagoText}>
            Esta factura ya está pagada; el importe se registrará como exceso
          </Text>
        </View>
      ) : null}

      {mostrarBannerExceso ? (
        <View style={styles.excesoBanner}>
          {excesosLoading ? (
            <View style={styles.excesoBannerLoading}>
              <ActivityIndicator size="small" color="#b45309" />
              <Text style={styles.excesoBannerText}>Buscando excesos aplicables…</Text>
            </View>
          ) : excesoSeleccionado ? (
            <>
              <Text style={styles.excesoBannerText}>
                Hay {formatMoneda(Number(excesoSeleccionado.exceso_pendiente) || 0)} de exceso en factura{' '}
                {excesoSeleccionado.etiqueta
                  || excesoSeleccionado.numero_factura_proveedor
                  || excesoSeleccionado.numero_factura
                  || excesoSeleccionado.id_factura}
                . ¿Descontar de este pago?
              </Text>
              {excesosDisponibles.length > 1 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.excesoSelector}>
                  {excesosDisponibles.map((ex) => {
                    const activo = ex.id_factura === excesoSeleccionadoId;
                    return (
                      <TouchableOpacity
                        key={ex.id_factura}
                        style={[styles.excesoChip, activo && styles.excesoChipActive]}
                        onPress={() => setExcesoSeleccionadoId(ex.id_factura)}
                      >
                        <Text style={[styles.excesoChipText, activo && styles.excesoChipTextActive]} numberOfLines={1}>
                          {(ex.etiqueta || ex.numero_factura_proveedor || ex.id_factura).slice(0, 28)}
                          {' · '}
                          {formatMoneda(Number(ex.exceso_pendiente) || 0)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              ) : null}
              <View style={styles.excesoBannerActions}>
                <TouchableOpacity
                  style={[styles.excesoBtnAplicar, (aplicandoExceso || importeAplicarExceso <= 0) && styles.btnPrimaryDisabled]}
                  onPress={() => void handleAplicarExceso()}
                  disabled={aplicandoExceso || submitting || bloqueadoPorPanel || importeAplicarExceso <= 0}
                >
                  {aplicandoExceso ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.excesoBtnAplicarText}>
                      Aplicar {formatMoneda(importeAplicarExceso)}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.excesoBtnIgnorar}
                  onPress={() => setExcesoBannerIgnorado(true)}
                  disabled={aplicandoExceso}
                >
                  <Text style={styles.excesoBtnIgnorarText}>Ignorar</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : null}
          {excesoError ? <Text style={styles.errorExterno}>{excesoError}</Text> : null}
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Fecha</Text>
        <InputFecha
          valueIso={fecha}
          onChangeIso={(v) => {
            setFecha(v);
            setFechaEditadaManual(true);
          }}
          placeholder="dd/mm/aaaa"
          style={styles.input}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Método de pago</Text>
        <View style={styles.pickerWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {formasDisponibles.map((fp) => (
              <TouchableOpacity
                key={fp}
                style={[styles.chip, metodo === fp && styles.chipActive]}
                onPress={() => onSeleccionarMetodo(fp)}
              >
                <Text style={[styles.chipText, metodo === fp && styles.chipTextActive]}>
                  {labelFormaPago(fp)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>

      {modo === 'factura' && esCompensacion ? (
        <View style={styles.field}>
          <SelectorDesplegableMulti
            label="Facturas a compensar *"
            placeholder="Buscar factura del mismo proveedor y sociedad…"
            icono="receipt-long"
            buscador
            buscadorPlaceholder="Nº factura, proveedor…"
            loading={compensablesLoading}
            opciones={compensables.map((f) => ({
              id: f.id_factura,
              titulo: f.etiqueta || f.numero_factura_proveedor || f.id_factura,
              subtitulo: [
                f.fecha_emision ? f.fecha_emision.slice(0, 10) : '',
                f.saldo_pendiente != null
                  ? `Saldo ${formatMoneda(f.saldo_pendiente)}`
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
              icono: 'description' as const,
            }))}
            valorIds={facturasCompensar}
            onChange={setFacturasCompensar}
            vacioTexto={
              compensablesError ||
              (compensablesLoading
                ? 'Cargando…'
                : 'No hay otras facturas compensables (misma sociedad y proveedor, saldo de signo opuesto).')
            }
          />
          {facturasCompensar.length > 0 && maxComp > 0 ? (
            <Text style={styles.compHint}>
              Importe máximo compensable: {formatMoneda(maxComp)}
            </Text>
          ) : null}
          {compensablesError ? (
            <Text style={styles.errorExterno}>{compensablesError}</Text>
          ) : null}
        </View>
      ) : null}

      {modo === 'factura' ? (
        <View style={styles.field}>
          <Text style={styles.label}>Importe (€)</Text>
          <TextInput
            style={styles.input}
            value={importe}
            onChangeText={setImporte}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor="#94a3b8"
          />
        </View>
      ) : null}

      {metodo === 'otro' ? (
        <View style={styles.field}>
          <Text style={styles.label}>Describe el método *</Text>
          <TextInput
            style={styles.input}
            value={metodoOtro}
            onChangeText={setMetodoOtro}
            placeholder="Ej. Cheque, PayPal…"
            placeholderTextColor="#94a3b8"
          />
        </View>
      ) : null}

      {!esCompensacion ? (
        <View style={styles.field}>
          <Text style={styles.label}>Referencia</Text>
          <TextInput
            style={styles.input}
            value={referencia}
            onChangeText={setReferencia}
            placeholder="Nº transferencia, cheque…"
            placeholderTextColor="#94a3b8"
          />
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Observaciones</Text>
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          value={observaciones}
          onChangeText={setObservaciones}
          placeholder="Notas opcionales…"
          placeholderTextColor="#94a3b8"
          multiline
          numberOfLines={2}
        />
      </View>

      {errorExterno ? (
        <Text style={styles.errorExterno}>{errorExterno}</Text>
      ) : null}

      <TouchableOpacity
        style={[styles.btnPrimary, { marginTop: 8 }, (bloqueadoPorPanel || aplicandoExceso) && styles.btnPrimaryDisabled]}
        onPress={handleSubmit}
        disabled={submitting || bloqueadoPorPanel || aplicandoExceso}
      >
        {submitting ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.btnPrimaryText}>{textoBoton}</Text>
        )}
      </TouchableOpacity>

      {modo === 'remesa' ? (
        <Text style={styles.avisoRemesa}>
          Esta acción crea los pagos en todas las facturas y no se puede deshacer desde aquí.
        </Text>
      ) : null}
    </ScrollView>
  );

  const cerrar = () => {
    if (bloqueadoPorPanel) return;
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cerrar}>
      <Pressable
        style={[styles.modalOverlay, apilado && styles.overlayFull]}
        onPress={() => !submitting && !bloqueadoPorPanel && onClose()}
      >
        <Pressable
          style={[
            styles.modalContent,
            conPanel && styles.contentPanel,
            conPanel && !apilado ? { maxHeight: winH * 0.94 } : null,
            apilado && styles.contentFull,
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.modalHeader}>
            <View style={styles.modalHeaderText}>
              <Text style={styles.modalTitle}>{titulo}</Text>
              {empresaPagadoraNombre !== undefined || fechaFactura !== undefined ? (
                <View style={styles.metaCabecera}>
                  {empresaPagadoraNombre !== undefined ? (
                    <Text style={styles.empresaPagadora}>
                      Empresa pagadora: {empresaPagadoraNombre.trim() || '—'}
                    </Text>
                  ) : null}
                  {fechaFactura !== undefined ? (
                    <View style={styles.fechaFacturaBadge}>
                      <Text style={styles.fechaFacturaCabecera}>
                        Fecha factura: {formatFechaPagoRow(fechaFactura)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
            <TouchableOpacity onPress={cerrar} disabled={submitting || bloqueadoPorPanel}>
              <MaterialIcons name="close" size={22} color="#334155" />
            </TouchableOpacity>
          </View>

          {modo === 'remesa' && resumen ? (
            <View style={styles.resumenBox}>
              <Text style={styles.resumenText}>
                Se registrará el pago de {resumen.numFacturas} factura
                {resumen.numFacturas === 1 ? '' : 's'} por un total de{' '}
                {formatMoneda(resumen.importeTotal)}
              </Text>
            </View>
          ) : null}

          {conPanel ? (
            <View style={[styles.dosColumnas, apilado && styles.dosColumnasApilado]}>
              <View style={[styles.columnaForm, apilado && styles.columnaFormApilada]}>
                <Text style={styles.columnaTitulo}>
                  Registrar el {variant === 'cobro' ? 'cobro' : 'pago'} a mano
                </Text>
                <Text style={styles.columnaAyuda}>
                  Si el {variant === 'cobro' ? 'cobro' : 'pago'} no está en el banco: efectivo,
                  compensación, extracto sin importar o {variant === 'cobro' ? 'cobro' : 'pago'} aún
                  por hacer.
                </Text>
                {bloqueadoPorPanel ? (
                  <View style={styles.bloqueoAviso}>
                    <ActivityIndicator size="small" color="#b45309" />
                    <Text style={styles.bloqueoAvisoText}>
                      Conciliando el movimiento bancario. El{' '}
                      {variant === 'cobro' ? 'cobro' : 'pago'} se registra solo: espera a que
                      termine y no lo registres a mano.
                    </Text>
                  </View>
                ) : null}
                {formulario}
              </View>
              <View style={[styles.columnaPanel, apilado && styles.columnaPanelApilada]}>
                <Text style={styles.columnaTitulo}>¿Ya está en el banco?</Text>
                <Text style={styles.columnaAyuda}>
                  Concilia el movimiento y el {variant === 'cobro' ? 'cobro' : 'pago'} se registra
                  solo: no rellenes también el formulario.
                </Text>
                {panelLateral}
              </View>
            </View>
          ) : (
            formulario
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    width: '100%',
    maxWidth: 520,
    maxHeight: '85%',
  },
  contentPanel: {
    width: '96%',
    maxWidth: 1100,
    maxHeight: undefined,
    flex: 1,
  },
  contentFull: {
    width: '100%',
    maxWidth: undefined,
    maxHeight: undefined,
    flex: 1,
    borderRadius: 0,
  },
  overlayFull: { padding: 0 },
  dosColumnas: { flex: 1, flexDirection: 'row', minHeight: 0, gap: 4 },
  dosColumnasApilado: { flexDirection: 'column', gap: 8 },
  columnaForm: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    paddingRight: 12,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
  },
  columnaFormApilada: { paddingRight: 0, borderRightWidth: 0 },
  columnaPanel: { flex: 1, minWidth: 0, minHeight: 0, paddingLeft: 12 },
  columnaPanelApilada: {
    paddingLeft: 0,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  columnaTitulo: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  columnaAyuda: { marginTop: 2, marginBottom: 8, fontSize: 11, lineHeight: 15, color: '#64748b' },
  bloqueoAviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    padding: 8,
  },
  bloqueoAvisoText: { flex: 1, fontSize: 11, lineHeight: 16, color: '#92400e', fontWeight: '600' },
  modalScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  modalScrollPanel: {
    flex: 1,
    flexGrow: 1,
  },
  modalScrollContent: {
    paddingBottom: 4,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 12,
  },
  modalHeaderText: {
    flex: 1,
    paddingRight: 4,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#334155',
  },
  empresaPagadora: {
    marginTop: 0,
    fontSize: 12,
    fontWeight: '600',
    color: '#0369a1',
    flexShrink: 1,
  },
  metaCabecera: {
    marginTop: 4,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  fechaFacturaBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fbcfe8',
    backgroundColor: '#fdf2f8',
    alignSelf: 'flex-start',
  },
  fechaFacturaCabecera: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9d174d',
  },
  resumenBox: {
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  resumenText: {
    fontSize: 13,
    color: '#0c4a6e',
    lineHeight: 20,
  },
  datosPagoBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  datosPagoBoxCompact: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  datosPagoTitulo: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 8,
  },
  datosPagoTituloCompact: {
    fontSize: 11,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  datosPagoAviso: {
    fontSize: 11,
    lineHeight: 16,
    color: '#b45309',
    fontStyle: 'italic',
    marginBottom: 2,
  },
  filaCopiable: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 4,
  },
  filaCopiableCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    paddingVertical: 2,
    minHeight: 28,
  },
  filaCopiableTexto: {
    flex: 1,
  },
  filaCopiableInline: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    color: '#334155',
  },
  filaCopiableLabel: {
    fontSize: 11,
    color: '#64748b',
  },
  filaCopiableLabelInline: {
    fontWeight: '600',
    color: '#64748b',
  },
  filaCopiableValor: {
    fontSize: 12,
    color: '#334155',
  },
  filaCopiableValorInline: {
    color: '#0f172a',
  },
  filaCopiableValorVacio: {
    color: '#94a3b8',
  },
  filaCopiableBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filaCopiableBtnCompact: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    marginBottom: 12,
  },
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
  inputMultiline: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  pickerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    marginRight: 6,
  },
  chipActive: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0ea5e9',
  },
  chipText: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#fff',
  },
  errorExterno: {
    color: '#dc2626',
    fontSize: 12,
    marginTop: 8,
  },
  compHint: {
    fontSize: 11,
    color: '#0369a1',
    marginTop: 6,
  },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  btnPrimaryDisabled: {
    opacity: 0.5,
  },
  btnPrimaryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  avisoRemesa: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 10,
    lineHeight: 16,
    textAlign: 'center',
  },
  avisoSobrepagoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 10,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    padding: 10,
  },
  avisoSobrepagoText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: '#92400e',
    fontWeight: '600',
  },
  excesoBanner: {
    marginBottom: 10,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fbbf24',
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  excesoBannerLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  excesoBannerText: {
    fontSize: 12,
    lineHeight: 17,
    color: '#92400e',
    fontWeight: '600',
  },
  excesoSelector: {
    marginTop: 2,
  },
  excesoChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#fde68a',
    backgroundColor: '#fff',
    marginRight: 6,
    maxWidth: 260,
  },
  excesoChipActive: {
    backgroundColor: '#d97706',
    borderColor: '#d97706',
  },
  excesoChipText: {
    fontSize: 11,
    color: '#92400e',
    fontWeight: '500',
  },
  excesoChipTextActive: {
    color: '#fff',
  },
  excesoBannerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 2,
  },
  excesoBtnAplicar: {
    backgroundColor: '#d97706',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    minHeight: 32,
    justifyContent: 'center',
  },
  excesoBtnAplicarText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  excesoBtnIgnorar: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  excesoBtnIgnorarText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
});
