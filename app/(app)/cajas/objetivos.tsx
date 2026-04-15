import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Modal,
  Pressable,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { captureRef } from 'react-native-view-shot';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { toPng } from 'html-to-image';
import { useAuth } from '../../contexts/AuthContext';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const OBJETIVOS_TABLA_HEADERS = [
  'Día',
  'Fecha',
  'FechaComparacion',
  'Festivo',
  'NombreFestivo',
  'TotalFacturadoReal',
  'TotalFacturadoComparativa',
  'Desvio',
  'DesvioPct',
] as const;

function objetivosExportFileSlug(nombre: string): string {
  return nombre.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 48) || 'local';
}

type Local = { id_Locales?: string; nombre?: string; Nombre?: string; agoraCode?: string; AgoraCode?: string };
type FestivoReg = { PK?: string; FechaComparativa?: string; Festivo?: boolean; NombreFestivo?: string };

type FilaObjetivo = {
  Fecha: string;
  FechaComparacion: string;
  Festivo: boolean;
  NombreFestivo: string;
  TotalFacturadoReal: number;
  TotalFacturadoComparativa: number;
  Desvio: number;
  DesvioPct: number | null;
};

function fechaComparacion(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00');
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function formatMoneda(n: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatPct(n: number | null): string {
  if (n == null) return '—';
  return (n * 100).toFixed(1) + '%';
}

function colorDesvio(valor: number | null): { color: string } {
  if (valor == null) return { color: '#64748b' };
  return { color: valor < 0 ? '#dc2626' : '#059669' };
}

function formatPctTicker(n: number | null): string {
  if (n == null) return '—';
  const pct = n * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function estiloTicker(valor: number | null): { backgroundColor: string; color: string } {
  if (valor == null) return { backgroundColor: '#f1f5f9', color: '#64748b' };
  return valor < 0
    ? { backgroundColor: 'rgba(220, 38, 38, 0.12)', color: '#b91c1c' }
    : { backgroundColor: 'rgba(5, 150, 105, 0.12)', color: '#047857' };
}

function diaSemana(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00');
  const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  return dias[d.getDay()] ?? '';
}

function diaVirtual(fecha: string, fechaComparacion: string): string {
  return `${diaSemana(fecha)}/${diaSemana(fechaComparacion)}`;
}

function filaObjetivoToExportCells(r: FilaObjetivo): (string | number)[] {
  return [
    diaVirtual(r.Fecha, r.FechaComparacion),
    r.Fecha,
    r.FechaComparacion,
    r.Festivo ? 'Sí' : 'No',
    r.NombreFestivo || '',
    r.TotalFacturadoReal,
    r.TotalFacturadoComparativa,
    r.Desvio,
    r.DesvioPct == null ? '' : r.DesvioPct,
  ];
}

function mesEnCurso(): { inicio: string; fin: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = String(hoy.getMonth() + 1).padStart(2, '0');
  const ultimoDia = new Date(y, hoy.getMonth() + 1, 0).getDate();
  return {
    inicio: `${y}-${m}-01`,
    fin: `${y}-${m}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

function ultimoDiaDelMes(fecha: string): string {
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  const d = new Date(fecha + 'T12:00:00');
  const y = d.getFullYear();
  const m = d.getMonth();
  const ultimoDia = new Date(y, m + 1, 0).getDate();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
}

/** Título del widget: mes y año del periodo seleccionado (primer día en ISO). */
function nombreMesYAnioDesdeFecha(iso: string): string {
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const hoy = new Date();
    return `${meses[hoy.getMonth()]} ${hoy.getFullYear()}`;
  }
  const [y, m] = iso.split('-').map(Number);
  return `${meses[m - 1]} ${y}`;
}

function ayerYYYYMMDD(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Fecha de negocio (YYYY-MM-DD), misma regla que arqueo de caja:
 * hasta las 09:30 (inclusive) corresponde el día anterior; desde las 09:31, el día natural.
 */
function fechaJornadaNegocioIso(): string {
  const now = new Date();
  const minutesOfDay = now.getHours() * 60 + now.getMinutes();
  const cutoff = 9 * 60 + 30;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (minutesOfDay <= cutoff) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatFechaCorta(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

type LocalObjetivo = {
  local: Local;
  sumReal: number;
  sumComp: number;
  desvioPct: number | null;
  sumRealHastaAyer: number;
  sumCompHastaAyer: number;
  desvioPctHastaAyer: number | null;
  ultimaFechaConDatos: string;
};

async function obtenerFilasObjetivos(
  workplaceId: string,
  fechaInicio: string,
  fechaFin: string,
): Promise<FilaObjetivo[]> {
  const [totalsRealRes, festivosRes] = await Promise.all([
    fetch(`${API_URL}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${fechaInicio}&dateTo=${fechaFin}`),
    fetch(`${API_URL}/api/gestion-festivos`),
  ]);
  const totalsRealData = await totalsRealRes.json();
  const festivosData = await festivosRes.json();
  const totalsReal: Record<string, number> = totalsRealData.totals ?? {};
  const festivosList: FestivoReg[] = Array.isArray(festivosData.registros) ? festivosData.registros : [];
  const festivosByFecha = Object.fromEntries(
    festivosList
      .filter((f) => f.PK || f.FechaComparativa)
      .map((f) => [String(f.PK ?? f.FechaComparativa ?? '').slice(0, 10), f]),
  );

  let minComp = '';
  let maxComp = '';
  const d = new Date(fechaInicio + 'T12:00:00');
  const end = new Date(fechaFin + 'T12:00:00');
  const fechaToComp: Record<string, string> = {};
  while (d <= end) {
    const fecha = d.toISOString().slice(0, 10);
    const festivo = festivosByFecha[fecha];
    const fechaComp =
      festivo?.FechaComparativa && /^\d{4}-\d{2}-\d{2}$/.test(String(festivo.FechaComparativa).slice(0, 10))
        ? String(festivo.FechaComparativa).slice(0, 10)
        : fechaComparacion(fecha);
    fechaToComp[fecha] = fechaComp;
    if (!minComp || fechaComp < minComp) minComp = fechaComp;
    if (!maxComp || fechaComp > maxComp) maxComp = fechaComp;
    d.setDate(d.getDate() + 1);
  }

  const totalsCompRes = await fetch(
    `${API_URL}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${minComp}&dateTo=${maxComp}`,
  );
  const totalsCompData = await totalsCompRes.json();
  const totalsComp: Record<string, number> = totalsCompData.totals ?? {};

  const filas: FilaObjetivo[] = [];
  const d2 = new Date(fechaInicio + 'T12:00:00');
  const end2 = new Date(fechaFin + 'T12:00:00');
  while (d2 <= end2) {
    const fecha = d2.toISOString().slice(0, 10);
    const fechaComp = fechaToComp[fecha];
    const real = totalsReal[fecha] ?? 0;
    const comp = totalsComp[fechaComp] ?? 0;
    const festivo = festivosByFecha[fecha];
    const esFestivo = String(festivo?.Festivo).toLowerCase() === 'true';
    const nombreFestivo = String(festivo?.NombreFestivo ?? '').trim();
    const desvio = real - comp;
    const desvioPct = comp === 0 ? null : real / comp - 1;
    filas.push({
      Fecha: fecha,
      FechaComparacion: fechaComp,
      Festivo: esFestivo,
      NombreFestivo: nombreFestivo,
      TotalFacturadoReal: real,
      TotalFacturadoComparativa: comp,
      Desvio: desvio,
      DesvioPct: desvioPct,
    });
    d2.setDate(d2.getDate() + 1);
  }
  return filas;
}

function generarPdfObjetivos(
  filas: FilaObjetivo[],
  nombreLocal: string,
  fechaInicio: string,
  fechaFin: string,
  tituloWidgetPeriodo: string,
): jsPDF {
  const ayer = ayerYYYYMMDD();
  const filasHastaAyer = filas.filter((r) => r.Fecha <= ayer);
  const sumReal = filas.reduce((a, r) => a + r.TotalFacturadoReal, 0);
  const sumComp = filas.reduce((a, r) => a + r.TotalFacturadoComparativa, 0);
  const sumDesvio = filas.reduce((a, r) => a + r.Desvio, 0);
  const desvioPctTotal = sumComp === 0 ? null : sumReal / sumComp - 1;
  const sumRealHoy = filasHastaAyer.reduce((a, r) => a + r.TotalFacturadoReal, 0);
  const sumCompHoy = filasHastaAyer.reduce((a, r) => a + r.TotalFacturadoComparativa, 0);
  const sumDesvioHoy = filasHastaAyer.reduce((a, r) => a + r.Desvio, 0);
  const desvioPctHoy = sumCompHoy === 0 ? null : sumRealHoy / sumCompHoy - 1;

  const body = filas.map((r) => {
    const row = filaObjetivoToExportCells(r);
    return [
      String(row[0]),
      String(row[1]),
      String(row[2]),
      String(row[3]),
      String(row[4]).slice(0, 36),
      typeof row[5] === 'number' ? formatMoneda(row[5]) : String(row[5]),
      typeof row[6] === 'number' ? formatMoneda(row[6]) : String(row[6]),
      typeof row[7] === 'number' ? formatMoneda(row[7]) : String(row[7]),
      row[8] === '' || row[8] == null ? '—' : formatPct(typeof row[8] === 'number' ? row[8] : Number(row[8])),
    ];
  });

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  let y = 12;
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Objetivos — comparativa diaria', 14, y);
  y += 6;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  doc.text(String(nombreLocal), 14, y);
  y += 5;
  doc.text(`Periodo: ${fechaInicio} → ${fechaFin} · ${tituloWidgetPeriodo}`, 14, y);
  y += 4;
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
  y += 5;
  if (filasHastaAyer.length > 0 && filasHastaAyer.length < filas.length) {
    const line = `Acumulado hasta ayer (${formatFechaCorta(ayer)}): facturado ${formatMoneda(sumRealHoy)} · comparativa ${formatMoneda(sumCompHoy)} · desvío ${formatMoneda(sumDesvioHoy)} · ${formatPctTicker(desvioPctHoy)}`;
    const split = doc.splitTextToSize(line, pageW - 28);
    doc.text(split, 14, y);
    y += split.length * 4 + 2;
  }
  doc.setTextColor(0);

  const COL_FECHA = 1;
  const COL_NOMBRE_FESTIVO = 4;
  const COL_TOTAL_REAL = 5;
  const COL_DESVIO_PCT = 8;
  const pinkFestivo: [number, number, number] = [219, 39, 119];
  const verdePct: [number, number, number] = [5, 150, 105];
  const rojoPct: [number, number, number] = [220, 38, 38];

  autoTable(doc, {
    startY: y,
    head: [OBJETIVOS_TABLA_HEADERS as unknown as string[]],
    body,
    foot: [
      [
        'TOTALES', '', '', '', '',
        formatMoneda(sumReal),
        formatMoneda(sumComp),
        formatMoneda(sumDesvio),
        desvioPctTotal == null ? '—' : formatPct(desvioPctTotal),
      ],
    ],
    showFoot: 'lastPage',
    theme: 'striped',
    styles: { fontSize: 7, cellPadding: 1.2 },
    headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
    footStyles: { fillColor: [241, 245, 249], textColor: 30, fontStyle: 'bold' },
    margin: { left: 10, right: 10 },
    tableWidth: pageW - 20,
    didParseCell: (data) => {
      if (data.section === 'body') {
        const colIdx = data.column.index;
        if (colIdx === COL_FECHA) {
          data.cell.styles.fontStyle = 'bold';
        }
        if (colIdx === COL_NOMBRE_FESTIVO) {
          const nombreF = String(filas[data.row.index]?.NombreFestivo ?? '').trim();
          if (nombreF) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = pinkFestivo;
          }
        }
        if (colIdx === COL_TOTAL_REAL) {
          data.cell.styles.fontStyle = 'bold';
        }
        if (colIdx === COL_DESVIO_PCT) {
          data.cell.styles.fontStyle = 'bold';
          const pct = filas[data.row.index]?.DesvioPct;
          if (pct != null && !Number.isNaN(pct)) {
            data.cell.styles.textColor = pct >= 0 ? verdePct : rojoPct;
          }
        }
      }
      if (data.section === 'foot' && data.column.index === COL_DESVIO_PCT) {
        data.cell.styles.fontStyle = 'bold';
        if (desvioPctTotal != null) {
          data.cell.styles.textColor = desvioPctTotal >= 0 ? verdePct : rojoPct;
        }
      }
    },
  });

  return doc;
}

export default function ObjetivosScreen() {
  const router = useRouter();
  const { localPermitido } = useAuth();
  const [fechaInicio, setFechaInicio] = useState(() => mesEnCurso().inicio);
  const [fechaFin, setFechaFin] = useState(() => mesEnCurso().fin);
  const [localSeleccionado, setLocalSeleccionado] = useState<Local | null>(null);
  const [locales, setLocales] = useState<Local[]>([]);
  const [loadingLocales, setLoadingLocales] = useState(true);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registros, setRegistros] = useState<FilaObjetivo[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [localesObjetivos, setLocalesObjetivos] = useState<LocalObjetivo[]>([]);
  const [loadingLocalesObjetivos, setLoadingLocalesObjetivos] = useState(false);
  const [rangosHastaAyer, setRangosHastaAyer] = useState<{
    fechaInicioMes: string;
    /** Fin del rango «Real» mostrado (min(fin periodo, ayer)); mismo día que inicio si aún no hay días cerrados en el periodo. */
    fechaFinRealHastaAyer: string;
    minCompHastaAyer: string;
    maxCompHastaAyer: string;
  } | null>(null);
  const [hoveredRangoKey, setHoveredRangoKey] = useState<string | null>(null);
  const widgetRef = useRef<View>(null);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [showMassDownload, setShowMassDownload] = useState(false);
  const [massSelectedLocals, setMassSelectedLocals] = useState<Set<string>>(new Set());
  const [massDownloading, setMassDownloading] = useState(false);
  const [massProgress, setMassProgress] = useState({ current: 0, total: 0, localName: '' });
  const [capturing, setCapturing] = useState(false);

  const cargarLocales = useCallback(() => {
    setLoadingLocales(true);
    fetch(`${API_URL}/api/locales`)
      .then((res) => res.json())
      .then((data: { locales?: Local[] }) => {
        const list = Array.isArray(data.locales) ? data.locales : [];
        const conAgora = list.filter((l) => (l.agoraCode ?? l.AgoraCode ?? '').toString().trim());
        setLocales(conAgora.filter((l) => localPermitido(l.nombre ?? l.Nombre ?? '')));
      })
      .catch((e) => setError(e.message || 'Error al cargar locales'))
      .finally(() => setLoadingLocales(false));
  }, [localPermitido]);

  useEffect(() => {
    cargarLocales();
  }, [cargarLocales]);

  /** Desplegable «Local» en Generar comparativa: orden alfabético por nombre (español). */
  const localesDropdownOrdenados = useMemo(
    () =>
      [...locales].sort((a, b) => {
        const na = String(a.nombre ?? a.Nombre ?? a.agoraCode ?? a.AgoraCode ?? '').trim();
        const nb = String(b.nombre ?? b.Nombre ?? b.agoraCode ?? b.AgoraCode ?? '').trim();
        return na.localeCompare(nb, 'es', { sensitivity: 'base' });
      }),
    [locales]
  );

  useEffect(() => {
    if (fechaInicio && /^\d{4}-\d{2}-\d{2}$/.test(fechaInicio)) {
      setFechaFin(ultimoDiaDelMes(fechaInicio));
    }
  }, [fechaInicio]);

  const cargarLocalesObjetivos = useCallback(async () => {
    if (locales.length === 0) return;
    if (
      !fechaInicio ||
      !fechaFin ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin) ||
      fechaInicio > fechaFin
    ) {
      setLocalesObjetivos([]);
      setRangosHastaAyer(null);
      setLoadingLocalesObjetivos(false);
      return;
    }
    setLoadingLocalesObjetivos(true);
    const fechaInicioMes = fechaInicio;
    const fechaFinMes = fechaFin;
    const fechaHastaAyerStr = ayerYYYYMMDD();
    /** Último día del periodo a considerar para «hasta ayer» (comparación lexicográfica ISO). */
    const finPeriodoHastaAyer =
      fechaHastaAyerStr < fechaInicioMes
        ? fechaInicioMes
        : fechaFinMes < fechaHastaAyerStr
          ? fechaFinMes
          : fechaHastaAyerStr;
    try {
      const festivosRes = await fetch(`${API_URL}/api/gestion-festivos`);
      const festivosData = await festivosRes.json();
      const festivosList: FestivoReg[] = Array.isArray(festivosData.registros) ? festivosData.registros : [];
      const festivosByFecha = Object.fromEntries(
        festivosList
          .filter((f) => f.PK || f.FechaComparativa)
          .map((f) => [String(f.PK ?? f.FechaComparativa ?? '').slice(0, 10), f])
      );
      const d = new Date(fechaInicioMes + 'T12:00:00');
      const end = new Date(fechaFinMes + 'T12:00:00');
      let minComp = '';
      let maxComp = '';
      const fechaToComp: Record<string, string> = {};
      while (d <= end) {
        const fecha = d.toISOString().slice(0, 10);
        const festivo = festivosByFecha[fecha];
        const fechaComp = festivo?.FechaComparativa && /^\d{4}-\d{2}-\d{2}$/.test(String(festivo.FechaComparativa).slice(0, 10))
          ? String(festivo.FechaComparativa).slice(0, 10)
          : fechaComparacion(fecha);
        fechaToComp[fecha] = fechaComp;
        if (!minComp || fechaComp < minComp) minComp = fechaComp;
        if (!maxComp || fechaComp > maxComp) maxComp = fechaComp;
        d.setDate(d.getDate() + 1);
      }
      let minCompHastaAyer = '';
      let maxCompHastaAyer = '';
      const dRango = new Date(fechaInicioMes + 'T12:00:00');
      const endRango = new Date(finPeriodoHastaAyer + 'T12:00:00');
      while (dRango <= endRango) {
        const fecha = dRango.toISOString().slice(0, 10);
        const fechaComp = fechaToComp[fecha];
        if (fechaComp) {
          if (!minCompHastaAyer || fechaComp < minCompHastaAyer) minCompHastaAyer = fechaComp;
          if (!maxCompHastaAyer || fechaComp > maxCompHastaAyer) maxCompHastaAyer = fechaComp;
        }
        dRango.setDate(dRango.getDate() + 1);
      }
      setRangosHastaAyer({
        fechaInicioMes,
        fechaFinRealHastaAyer: finPeriodoHastaAyer,
        minCompHastaAyer,
        maxCompHastaAyer,
      });
      const resultados: LocalObjetivo[] = await Promise.all(
        locales.map(async (loc) => {
          const workplaceId = (loc.agoraCode ?? loc.AgoraCode ?? '').toString().trim();
          if (!workplaceId) return { local: loc, sumReal: 0, sumComp: 0, desvioPct: null, sumRealHastaAyer: 0, sumCompHastaAyer: 0, desvioPctHastaAyer: null, ultimaFechaConDatos: '' };
          try {
            const [totalsRealRes, totalsCompRes] = await Promise.all([
              fetch(`${API_URL}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${fechaInicioMes}&dateTo=${fechaFinMes}`),
              fetch(`${API_URL}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${minComp}&dateTo=${maxComp}`),
            ]);
            const totalsRealData = await totalsRealRes.json();
            const totalsCompData = await totalsCompRes.json();
            const totalsReal: Record<string, number> = totalsRealData.totals ?? {};
            const totalsComp: Record<string, number> = totalsCompData.totals ?? {};
            const d2 = new Date(fechaInicioMes + 'T12:00:00');
            const end2 = new Date(fechaFinMes + 'T12:00:00');
            let sumReal = 0;
            let sumComp = 0;
            let sumRealHastaAyer = 0;
            let sumCompHastaAyer = 0;
            while (d2 <= end2) {
              const fecha = d2.toISOString().slice(0, 10);
              const fechaComp = fechaToComp[fecha];
        const real = totalsReal[fecha] ?? 0;
        const comp = totalsComp[fechaComp] ?? 0;
              sumReal += real;
              sumComp += comp;
              if (fecha <= fechaHastaAyerStr) {
                sumRealHastaAyer += real;
                sumCompHastaAyer += comp;
              }
              d2.setDate(d2.getDate() + 1);
            }
            const desvioPct = sumComp === 0 ? null : sumReal / sumComp - 1;
            const desvioPctHastaAyer = sumCompHastaAyer === 0 ? null : sumRealHastaAyer / sumCompHastaAyer - 1;
            const ultimaFechaConDatos = Object.keys(totalsReal)
              .filter((f) => (totalsReal[f] ?? 0) > 0)
              .sort()
              .pop() ?? '';
            return {
              local: loc,
              sumReal,
              sumComp,
              desvioPct,
              sumRealHastaAyer,
              sumCompHastaAyer,
              desvioPctHastaAyer,
              ultimaFechaConDatos,
            };
          } catch {
            return {
              local: loc,
              sumReal: 0,
              sumComp: 0,
              desvioPct: null,
              sumRealHastaAyer: 0,
              sumCompHastaAyer: 0,
              desvioPctHastaAyer: null,
              ultimaFechaConDatos: '',
            };
          }
        })
      );
      setLocalesObjetivos(resultados);
    } catch {
      setLocalesObjetivos([]);
    } finally {
      setLoadingLocalesObjetivos(false);
    }
  }, [locales, fechaInicio, fechaFin]);

  useEffect(() => {
    cargarLocalesObjetivos();
  }, [cargarLocalesObjetivos]);

  const tituloWidgetPeriodo = useMemo(() => nombreMesYAnioDesdeFecha(fechaInicio), [fechaInicio]);

  const captureWidget = useCallback(async (): Promise<string | null> => {
    if (!widgetRef.current) return null;
    try {
      if (Platform.OS === 'web') {
        const node = widgetRef.current as unknown as HTMLElement;
        const dataUrl = await toPng(node, {
          cacheBust: true,
          pixelRatio: 1.5,
          filter: (domNode: HTMLElement) => {
            if (domNode?.dataset?.captureHide) return false;
            return true;
          },
        });
        return dataUrl;
      }
      const uri = await captureRef(widgetRef, { format: 'jpg', quality: 0.9 });
      return uri;
    } catch (e) {
      console.warn('captureWidget error:', e);
      return null;
    }
  }, []);

  const handleShareJPG = useCallback(async () => {
    setShareMenuOpen(false);
    setCapturing(true);
    try {
      const uri = await captureWidget();
      if (!uri) return;
      if (Platform.OS === 'web') {
        const a = document.createElement('a');
        a.href = uri;
        a.download = `objetivos_${tituloWidgetPeriodo.replace(/\s/g, '_')}.png`;
        a.click();
      } else {
        await Sharing.shareAsync(uri, { mimeType: 'image/jpeg', dialogTitle: 'Guardar imagen' });
      }
    } finally {
      setCapturing(false);
    }
  }, [captureWidget, tituloWidgetPeriodo]);

  const handleSharePDF = useCallback(async () => {
    setShareMenuOpen(false);
    setCapturing(true);
    try {
      const dataUrl = await captureWidget();
      if (!dataUrl) return;
      if (Platform.OS === 'web') {
        const img = new Image();
        img.src = dataUrl;
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
        });
        const pxW = img.naturalWidth || img.width;
        const pxH = img.naturalHeight || img.height;
        const margin = 10;
        const pdfW = 210;
        const imgW = pdfW - margin * 2;
        const imgH = (pxH / pxW) * imgW;
        const pdfH = imgH + 30;
        const doc = new jsPDF({
          orientation: pdfH > pdfW ? 'portrait' : 'landscape',
          unit: 'mm',
          format: [pdfW, pdfH],
        });
        doc.setFontSize(12);
        doc.text(`Objetivos – ${tituloWidgetPeriodo}`, margin, 10);
        doc.addImage(dataUrl, 'PNG', margin, 18, imgW, imgH);
        doc.save(`objetivos_${tituloWidgetPeriodo.replace(/\s/g, '_')}.pdf`);
      } else {
        const base64 = await FileSystemLegacy.readAsStringAsync(dataUrl, { encoding: FileSystemLegacy.EncodingType.Base64 });
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        doc.setFontSize(12);
        doc.text(`Objetivos – ${tituloWidgetPeriodo}`, 10, 10);
        doc.addImage(`data:image/jpeg;base64,${base64}`, 'JPEG', 5, 18, 200, 0);
        const pdfBase64 = doc.output('datauristring').split(',')[1];
        const pdfUri = `${FileSystemLegacy.cacheDirectory}objetivos.pdf`;
        await FileSystemLegacy.writeAsStringAsync(pdfUri, pdfBase64, { encoding: FileSystemLegacy.EncodingType.Base64 });
        await Sharing.shareAsync(pdfUri, { mimeType: 'application/pdf', dialogTitle: 'Guardar PDF' });
      }
    } catch (e) {
      console.warn('handleSharePDF error:', e);
    } finally {
      setCapturing(false);
    }
  }, [captureWidget, tituloWidgetPeriodo]);

  const handleShareWhatsApp = useCallback(async () => {
    setShareMenuOpen(false);
    setCapturing(true);
    try {
      const uri = await captureWidget();
      if (!uri) return;
      if (Platform.OS === 'web') {
        const a = document.createElement('a');
        a.href = uri;
        a.download = `objetivos_${tituloWidgetPeriodo.replace(/\s/g, '_')}.png`;
        a.click();
        setTimeout(() => {
          window.open('https://web.whatsapp.com/', '_blank');
        }, 500);
      } else {
        await Sharing.shareAsync(uri, { mimeType: 'image/jpeg', dialogTitle: 'Compartir por WhatsApp' });
      }
    } finally {
      setCapturing(false);
    }
  }, [captureWidget, tituloWidgetPeriodo]);

  const generar = useCallback(async () => {
    const workplaceId = (localSeleccionado?.agoraCode ?? localSeleccionado?.AgoraCode ?? '').toString().trim();
    if (!workplaceId) { setError('Selecciona un local'); return; }
    if (!fechaInicio || !fechaFin || !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)) { setError('Indica rango de fechas (YYYY-MM-DD)'); return; }
    if (fechaInicio > fechaFin) { setError('Fecha inicio debe ser <= fecha fin'); return; }
    setError(null);
    setGenerando(true);
    try {
      setRegistros(await obtenerFilasObjetivos(workplaceId, fechaInicio, fechaFin));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al generar');
      setRegistros([]);
    } finally {
      setGenerando(false);
    }
  }, [fechaInicio, fechaFin, localSeleccionado]);

  const nombreLocal = localSeleccionado ? (localSeleccionado.nombre ?? localSeleccionado.Nombre ?? localSeleccionado.agoraCode ?? localSeleccionado.AgoraCode ?? '—') : 'Seleccionar local';

  const sumReal = registros.reduce((a, r) => a + r.TotalFacturadoReal, 0);
  const sumComp = registros.reduce((a, r) => a + r.TotalFacturadoComparativa, 0);
  const sumDesvio = registros.reduce((a, r) => a + r.Desvio, 0);
  const desvioPctTotal = sumComp === 0 ? null : sumReal / sumComp - 1;
  const tickerEstilo = estiloTicker(desvioPctTotal);

  const ayerStr = ayerYYYYMMDD();
  const registrosHastaAyer = registros.filter((r) => r.Fecha <= ayerStr);
  const sumRealHoy = registrosHastaAyer.reduce((a, r) => a + r.TotalFacturadoReal, 0);
  const sumCompHoy = registrosHastaAyer.reduce((a, r) => a + r.TotalFacturadoComparativa, 0);
  const sumDesvioHoy = registrosHastaAyer.reduce((a, r) => a + r.Desvio, 0);
  const desvioPctHoy = sumCompHoy === 0 ? null : sumRealHoy / sumCompHoy - 1;
  const tickerEstiloHoy = estiloTicker(desvioPctHoy);

  const fechaJornadaNegocio = fechaJornadaNegocioIso();

  const exportarTablaObjetivosExcel = useCallback(() => {
    if (registros.length === 0) return;
    setExportMenuOpen(false);
    const slug = objetivosExportFileSlug(String(nombreLocal));
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `objetivos_${slug}_${stamp}.xlsx`;

    const meta: (string | number)[][] = [
      ['Objetivos — detalle local', String(nombreLocal)],
      ['Periodo', `${fechaInicio} → ${fechaFin}`, tituloWidgetPeriodo],
      ['Generado', new Date().toLocaleString('es-ES')],
      [],
    ];
    if (registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length) {
      meta.push([
        `Acumulado hasta ayer (${formatFechaCorta(ayerStr)}): facturado ${formatMoneda(sumRealHoy)} · comparativa ${formatMoneda(sumCompHoy)} · desvío ${formatMoneda(sumDesvioHoy)} · ${formatPctTicker(desvioPctHoy)}`,
      ]);
      meta.push([]);
    }

    const header = [...OBJETIVOS_TABLA_HEADERS];
    const body = registros.map(filaObjetivoToExportCells);
    const totales: (string | number)[] = [
      'TOTALES',
      '',
      '',
      '',
      '',
      sumReal,
      sumComp,
      sumDesvio,
      desvioPctTotal ?? '',
    ];
    const aoa: (string | number)[][] = [...meta, header, ...body, totales];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Objetivos');

    if (Platform.OS === 'web') {
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() =>
          Sharing.shareAsync(fileUri, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: fname,
          })
        )
        .catch(() => {});
    }
  }, [
    registros,
    nombreLocal,
    fechaInicio,
    fechaFin,
    tituloWidgetPeriodo,
    sumReal,
    sumComp,
    sumDesvio,
    desvioPctTotal,
    registrosHastaAyer.length,
    ayerStr,
    sumRealHoy,
    sumCompHoy,
    sumDesvioHoy,
    desvioPctHoy,
  ]);

  const exportarTablaObjetivosPDF = useCallback(() => {
    if (registros.length === 0) return;
    setExportMenuOpen(false);
    const slug = objetivosExportFileSlug(String(nombreLocal));
    const fname = `objetivos_${slug}_${new Date().toISOString().slice(0, 10)}.pdf`;
    const doc = generarPdfObjetivos(registros, String(nombreLocal), fechaInicio, fechaFin, tituloWidgetPeriodo);

    if (Platform.OS === 'web') {
      doc.save(fname);
    } else {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1] || '';
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() => Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fname }))
        .catch(() => {});
    }
  }, [registros, nombreLocal, fechaInicio, fechaFin, tituloWidgetPeriodo]);

  const handleOpenMassDownload = useCallback(() => {
    setExportMenuOpen(false);
    setMassSelectedLocals(new Set());
    setMassProgress({ current: 0, total: 0, localName: '' });
    setShowMassDownload(true);
  }, []);

  const toggleMassLocal = useCallback((code: string) => {
    setMassSelectedLocals((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }, []);

  const toggleMassAll = useCallback(() => {
    setMassSelectedLocals((prev) => {
      const allCodes = localesDropdownOrdenados.map((l) => (l.agoraCode ?? l.AgoraCode ?? '').toString().trim()).filter(Boolean);
      return prev.size === allCodes.length ? new Set() : new Set(allCodes);
    });
  }, [localesDropdownOrdenados]);

  const handleMassDownload = useCallback(async () => {
    if (massSelectedLocals.size === 0) return;
    if (!fechaInicio || !fechaFin || fechaInicio > fechaFin) return;
    setMassDownloading(true);
    const selected = localesDropdownOrdenados.filter((l) => {
      const code = (l.agoraCode ?? l.AgoraCode ?? '').toString().trim();
      return massSelectedLocals.has(code);
    });
    setMassProgress({ current: 0, total: selected.length, localName: '' });

    for (let i = 0; i < selected.length; i++) {
      const loc = selected[i];
      const code = (loc.agoraCode ?? loc.AgoraCode ?? '').toString().trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? code);
      setMassProgress({ current: i, total: selected.length, localName: nombre });
      try {
        const filas = await obtenerFilasObjetivos(code, fechaInicio, fechaFin);
        if (filas.length === 0) continue;
        const doc = generarPdfObjetivos(filas, nombre, fechaInicio, fechaFin, tituloWidgetPeriodo);
        const slug = objetivosExportFileSlug(nombre);
        const fname = `objetivos_${slug}_${new Date().toISOString().slice(0, 10)}.pdf`;
        if (Platform.OS === 'web') {
          doc.save(fname);
          await new Promise((r) => setTimeout(r, 350));
        } else {
          const dataUri = doc.output('datauristring');
          const base64 = dataUri.split(',')[1] || '';
          const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
          const fileUri = `${cacheDir}${fname}`;
          await FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 });
          await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fname });
        }
      } catch { /* continuar con el siguiente local */ }
    }
    setMassProgress((p) => ({ ...p, current: selected.length, localName: '' }));
    setMassDownloading(false);
    setShowMassDownload(false);
  }, [massSelectedLocals, localesDropdownOrdenados, fechaInicio, fechaFin, tituloWidgetPeriodo]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Objetivos</Text>
      </View>

      <ScrollView
        style={styles.mainScroll}
        contentContainerStyle={styles.mainScrollContent}
        showsVerticalScrollIndicator
      >
      <View style={styles.mainRow}>
        <View style={styles.leftColumn}>
      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>Generar comparativa</Text>
        <View style={styles.formRow}>
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Fecha inicio</Text>
            <InputFecha
              value={fechaInicio}
              onChange={setFechaInicio}
              format="iso"
              placeholder="YYYY-MM-DD"
              style={styles.formInput}
            />
          </View>
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Fecha fin</Text>
            <InputFecha
              value={fechaFin}
              onChange={() => {}}
              format="iso"
              placeholder="YYYY-MM-DD"
              style={[styles.formInput, styles.formInputDisabled]}
              editable={false}
            />
          </View>
        </View>
        <View style={styles.formRow}>
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Local</Text>
            <TouchableOpacity
              style={styles.dropdown}
              onPress={() => setDropdownOpen((v) => !v)}
            >
              <Text style={styles.dropdownText} numberOfLines={1} ellipsizeMode="tail">
                {loadingLocales ? 'Cargando…' : nombreLocal}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={16} color="#64748b" style={styles.dropdownIcon} />
            </TouchableOpacity>
            {dropdownOpen && (
              <Modal visible transparent animationType="fade">
                <Pressable style={styles.dropdownOverlay} onPress={() => setDropdownOpen(false)}>
                  <View style={styles.dropdownList}>
                    {localesDropdownOrdenados.length > 0 ? (
                      <ScrollView style={styles.dropdownListScroll} nestedScrollEnabled showsVerticalScrollIndicator>
                        {localesDropdownOrdenados.map((loc) => {
                      const code = (loc.agoraCode ?? loc.AgoraCode ?? '').toString().trim();
                      const nom = (loc.nombre ?? loc.Nombre ?? code).toString().trim();
                      return (
                        <TouchableOpacity
                          key={loc.id_Locales ?? code}
                          style={styles.dropdownItem}
                          onPress={() => {
                            setLocalSeleccionado(loc);
                            setDropdownOpen(false);
                          }}
                        >
                              <Text style={styles.dropdownItemText} numberOfLines={1} ellipsizeMode="tail">
                                {nom || code || '—'}
                              </Text>
                        </TouchableOpacity>
                      );
                    })}
                      </ScrollView>
                    ) : !loadingLocales ? (
                      <Text style={styles.dropdownEmpty}>No hay locales con AgoraCode</Text>
                    ) : null}
                  </View>
                </Pressable>
              </Modal>
            )}
          </View>
          <TouchableOpacity
            style={[styles.btnGenerar, generando && styles.btnGenerarDisabled]}
            onPress={generar}
            disabled={generando}
          >
            {generando ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
                <MaterialIcons name="play-arrow" size={16} color="#fff" />
            )}
            <Text style={styles.btnGenerarText}>Generar</Text>
          </TouchableOpacity>
        </View>
      </View>

          <View ref={widgetRef} style={[styles.widget, styles.widgetLocales]} collapsable={false}>
          <View style={styles.widgetLocalesHeader}>
            <Text style={styles.widgetLocalesTitle}>{tituloWidgetPeriodo}</Text>
            <View style={styles.shareWrap} {...{ dataSet: { captureHide: 'true' } }}>
              <TouchableOpacity
                style={styles.shareBtn}
                onPress={() => setShareMenuOpen((v) => !v)}
                disabled={capturing || loadingLocalesObjetivos}
              >
                {capturing ? (
                  <ActivityIndicator size={12} color="#0ea5e9" />
                ) : (
                  <MaterialIcons name="share" size={14} color="#0ea5e9" />
                )}
              </TouchableOpacity>
              <Modal visible={shareMenuOpen} transparent animationType="fade" onRequestClose={() => setShareMenuOpen(false)}>
                <Pressable style={styles.shareOverlay} onPress={() => setShareMenuOpen(false)}>
                  <Pressable onPress={() => {}}>
                    <View style={styles.shareMenu}>
                      <TouchableOpacity style={styles.shareMenuItem} onPress={handleShareJPG}>
                        <MaterialIcons name="image" size={16} color="#0ea5e9" />
                        <Text style={styles.shareMenuText}>Descargar JPG</Text>
                      </TouchableOpacity>
                      <View style={styles.shareMenuDivider} />
                      <TouchableOpacity style={styles.shareMenuItem} onPress={handleSharePDF}>
                        <MaterialIcons name="picture-as-pdf" size={16} color="#dc2626" />
                        <Text style={styles.shareMenuText}>Descargar PDF</Text>
                      </TouchableOpacity>
                      <View style={styles.shareMenuDivider} />
                      <TouchableOpacity style={styles.shareMenuItem} onPress={handleShareWhatsApp}>
                        <MaterialIcons name="send" size={16} color="#25d366" />
                        <Text style={styles.shareMenuText}>WhatsApp</Text>
                      </TouchableOpacity>
                    </View>
                  </Pressable>
                </Pressable>
              </Modal>
            </View>
          </View>
          {loadingLocalesObjetivos ? (
            <ActivityIndicator size="small" color="#64748b" style={styles.widgetLocalesLoader} />
          ) : (
            <View style={styles.localesListWrap}>
              {[...localesObjetivos]
                .sort((a, b) => {
                  const nomA = (a.local.nombre ?? a.local.Nombre ?? a.local.agoraCode ?? a.local.AgoraCode ?? '—').toString().trim().toLowerCase();
                  const nomB = (b.local.nombre ?? b.local.Nombre ?? b.local.agoraCode ?? b.local.AgoraCode ?? '—').toString().trim().toLowerCase();
                  return nomA.localeCompare(nomB);
                })
                .map((item) => {
                const itemKey = String(item.local.id_Locales ?? item.local.agoraCode ?? item.local.AgoraCode ?? '');
                const nom = (item.local.nombre ?? item.local.Nombre ?? item.local.agoraCode ?? item.local.AgoraCode ?? '—').toString().trim();
                const sumDesvioHastaAyer = item.sumRealHastaAyer - item.sumCompHastaAyer;
                const estiloHastaAyer = estiloTicker(item.desvioPctHastaAyer);
                const ayerCheck = ayerYYYYMMDD();
                const datosAlDia = item.ultimaFechaConDatos >= ayerCheck;
                return (
                  <View key={itemKey} style={styles.localesListItem}>
                    <View style={styles.localesListHeader}>
                      <Text style={styles.localesListNombre} numberOfLines={1}>{nom}</Text>
                      <View style={[styles.syncBadge, datosAlDia ? styles.syncBadgeOk : styles.syncBadgeWarn]}>
                        <MaterialIcons
                          name={datosAlDia ? 'check-circle' : 'warning'}
                          size={10}
                          color={datosAlDia ? '#16a34a' : '#d97706'}
                        />
                        <Text style={[styles.syncBadgeText, datosAlDia ? styles.syncBadgeTextOk : styles.syncBadgeTextWarn]} numberOfLines={1}>
                          {datosAlDia
                            ? 'Actualizado'
                            : item.ultimaFechaConDatos
                              ? `Último dato: ${formatFechaCorta(item.ultimaFechaConDatos)}`
                              : 'Sin datos'}
                        </Text>
                      </View>
                    </View>
                    {rangosHastaAyer && (
                      <View style={styles.localesListHastaAyerInfo}>
                        <View
                          style={styles.localesListHastaAyerRangoWrap}
                          {...(Platform.OS === 'web' && {
                            onMouseEnter: () => setHoveredRangoKey(item.local.id_Locales ?? item.local.agoraCode ?? item.local.AgoraCode ?? ''),
                            onMouseLeave: () => setHoveredRangoKey(null),
                          } as any)}
                        >
                          <Text style={styles.localesListHastaAyerRango} numberOfLines={1}>
                            Real {formatFechaCorta(rangosHastaAyer.fechaInicioMes)} → {formatFechaCorta(rangosHastaAyer.fechaFinRealHastaAyer)} | Comp. {formatFechaCorta(rangosHastaAyer.minCompHastaAyer)} → {formatFechaCorta(rangosHastaAyer.maxCompHastaAyer)}
                          </Text>
                          {Platform.OS === 'web' && hoveredRangoKey === (item.local.id_Locales ?? item.local.agoraCode ?? item.local.AgoraCode) && (
                            <View style={styles.localesListRangoTooltip}>
                              <Text style={styles.localesListRangoTooltipText}>
                                Real {formatFechaCorta(rangosHastaAyer.fechaInicioMes)} → {formatFechaCorta(rangosHastaAyer.fechaFinRealHastaAyer)}{'\n'}Comp. {formatFechaCorta(rangosHastaAyer.minCompHastaAyer)} → {formatFechaCorta(rangosHastaAyer.maxCompHastaAyer)}
                              </Text>
                            </View>
                          )}
                        </View>
                        <View style={styles.localesListValoresRow}>
                          <View style={styles.localesListValorItem} {...{ dataSet: { captureHide: 'true' } }}>
                            <Text style={styles.localesListValorLabel}>Facturado</Text>
                            <Text style={styles.localesListValorNum}>{formatMoneda(item.sumRealHastaAyer)}</Text>
                          </View>
                          <View style={styles.localesListValorItem} {...{ dataSet: { captureHide: 'true' } }}>
                            <Text style={styles.localesListValorLabel}>Comparativa</Text>
                            <Text style={[styles.localesListValorNum, styles.localesListValorSecundario]}>{formatMoneda(item.sumCompHastaAyer)}</Text>
                          </View>
                          <View style={styles.localesListValorItem}>
                            <Text style={styles.localesListValorLabel}>Desvío</Text>
                            <Text style={[styles.localesListValorNum, colorDesvio(sumDesvioHastaAyer)]}>{formatMoneda(sumDesvioHastaAyer)}</Text>
                          </View>
                          <View style={styles.localesListValorItem}>
                            <View style={[styles.tickerBadge, styles.tickerBadgeSmall, { backgroundColor: estiloHastaAyer.backgroundColor }]}>
                              {item.desvioPctHastaAyer != null && (
                                <MaterialIcons name={item.desvioPctHastaAyer >= 0 ? 'trending-up' : 'trending-down'} size={9} color={estiloHastaAyer.color} />
                              )}
                              <Text style={[styles.tickerText, { color: estiloHastaAyer.color, fontSize: 9 }]}>
                                {formatPctTicker(item.desvioPctHastaAyer)}
                              </Text>
                            </View>
                          </View>
                        </View>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
          </View>
        </View>

      {registros.length > 0 && (
        <View style={styles.tableWrapper}>
          <ScrollView
            horizontal
            style={styles.tableScroll}
            contentContainerStyle={styles.tableScrollContent}
            showsHorizontalScrollIndicator
          >
            <View style={styles.tableWithProgress}>
              <View style={styles.progressSection}>
                {localSeleccionado && (
                  <View style={styles.progressLocalRow}>
                    <View style={styles.progressLocalTextCol}>
                      <Text style={styles.progressLocalName} numberOfLines={1}>{nombreLocal}</Text>
                      <Text style={styles.progressRegistrosCount}>
                        {registros.length} {registros.length === 1 ? 'registro' : 'registros'}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[styles.exportTablaBtn, registros.length === 0 && styles.exportTablaBtnDisabled]}
                      onPress={() => registros.length > 0 && setExportMenuOpen(true)}
                      disabled={registros.length === 0}
                      accessibilityLabel="Exportar tabla"
                    >
                      <MaterialIcons name="file-download" size={16} color={registros.length === 0 ? '#cbd5e1' : '#0369a1'} />
                      <Text style={[styles.exportTablaBtnText, registros.length === 0 && styles.exportTablaBtnTextDisabled]}>
                        Exportar
                      </Text>
                    </TouchableOpacity>
                    <Modal visible={exportMenuOpen} transparent animationType="fade" onRequestClose={() => setExportMenuOpen(false)}>
                      <Pressable style={styles.shareOverlay} onPress={() => setExportMenuOpen(false)}>
                        <Pressable onPress={() => {}}>
                          <View style={styles.shareMenu}>
                            <Text style={styles.exportMenuTitle}>Formato de exportación</Text>
                            <TouchableOpacity style={styles.shareMenuItem} onPress={exportarTablaObjetivosExcel}>
                              <MaterialIcons name="table-chart" size={18} color="#16a34a" />
                              <Text style={styles.shareMenuText}>Excel (.xlsx)</Text>
                            </TouchableOpacity>
                            <View style={styles.shareMenuDivider} />
                            <TouchableOpacity style={styles.shareMenuItem} onPress={exportarTablaObjetivosPDF}>
                              <MaterialIcons name="picture-as-pdf" size={18} color="#dc2626" />
                              <Text style={styles.shareMenuText}>PDF</Text>
                            </TouchableOpacity>
                            <View style={styles.shareMenuDivider} />
                            <TouchableOpacity style={styles.shareMenuItem} onPress={handleOpenMassDownload}>
                              <MaterialIcons name="download-for-offline" size={18} color="#7c3aed" />
                              <Text style={styles.shareMenuText}>Descarga masiva (PDF)</Text>
                            </TouchableOpacity>
                          </View>
                        </Pressable>
                      </Pressable>
                    </Modal>
                    <Modal visible={showMassDownload} transparent animationType="fade" onRequestClose={() => !massDownloading && setShowMassDownload(false)}>
                      <Pressable style={styles.shareOverlay} onPress={() => !massDownloading && setShowMassDownload(false)}>
                        <Pressable onPress={() => {}} style={styles.massModal}>
                          <Text style={styles.massTitle}>Descarga masiva de PDF</Text>
                          <Text style={styles.massSubtitle}>
                            Periodo: {fechaInicio} → {fechaFin} · {tituloWidgetPeriodo}
                          </Text>
                          <View style={styles.massSelectAllRow}>
                            <TouchableOpacity
                              style={styles.massCheckRow}
                              onPress={toggleMassAll}
                              disabled={massDownloading}
                            >
                              <MaterialIcons
                                name={massSelectedLocals.size === localesDropdownOrdenados.length ? 'check-box' : 'check-box-outline-blank'}
                                size={20}
                                color={massSelectedLocals.size === localesDropdownOrdenados.length ? '#0ea5e9' : '#94a3b8'}
                              />
                              <Text style={styles.massSelectAllText}>Seleccionar todos</Text>
                            </TouchableOpacity>
                            <Text style={styles.massCountText}>
                              {massSelectedLocals.size} de {localesDropdownOrdenados.length}
                            </Text>
                          </View>
                          <ScrollView style={styles.massListScroll} nestedScrollEnabled>
                            {localesDropdownOrdenados.map((loc) => {
                              const code = (loc.agoraCode ?? loc.AgoraCode ?? '').toString().trim();
                              const nombre = String(loc.nombre ?? loc.Nombre ?? code);
                              const checked = massSelectedLocals.has(code);
                              return (
                                <TouchableOpacity
                                  key={code}
                                  style={styles.massCheckRow}
                                  onPress={() => toggleMassLocal(code)}
                                  disabled={massDownloading}
                                >
                                  <MaterialIcons
                                    name={checked ? 'check-box' : 'check-box-outline-blank'}
                                    size={20}
                                    color={checked ? '#0ea5e9' : '#cbd5e1'}
                                  />
                                  <Text style={[styles.massLocalName, checked && styles.massLocalNameSelected]}>{nombre}</Text>
                                </TouchableOpacity>
                              );
                            })}
                          </ScrollView>
                          {massDownloading && (
                            <View style={styles.massProgressWrap}>
                              <View style={styles.massProgressBarBg}>
                                <View style={[styles.massProgressBarFill, { width: `${massProgress.total > 0 ? Math.round((massProgress.current / massProgress.total) * 100) : 0}%` }]} />
                              </View>
                              <Text style={styles.massProgressText}>
                                {massProgress.current} / {massProgress.total}{massProgress.localName ? ` — ${massProgress.localName}` : ''}
                              </Text>
                            </View>
                          )}
                          <View style={styles.massActions}>
                            <TouchableOpacity
                              style={styles.massCancelBtn}
                              onPress={() => !massDownloading && setShowMassDownload(false)}
                              disabled={massDownloading}
                            >
                              <Text style={styles.massCancelText}>Cancelar</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.massDownloadBtn, (massSelectedLocals.size === 0 || massDownloading) && styles.massDownloadBtnDisabled]}
                              onPress={handleMassDownload}
                              disabled={massSelectedLocals.size === 0 || massDownloading}
                            >
                              {massDownloading ? (
                                <ActivityIndicator size="small" color="#fff" />
                              ) : (
                                <>
                                  <MaterialIcons name="download" size={16} color="#fff" />
                                  <Text style={styles.massDownloadText}>
                                    Descargar {massSelectedLocals.size > 0 ? `(${massSelectedLocals.size})` : ''}
                                  </Text>
                                </>
                              )}
                            </TouchableOpacity>
                          </View>
                        </Pressable>
                      </Pressable>
                    </Modal>
                  </View>
                )}
                <View style={styles.progressHeader}>
                  <Text style={styles.progressLabel}>
                    {formatMoneda(sumReal)} / {formatMoneda(sumComp)}
                  </Text>
                  <View style={styles.progressHeaderRight}>
                    <View style={[
                      styles.progressRestanteBadge,
                      (sumComp - sumReal) <= 0 ? styles.progressRestanteAlcanzado : styles.progressRestantePendiente,
                    ]}>
                      <Text style={styles.progressRestanteText}>
                        {(sumComp - sumReal) <= 0
                          ? 'Objetivo alcanzado'
                          : `Faltan ${formatMoneda(sumComp - sumReal)}`}
                      </Text>
                    </View>
                    <Text style={styles.progressPct}>
                      {sumComp === 0 ? '0%' : `${Math.min(100, (sumReal / sumComp) * 100).toFixed(1)}%`}
                    </Text>
                  </View>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${sumComp === 0 ? 0 : Math.min(100, (sumReal / sumComp) * 100)}%`,
                      },
                    ]}
                  />
                </View>
                {registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length && (
                  <View style={styles.parcialBox}>
                    <Text style={styles.parcialTitle}>Acumulado hasta ayer ({formatFechaCorta(ayerStr)})</Text>
                    <View style={styles.parcialRow}>
                      <View style={styles.parcialItem}>
                        <Text style={styles.parcialLabel}>Facturado</Text>
                        <Text style={[styles.parcialValue, { color: '#1e293b' }]}>{formatMoneda(sumRealHoy)}</Text>
                      </View>
                      <View style={styles.parcialItem}>
                        <Text style={styles.parcialLabel}>Comparativa</Text>
                        <Text style={[styles.parcialValue, { color: '#64748b' }]}>{formatMoneda(sumCompHoy)}</Text>
                      </View>
                      <View style={styles.parcialItem}>
                        <Text style={styles.parcialLabel}>Desvío</Text>
                        <Text style={[styles.parcialValue, colorDesvio(sumDesvioHoy)]}>{formatMoneda(sumDesvioHoy)}</Text>
                      </View>
                      <View style={styles.parcialItem}>
                        <View style={[styles.tickerBadge, { backgroundColor: tickerEstiloHoy.backgroundColor }]}>
                          {desvioPctHoy != null && (
                            <MaterialIcons name={desvioPctHoy >= 0 ? 'trending-up' : 'trending-down'} size={14} color={tickerEstiloHoy.color} />
                          )}
                          <Text style={[styles.tickerText, { color: tickerEstiloHoy.color }]}>
                            {formatPctTicker(desvioPctHoy)}
                          </Text>
                        </View>
                      </View>
                    </View>
                  </View>
                )}
              </View>
          <View style={styles.table}>
            <View style={styles.rowHeader}>
              <Text style={[styles.cellHeader, styles.cellDia]}>Día</Text>
              <Text style={[styles.cellHeader, styles.cellFecha]}>Fecha</Text>
              <Text style={[styles.cellHeader, styles.cellFecha]}>FechaComparacion</Text>
              <Text style={[styles.cellHeader, styles.cellFestivo]}>Festivo</Text>
              <Text style={[styles.cellHeader, styles.cellNombre]}>NombreFestivo</Text>
              <Text style={[styles.cellHeader, styles.cellMoneda]}>TotalFacturadoReal</Text>
              <Text style={[styles.cellHeader, styles.cellMoneda]}>TotalFacturadoComparativa</Text>
              <Text style={[styles.cellHeader, styles.cellMoneda]}>Desvio</Text>
              <Text style={[styles.cellHeader, styles.cellPct]}>DesvioPct</Text>
            </View>
            <View style={styles.rowSummary}>
              <Text style={[styles.cellSummary, styles.cellDia]}>
                {registros.length} {registros.length === 1 ? 'registro' : 'registros'}
              </Text>
              <Text style={[styles.cellSummary, styles.cellFecha]} />
              <Text style={[styles.cellSummary, styles.cellFecha]} />
              <Text style={[styles.cellSummary, styles.cellFestivo]} />
              <Text style={[styles.cellSummary, styles.cellNombre]} />
              <Text style={[styles.cellSummary, styles.cellMoneda]}>{formatMoneda(sumReal)}</Text>
              <Text style={[styles.cellSummary, styles.cellMoneda]}>{formatMoneda(sumComp)}</Text>
              <Text style={[styles.cellSummary, styles.cellMoneda, styles.cellBold, colorDesvio(sumDesvio)]}>
                {formatMoneda(sumDesvio)}
              </Text>
              <View style={[styles.cellPctWrapper, styles.cellPct]}>
                <View style={[styles.tickerBadge, { backgroundColor: tickerEstilo.backgroundColor }]}>
                  {desvioPctTotal != null && (
                    <MaterialIcons
                      name={desvioPctTotal >= 0 ? 'trending-up' : 'trending-down'}
                      size={12}
                      color={tickerEstilo.color}
                    />
                  )}
                  <Text style={[styles.tickerText, { color: tickerEstilo.color }]}>
                    {formatPctTicker(desvioPctTotal)}
                  </Text>
                </View>
              </View>
            </View>
            <ScrollView
              style={[
                styles.tableBodyScroll,
                Platform.OS === 'web' && ({ maxHeight: 'min(72vh, 640px)' } as Record<string, unknown>),
              ]}
              contentContainerStyle={styles.tableBodyScrollContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
            {registros.map((r, idx) => (
                <View
                  key={idx}
                  style={[styles.row, r.Fecha === fechaJornadaNegocio && styles.rowJornadaActual]}
                >
                  <Text style={[styles.cell, styles.cellDia]}>{diaVirtual(r.Fecha, r.FechaComparacion)}</Text>
                  <Text style={[styles.cell, styles.cellFecha, styles.cellBold]} numberOfLines={1}>{r.Fecha}</Text>
                <Text style={[styles.cell, styles.cellFecha]} numberOfLines={1}>{r.FechaComparacion}</Text>
                <Text style={[styles.cell, styles.cellFestivo]}>{r.Festivo ? 'Sí' : 'No'}</Text>
                  <View style={[styles.cell, styles.cellNombre]}>
                    {r.NombreFestivo ? (
                      <View style={styles.nombreFestivoBadge}>
                        <Text style={styles.nombreFestivoText} numberOfLines={1}>{r.NombreFestivo}</Text>
                      </View>
                    ) : (
                      <Text style={styles.cellText} numberOfLines={1}>—</Text>
                    )}
                  </View>
                  <Text style={[styles.cell, styles.cellMoneda, styles.cellBold]}>{formatMoneda(r.TotalFacturadoReal)}</Text>
                <Text style={[styles.cell, styles.cellMoneda]}>{formatMoneda(r.TotalFacturadoComparativa)}</Text>
                  <Text style={[styles.cell, styles.cellMoneda, styles.cellBold, colorDesvio(r.Desvio)]}>{formatMoneda(r.Desvio)}</Text>
                  <Text style={[styles.cell, styles.cellPct, styles.cellBold, colorDesvio(r.DesvioPct)]}>{formatPct(r.DesvioPct)}</Text>
              </View>
            ))}
            </ScrollView>
          </View>
          </View>
        </ScrollView>
        </View>
      )}
      </View>
      </ScrollView>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  mainScroll: { flex: 1 },
  mainScrollContent: { flexGrow: 1, paddingBottom: 20 },
  mainRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  leftColumn: { flexDirection: 'column', gap: 12, flexShrink: 0, minWidth: 220 },
  widget: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignSelf: 'flex-start',
  },
  tableWrapper: { flex: 1, minWidth: 0 },
  widgetTitle: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 12 },
  formRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'flex-end' },
  formGroup: { flex: 1, minWidth: 90, maxWidth: 180 },
  formLabel: { fontSize: 11, fontWeight: '500', color: '#64748b', marginBottom: 1 },
  formInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 3,
    fontSize: 12,
    color: '#334155',
  },
  formInputDisabled: { backgroundColor: '#f1f5f9', color: '#94a3b8' },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 3,
    minHeight: 24,
    overflow: 'hidden',
  },
  dropdownText: { fontSize: 12, color: '#334155', flex: 1, minWidth: 0 },
  dropdownIcon: { marginLeft: 2, flexShrink: 0 },
  dropdownOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  dropdownList: {
    backgroundColor: '#fff',
    borderRadius: 6,
    maxHeight: 240,
    minWidth: 200,
    maxWidth: 320,
    width: '100%',
    overflow: 'hidden',
  },
  dropdownListScroll: { maxHeight: 240 },
  dropdownItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    overflow: 'hidden',
    minWidth: 0,
  },
  dropdownItemText: { fontSize: 12, color: '#334155' },
  dropdownEmpty: { padding: 12, fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  btnGenerar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#0ea5e9',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 5,
  },
  btnGenerarDisabled: { opacity: 0.7 },
  btnGenerarText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  widgetLocales: { alignSelf: 'stretch', minHeight: 120, marginTop: 12 },
  widgetLocalesHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  widgetLocalesTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  shareWrap: { position: 'relative', zIndex: 50 },
  shareBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  shareOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.3)' },
  shareMenu: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minWidth: 200,
    ...(Platform.OS === 'web' && { boxShadow: '0 8px 24px rgba(0,0,0,0.15)' } as object),
  },
  shareMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  shareMenuText: { fontSize: 12, color: '#334155', fontWeight: '500' },
  shareMenuDivider: { height: 1, backgroundColor: '#f1f5f9' },
  widgetLocalesLoader: { marginVertical: 20 },
  localesListWrap: {},
  localesListItem: {
    marginBottom: 0,
    paddingBottom: 10,
    paddingTop: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  localesListHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  localesListNombre: { fontSize: 12, fontWeight: '500', color: '#334155', flex: 1, marginRight: 8 },
  localesListPct: { fontSize: 9, color: '#64748b', fontWeight: '400' },
  localesListProgressTrack: {
    height: 6,
    backgroundColor: '#e2e8f0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  localesListProgressFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: '#0ea5e9',
  },
  localesListProgressTrackSecondary: {
    marginTop: 4,
  },
  localesListProgressFillSecondary: {
    backgroundColor: '#94a3b8',
  },
  localesListHastaAyerInfo: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 4,
  },
  localesListValoresRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  },
  localesListValorItem: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  localesListValorLabel: { fontSize: 9, color: '#64748b', fontWeight: '500' },
  localesListValorNum: { fontSize: 10, fontWeight: '600', color: '#334155' },
  localesListValorSecundario: { color: '#64748b', fontWeight: '500' },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  syncBadgeOk: { backgroundColor: '#dcfce7' },
  syncBadgeWarn: { backgroundColor: '#fef3c7' },
  syncBadgeText: { fontSize: 8, fontWeight: '600' },
  syncBadgeTextOk: { color: '#16a34a' },
  syncBadgeTextWarn: { color: '#d97706' },
  localesListHastaAyerLabel: { fontSize: 9, color: '#475569', fontWeight: '600' },
  localesListHastaAyerRangoWrap: { position: 'relative' as const, alignSelf: 'flex-start', flexShrink: 0 },
  localesListHastaAyerRango: { fontSize: 8, color: '#94a3b8', maxWidth: 200 },
  localesListRangoTooltip: {
    position: 'absolute' as const,
    bottom: '100%',
    left: 0,
    marginBottom: 4,
    backgroundColor: '#fef08a',
    borderWidth: 1,
    borderColor: '#eab308',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    zIndex: 1000,
    maxWidth: 320,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 8,
  },
  localesListRangoTooltipText: { fontSize: 10, color: '#334155', lineHeight: 16 },
  tickerBadgeSmall: { paddingHorizontal: 6, paddingVertical: 2 },
  tableWithProgress: { minWidth: 862 },
  progressSection: { marginBottom: 8 },
  progressLocalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  progressLocalTextCol: { flex: 1, minWidth: 0 },
  exportTablaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    flexShrink: 0,
  },
  exportTablaBtnDisabled: { opacity: 0.55 },
  exportTablaBtnText: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  exportTablaBtnTextDisabled: { color: '#94a3b8' },
  exportMenuTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  progressLocalName: { fontSize: 14, fontWeight: '700', color: '#334155' },
  progressRegistrosCount: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic' },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  progressHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progressLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  progressPct: { fontSize: 12, fontWeight: '700', color: '#334155' },
  progressRestanteBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  progressRestanteAlcanzado: { backgroundColor: '#d1fae5' },
  progressRestantePendiente: { backgroundColor: '#fef3c7' },
  progressRestanteText: { fontSize: 11, fontWeight: '600', color: '#475569' },
  progressTrack: {
    height: 14,
    backgroundColor: '#e2e8f0',
    borderRadius: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 6,
    backgroundColor: '#0ea5e9',
  },
  errorText: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  tableScroll: { flexGrow: 1 },
  tableScrollContent: { paddingBottom: 20 },
  table: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    flexDirection: 'column',
  },
  /** Altura máxima base del cuerpo con scroll (en web se amplía con estilo inline). */
  tableBodyScroll: {
    flexGrow: 0,
    maxHeight: 420,
  },
  tableBodyScrollContent: {
    flexGrow: 0,
    paddingBottom: 6,
  },
  rowHeader: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  cellHeader: { fontSize: 10, fontWeight: '600', color: '#334155', paddingVertical: 4, paddingHorizontal: 6 },
  rowSummary: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  cellSummary: { fontSize: 10, fontWeight: '600', color: '#334155', paddingVertical: 3, paddingHorizontal: 6 },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  /** Fila cuyo campo Fecha coincide con la jornada de negocio actual (corte 09:30, como arqueo de caja). */
  rowJornadaActual: {
    backgroundColor: '#e0f2fe',
    borderLeftWidth: 3,
    borderLeftColor: '#0284c7',
  },
  cell: { fontSize: 10, color: '#475569', paddingVertical: 3, paddingHorizontal: 6, lineHeight: 14 },
  cellBold: { fontWeight: '700' },
  cellDia: { width: 72 },
  cellFecha: { width: 100 },
  cellFestivo: { width: 60 },
  cellNombre: { width: 120 },
  cellText: { fontSize: 10, color: '#475569', lineHeight: 14 },
  nombreFestivoBadge: {
    backgroundColor: '#fce7f3',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    alignSelf: 'flex-start',
  },
  nombreFestivoText: { fontSize: 10, color: '#9d174d', lineHeight: 13 },
  cellMoneda: { width: 110, textAlign: 'right' },
  cellPct: { width: 80, textAlign: 'right' },
  cellPctWrapper: { justifyContent: 'center', alignItems: 'flex-end', paddingVertical: 2 },
  tickerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: 'flex-end',
    gap: 2,
  },
  massModal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
  },
  massTitle: { fontSize: 16, fontWeight: '700', color: '#1e293b', marginBottom: 4 },
  massSubtitle: { fontSize: 11, color: '#64748b', marginBottom: 12 },
  massSelectAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    marginBottom: 4,
  },
  massSelectAllText: { fontSize: 12, fontWeight: '600', color: '#334155', marginLeft: 8 },
  massCountText: { fontSize: 11, color: '#94a3b8' },
  massListScroll: { maxHeight: 260, marginBottom: 12 },
  massCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    gap: 8,
  },
  massLocalName: { fontSize: 12, color: '#475569' },
  massLocalNameSelected: { color: '#0ea5e9', fontWeight: '500' },
  massProgressWrap: { marginBottom: 12 },
  massProgressBarBg: { height: 6, backgroundColor: '#e2e8f0', borderRadius: 3, overflow: 'hidden', marginBottom: 4 },
  massProgressBarFill: { height: '100%', backgroundColor: '#0ea5e9', borderRadius: 3 },
  massProgressText: { fontSize: 11, color: '#64748b', textAlign: 'center' },
  massActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  massCancelBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#f1f5f9' },
  massCancelText: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  massDownloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#7c3aed',
  },
  massDownloadBtnDisabled: { opacity: 0.5 },
  massDownloadText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  tickerText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
  parcialBox: {
    marginTop: 12,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  parcialTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  parcialRow: {
    flexDirection: 'row',
    gap: 16,
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
  },
  parcialItem: {
    alignItems: 'center',
    minWidth: 80,
  },
  parcialLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: '#94a3b8',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  parcialValue: {
    fontSize: 14,
    fontWeight: '700',
  },
});
