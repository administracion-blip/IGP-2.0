/**
 * «Pagar» de una factura de gasto fuera del listado (ventana de deuda con
 * proveedores). Renderiza `RegistrarPagoModal` con las mismas props y el mismo
 * flujo que el modal de pago de `facturacion/facturas-gasto`.
 */
import { useEffect, useState } from 'react';
import { RegistrarPagoModal, type RegistrarPagoInitial, type RegistrarPagoPayloadFactura } from '../RegistrarPagoModal';
import { PanelMovimientosFactura } from '../conciliacion/PanelMovimientosFactura';
import type { ToastType } from '../Toast';
import { useAuth } from '../../contexts/AuthContext';
import { useConfirmar } from '../../hooks/useConfirmar';
import { fechaEmisionFacturaAIso } from '../../utils/formatFecha';
import { buildConceptoRemesaFacturaRecibida } from '../../lib/conceptoRemesa';
import { resolverIbanBeneficiarioFactura } from '../../lib/resolverIbanFactura';
import { initialPagoFacturaGasto, registrarPagoFacturaApi } from '../../lib/pagosFacturaDetalle';
import type { EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';
import type { FacturaListado } from '../../types/factura';

export type FacturaPagoGasto = Omit<FacturaListado, 'remesaActiva'>;

type Props = {
  /** null = cerrado. */
  factura: FacturaPagoGasto | null;
  empresasCatalogo: EmpresaConTipoRecibo[];
  onClose: () => void;
  /** Pago, compensación, exceso o conciliación registrados: refrescar datos. */
  onPagoRegistrado: () => void;
  /** Solo avisos de éxito (el modal ya está cerrado); los errores se muestran encima del propio modal. */
  onToast: (titulo: string, mensaje: string, tipo: ToastType) => void;
};

export function PagarFacturaGastoModal({ factura, empresasCatalogo, onClose, onPagoRegistrado, onToast }: Props) {
  const { hasPermiso, user } = useAuth();
  const { confirmar, ConfirmarView } = useConfirmar();
  const [initial, setInitial] = useState<RegistrarPagoInitial>({});
  const [procesando, setProcesando] = useState(false);
  /** El panel de movimientos tiene una conciliación en vuelo: no se puede pagar a mano ni cerrar. */
  const [conciliandoEnPanel, setConciliandoEnPanel] = useState(false);

  const puedeGestionarPagos = hasPermiso('facturacion.cobrar_pagar');
  const puedeVerConciliacion = hasPermiso('banca.ver');

  useEffect(() => {
    if (!factura) return;
    setInitial(initialPagoFacturaGasto(factura, empresasCatalogo));
    setConciliandoEnPanel(false);
    // Solo al abrir otra factura: el catálogo puede llegar después sin reiniciar el formulario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factura?.id_factura]);

  const cerrar = () => {
    if (procesando) return;
    setConciliandoEnPanel(false);
    onClose();
  };

  const handleRegistrarPago = async (payload: RegistrarPagoPayloadFactura) => {
    if (!factura) return;
    setProcesando(true);
    try {
      await registrarPagoFacturaApi(factura.id_factura, payload, {
        id: user?.id_usuario,
        nombre: user?.Nombre,
      });
      onClose();
      onToast(
        'Registrado',
        payload.metodo_pago === 'compensacion'
          ? 'Compensación registrada correctamente'
          : 'Pago registrado correctamente',
        'success',
      );
      onPagoRegistrado();
    } catch (e: unknown) {
      void confirmar('Error', e instanceof Error ? e.message : 'Error al registrar el pago', { soloAceptar: true });
    } finally {
      setProcesando(false);
    }
  };

  return (
    <>
      <RegistrarPagoModal
        visible={factura !== null}
        onClose={cerrar}
        modo="factura"
        variant="pago"
        initial={initial}
        empresaPagadoraNombre={factura?.emisor_nombre ?? ''}
        fechaFactura={factura?.fecha_emision}
        fechaReferenciaTarjeta={
          factura
            ? fechaEmisionFacturaAIso(factura.fecha_emision ?? '') ?? undefined
            : undefined
        }
        datosPago={
          factura
            ? {
              beneficiario: factura.empresa_nombre ?? '',
              iban: resolverIbanBeneficiarioFactura(factura, empresasCatalogo),
              concepto: buildConceptoRemesaFacturaRecibida({
                numeroFacturaProveedor: factura.numero_factura_proveedor,
                numeroFactura: factura.numero_factura,
                proveedorNombre: factura.empresa_nombre,
                observaciones: factura.observaciones,
              }),
            }
            : undefined
        }
        habilitarCompensacion
        facturaId={factura?.id_factura}
        saldoOrigen={Number(factura?.saldo_pendiente ?? 0)}
        avisoSobrepago={factura?.estado === 'pagada'}
        habilitarAplicacionExceso={
          !!factura
          && factura.estado !== 'pagada'
          && Math.abs(Number(factura.saldo_pendiente) || 0) > 0.001
        }
        onAplicacionExcesoSuccess={() => {
          onClose();
          onToast('Registrado', 'Exceso aplicado correctamente', 'success');
          onPagoRegistrado();
        }}
        panelLateral={
          factura && String(factura.emisor_id ?? '').trim() && puedeVerConciliacion
            ? (
              <PanelMovimientosFactura
                idFactura={factura.id_factura}
                numeroFactura={
                  factura.numero_factura_proveedor?.trim()
                  || factura.numero_factura?.trim()
                  || factura.id_factura
                }
                empresaId={String(factura.emisor_id ?? '').trim()}
                tipo="IN"
                fechaEmision={factura.fecha_emision}
                contraparteNombre={factura.empresa_nombre}
                saldoPendiente={Math.abs(Number(factura.saldo_pendiente ?? 0))}
                puedeConciliar={puedeGestionarPagos}
                onConciliado={(resumen) => {
                  setConciliandoEnPanel(false);
                  onClose();
                  onToast(
                    resumen.requiereRevision ? 'Pago registrado · revisa el movimiento' : 'Pago registrado',
                    resumen.mensaje,
                    resumen.requiereRevision ? 'warning' : 'success',
                  );
                  onPagoRegistrado();
                }}
                onOcupadoChange={setConciliandoEnPanel}
              />
            )
            : undefined
        }
        bloqueadoPorPanel={conciliandoEnPanel}
        submitting={procesando}
        onValidationError={(titulo, mensaje) => void confirmar(titulo, mensaje, { soloAceptar: true })}
        onSubmit={handleRegistrarPago}
      />
      {ConfirmarView}
    </>
  );
}
