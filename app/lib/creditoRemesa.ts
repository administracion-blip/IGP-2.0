import { apiFetch } from '../utils/api';

export type MotivoCreditoRemesa = 'exceso' | 'abono';

export type LineaCreditoRemesa = {
  id_factura: string;
  numero: string;
  motivo: MotivoCreditoRemesa;
  importe: number;
};

export type GrupoCreditoRemesa = {
  proveedorNombre: string;
  sociedadNombre: string;
  lineas: LineaCreditoRemesa[];
  total: number;
};

export type CreditoSinAplicarRemesa = {
  grupos: GrupoCreditoRemesa[];
  total: number;
};

function parseCreditoSinAplicar(data: unknown): CreditoSinAplicarRemesa {
  if (!data || typeof data !== 'object') throw new Error('Respuesta no válida');
  const body = data as { grupos?: unknown; total?: unknown };
  if (!Array.isArray(body.grupos)) throw new Error('Respuesta no válida');
  const total = Number(body.total);
  if (!Number.isFinite(total)) throw new Error('Respuesta no válida');

  const grupos = body.grupos.map((item): GrupoCreditoRemesa => {
    if (!item || typeof item !== 'object') throw new Error('Respuesta no válida');
    const grupo = item as {
      proveedorNombre?: unknown;
      sociedadNombre?: unknown;
      lineas?: unknown;
      total?: unknown;
    };
    if (!Array.isArray(grupo.lineas)) throw new Error('Respuesta no válida');
    const totalGrupo = Number(grupo.total);
    if (!Number.isFinite(totalGrupo)) throw new Error('Respuesta no válida');

    const lineas = grupo.lineas.map((raw): LineaCreditoRemesa => {
      if (!raw || typeof raw !== 'object') throw new Error('Respuesta no válida');
      const linea = raw as {
        id_factura?: unknown;
        numero?: unknown;
        motivo?: unknown;
        importe?: unknown;
      };
      if (linea.motivo !== 'exceso' && linea.motivo !== 'abono') {
        throw new Error('Respuesta no válida');
      }
      const importe = Number(linea.importe);
      if (!Number.isFinite(importe)) throw new Error('Respuesta no válida');
      return {
        id_factura: String(linea.id_factura ?? ''),
        numero: String(linea.numero ?? '').trim() || '—',
        motivo: linea.motivo,
        importe,
      };
    });

    return {
      proveedorNombre: String(grupo.proveedorNombre ?? '').trim() || 'Proveedor',
      sociedadNombre: String(grupo.sociedadNombre ?? '').trim(),
      lineas,
      total: totalGrupo,
    };
  });

  return { grupos, total };
}

/** Crédito (abonos y pagos en exceso) de los proveedores de las facturas de la remesa. */
export async function consultarCreditoSinAplicar(
  facturaIds: string[],
  signal?: AbortSignal,
): Promise<CreditoSinAplicarRemesa> {
  const res = await apiFetch('/api/facturacion/remesas/credito-sin-aplicar', {
    method: 'POST',
    body: JSON.stringify({ facturaIds }),
    signal,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error('No se han podido comprobar abonos ni excesos');
  }
  return parseCreditoSinAplicar(data);
}
