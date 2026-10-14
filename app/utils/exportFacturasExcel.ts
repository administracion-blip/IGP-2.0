import * as XLSX from 'xlsx';
import { formatMoneda, labelEstado, labelFormaPago } from './facturacion';
import {
  getProveedorEtiquetasFromEmpresasList,
  resolverFormaPagoEfectiva,
  type EmpresaConTipoRecibo,
} from './empresaTipoRecibo';
import type { DeudaProveedoresResp, FacturaDeuda } from '../types/deudaProveedores';

type FacturaRow = Record<string, unknown>;

const COLS_OUT = [
  { key: 'numero_factura', header: 'Nº Factura' },
  { key: 'fecha_emision', header: 'Fecha emisión' },
  { key: 'fecha_vencimiento', header: 'Fecha vencimiento' },
  { key: 'empresa_nombre', header: 'Empresa' },
  { key: 'empresa_cif', header: 'CIF' },
  { key: 'serie', header: 'Serie' },
  { key: 'impuestos_resumen', header: 'Impuestos IVA/Ret.' },
  { key: 'base_imponible', header: 'Base imponible', numeric: true },
  { key: 'total_iva', header: 'IVA', numeric: true },
  { key: 'total_retencion', header: 'Retención', numeric: true },
  { key: 'total_factura', header: 'Total factura', numeric: true },
  { key: 'total_cobrado', header: 'Cobrado', numeric: true },
  { key: 'saldo_pendiente', header: 'Saldo pendiente', numeric: true },
  { key: 'estado', header: 'Estado', transform: labelEstado },
  { key: 'forma_pago', header: 'Forma de pago', transform: labelFormaPago },
  { key: 'condiciones_pago', header: 'Condiciones' },
  { key: 'observaciones', header: 'Observaciones' },
];

const COLS_IN = [
  { key: 'numero_factura', header: 'Nº Factura' },
  { key: 'fecha_emision', header: 'Fecha emisión' },
  { key: 'fecha_vencimiento', header: 'Fecha vencimiento' },
  { key: 'empresa_nombre', header: 'Proveedor' },
  { key: 'empresa_cif', header: 'CIF' },
  { key: 'numero_factura_proveedor', header: 'Nº Proveedor' },
  { key: 'total_factura', header: 'Total factura', numeric: true },
  { key: 'forma_pago', header: 'Forma de pago', transform: labelFormaPago },
  { key: 'proveedor_etiquetas', header: 'Etiquetas' },
  { key: 'base_imponible', header: 'Base imponible', numeric: true },
  { key: 'total_iva', header: 'IVA soportado', numeric: true },
  { key: 'total_retencion', header: 'Retención', numeric: true },
  { key: 'total_cobrado', header: 'Pagado', numeric: true },
  { key: 'saldo_pendiente', header: 'Saldo pendiente', numeric: true },
  { key: 'estado', header: 'Estado', transform: labelEstado },
  { key: 'observaciones', header: 'Observaciones' },
];

type ColDef = { key: string; header: string; numeric?: boolean; transform?: (v: string) => string };

function enrichFacturaGastoRow(
  f: FacturaRow,
  empresas?: EmpresaConTipoRecibo[] | null,
): FacturaRow {
  if (!empresas?.length) return f;
  const formaClave = resolverFormaPagoEfectiva(
    {
      forma_pago: f.forma_pago != null ? String(f.forma_pago) : undefined,
      empresa_id: f.empresa_id != null ? String(f.empresa_id) : undefined,
      empresa_cif: f.empresa_cif != null ? String(f.empresa_cif) : undefined,
    },
    empresas,
  );
  const etiquetas = getProveedorEtiquetasFromEmpresasList(
    empresas,
    f.empresa_id != null ? String(f.empresa_id) : undefined,
    f.empresa_cif != null ? String(f.empresa_cif) : undefined,
  );
  return {
    ...f,
    forma_pago: formaClave,
    proveedor_etiquetas: etiquetas.join(', '),
  };
}

function buildRows(facturas: FacturaRow[], cols: ColDef[], enrich?: (f: FacturaRow) => FacturaRow) {
  return facturas.map((raw) => {
    const f = enrich ? enrich(raw) : raw;
    const row: Record<string, unknown> = {};
    cols.forEach((col) => {
      let val = f[col.key] ?? '';
      if (col.transform && typeof val === 'string') val = col.transform(val);
      if (col.numeric) val = typeof val === 'number' ? val : parseFloat(String(val)) || 0;
      row[col.header] = val;
    });
    return row;
  });
}

