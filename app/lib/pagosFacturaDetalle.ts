import { apiFetch } from '../utils/api';
import { mapTipoReciboToFormaPago } from '../utils/facturacion';
import type { RegistrarPagoInitial, RegistrarPagoPayloadFactura } from '../components/RegistrarPagoModal';
import type { FacturaListado } from '../types/factura';

export type PagoDetalleRow = {
  id_pago?: string;
  fecha?: string;
  importe?: number;
  metodo_pago?: string;
  referencia?: string;
  observaciones?: string;
};

export function pagoRecordToInitial(p: PagoDetalleRow): RegistrarPagoInitial {
  const metodo = String(p.metodo_pago ?? '');
  const { clave, otroTexto } = mapTipoReciboToFormaPago(metodo);
  const fechaRaw = String(p.fecha ?? '').trim();
  const fechaIso = /^\d{4}-\d{2}-\d{2}$/.test(fechaRaw) ? fechaRaw : fechaRaw.slice(0, 10);
  return {
    fecha: fechaIso,
    metodo: clave,
    metodoOtro: otroTexto,
    referencia: String(p.referencia ?? ''),
    observaciones: String(p.observaciones ?? ''),
    importe: p.importe != null ? String(p.importe) : '',
  };
}

export async function fetchPagosFactura(idFactura: string): Promise<PagoDetalleRow[]> {
  const r = await apiFetch(`/api/facturacion/facturas/${idFactura}/pagos`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Error al cargar pagos');
  return Array.isArray(data.pagos) ? data.pagos : [];
}

export async function eliminarPagoFactura(
  idFactura: string,
  idPago: string,
  usuario: { id?: string; nombre?: string },
): Promise<FacturaListado | null> {
  const r = await apiFetch(`/api/facturacion/pagos/${idFactura}/${idPago}`, {
    method: 'DELETE',
    body: JSON.stringify({
      usuario_id: usuario.id ?? '',
      usuario_nombre: usuario.nombre ?? '',
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Error al eliminar el pago');
  return (data.factura as FacturaListado | undefined) ?? null;
}

export async function actualizarPagoFactura(
  idFactura: string,
  idPago: string,
  payload: RegistrarPagoPayloadFactura,
  usuario: { id?: string; nombre?: string },
): Promise<{ pago: PagoDetalleRow; factura: FacturaListado | null }> {
  const r = await apiFetch(`/api/facturacion/pagos/${idFactura}/${idPago}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...payload,
      usuario_id: usuario.id ?? '',
      usuario_nombre: usuario.nombre ?? '',
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Error al actualizar el pago');
  return {
    pago: (data.pago as PagoDetalleRow) ?? {},
    factura: (data.factura as FacturaListado | undefined) ?? null,
  };
}
