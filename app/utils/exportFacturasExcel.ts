import * as XLSX from 'xlsx';
import { formatMoneda, labelEstado, labelFormaPago } from './facturacion';
import {
  getProveedorEtiquetasFromEmpresasList,
  resolverFormaPagoEfectiva,
  type EmpresaConTipoRecibo,
} from './empresaTipoRecibo';

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