function download(wb: XLSX.WorkBook, filename: string) {
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportarFacturasVentaExcel(facturas: FacturaRow[], filename?: string) {
  const rows = buildRows(facturas, COLS_OUT);
  const ws = XLSX.utils.json_to_sheet(rows);
  const colWidths = COLS_OUT.map((c) => ({ wch: Math.max(c.header.length + 2, c.numeric ? 14 : 20) }));
  ws['!cols'] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Facturas emitidas');
  download(wb, filename || `facturas-emitidas-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

const ETIQUETA_ESTADO_DEUDA_EXCEL: Record<string, string> = {
  cuadrado: 'Cuadrado',
  pendiente: 'Pendiente',
  vencido: 'Vencido',
};

const TRAMO_DEUDA_EXCEL: Record<string, string> = {
  no_vencido: 'No vencido',
  d0_30: '0-30 días',
  d31_60: '31-60 días',
  d61_90: '61-90 días',
  d90mas: 'Más de 90 días',
};

/** Hojas «Resumen proveedores» y, si se pasan, «Facturas» de la ventana de deuda. */
export function exportarDeudaProveedoresExcel(resumen: DeudaProveedoresResp, facturas?: FacturaDeuda[]) {
  const num = (v: unknown) => Number(v) || 0;
  const filasResumen = resumen.proveedores.map((p) => ({
    Proveedor: p.nombre,
    CIF: p.cif ?? '',
    Estado: ETIQUETA_ESTADO_DEUDA_EXCEL[p.estado] ?? p.estado,
    Facturado: num(p.facturado),
    Pagado: num(p.pagado),
    Pendiente: num(p.pendiente),
    Vencido: num(p.vencido),
    '% pagado': num(p.pctPagado),
    'Nº facturas': num(p.numFacturas),
    'Nº pendientes': num(p.numPendientes),
    'Nº vencidas': num(p.numVencidas),
    'Vencimiento más antiguo': p.vencimientoMasAntiguo ?? '',
    'Pendiente anterior al periodo': num(p.anterior?.pendiente),
    'No vencido': num(p.antiguedad?.noVencido),
    '0-30 días': num(p.antiguedad?.d0_30),
    '31-60 días': num(p.antiguedad?.d31_60),
    '61-90 días': num(p.antiguedad?.d61_90),
    'Más de 90 días': num(p.antiguedad?.d90mas),
    'Saldo a favor': p.saldoAFavor ? 'Sí' : '',
    Intragrupo: p.intragrupo ? 'Sí' : '',
    'Le debemos': p.intragrupo ? num(p.intragrupo.leDebemos) : '',
    'Nos debe': p.intragrupo ? num(p.intragrupo.nosDebe) : '',
  }));
  const wb = XLSX.utils.book_new();
  const wsResumen = XLSX.utils.json_to_sheet(filasResumen);
  wsResumen['!cols'] = Object.keys(filasResumen[0] ?? { Proveedor: '' }).map((k) => ({
    wch: k === 'Proveedor' ? 34 : Math.max(k.length + 2, 12),
  }));
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen proveedores');

  if (facturas) {
    const filasFacturas = facturas.map((f) => ({
      'ID factura': f.id_factura,
      'Nº factura proveedor': f.numero_factura_proveedor ?? f.numero_factura ?? '',
      Proveedor: f.empresa_nombre ?? '',
      CIF: f.empresa_cif ?? '',
      Sociedad: f.emisor_nombre ?? '',
      Emisión: f.fecha_emision ?? '',
      Vencimiento: f.fecha_vencimiento ?? '',
      Total: num(f.total_factura),
      Pagado: num(f.total_cobrado),
      Pendiente: num(f.saldo_pendiente),
      Estado: labelEstado(String(f.estado ?? '')),
      Antigüedad: f.tramo ? TRAMO_DEUDA_EXCEL[f.tramo] ?? '' : '',
      'Días vencida': f.diasVencida ?? '',
      'Anterior al periodo': f.anteriorAlPeriodo ? 'Sí' : '',
      'En remesa': f.remesaActiva ? f.remesaActiva.nombre || 'Sí' : '',
    }));
    const wsFacturas = XLSX.utils.json_to_sheet(filasFacturas);
    wsFacturas['!cols'] = Object.keys(filasFacturas[0] ?? { Proveedor: '' }).map((k) => ({
      wch: k === 'Proveedor' || k === 'Sociedad' ? 30 : Math.max(k.length + 2, 12),
    }));
    XLSX.utils.book_append_sheet(wb, wsFacturas, 'Facturas');
  }

  download(wb, `deuda-proveedores-${resumen.rango.desde}_${resumen.rango.hasta}.xlsx`);
}

export function exportarFacturasGastoExcel(
  facturas: FacturaRow[],
  filename?: string,
  empresasCatalogo?: EmpresaConTipoRecibo[] | null,
) {
  const enrich = empresasCatalogo?.length
    ? (f: FacturaRow) => enrichFacturaGastoRow(f, empresasCatalogo)
    : undefined;
  const rows = buildRows(facturas, COLS_IN, enrich);
  const ws = XLSX.utils.json_to_sheet(rows);
  const colWidths = COLS_IN.map((c) => ({ wch: Math.max(c.header.length + 2, c.numeric ? 14 : 20) }));
  ws['!cols'] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Facturas recibidas');
  download(wb, filename || `facturas-recibidas-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
