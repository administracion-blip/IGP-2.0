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
};

type FacturaProps = BaseProps & {
  modo: 'factura';
  variant: 'pago' | 'cobro';
  fechaReferenciaTarjeta?: string;
  onSubmit: (payload: RegistrarPagoPayloadFactura) => void;
};

type RemesaProps = BaseProps & {
  modo: 'remesa';
  resumen: { numFacturas: number; importeTotal: number };
  onSubmit: (payload: RegistrarPagoPayloadRemesa) => void;
};

export type RegistrarPagoModalProps = FacturaProps | RemesaProps;

export function RegistrarPagoModal(props: RegistrarPagoModalProps) {
  const {
    visible,
    onClose,
    initial,
    submitting = false,
    errorExterno,
    onValidationError,
    modo,
  } = props;

  const variant = props.modo === 'factura' ? props.variant : 'pago';
  const fechaReferenciaTarjeta =
    props.modo === 'factura' ? props.fechaReferenciaTarjeta : undefined;
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
    modo === 'remesa'
      ? 'Registrar pago de remesa'
      : `Registrar ${variant === 'cobro' ? 'cobro' : 'pago'}`;

  const textoBoton =
    modo === 'remesa'
      ? 'Confirmar pagos'
      : `Guardar ${variant === 'cobro' ? 'cobro' : 'pago'}`;

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
