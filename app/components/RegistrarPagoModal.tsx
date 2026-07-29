import { useEffect, useRef, useState } from 'react';
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
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from './InputFecha';
import {
  FORMAS_PAGO,
  formatMoneda,
  labelFormaPago,
  resolveMetodoPagoParaEnvio,
} from '../utils/facturacion';
import { hoyISO } from '../utils/facturaFormLogic';
import { copyToClipboard } from '../utils/clipboard';

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
};

export type DatosPagoInfo = {
  beneficiario: string;
  iban: string;
  ibanAlternativo?: string;
  concepto: string;
};

type FacturaProps = BaseProps & {
  modo: 'factura';
  variant: 'pago' | 'cobro';
  fechaReferenciaTarjeta?: string;
  datosPago?: DatosPagoInfo;
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
      {datosPago.ibanAlternativo ? (
        <FilaCopiable compact={compact} label="IBAN alt." valor={datosPago.ibanAlternativo} />
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
    modo,
  } = props;

  const variant = props.modo === 'factura' ? props.variant : 'pago';
  const fechaReferenciaTarjeta =
    props.modo === 'factura' ? props.fechaReferenciaTarjeta : undefined;
  const datosPago = props.modo === 'factura' ? props.datosPago : undefined;
  const resumen = props.modo === 'remesa' ? props.resumen : undefined;

  const [fecha, setFecha] = useState(hoyISO());
  const [importe, setImporte] = useState('');
  const [metodo, setMetodo] = useState('transferencia');
  const [metodoOtro, setMetodoOtro] = useState('');
  const [fechaEditadaManual, setFechaEditadaManual] = useState(false);
  const [referencia, setReferencia] = useState('');
  const [observaciones, setObservaciones] = useState('');

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
  }, [visible, initial, modo]);

  const fechaParaMetodoTarjeta = () => {
    if (modo === 'remesa') return hoyISO();
    const ref = fechaReferenciaTarjeta?.trim();
    if (ref && /^\d{4}-\d{2}-\d{2}$/.test(ref)) return ref;
    return hoyISO();
  };

  const onSeleccionarMetodo = (fp: string) => {
    setMetodo(fp);
    if (fp !== 'otro') setMetodoOtro('');
    if (fechaEditadaManual) return;
    setFecha(fp === 'tarjeta' ? fechaParaMetodoTarjeta() : hoyISO());
  };

  const mostrarError = (titulo: string, mensaje: string) => {
    if (onValidationError) onValidationError(titulo, mensaje);
  };

  const handleSubmit = () => {
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
      const importeNum = parseFloat(importe);
      if (isNaN(importeNum) || importeNum <= 0) {
        mostrarError('Error', 'Indica fecha e importe válidos');
        return;
      }
      props.onSubmit({
        fecha: fechaIso,
        importe: importeNum,
        metodo_pago: metodoEnvio,
        referencia,
        observaciones,
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

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={() => !submitting && onClose()}>
        <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{titulo}</Text>
            <TouchableOpacity onPress={onClose} disabled={submitting}>
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

          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollContent}
            showsVerticalScrollIndicator={false}
          >
          <DatosParaPago datosPago={datosPago} />

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

          <View style={styles.field}>
            <Text style={styles.label}>Método de pago</Text>
            <View style={styles.pickerWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {FORMAS_PAGO.map((fp) => (
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
            style={[styles.btnPrimary, { marginTop: 8 }]}
            onPress={handleSubmit}
            disabled={submitting}
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
  modalScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  modalScrollContent: {
    paddingBottom: 4,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#334155',
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
});
