/**
 * Crear remesa(s) de pago a partir de facturas de gasto seleccionadas fuera del
 * listado (ventana de deuda con proveedores). Mismo formulario y flujo que el
 * modal «Crear remesa de pago» de `facturacion/facturas-gasto`: una remesa por
 * sociedad ordenante y aviso si algún proveedor no tiene «Transferencia».
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../InputFecha';
import { useConfirmar } from '../../hooks/useConfirmar';
import {
  agruparFacturasRemesaPorSociedad,
  crearRemesasPorSociedad,
  type FacturaRemesaAgrupable,
  type ResultadoCrearRemesas,
} from '../../lib/remesas';
import { listProveedoresNoTransferenciaRemesa, type EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';
import { AvisoCreditoRemesa, useAvisoCreditoRemesa } from './AvisoCreditoRemesa';

export type FacturaRemesaSeleccion = FacturaRemesaAgrupable & {
  empresa_id?: string | null;
  empresa_cif?: string | null;
  empresa_nombre?: string | null;
};

type Props = {
  visible: boolean;
  /** Facturas ya filtradas como remesables. */
  facturas: FacturaRemesaSeleccion[];
  empresasCatalogo: EmpresaConTipoRecibo[];
  onClose: () => void;
  /** Al menos una remesa creada; `error` si alguna sociedad posterior falló. */
  onCreadas: (resultado: ResultadoCrearRemesas) => void;
  /** No se creó ninguna remesa: el modal sigue abierto y los datos deben refrescarse. */
  onFallo?: () => void;
};

function nombrePorDefecto(): string {
  const hoy = new Date();
  return `Pagos proveedores ${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}`;
}

