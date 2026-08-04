import { apiFetch } from '../utils/api';
import { mapTipoReciboToFormaPago } from '../utils/facturacion';
import { esMetodoCompensacion } from './compensacionFactura';
import type { RegistrarPagoInitial, RegistrarPagoPayloadFactura } from '../components/RegistrarPagoModal';
import type { FacturaListado } from '../types/factura';
import type { RemesaActivaFactura } from '../types/remesas';

export type PagoDetalleRow = {
  id_pago?: string;
  fecha?: string;
  importe?: number;
  metodo_pago?: string;
  referencia?: string;
  observaciones?: string;
};

type ErrorPagoBody = {
  error?: string;
  code?: string;
  remesaActiva?: RemesaActivaFactura | null;
};

function mensajeErrorPago(status: number, data: ErrorPagoBody, fallback: string): string {
  if (status === 409 && data?.code === 'FACTURA_EN_REMESA') {
    const nombre = String(data.remesaActiva?.nombre ?? '').trim();
    if (data.error) return String(data.error);
    return nombre
      ? `Esta factura está incluida en la remesa «${nombre}». No se pueden registrar, editar ni eliminar pagos manualmente.`
      : 'Esta factura está incluida en una remesa activa. No se pueden registrar, editar ni eliminar pagos manualmente.';
  }
  return data?.error || fallback;
}

export function pagoRecordToInitial(p: PagoDetalleRow): RegistrarPagoInitial {
  const metodo = String(p.metodo_pago ?? '');
  if (esMetodoCompensacion(metodo)) {
    const fechaRaw = String(p.fecha ?? '').trim();
    const fechaIso = /^\d{4}-\d{2}-\d{2}$/.test(fechaRaw) ? fechaRaw : fechaRaw.slice(0, 10);
    return {
      fecha: fechaIso,
      metodo: 'compensacion',
      referencia: String(p.referencia ?? ''),
      observaciones: String(p.observaciones ?? ''),
      importe: p.importe != null ? String(p.importe) : '',
    };
  }
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

export async function registrarPagoFacturaApi(
  idFactura: string,
  payload: RegistrarPagoPayloadFactura,
  usuario: { id?: string; nombre?: string },
): Promise<{ pago?: PagoDetalleRow; factura?: FacturaListado | null }> {
  const baseBody = {
    fecha: payload.fecha,
    importe: payload.importe,
    observaciones: payload.observaciones,
    usuario_id: usuario.id ?? '',
    usuario_nombre: usuario.nombre ?? '',
  };

  if (esMetodoCompensacion(payload.metodo_pago)) {
    const r = await apiFetch(`/api/facturacion/facturas/${idFactura}/pagos/compensacion`, {
      method: 'POST',
      body: JSON.stringify({
        ...baseBody,
        facturas_compensar: payload.facturas_compensar ?? [],
      }),
    });
    const data = (await r.json()) as ErrorPagoBody & { pago?: PagoDetalleRow; factura?: FacturaListado };
    if (!r.ok) throw new Error(mensajeErrorPago(r.status, data, 'Error al registrar compensación'));
    return { pago: data.pago, factura: (data.factura as FacturaListado | undefined) ?? null };
  }

  const r = await apiFetch(`/api/facturacion/facturas/${idFactura}/pagos`, {
    method: 'POST',
    body: JSON.stringify({
      ...baseBody,
      metodo_pago: payload.metodo_pago,
      referencia: payload.referencia,
    }),
  });
  const data = (await r.json()) as ErrorPagoBody & { pago?: PagoDetalleRow; factura?: FacturaListado };
  if (!r.ok) throw new Error(mensajeErrorPago(r.status, data, 'Error al registrar pago'));
  return { pago: data.pago, factura: (data.factura as FacturaListado | undefined) ?? null };
}

export async function eliminarPagoFactura(
  idFactura: string,
  idPago: string,
  usuario: { id?: string; nombre?: string },
  pago?: PagoDetalleRow,
): Promise<FacturaListado | null> {
  if (pago && esMetodoCompensacion(pago.metodo_pago)) {
    throw new Error('Los pagos por compensación no se pueden eliminar desde aquí');
  }
  const r = await apiFetch(`/api/facturacion/pagos/${idFactura}/${idPago}`, {
    method: 'DELETE',
    body: JSON.stringify({
      usuario_id: usuario.id ?? '',
      usuario_nombre: usuario.nombre ?? '',
    }),
  });
  const data = (await r.json()) as ErrorPagoBody & { factura?: FacturaListado };
  if (!r.ok) throw new Error(mensajeErrorPago(r.status, data, 'Error al eliminar el pago'));
  return (data.factura as FacturaListado | undefined) ?? null;
}

export async function actualizarPagoFactura(
  idFactura: string,
  idPago: string,
  payload: RegistrarPagoPayloadFactura,
  usuario: { id?: string; nombre?: string },
): Promise<{ pago: PagoDetalleRow; factura: FacturaListado | null }> {
  if (esMetodoCompensacion(payload.metodo_pago)) {
    throw new Error('Los pagos por compensación no se pueden editar');
  }
  const r = await apiFetch(`/api/facturacion/pagos/${idFactura}/${idPago}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...payload,
      usuario_id: usuario.id ?? '',
      usuario_nombre: usuario.nombre ?? '',
    }),
  });
  const data = (await r.json()) as ErrorPagoBody & { pago?: PagoDetalleRow; factura?: FacturaListado };
  if (!r.ok) throw new Error(mensajeErrorPago(r.status, data, 'Error al actualizar el pago'));
  return {
    pago: (data.pago as PagoDetalleRow) ?? {},
    factura: (data.factura as FacturaListado | undefined) ?? null,
  };
}
