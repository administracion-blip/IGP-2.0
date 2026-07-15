import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { truncarNombreFit } from '../concepto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLANTILLA_PATH = join(__dirname, '../../../assets/remesas/bbva-fit-plantilla.xlsx');

const HOJA = 'Remesa Transferencia SEPA';
const FILA_CABECERA_DATOS = 7;
const FILA_DETALLE_INICIO = 12;
const COL = {
  CIF: 1,
  SUFIJO: 2,
  NOMBRE: 3,
  CUENTA: 4,
  MOMENTO: 5,
  FECHA: 6,
  SEPA_VALOR: 7,
  AGRUPAR: 8,
  IMPORTE_TOTAL: 9,
  DIVISA: 10,
  BEN_NOMBRE: 1,
  BEN_CUENTA: 2,
  BEN_IMPORTE: 3,
  BEN_CONCEPTO: 4,
};

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** dd/mm/aaaa desde YYYY-MM-DD */
function fechaIsoADmy(iso) {
  const s = String(iso ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function setCellValue(ws, row, col, value) {
  const cell = ws.getCell(row, col);
  cell.value = value;
  if (cell.formula) delete cell.formula;
}

export const bbvaFitFormato = {
  clave: 'BBVA_FIT',
  nombre: 'BBVA Net Cash (FIT)',
  plantilla: PLANTILLA_PATH,

  /**
   * @param {object} remesa
   * @returns {Promise<Buffer>}
   */
  async generar(remesa) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(PLANTILLA_PATH);
    const ws = wb.getWorksheet(HOJA);
    if (!ws) throw new Error(`Hoja "${HOJA}" no encontrada en plantilla BBVA FIT`);

    const lineas = Array.isArray(remesa.lineas) ? remesa.lineas : [];
    const importeTotal = round2(lineas.reduce((s, l) => s + (Number(l.importe) || 0), 0));

    const r = FILA_CABECERA_DATOS;
    setCellValue(ws, r, COL.CIF, String(remesa.sociedadCif || '').trim());
    setCellValue(ws, r, COL.SUFIJO, String(remesa.sufijoOrdenante || '').trim());
    setCellValue(ws, r, COL.NOMBRE, truncarNombreFit(remesa.sociedadNombre));
    setCellValue(ws, r, COL.CUENTA, String(remesa.cuentaOrdenante || '').trim());

    const tieneFecha = !!String(remesa.fechaEjecucion || '').trim();
    // 1 = Ahora, 2 = Fecha específica (según plantilla de ejemplo E7=2)
    setCellValue(ws, r, COL.MOMENTO, tieneFecha ? 2 : 1);
    setCellValue(ws, r, COL.FECHA, tieneFecha ? fechaIsoADmy(remesa.fechaEjecucion) : '');
    setCellValue(ws, r, COL.SEPA_VALOR, false);
    setCellValue(ws, r, COL.AGRUPAR, false);
    setCellValue(ws, r, COL.IMPORTE_TOTAL, importeTotal);
    setCellValue(ws, r, COL.DIVISA, 'EUR');

    let fila = FILA_DETALLE_INICIO;
    for (const linea of lineas) {
      setCellValue(ws, fila, COL.BEN_NOMBRE, truncarNombreFit(linea.proveedorNombre));
      setCellValue(ws, fila, COL.BEN_CUENTA, String(linea.ibanBeneficiario || '').trim());
      setCellValue(ws, fila, COL.BEN_IMPORTE, round2(linea.importe));
      setCellValue(ws, fila, COL.BEN_CONCEPTO, String(linea.concepto || '').slice(0, 140));
      fila += 1;
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  },
};