export function CrearRemesaModal({ visible, facturas, empresasCatalogo, onClose, onCreadas, onFallo }: Props) {
  const { confirmar, ConfirmarView } = useConfirmar();
  const [remesaNombre, setRemesaNombre] = useState('');
  const [remesaFechaEjecucion, setRemesaFechaEjecucion] = useState('');
  const [procesando, setProcesando] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setRemesaNombre(nombrePorDefecto());
    setRemesaFechaEjecucion('');
  }, [visible]);

  const gruposRemesaPorSociedad = useMemo(() => agruparFacturasRemesaPorSociedad(facturas), [facturas]);

  const proveedoresNoTransferenciaRemesa = useMemo(
    () => listProveedoresNoTransferenciaRemesa(facturas, empresasCatalogo),
    [facturas, empresasCatalogo],
  );

  const creditoRemesa = useAvisoCreditoRemesa(
    visible,
    facturas.map((f) => f.id_factura),
  );
  const comprobandoCreditoRemesa = creditoRemesa.fase === 'cargando';

  const cerrar = () => {
    if (procesando) return;
    onClose();
  };

  const crearRemesa = async () => {
    if (comprobandoCreditoRemesa) return;
    if (gruposRemesaPorSociedad.length === 0 || facturas.length === 0) return;
    const nombreBase = remesaNombre.trim();
    if (!nombreBase) {
      await confirmar('Aviso', 'Indica un nombre para la remesa', { soloAceptar: true });
      return;
    }

    const variasSociedades = gruposRemesaPorSociedad.length > 1;
    const confirmarLabel = variasSociedades
      ? `Crear ${gruposRemesaPorSociedad.length} remesas`
      : 'Crear remesa';

    if (proveedoresNoTransferenciaRemesa.length > 0) {
      const lista = proveedoresNoTransferenciaRemesa
        .slice(0, 5)
        .map((p) => `· ${p.nombre} (${p.tipoReciboLabel})`)
        .join('\n');
      const extra = proveedoresNoTransferenciaRemesa.length > 5
        ? `\n… y ${proveedoresNoTransferenciaRemesa.length - 5} más`
        : '';
      const ok = await confirmar(
        'Tipo de recibo distinto de transferencia',
        `${proveedoresNoTransferenciaRemesa.length} proveedor${proveedoresNoTransferenciaRemesa.length !== 1 ? 'es' : ''} no tienen «Transferencia» en su ficha:\n\n${lista}${extra}\n\nPuedes crear la remesa igualmente. ¿Continuar?`,
        { confirmarLabel },
      );
      if (!ok) return;
    }

    setProcesando(true);
    let resultado: ResultadoCrearRemesas;
    try {
      resultado = await crearRemesasPorSociedad({
        grupos: gruposRemesaPorSociedad,
        nombreBase,
        fechaEjecucion: remesaFechaEjecucion || undefined,
      });
    } catch (e: unknown) {
      resultado = { creadas: [], totalExcluidas: 0, error: e instanceof Error ? e.message : 'No se pudo crear la remesa' };
    } finally {
      setProcesando(false);
    }
    if (resultado.creadas.length > 0) {
      onCreadas(resultado);
      return;
    }
    onFallo?.();
    await confirmar('Error', resultado.error || 'No se pudo crear la remesa', { soloAceptar: true });
  };

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={cerrar}>
        <Pressable style={styles.modalOverlay} onPress={cerrar}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Crear remesa de pago</Text>
            <Text style={styles.modalLabel}>
              {facturas.length} factura(s)
              {gruposRemesaPorSociedad.length === 1
                ? ` · Sociedad: ${gruposRemesaPorSociedad[0]?.sociedadNombre || '—'}`
                : ` · ${gruposRemesaPorSociedad.length} remesas (una por sociedad ordenante)`}
            </Text>
            {gruposRemesaPorSociedad.length > 1 ? (
              <View style={styles.modalGruposRemesa}>
                {gruposRemesaPorSociedad.map((g) => (
                  <Text key={g.sociedadId || g.sociedadNombre} style={styles.modalGrupoRemesaLinea}>
                    · {g.sociedadNombre}: {g.facturas.length} factura{g.facturas.length !== 1 ? 's' : ''}
                  </Text>
                ))}
              </View>
            ) : null}
            <AvisoCreditoRemesa
              estado={creditoRemesa}
              mostrarSociedad={gruposRemesaPorSociedad.length > 1}
            />
            {proveedoresNoTransferenciaRemesa.length > 0 ? (
              <View style={styles.modalAvisoTipoRecibo}>
                <MaterialIcons name="warning-amber" size={18} color="#b45309" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.modalAvisoTipoReciboTitulo}>
                    {proveedoresNoTransferenciaRemesa.length} proveedor{proveedoresNoTransferenciaRemesa.length !== 1 ? 'es' : ''} sin tipo de recibo «Transferencia»
                  </Text>
                  {proveedoresNoTransferenciaRemesa.slice(0, 4).map((p) => (
                    <Text key={p.key} style={styles.modalAvisoTipoReciboLinea} numberOfLines={1}>
                      · {p.nombre} — {p.tipoReciboLabel}
                    </Text>
                  ))}
                  {proveedoresNoTransferenciaRemesa.length > 4 ? (
                    <Text style={styles.modalAvisoTipoReciboLinea}>
                      … y {proveedoresNoTransferenciaRemesa.length - 4} más
                    </Text>
                  ) : null}
                  <Text style={styles.modalAvisoTipoReciboPie}>
                    Puedes crear la remesa igualmente; revisa la ficha del proveedor si procede.
                  </Text>
                </View>
              </View>
            ) : null}
            <Text style={styles.modalFieldLabel}>Nombre de la remesa *</Text>
            <TextInput
              style={styles.modalInput}
              value={remesaNombre}
              onChangeText={setRemesaNombre}
              placeholder="Pagos proveedores…"
              placeholderTextColor="#94a3b8"
            />
            <Text style={styles.modalFieldLabel}>Fecha ejecución en banco (opcional)</Text>
            <InputFecha valueIso={remesaFechaEjecucion} onChangeIso={setRemesaFechaEjecucion} placeholder="Vacío = Ahora" />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={cerrar} disabled={procesando}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtnConfirm, (procesando || comprobandoCreditoRemesa) && styles.modalBtnDisabled]}
                onPress={crearRemesa}
                disabled={procesando || comprobandoCreditoRemesa}
              >
                {procesando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnConfirmText}>
                    {gruposRemesaPorSociedad.length > 1
                      ? `Crear ${gruposRemesaPorSociedad.length} remesas`
                      : 'Crear remesa'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      {ConfirmarView}
    </>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '90%',
    maxWidth: 520,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 8 },
  modalLabel: { fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 18 },
  modalGruposRemesa: {
    marginBottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#eef1f5',
    gap: 2,
  },
  modalGrupoRemesaLinea: { fontSize: 11, color: '#475569', lineHeight: 16 },
  modalAvisoTipoRecibo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 12,
    padding: 10,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
  },
  modalAvisoTipoReciboTitulo: { fontSize: 12, fontWeight: '700', color: '#b45309', marginBottom: 4 },
  modalAvisoTipoReciboLinea: { fontSize: 11, color: '#92400e', lineHeight: 16 },
  modalAvisoTipoReciboPie: { fontSize: 11, color: '#78716c', marginTop: 6, fontStyle: 'italic' },
  modalFieldLabel: { fontSize: 11, fontWeight: '600', color: '#334155', marginBottom: 4, marginTop: 8 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#eef1f5',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#ffffff',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 16,
  },
  modalBtnCancel: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eef1f5',
    backgroundColor: '#ffffff',
  },
  modalBtnCancelText: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  modalBtnConfirm: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  modalBtnConfirmText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  modalBtnDisabled: { opacity: 0.6 },
});
