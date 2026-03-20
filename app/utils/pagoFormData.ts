import { Platform } from 'react-native';

export type ReciboAsset = {
  uri: string;
  name: string;
  mimeType?: string;
};

/**
 * Construye FormData para POST /facturacion/facturas/:id/pagos (multipart).
 */
export async function buildPagoFormData(params: {
  fecha: string;
  importe: number;
  metodo_pago: string;
  referencia: string;
  usuario_id?: string;
  usuario_nombre?: string;
  recibo?: ReciboAsset | null;
}): Promise<FormData> {
  const fd = new FormData();
  fd.append('fecha', params.fecha);
  fd.append('importe', String(params.importe));
  fd.append('metodo_pago', params.metodo_pago);
  if (params.referencia.trim()) fd.append('referencia', params.referencia.trim());
  if (params.usuario_id) fd.append('usuario_id', params.usuario_id);
  if (params.usuario_nombre) fd.append('usuario_nombre', params.usuario_nombre);

  if (params.recibo) {
    const a = params.recibo;
    if (Platform.OS === 'web') {
      const r = await fetch(a.uri);
      const blob = await r.blob();
      fd.append('recibo', blob, a.name || 'recibo');
    } else {
      // RN FormData acepta objeto { uri, name, type }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fd.append('recibo', { uri: a.uri, name: a.name || 'recibo', type: a.mimeType || 'application/octet-stream' } as any);
    }
  }

  return fd;
}
