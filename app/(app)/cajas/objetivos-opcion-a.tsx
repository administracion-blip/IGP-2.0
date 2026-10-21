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
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { SelectorRangoSemana } from '../../components/SelectorRangoSemana';
import { AgrupacionesObjetivosModal } from './AgrupacionesObjetivosModal';
import { useAgrupacionesObjetivos } from '../../hooks/useAgrupacionesObjetivos';
import { captureRef } from 'react-native-view-shot';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { toPng } from 'html-to-image';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
type jsPDF = import('jspdf').jsPDF;
import * as XLSX from 'xlsx';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import {
  type FestivoReg,
  type FilaObjetivo,
  fechaComparacion,
  fechaCorteMediaRealObjetivos,
  mediasPorDiaSemanaDesdeFilas,
  obtenerFilasObjetivos,
} from '../../lib/objetivosFilasApi';
import { buildTextoResumenObjetivos } from '../../lib/objetivosListadoPdf';
import { generarPdfListadoObjetivosWhatsApp } from '../../lib/objetivosReportePdf';
import {
  type FilaFranja,
  type PlantillaFranjas,
  agruparEnFranjas,
  obtenerPlantillasFranjas,
  obtenerVentasPorHora,
} from '../../lib/ventasPorHoraApi';
import { apiFetch, errorMessage } from '../../utils/api';
import {
  ObjetivosShareExport,
  type ObjetivosShareExportProps,
  type ObjetivosShareGrupo,
  type ObjetivosShareLocal,
} from '../../components/ObjetivosShareExport';

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

/** Etiquetas visibles en pantalla (export Excel/PDF sigue usando OBJETIVOS_TABLA_HEADERS). */
const OBJETIVOS_TABLA_HEADERS_UI = [
  'Día',
  'Fecha',
  'Fecha comp.',
  'Fest.',
  'Anotaciones',
  'Facturado',
  'Comparativa',
  'Desvío',
  '%',
] as const;

function objetivosExportFileSlug(nombre: string): string {
  return nombre.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 48) || 'local';
}

type Local = { id_Locales?: string; nombre?: string; Nombre?: string; agoraCode?: string; AgoraCode?: string };

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

/** Variación % media real vs comparativa (misma fila). null si igualdad o mediaComp≤0. */
function variacionPctMediasVsComp(
  mediaReal: number,
  mediaComp: number,
): { pct: number; up: boolean } | null {
  if (!(mediaComp > 0) || mediaReal === mediaComp) return null;
  const pct = (mediaReal / mediaComp - 1) * 100;
  return { pct, up: mediaReal > mediaComp };
}

function colorDesvio(valor: number | null): { color: string } {
  if (valor == null) return { color: colors.textMuted };
  return { color: valor < 0 ? colors.danger : '#059669' };
}

function formatPctTicker(n: number | null): string {
  if (n == null) return '—';
  const pct = n * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function colorSemDesvio(pct: number | null): string {
  if (pct == null) return colors.textMuted;
  return pct >= 0 ? colors.success : colors.danger;
}

const CHIP_MES_PASTEL = {
  anterior: { bg: colors.bg, bgSel: colors.border, border: colors.border, borderSel: colors.borderStrong, text: colors.textPrimary },
  actual: { bg: colors.accentMuted, bgSel: '#bae6fd', border: '#bae6fd', borderSel: '#7dd3fc', text: '#075985' },
  proximo: { bg: '#f5f3ff', bgSel: '#ddd6fe', border: '#ddd6fe', borderSel: '#c4b5fd', text: '#6d28d9' },
} as const;

const CHIP_TAB_PASTEL = {
  tabla: { bg: colors.bg, bgSel: colors.accentMuted, border: colors.border, borderSel: '#7dd3fc', text: colors.textPrimary, textSel: '#075985' },
  medias: { bg: colors.bg, bgSel: statusColors.warning.bg, border: colors.border, borderSel: '#fcd34d', text: colors.textPrimary, textSel: '#92400e' },
} as const;

function KpiCard({ label, value, color, compact }: { label: string; value: string; color?: string; compact?: boolean }) {
  return (
    <View style={[styles.kpiCard, compact && styles.kpiCardCompact]}>
      <Text style={[styles.kpiLabel, compact && styles.kpiLabelCompact]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, compact && styles.kpiValueCompact, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function estiloTicker(valor: number | null): { backgroundColor: string; color: string } {
  if (valor == null) return { backgroundColor: colors.navActive, color: colors.textMuted };
  return valor < 0
    ? { backgroundColor: 'rgba(220, 38, 38, 0.12)', color: statusColors.danger.text }
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

function diaSemanaLargo(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00');
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  return dias[d.getDay()] ?? '';
}

function nombreFestivoCombinado(r: FilaObjetivo): string {
  const lineas: string[] = [];
  if (r.NombreFestivo) lineas.push(`${formatFechaCorta(r.Fecha)} · ${r.NombreFestivo}`);
  if (r.NombreFestivoComparacion) lineas.push(`${formatFechaCorta(r.FechaComparacion)} · ${r.NombreFestivoComparacion}`);
  return lineas.join('\n');
}

function filaObjetivoToExportCells(r: FilaObjetivo): (string | number)[] {
  return [
    diaVirtual(r.Fecha, r.FechaComparacion),
    r.Fecha,
    r.FechaComparacion,
    r.Festivo ? 'Sí' : 'No',
    nombreFestivoCombinado(r),
    r.TotalFacturadoReal,
    r.TotalFacturadoComparativa,
    r.Desvio,
    r.DesvioPct == null ? '' : r.DesvioPct,
  ];
}

/** Primer y último día del mes desplazado `offset` meses respecto al actual. */
function mesConOffset(offset: number): { inicio: string; fin: string } {
  const hoy = new Date();
  const inicioDate = new Date(hoy.getFullYear(), hoy.getMonth() + offset, 1);
  const y = inicioDate.getFullYear();
  const m = inicioDate.getMonth();
  const ultimoDia = new Date(y, m + 1, 0).getDate();
  const mStr = String(m + 1).padStart(2, '0');
  return {
    inicio: `${y}-${mStr}-01`,
    fin: `${y}-${mStr}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

function mesEnCurso(): { inicio: string; fin: string } {
  return mesConOffset(0);
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

async function generarPdfObjetivos(
  filas: FilaObjetivo[],
  nombreLocal: string,
  fechaInicio: string,
  fechaFin: string,
  tituloWidgetPeriodo: string,
): Promise<jsPDF> {
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
      String(row[4]).split('\n').map((l) => l.slice(0, 36)).join('\n'),
      typeof row[5] === 'number' ? formatMoneda(row[5]) : String(row[5]),
      typeof row[6] === 'number' ? formatMoneda(row[6]) : String(row[6]),
      typeof row[7] === 'number' ? formatMoneda(row[7]) : String(row[7]),
      row[8] === '' || row[8] == null ? '—' : formatPct(typeof row[8] === 'number' ? row[8] : Number(row[8])),
    ];
  });

  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
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
          const fila = filas[data.row.index];
          const nombreF = String(fila?.NombreFestivo ?? '').trim();
          const nombreComp = String(fila?.NombreFestivoComparacion ?? '').trim();
          if (nombreF || nombreComp) {
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

  const corteMediasPdf = fechaCorteMediaRealObjetivos(fechaFin, ayer);
  const mediasFilas = mediasPorDiaSemanaDesdeFilas(filas, {
    fechaMaxRealInclusive: corteMediasPdf,
  });
  const mediasBody = mediasFilas.map((row) => {
    const realStr =
      row.nReal === 0 ? '—' : `${formatMoneda(row.mediaReal)} (${row.nReal})`;
    const variacion =
      row.nReal > 0 && row.nComp > 0 ? variacionPctMediasVsComp(row.mediaReal, row.mediaComp) : null;
    const realCol =
      variacion != null
        ? `${realStr}  ${variacion.up ? '+' : ''}${variacion.pct.toFixed(1)}%`
        : realStr;
    return [
      row.label,
      realCol,
      row.nComp === 0 ? '—' : `${formatMoneda(row.mediaComp)} (${row.nComp})`,
    ];
  });

  const pageH = doc.internal.pageSize.getHeight();
  let yMedias = ((doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 10;
  if (yMedias > pageH - 55) {
    doc.addPage();
    yMedias = 14;
  }

  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Media por día de la semana', 14, yMedias);
  yMedias += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(80);
  const hintMedias =
    `Media real: solo fechas hasta ${formatFechaCorta(corteMediasPdf)} (mín. entre fin de periodo y ayer). ` +
    'Comparativa: todo el periodo (día de semana según fecha comparación). Entre paréntesis: nº de días. ±X% junto a media real: variación vs comparativa (verde al alza, rojo a la baja).';
  const hintLines = doc.splitTextToSize(hintMedias, pageW - 28);
  doc.text(hintLines, 14, yMedias);
  yMedias += hintLines.length * 3.5 + 3;
  doc.setTextColor(0);

  autoTable(doc, {
    startY: yMedias,
    head: [['Día', 'Media real', 'Media comparativa']],
    body: mediasBody,
    theme: 'striped',
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold' },
    margin: { left: 10, right: 10 },
    tableWidth: pageW - 20,
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 0) {
        data.cell.styles.fontStyle = 'bold';
      }
    },
  });

  return doc;
}

/** UI Opción A — ver objetivos.tsx para revertir a la pantalla anterior. */
export default function ObjetivosOpcionAScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { shouldStackPanels, shouldStackToolbar } = useBreakpoint();
  const isNarrow = shouldStackPanels;
  const { localPermitido } = useAuth();
  const [fechaInicio, setFechaInicio] = useState(() => mesEnCurso().inicio);
  const [fechaFin, setFechaFin] = useState(() => mesEnCurso().fin);
  const [localSeleccionado, setLocalSeleccionado] = useState<Local | null>(null);
  const [locales, setLocales] = useState<Local[]>([]);
  const [loadingLocales, setLoadingLocales] = useState(true);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registros, setRegistros] = useState<FilaObjetivo[]>([]);
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
  const [agrupModalOpen, setAgrupModalOpen] = useState(false);
  const { agrupaciones, guardar: guardarAgrupacion, borrar: borrarAgrupacion } = useAgrupacionesObjetivos();
  const widgetRef = useRef<View>(null);
  const shareExportRef = useRef<View>(null);
  const [shareCaptureProps, setShareCaptureProps] = useState<ObjetivosShareExportProps | null>(null);
  const [descargasMenuOpen, setDescargasMenuOpen] = useState(false);
  const [mediasAyudaOpen, setMediasAyudaOpen] = useState(false);
  const [massSelectedLocals, setMassSelectedLocals] = useState<Set<string>>(new Set());
  const [massDownloading, setMassDownloading] = useState(false);
  const [massProgress, setMassProgress] = useState({ current: 0, total: 0, localName: '' });
  const [capturing, setCapturing] = useState(false);
  const [detalleTab, setDetalleTab] = useState<'tabla' | 'medias'>('tabla');
  const [visionGlobalAbierta, setVisionGlobalAbierta] = useState(true);
  const [showMassDownload, setShowMassDownload] = useState(false);
  const [horasModalOpen, setHorasModalOpen] = useState(false);
  const [horasFechaSel, setHorasFechaSel] = useState<string>('');
  const [plantillas, setPlantillas] = useState<PlantillaFranjas[]>([]);
  const [plantillaSelId, setPlantillaSelId] = useState<string>('');
  const [horasLoading, setHorasLoading] = useState(false);
  const [horasError, setHorasError] = useState<string | null>(null);
  const [filasFranja, setFilasFranja] = useState<FilaFranja[] | null>(null);
  const [horasMeta, setHorasMeta] = useState<{ totalReal: number; totalComp: number } | null>(null);

  const cargarLocales = useCallback(() => {
    setLoadingLocales(true);
    apiFetch('/api/locales')
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
      const festivosRes = await apiFetch('/api/gestion-festivos');
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
              apiFetch(`/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${fechaInicioMes}&dateTo=${fechaFinMes}`),
              apiFetch(`/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${minComp}&dateTo=${maxComp}`),
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

  /** LocalObjetivo indexado por id_Locales, para agregar agrupaciones. */
  const localesObjetivosById = useMemo(() => {
    const m = new Map<string, LocalObjetivo>();
    for (const it of localesObjetivos) {
      const id = String(it.local.id_Locales ?? '').trim();
      if (id) m.set(id, it);
    }
    return m;
  }, [localesObjetivos]);

  /**
   * Agregación por agrupación: suma los totales de los locales que la forman.
   * `ultimaFechaConDatos` = la más antigua de sus locales (el más atrasado manda),
   * por lo que el grupo solo está «al día» si TODOS sus locales lo están.
   */
  const agrupacionesCalculadas = useMemo(() => {
    return agrupaciones.map((ag) => {
      let sumReal = 0;
      let sumComp = 0;
      let sumRealHastaAyer = 0;
      let sumCompHastaAyer = 0;
      let ultimaFechaConDatos = '';
      let encontrados = 0;
      for (const id of ag.localIds) {
        const lo = localesObjetivosById.get(String(id));
        if (!lo) continue;
        sumReal += lo.sumReal;
        sumComp += lo.sumComp;
        sumRealHastaAyer += lo.sumRealHastaAyer;
        sumCompHastaAyer += lo.sumCompHastaAyer;
        if (encontrados === 0 || lo.ultimaFechaConDatos < ultimaFechaConDatos) {
          ultimaFechaConDatos = lo.ultimaFechaConDatos;
        }
        encontrados += 1;
      }
      return {
        agrupacion: ag,
        encontrados,
        totalLocales: ag.localIds.length,
        sumReal,
        sumComp,
        desvioPct: sumComp === 0 ? null : sumReal / sumComp - 1,
        sumRealHastaAyer,
        sumCompHastaAyer,
        desvioPctHastaAyer: sumCompHastaAyer === 0 ? null : sumRealHastaAyer / sumCompHastaAyer - 1,
        ultimaFechaConDatos: encontrados > 0 ? ultimaFechaConDatos : '',
      };
    });
  }, [agrupaciones, localesObjetivosById]);

  const datosShareWhatsApp = useMemo(() => {
    const sorted = [...localesObjetivos].sort((a, b) => {
      const na = String(a.local.nombre ?? a.local.Nombre ?? a.local.agoraCode ?? a.local.AgoraCode ?? '').trim();
      const nb = String(b.local.nombre ?? b.local.Nombre ?? b.local.agoraCode ?? b.local.AgoraCode ?? '').trim();
      return na.localeCompare(nb, 'es', { sensitivity: 'base' });
    });
    const locales: ObjetivosShareLocal[] = sorted.map((item) => {
      const key = String(item.local.id_Locales ?? item.local.agoraCode ?? item.local.AgoraCode ?? '').trim();
      return {
        key,
        nombre: String(item.local.nombre ?? item.local.Nombre ?? item.local.agoraCode ?? item.local.AgoraCode ?? '—').trim(),
        sumRealHastaAyer: item.sumRealHastaAyer,
        sumCompHastaAyer: item.sumCompHastaAyer,
        desvioPctHastaAyer: item.desvioPctHastaAyer,
      };
    });
    const localIdsEnGrupo = new Set(agrupaciones.flatMap((ag) => ag.localIds.map((id) => String(id))));
    const localesSueltos = locales.filter((l) => !localIdsEnGrupo.has(l.key));
    const grupos: ObjetivosShareGrupo[] = agrupacionesCalculadas
      .filter((g) => g.encontrados > 0)
      .map((g) => ({
        id: g.agrupacion.id,
        nombre: g.agrupacion.nombre,
        color: g.agrupacion.color,
        sumRealHastaAyer: g.sumRealHastaAyer,
        sumCompHastaAyer: g.sumCompHastaAyer,
        desvioPctHastaAyer: g.desvioPctHastaAyer,
        locales: g.agrupacion.localIds
          .map((id) => localesObjetivosById.get(String(id)))
          .filter((lo): lo is LocalObjetivo => !!lo)
          .map((lo) => {
            const key = String(lo.local.id_Locales ?? lo.local.agoraCode ?? lo.local.AgoraCode ?? '').trim();
            return {
              key,
              nombre: String(lo.local.nombre ?? lo.local.Nombre ?? lo.local.agoraCode ?? lo.local.AgoraCode ?? '—').trim(),
              sumRealHastaAyer: lo.sumRealHastaAyer,
              sumCompHastaAyer: lo.sumCompHastaAyer,
              desvioPctHastaAyer: lo.desvioPctHastaAyer,
            };
          }),
      }));
    const sumRealHastaAyer = locales.reduce((a, l) => a + l.sumRealHastaAyer, 0);
    const sumCompHastaAyer = locales.reduce((a, l) => a + l.sumCompHastaAyer, 0);
    const desvioPctHastaAyer = sumCompHastaAyer === 0 ? null : sumRealHastaAyer / sumCompHastaAyer - 1;
    return {
      locales,
      localesSueltos,
      grupos,
      totales: { sumRealHastaAyer, sumCompHastaAyer, desvioPctHastaAyer },
    };
  }, [localesObjetivos, agrupaciones, agrupacionesCalculadas, localesObjetivosById]);

  const shareExportBase = useMemo(
    (): Omit<ObjetivosShareExportProps, 'mode'> => ({
      tituloPeriodo: tituloWidgetPeriodo,
      fechaHastaLabel: formatFechaCorta(ayerYYYYMMDD()),
      generadoLabel: `Generado ${new Date().toLocaleString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}`,
      totales: datosShareWhatsApp.totales,
      locales: datosShareWhatsApp.locales,
      grupos: datosShareWhatsApp.grupos,
    }),
    [tituloWidgetPeriodo, datosShareWhatsApp],
  );

  const captureShareExport = useCallback(async (props: ObjetivosShareExportProps): Promise<string | null> => {
    setShareCaptureProps(props);
    await new Promise((r) => setTimeout(r, 180));
    try {
      if (!shareExportRef.current) return null;
      if (Platform.OS === 'web') {
        const node = shareExportRef.current as unknown as HTMLElement;
        return await toPng(node, { cacheBust: true, pixelRatio: 3 });
      }
      return await captureRef(shareExportRef, { format: 'png', quality: 1 });
    } catch (e) {
      console.warn('captureShareExport error:', e);
      return null;
    } finally {
      setShareCaptureProps(null);
    }
  }, []);

  const compartirImagenExport = useCallback(async (uri: string, fileBase: string) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `${fileBase}_${stamp}.png`;
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = uri;
      a.download = fname;
      a.click();
      return;
    }
    await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: fname });
  }, []);

  const compartirPdfExport = useCallback(async (doc: jsPDF, fileBase: string) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `${fileBase}_${stamp}.pdf`;
    if (Platform.OS === 'web') {
      doc.save(fname);
      return;
    }
    const dataUri = doc.output('datauristring');
    const base64 = dataUri.split(',')[1] || '';
    const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
    const fileUri = `${cacheDir}${fname}`;
    await FileSystemLegacy.writeAsStringAsync(fileUri, base64, {
      encoding: FileSystemLegacy.EncodingType.Base64,
    });
    await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fname });
  }, []);

  const datosPdfListado = useMemo(
    () => ({
      grupos: datosShareWhatsApp.grupos.map((g) => ({
        nombre: g.nombre,
        orden: agrupacionesCalculadas.find((ac) => ac.agrupacion.id === g.id)?.agrupacion.orden ?? 0,
        locales: g.locales.map((loc) => ({
          nombre: loc.nombre,
          sumRealHastaAyer: loc.sumRealHastaAyer,
          sumCompHastaAyer: loc.sumCompHastaAyer,
        })),
      })),
      localesSueltos: datosShareWhatsApp.localesSueltos.map((loc) => ({
        nombre: loc.nombre,
        sumRealHastaAyer: loc.sumRealHastaAyer,
        sumCompHastaAyer: loc.sumCompHastaAyer,
      })),
    }),
    [datosShareWhatsApp, agrupacionesCalculadas],
  );

  const handleShareResumenWhatsApp = useCallback(async () => {
    if (datosShareWhatsApp.locales.length === 0) return;
    setDescargasMenuOpen(false);
    setCapturing(true);
    try {
      const uri = await captureShareExport({ ...shareExportBase, mode: 'resumen' });
      if (!uri) return;
      const slug = tituloWidgetPeriodo.replace(/\s/g, '_');
      await compartirImagenExport(uri, `objetivos_resumen_${slug}`);
    } finally {
      setCapturing(false);
    }
  }, [captureShareExport, compartirImagenExport, datosShareWhatsApp.locales.length, shareExportBase, tituloWidgetPeriodo]);

  const handleShareListadoWhatsApp = useCallback(async () => {
    if (datosShareWhatsApp.locales.length === 0) return;
    setDescargasMenuOpen(false);
    setCapturing(true);
    try {
      const doc = await generarPdfListadoObjetivosWhatsApp({
        tituloPeriodo: shareExportBase.tituloPeriodo,
        fechaHastaLabel: shareExportBase.fechaHastaLabel,
        generadoLabel: shareExportBase.generadoLabel,
        totales: shareExportBase.totales,
        grupos: datosPdfListado.grupos,
        localesSueltos: datosPdfListado.localesSueltos,
      });
      const slug = tituloWidgetPeriodo.replace(/\s/g, '_');
      await compartirPdfExport(doc, `objetivos_listado_${slug}`);
    } catch (e) {
      console.warn('handleShareListadoWhatsApp error:', e);
    } finally {
      setCapturing(false);
    }
  }, [
    compartirPdfExport,
    datosPdfListado,
    datosShareWhatsApp.locales.length,
    shareExportBase,
    tituloWidgetPeriodo,
  ]);

  const handleCopiarResumenTexto = useCallback(async () => {
    if (datosShareWhatsApp.locales.length === 0) return;
    setDescargasMenuOpen(false);
    const texto = buildTextoResumenObjetivos({
      tituloPeriodo: shareExportBase.tituloPeriodo,
      fechaHastaLabel: shareExportBase.fechaHastaLabel,
      totales: shareExportBase.totales,
      locales: datosShareWhatsApp.locales.map((loc) => ({
        nombre: loc.nombre,
        sumRealHastaAyer: loc.sumRealHastaAyer,
        sumCompHastaAyer: loc.sumCompHastaAyer,
        desvioPctHastaAyer: loc.desvioPctHastaAyer,
      })),
    });
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(texto);
      } else {
        await Clipboard.setStringAsync(texto);
      }
      Alert.alert('Copiado', 'Resumen copiado al portapapeles. Pégalo en WhatsApp u otro chat.');
    } catch {
      Alert.alert('Error', 'No se pudo copiar el resumen al portapapeles.');
    }
  }, [datosShareWhatsApp, shareExportBase]);

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
    setDescargasMenuOpen(false);
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
    setDescargasMenuOpen(false);
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
        const { jsPDF: JsPDF } = await import('jspdf');
        const doc = new JsPDF({
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
        const { jsPDF: JsPDF2 } = await import('jspdf');
        const doc = new JsPDF2({ orientation: 'portrait', unit: 'mm', format: 'a4' });
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

  const generarParaLocal = useCallback(async (loc?: Local | null) => {
    const target = loc ?? localSeleccionado;
    const workplaceId = (target?.agoraCode ?? target?.AgoraCode ?? '').toString().trim();
    if (!workplaceId) { setError('Selecciona un local'); return; }
    if (!fechaInicio || !fechaFin || !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)) { setError('Indica una fecha válida (dd/mm/aaaa)'); return; }
    if (fechaInicio > fechaFin) { setError('Fecha inicio debe ser <= fecha fin'); return; }
    setError(null);
    setGenerando(true);
    try {
      setRegistros(await obtenerFilasObjetivos(API_URL, workplaceId, fechaInicio, fechaFin));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al generar');
      setRegistros([]);
    } finally {
      setGenerando(false);
    }
  }, [fechaInicio, fechaFin, localSeleccionado]);

  const generar = useCallback(() => generarParaLocal(null), [generarParaLocal]);

  const seleccionarLocalLista = useCallback((loc: Local) => {
    setLocalSeleccionado(loc);
    generarParaLocal(loc);
  }, [generarParaLocal]);

  const esMesActual = useMemo(() => {
    const m = mesEnCurso();
    return fechaInicio === m.inicio && fechaFin === m.fin;
  }, [fechaInicio, fechaFin]);

  const esMesAnterior = useMemo(() => {
    const m = mesConOffset(-1);
    return fechaInicio === m.inicio && fechaFin === m.fin;
  }, [fechaInicio, fechaFin]);

  const esMesProximo = useMemo(() => {
    const m = mesConOffset(1);
    return fechaInicio === m.inicio && fechaFin === m.fin;
  }, [fechaInicio, fechaFin]);

  const localSeleccionadoKey = localSeleccionado
    ? String(localSeleccionado.id_Locales ?? localSeleccionado.agoraCode ?? localSeleccionado.AgoraCode ?? '')
    : '';

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

  const corteMediasReal = useMemo(
    () => fechaCorteMediaRealObjetivos(fechaFin, ayerStr),
    [fechaFin, ayerStr],
  );
  const mediasPorDiaSemana = useMemo(
    () => mediasPorDiaSemanaDesdeFilas(registros, { fechaMaxRealInclusive: corteMediasReal }),
    [registros, corteMediasReal],
  );

  const fechaJornadaNegocio = fechaJornadaNegocioIso();

  const exportarTablaObjetivosExcel = useCallback(() => {
    if (registros.length === 0) return;
    setDescargasMenuOpen(false);
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

  const exportarTablaObjetivosPDF = useCallback(async () => {
    if (registros.length === 0) return;
    setDescargasMenuOpen(false);
    const slug = objetivosExportFileSlug(String(nombreLocal));
    const fname = `objetivos_${slug}_${new Date().toISOString().slice(0, 10)}.pdf`;
    const doc = await generarPdfObjetivos(registros, String(nombreLocal), fechaInicio, fechaFin, tituloWidgetPeriodo);

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
    setDescargasMenuOpen(false);
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
        const filas = await obtenerFilasObjetivos(API_URL, code, fechaInicio, fechaFin);
        if (filas.length === 0) continue;
        const doc = await generarPdfObjetivos(filas, nombre, fechaInicio, fechaFin, tituloWidgetPeriodo);
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

  const abrirHorasModal = useCallback(() => {
    setHorasModalOpen(true);
    setHorasError(null);
    setFilasFranja(null);
    setHorasMeta(null);
    if (plantillas.length === 0) {
      obtenerPlantillasFranjas()
        .then(setPlantillas)
        .catch((e) => setHorasError(errorMessage(e, 'Error al cargar plantillas')));
    }
  }, [plantillas.length]);

  const filaHorasSel = useMemo(
    () => registros.find((r) => r.Fecha === horasFechaSel) ?? null,
    [registros, horasFechaSel],
  );
  const plantillaSel = useMemo(
    () => plantillas.find((p) => p.plantillaId === plantillaSelId) ?? null,
    [plantillas, plantillaSelId],
  );

  useEffect(() => {
    const workplaceId = (localSeleccionado?.agoraCode ?? localSeleccionado?.AgoraCode ?? '').toString().trim();
    if (!horasModalOpen || !filaHorasSel || !plantillaSel || !workplaceId) {
      setFilasFranja(null);
      setHorasMeta(null);
      return;
    }
    let cancelado = false;
    setHorasLoading(true);
    setHorasError(null);
    Promise.all([
      obtenerVentasPorHora(workplaceId, filaHorasSel.Fecha),
      obtenerVentasPorHora(workplaceId, filaHorasSel.FechaComparacion),
    ])
      .then(([real, comp]) => {
        if (cancelado) return;
        setFilasFranja(agruparEnFranjas(real.porHora, comp.porHora, plantillaSel.franjas));
        setHorasMeta({ totalReal: real.totalDia, totalComp: comp.totalDia });
      })
      .catch((e) => {
        if (cancelado) return;
        setHorasError(errorMessage(e, 'Error al calcular ventas por hora'));
        setFilasFranja(null);
        setHorasMeta(null);
      })
      .finally(() => {
        if (!cancelado) setHorasLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [horasModalOpen, filaHorasSel, plantillaSel, localSeleccionado]);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Math.max(12, insets.top), paddingLeft: Math.max(16, insets.left), paddingRight: Math.max(16, insets.right) }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Objetivos</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.outlineBtnPurple} onPress={() => setAgrupModalOpen(true)} accessibilityLabel="Agrupaciones">
            <MaterialIcons name="workspaces" size={16} color="#7c3aed" />
            <Text style={styles.outlineBtnPurpleText}>Agrupaciones</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.outlineBtnBlue}
            onPress={() => setDescargasMenuOpen(true)}
            disabled={capturing}
            accessibilityLabel="Descargas"
          >
            {capturing ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <MaterialIcons name="download" size={16} color={colors.accent} />
            )}
            <Text style={styles.outlineBtnBlueText}>Descargas</Text>
            <MaterialIcons name="expand-more" size={16} color={colors.accent} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.mainScroll}
        contentContainerStyle={styles.mainScrollContent}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
        {...(Platform.OS === 'web' ? ({ scrollbarGutter: 'stable' } as object) : {})}
      >
      <View style={[styles.toolbar, descargasMenuOpen && styles.toolbarOnTop, { paddingLeft: Math.max(12, insets.left), paddingRight: Math.max(12, insets.right) }]}>
        <View style={[styles.filaPeriodo, shouldStackToolbar && styles.filaPeriodoStack]}>
          <SelectorRangoSemana
            from={fechaInicio}
            to={fechaFin}
            onChange={(f, t) => { setFechaInicio(f); setFechaFin(t); }}
          />
          <View style={styles.chipRowEstado}>
            {([
              { key: 'anterior' as const, label: 'Mes anterior', active: esMesAnterior, onPress: () => { const m = mesConOffset(-1); setFechaInicio(m.inicio); setFechaFin(m.fin); } },
              { key: 'actual' as const, label: 'Mes actual', active: esMesActual, onPress: () => { const m = mesEnCurso(); setFechaInicio(m.inicio); setFechaFin(m.fin); } },
              { key: 'proximo' as const, label: 'Mes próximo', active: esMesProximo, onPress: () => { const m = mesConOffset(1); setFechaInicio(m.inicio); setFechaFin(m.fin); } },
            ]).map(({ key, label, active, onPress }) => {
              const pastel = CHIP_MES_PASTEL[key];
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.estadoChip, { backgroundColor: active ? pastel.bgSel : pastel.bg, borderColor: active ? pastel.borderSel : pastel.border }]}
                  onPress={onPress}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.estadoChipText, { color: pastel.text }, active && styles.estadoChipTextSel]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={[styles.toolbarFilaUnica, shouldStackToolbar && styles.toolbarFilaUnicaStack]}>
          <View style={[styles.toolbarFiltros, shouldStackToolbar && styles.toolbarFiltrosStack]}>
            <View style={[styles.formGroup, !shouldStackToolbar && styles.formGroupCompact]}>
              <Text style={styles.formLabel}>Desde</Text>
              <InputFecha
                compact={!shouldStackToolbar}
                valueIso={fechaInicio}
                onChangeIso={setFechaInicio}
                placeholder="dd/mm/aaaa"
                style={shouldStackToolbar ? styles.formInput : styles.inputFechaToolbar}
              />
            </View>
            <View style={[styles.formGroup, !shouldStackToolbar && styles.formGroupCompact]}>
              <Text style={styles.formLabel}>Hasta</Text>
              <InputFecha
                compact={!shouldStackToolbar}
                valueIso={fechaFin}
                onChangeIso={setFechaFin}
                placeholder="dd/mm/aaaa"
                style={shouldStackToolbar ? styles.formInput : styles.inputFechaToolbar}
              />
            </View>
            <View style={[styles.formGroup, styles.formGroupWide, !shouldStackToolbar && styles.formGroupLocalCompact]}>
              <SelectorDesplegable
                label="Local"
                icono="store"
                placeholder="Selecciona un local"
                tituloLista="Selecciona un local"
                iconoLista="store"
                loading={loadingLocales}
                vacioTexto="No hay locales con AgoraCode."
                valorId={localSeleccionadoKey || null}
                opciones={localesDropdownOrdenados.map((loc) => {
                  const code = (loc.agoraCode ?? loc.AgoraCode ?? '').toString().trim();
                  const nom = (loc.nombre ?? loc.Nombre ?? code).toString().trim();
                  return {
                    id: String(loc.id_Locales ?? code),
                    titulo: nom || code || '—',
                    subtitulo: code ? `Código ${code}` : undefined,
                    icono: 'store' as const,
                  };
                })}
                onSeleccionar={(id) => {
                  const loc = localesDropdownOrdenados.find(
                    (l) => String(l.id_Locales ?? (l.agoraCode ?? l.AgoraCode ?? '').toString().trim()) === id,
                  );
                  if (loc) seleccionarLocalLista(loc);
                }}
              />
            </View>
            <TouchableOpacity
              style={[
                shouldStackToolbar ? styles.btnFiltrar : styles.btnFiltrarIcon,
                (generando || !localSeleccionado) && styles.btnFiltrarDisabled,
              ]}
              onPress={generar}
              disabled={generando || !localSeleccionado}
              accessibilityLabel="Recalcular"
            >
              {generando ? (
                <ActivityIndicator size="small" color={colors.surface} />
              ) : (
                <>
                  <MaterialIcons name="refresh" size={16} color={colors.surface} />
                  {shouldStackToolbar ? <Text style={styles.btnFiltrarText}>Recalcular</Text> : null}
                </>
              )}
            </TouchableOpacity>
          </View>

          {registros.length > 0 && localSeleccionado ? (
            <>
              {!shouldStackToolbar ? <View style={styles.toolbarDivider} /> : null}
              <View style={[styles.kpiRow, !shouldStackToolbar && styles.kpiRowInline]}>
                <KpiCard
                  compact={!shouldStackToolbar}
                  label="Facturado"
                  value={formatMoneda(registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length ? sumRealHoy : sumReal)}
                />
                <KpiCard
                  compact={!shouldStackToolbar}
                  label="Comparativa"
                  value={formatMoneda(registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length ? sumCompHoy : sumComp)}
                  color={colors.textMuted}
                />
                <KpiCard
                  compact={!shouldStackToolbar}
                  label="Desvío"
                  value={formatMoneda(registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length ? sumDesvioHoy : sumDesvio)}
                  color={colorDesvio(registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length ? sumDesvioHoy : sumDesvio).color}
                />
                <KpiCard
                  compact={!shouldStackToolbar}
                  label="% vs comp."
                  value={formatPctTicker(registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length ? desvioPctHoy : desvioPctTotal)}
                  color={(registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length ? tickerEstiloHoy : tickerEstilo).color}
                />
              </View>
            </>
          ) : null}
        </View>

        <Text style={styles.toolbarHint}>
          Periodo {formatFechaCorta(fechaInicio)} → {formatFechaCorta(fechaFin)} · {tituloWidgetPeriodo}
          {localSeleccionado ? ` · ${nombreLocal}` : ''}
          {registrosHastaAyer.length > 0 && registrosHastaAyer.length < registros.length
            ? ` · Acumulado hasta ${formatFechaCorta(ayerStr)}`
            : ''}
        </Text>
      </View>

      {error ? (
        <View style={[styles.errorBar, { marginLeft: Math.max(16, insets.left), marginRight: Math.max(16, insets.right) }]}>
          <Text style={styles.errorBarText}>{error}</Text>
        </View>
      ) : null}

      <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
        <View style={[styles.panelLista, !shouldStackPanels && styles.panelListaBorder]}>
          <View ref={widgetRef} collapsable={false} style={styles.panelListaInner}>
            <TouchableOpacity
              style={styles.visionGlobalHeader}
              onPress={() => setVisionGlobalAbierta((v) => !v)}
              activeOpacity={0.7}
            >
              <Text style={styles.visionGlobalTitle}>Visión global — {tituloWidgetPeriodo}</Text>
              <MaterialIcons name={visionGlobalAbierta ? 'expand-less' : 'expand-more'} size={22} color={colors.textMuted} />
            </TouchableOpacity>
            {!visionGlobalAbierta && localSeleccionado ? (
              <Text style={styles.visionGlobalCompact} numberOfLines={1}>
                Seleccionado: {nombreLocal}
                {(() => {
                  const item = localesObjetivos.find(
                    (i) => String(i.local.id_Locales ?? i.local.agoraCode ?? i.local.AgoraCode ?? '') === localSeleccionadoKey,
                  );
                  return item ? ` · ${formatPctTicker(item.desvioPctHastaAyer)}` : '';
                })()}
              </Text>
            ) : null}
            {visionGlobalAbierta ? (
              loadingLocalesObjetivos ? (
                <View style={styles.center}><ActivityIndicator size="small" color={colors.textMuted} /></View>
              ) : (
                <View style={styles.listContent}>
                  {agrupacionesCalculadas.map((grupo) => {
                    const ag = grupo.agrupacion;
                    const sumDesvioHastaAyer = grupo.sumRealHastaAyer - grupo.sumCompHastaAyer;
                    const estiloHastaAyer = estiloTicker(grupo.desvioPctHastaAyer);
                    const datosAlDia = grupo.encontrados > 0 && grupo.ultimaFechaConDatos >= ayerYYYYMMDD();
                    return (
                      <View key={ag.id} style={[styles.card, { borderLeftWidth: 3, borderLeftColor: ag.color }]}>
                        <View style={styles.cardHeader}>
                          <View style={styles.cardTitleWrap}>
                            <View style={[styles.dotSem, { backgroundColor: ag.color }]} />
                            <Text style={styles.cardTitle} numberOfLines={1}>{ag.nombre}</Text>
                            <View style={[styles.badge, { backgroundColor: estiloHastaAyer.backgroundColor, borderColor: estiloHastaAyer.color }]}>
                              <Text style={[styles.badgeText, { color: estiloHastaAyer.color }]}>{formatPctTicker(grupo.desvioPctHastaAyer)}</Text>
                            </View>
                          </View>
                          <View style={[styles.syncBadge, datosAlDia ? styles.syncBadgeOk : styles.syncBadgeWarn]}>
                            <MaterialIcons name={datosAlDia ? 'check-circle' : 'warning'} size={10} color={datosAlDia ? colors.success : colors.warning} />
                            <Text style={[styles.syncBadgeText, datosAlDia ? styles.syncBadgeTextOk : styles.syncBadgeTextWarn]} numberOfLines={1}>
                              {datosAlDia ? 'Actualizado' : grupo.ultimaFechaConDatos ? `Último: ${formatFechaCorta(grupo.ultimaFechaConDatos)}` : 'Sin datos'}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.cardBody}>
                          <View style={styles.cardField}>
                            <Text style={styles.cardFieldLabel}>Locales</Text>
                            <Text style={styles.cardFieldValue}>{grupo.totalLocales}</Text>
                          </View>
                          <View style={styles.cardField} {...{ dataSet: { captureHide: 'true' } }}>
                            <Text style={styles.cardFieldLabel}>Facturado</Text>
                            <Text style={styles.cardFieldValue}>{formatMoneda(grupo.sumRealHastaAyer)}</Text>
                          </View>
                          <View style={styles.cardField} {...{ dataSet: { captureHide: 'true' } }}>
                            <Text style={styles.cardFieldLabel}>Comparativa</Text>
                            <Text style={[styles.cardFieldValue, styles.cardFieldMuted]}>{formatMoneda(grupo.sumCompHastaAyer)}</Text>
                          </View>
                          <View style={styles.cardField}>
                            <Text style={styles.cardFieldLabel}>Desvío</Text>
                            <Text style={[styles.cardFieldValue, colorDesvio(sumDesvioHastaAyer)]}>{formatMoneda(sumDesvioHastaAyer)}</Text>
                          </View>
                        </View>
                      </View>
                    );
                  })}
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
                      const semColor = colorSemDesvio(item.desvioPctHastaAyer);
                      const estiloHastaAyer = estiloTicker(item.desvioPctHastaAyer);
                      const datosAlDia = item.ultimaFechaConDatos >= ayerYYYYMMDD();
                      const seleccionado = itemKey === localSeleccionadoKey;
                      return (
                        <TouchableOpacity
                          key={itemKey}
                          style={[styles.card, seleccionado && styles.cardActiva]}
                          onPress={() => seleccionarLocalLista(item.local)}
                          activeOpacity={0.7}
                        >
                          <View style={styles.cardHeader}>
                            <View style={styles.cardTitleWrap}>
                              <Text style={styles.cardTitle} numberOfLines={1}>{nom}</Text>
                              <View style={[styles.badge, { backgroundColor: estiloHastaAyer.backgroundColor, borderColor: estiloHastaAyer.color }]}>
                                <Text style={[styles.badgeText, { color: estiloHastaAyer.color }]}>{formatPctTicker(item.desvioPctHastaAyer)}</Text>
                              </View>
                              <View style={[styles.dotSem, { backgroundColor: semColor }]} />
                            </View>
                            <View style={[styles.syncBadge, datosAlDia ? styles.syncBadgeOk : styles.syncBadgeWarn]}>
                              <MaterialIcons name={datosAlDia ? 'check-circle' : 'warning'} size={10} color={datosAlDia ? colors.success : colors.warning} />
                              <Text style={[styles.syncBadgeText, datosAlDia ? styles.syncBadgeTextOk : styles.syncBadgeTextWarn]} numberOfLines={1}>
                                {datosAlDia ? 'OK' : item.ultimaFechaConDatos ? formatFechaCorta(item.ultimaFechaConDatos) : '—'}
                              </Text>
                            </View>
                          </View>
                          <View style={styles.cardBody}>
                            {rangosHastaAyer ? (
                              <View style={styles.cardFieldFull}>
                                <Text style={styles.cardFieldLabel}>Rango acumulado</Text>
                                <Text style={styles.cardFieldValue} numberOfLines={2}>
                                  Real {formatFechaCorta(rangosHastaAyer.fechaInicioMes)} → {formatFechaCorta(rangosHastaAyer.fechaFinRealHastaAyer)} · Comp. {formatFechaCorta(rangosHastaAyer.minCompHastaAyer)} → {formatFechaCorta(rangosHastaAyer.maxCompHastaAyer)}
                                </Text>
                              </View>
                            ) : null}
                            <View style={styles.cardField} {...{ dataSet: { captureHide: 'true' } }}>
                              <Text style={styles.cardFieldLabel}>Facturado</Text>
                              <Text style={styles.cardFieldValue}>{formatMoneda(item.sumRealHastaAyer)}</Text>
                            </View>
                            <View style={styles.cardField} {...{ dataSet: { captureHide: 'true' } }}>
                              <Text style={styles.cardFieldLabel}>Comparativa</Text>
                              <Text style={[styles.cardFieldValue, styles.cardFieldMuted]}>{formatMoneda(item.sumCompHastaAyer)}</Text>
                            </View>
                            <View style={styles.cardField}>
                              <Text style={styles.cardFieldLabel}>Desvío</Text>
                              <Text style={[styles.cardFieldValue, colorDesvio(sumDesvioHastaAyer)]}>{formatMoneda(sumDesvioHastaAyer)}</Text>
                            </View>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  {localesObjetivos.length === 0 ? (
                    <View style={styles.emptyWrap}>
                      <MaterialIcons name="store" size={40} color={colors.borderStrong} />
                      <Text style={styles.emptyText}>No hay datos de locales para este periodo.</Text>
                    </View>
                  ) : null}
                </View>
              )
            ) : null}
          </View>
        </View>

        <View style={[styles.panelDetalle, shouldStackPanels && styles.panelDetalleStack]}>
          {!localSeleccionado ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="touch-app" size={40} color={colors.borderStrong} />
              <Text style={styles.emptyText}>Selecciona un local en la lista o en el filtro superior.</Text>
            </View>
          ) : registros.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="bar-chart" size={40} color={colors.borderStrong} />
              <Text style={styles.emptyText}>No hay registros para {nombreLocal}. Pulsa Recalcular.</Text>
            </View>
          ) : (
        <View style={styles.detailSection}>
          <View style={styles.detailHeader}>
            <Text style={styles.detailTitle}>Detalle — {nombreLocal}</Text>
            <View style={styles.detailTabsRow}>
              {(['tabla', 'medias'] as const).map((tabId) => {
                const pastel = CHIP_TAB_PASTEL[tabId];
                const sel = detalleTab === tabId;
                const label = tabId === 'tabla' ? 'Tabla diaria' : 'Media por día';
                return (
                  <TouchableOpacity
                    key={tabId}
                    style={[styles.estadoChip, { backgroundColor: sel ? pastel.bgSel : pastel.bg, borderColor: sel ? pastel.borderSel : pastel.border }]}
                    onPress={() => setDetalleTab(tabId)}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.estadoChipText, { color: sel ? pastel.textSel : pastel.text }, sel && styles.estadoChipTextSel]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
              {detalleTab === 'medias' && (
                <TouchableOpacity style={styles.detailTabInfo} onPress={() => setMediasAyudaOpen((v) => !v)}>
                  <MaterialIcons name="info-outline" size={18} color={colors.textMuted} />
                </TouchableOpacity>
              )}
              {detalleTab === 'tabla' && (
                <TouchableOpacity style={styles.exportTablaBtn} onPress={abrirHorasModal} accessibilityLabel="Ventas por horas">
                  <MaterialIcons name="schedule" size={16} color={statusColors.info.text} />
                  <Text style={styles.exportTablaBtnText}>Por horas</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {detalleTab === 'medias' ? (
            <View style={[styles.widget, styles.mediasPorDiaWidget, isNarrow && styles.widgetNarrow]}>
              {mediasAyudaOpen && (
                <Text style={styles.mediasPorDiaHint}>
                  Media real: solo días con fecha ≤ {formatFechaCorta(corteMediasReal)} (mínimo entre fin de periodo y ayer). Comparativa:
                  todo el periodo ({formatFechaCorta(fechaInicio)} → {formatFechaCorta(fechaFin)}). La real agrupa por día de la semana de la fecha; la comparativa por el
                  día de la semana de la fecha de comparación. Entre paréntesis: días que entran en cada media.
                </Text>
              )}
              <View style={styles.mediasPorDiaHeader}>
                <Text style={[styles.mediasPorDiaHeaderCell, styles.mediasPorDiaColDia]}>Día</Text>
                <Text style={[styles.mediasPorDiaHeaderCell, styles.mediasPorDiaColNum]}>Media real</Text>
                <Text style={[styles.mediasPorDiaHeaderCell, styles.mediasPorDiaColNum]}>Media comparativa</Text>
              </View>
              {mediasPorDiaSemana.map((row) => {
                const variacion = row.nReal > 0 && row.nComp > 0 ? variacionPctMediasVsComp(row.mediaReal, row.mediaComp) : null;
                return (
                  <View key={row.label} style={styles.mediasPorDiaRow}>
                    <Text style={[styles.mediasPorDiaCell, styles.mediasPorDiaColDia, styles.mediasPorDiaDiaNegrita]}>{row.label}</Text>
                    <View style={styles.mediasPorDiaRealWrap}>
                      <Text style={[styles.mediasPorDiaCell, styles.mediasPorDiaRealAmount]} numberOfLines={2}>
                        {row.nReal === 0 ? '—' : `${formatMoneda(row.mediaReal)} (${row.nReal})`}
                      </Text>
                      {variacion != null ? (
                        <View style={[styles.mediasPorDiaVarBadge, variacion.up ? styles.mediasPorDiaVarBadgeUp : styles.mediasPorDiaVarBadgeDown]}>
                          <Text style={[styles.mediasPorDiaVarText, variacion.up ? styles.mediasPorDiaVarTextUp : styles.mediasPorDiaVarTextDown]}>
                            {variacion.up ? '+' : ''}{variacion.pct.toFixed(1)}%
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={[styles.mediasPorDiaCell, styles.mediasPorDiaColNum]}>
                      {row.nComp === 0 ? '—' : `${formatMoneda(row.mediaComp)} (${row.nComp})`}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : (
        <View style={styles.tableOuterNoHScroll}>
            <View style={styles.tableWithProgress}>
              <View style={styles.progressSection}>
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
              </View>
          <View style={styles.table}>
            <View style={styles.rowHeader}>
              {OBJETIVOS_TABLA_HEADERS_UI.map((h, i) => (
                <Text
                  key={h}
                  style={[
                    styles.cellHeader,
                    i === 0 ? styles.cellDia : i === 1 || i === 2 ? styles.cellFecha : i === 3 ? styles.cellFestivo : i === 4 ? styles.cellNombre : i === 8 ? styles.cellPct : styles.cellMoneda,
                  ]}
                >
                  {h}
                </Text>
              ))}
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
              <View style={styles.cellPctWrapper}>
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
            <View style={styles.tableBodyScrollContent}>
            {registros.map((r, idx) => (
                <View
                  key={idx}
                  style={[styles.row, r.Fecha === fechaJornadaNegocio && styles.rowJornadaActual]}
                >
                  <Text style={[styles.cell, styles.cellDia]}>{diaVirtual(r.Fecha, r.FechaComparacion)}</Text>
                  <Text style={[styles.cell, styles.cellFecha, styles.cellBold]} numberOfLines={1}>{formatFechaCorta(r.Fecha)}</Text>
                <Text style={[styles.cell, styles.cellFecha]} numberOfLines={1}>{formatFechaCorta(r.FechaComparacion)}</Text>
                <Text style={[styles.cell, styles.cellFestivo]}>{r.Festivo ? 'Sí' : 'No'}</Text>
                  <View style={[styles.cell, styles.cellNombre]}>
                    {(r.NombreFestivo || r.NombreFestivoComparacion) ? (
                      <View style={styles.nombreFestivoStack}>
                        {r.NombreFestivo ? (
                          <View style={styles.nombreFestivoBadge}>
                            <Text style={styles.nombreFestivoText} numberOfLines={1}>
                              {formatFechaCorta(r.Fecha)} · {r.NombreFestivo}
                            </Text>
                          </View>
                        ) : null}
                        {r.NombreFestivoComparacion ? (
                          <View style={styles.nombreFestivoBadgeComp}>
                            <Text style={styles.nombreFestivoTextComp} numberOfLines={1}>
                              {formatFechaCorta(r.FechaComparacion)} · {r.NombreFestivoComparacion}
                            </Text>
                          </View>
                        ) : null}
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
            </View>
          </View>
          </View>
        </View>
          )}
        </View>
          )}
        </View>
      </View>

      </ScrollView>

      <Modal visible={descargasMenuOpen} transparent animationType="fade" onRequestClose={() => setDescargasMenuOpen(false)}>
        <Pressable style={styles.shareOverlay} onPress={() => setDescargasMenuOpen(false)}>
          <Pressable onPress={() => {}}>
            <View style={styles.shareMenu}>
              <Text style={styles.exportMenuTitle}>Descargas</Text>
              <TouchableOpacity
                style={styles.shareMenuItem}
                disabled={localesObjetivos.length === 0 || capturing}
                onPress={handleShareResumenWhatsApp}
              >
                <MaterialIcons name="insights" size={16} color="#25d366" />
                <View style={styles.shareMenuItemTextCol}>
                  <Text style={styles.shareMenuText}>Resumen WhatsApp</Text>
                  <Text style={styles.shareMenuHint}>KPIs, tops y consecución por local</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.shareMenuItem}
                disabled={localesObjetivos.length === 0 || capturing}
                onPress={handleShareListadoWhatsApp}
              >
                <MaterialIcons name="picture-as-pdf" size={16} color="#25d366" />
                <View style={styles.shareMenuItemTextCol}>
                  <Text style={styles.shareMenuText}>Listado WhatsApp (PDF)</Text>
                  <Text style={styles.shareMenuHint}>Informe visual con barras por zona</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.shareMenuItem}
                disabled={localesObjetivos.length === 0 || capturing}
                onPress={handleCopiarResumenTexto}
              >
                <MaterialIcons name="content-copy" size={16} color={colors.textMuted} />
                <View style={styles.shareMenuItemTextCol}>
                  <Text style={styles.shareMenuText}>Copiar resumen texto</Text>
                  <Text style={styles.shareMenuHint}>Pegar directamente en WhatsApp</Text>
                </View>
              </TouchableOpacity>
              <View style={styles.shareMenuDivider} />
              <TouchableOpacity style={styles.shareMenuItem} onPress={() => { setDescargasMenuOpen(false); handleShareJPG(); }}>
                <MaterialIcons name="image" size={16} color={colors.accent} />
                <Text style={styles.shareMenuText}>Captura pantalla (JPG)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.shareMenuItem} onPress={() => { setDescargasMenuOpen(false); handleSharePDF(); }}>
                <MaterialIcons name="picture-as-pdf" size={16} color={colors.danger} />
                <Text style={styles.shareMenuText}>Captura pantalla (PDF)</Text>
              </TouchableOpacity>
              {registros.length > 0 && (
                <>
                  <View style={styles.shareMenuDivider} />
                  <TouchableOpacity style={styles.shareMenuItem} onPress={() => { setDescargasMenuOpen(false); exportarTablaObjetivosExcel(); }}>
                    <MaterialIcons name="table-chart" size={16} color={colors.success} />
                    <Text style={styles.shareMenuText}>Detalle Excel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.shareMenuItem} onPress={() => { setDescargasMenuOpen(false); exportarTablaObjetivosPDF(); }}>
                    <MaterialIcons name="picture-as-pdf" size={16} color={colors.danger} />
                    <Text style={styles.shareMenuText}>Detalle PDF</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.shareMenuItem} onPress={() => { setDescargasMenuOpen(false); handleOpenMassDownload(); }}>
                    <MaterialIcons name="download-for-offline" size={16} color="#7c3aed" />
                    <Text style={styles.shareMenuText}>Descarga masiva PDF</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <AgrupacionesObjetivosModal
        visible={agrupModalOpen}
        onClose={() => setAgrupModalOpen(false)}
        locales={locales}
        agrupaciones={agrupaciones}
        onGuardar={guardarAgrupacion}
        onBorrar={borrarAgrupacion}
      />

      <Modal visible={showMassDownload} transparent animationType="fade" onRequestClose={() => !massDownloading && setShowMassDownload(false)}>
        <Pressable style={styles.shareOverlay} onPress={() => !massDownloading && setShowMassDownload(false)}>
          <Pressable onPress={() => {}} style={styles.massModal}>
            <Text style={styles.massTitle}>Descarga masiva de PDF</Text>
            <Text style={styles.massSubtitle}>
              Periodo: {formatFechaCorta(fechaInicio)} → {formatFechaCorta(fechaFin)} · {tituloWidgetPeriodo}
            </Text>
            <View style={styles.massSelectAllRow}>
              <TouchableOpacity style={styles.massCheckRow} onPress={toggleMassAll} disabled={massDownloading}>
                <MaterialIcons
                  name={massSelectedLocals.size === localesDropdownOrdenados.length ? 'check-box' : 'check-box-outline-blank'}
                  size={20}
                  color={massSelectedLocals.size === localesDropdownOrdenados.length ? colors.accent : colors.textMuted}
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
                  <TouchableOpacity key={code} style={styles.massCheckRow} onPress={() => toggleMassLocal(code)} disabled={massDownloading}>
                    <MaterialIcons name={checked ? 'check-box' : 'check-box-outline-blank'} size={20} color={checked ? colors.accent : colors.borderStrong} />
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
              <TouchableOpacity style={styles.massCancelBtn} onPress={() => !massDownloading && setShowMassDownload(false)} disabled={massDownloading}>
                <Text style={styles.massCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.massDownloadBtn, (massSelectedLocals.size === 0 || massDownloading) && styles.massDownloadBtnDisabled]}
                onPress={handleMassDownload}
                disabled={massSelectedLocals.size === 0 || massDownloading}
              >
                {massDownloading ? (
                  <ActivityIndicator size="small" color={colors.surface} />
                ) : (
                  <>
                    <MaterialIcons name="download" size={16} color={colors.surface} />
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

      <Modal visible={horasModalOpen} transparent animationType="fade" onRequestClose={() => setHorasModalOpen(false)}>
        <Pressable style={styles.shareOverlay} onPress={() => setHorasModalOpen(false)}>
          <Pressable onPress={() => {}} style={styles.horasModal}>
            <View style={styles.horasHeader}>
              <Text style={styles.horasTitle}>Ventas por horas — {nombreLocal}</Text>
              <TouchableOpacity onPress={() => setHorasModalOpen(false)} accessibilityLabel="Cerrar">
                <MaterialIcons name="close" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={styles.horasSelectoresRow}>
              <View style={styles.horasSelectorGroup}>
                <SelectorDesplegable
                  label="Día"
                  icono="calendar-today"
                  placeholder="Selecciona un día"
                  tituloLista="Selecciona un día"
                  iconoLista="calendar-today"
                  valorId={horasFechaSel}
                  opciones={registros.map((r) => ({
                    id: r.Fecha,
                    titulo: `${diaSemanaLargo(r.Fecha)} · ${formatFechaCorta(r.Fecha)}`,
                    subtitulo: `comparativa ${formatFechaCorta(r.FechaComparacion)}`,
                    badge: diaSemana(r.Fecha),
                  }))}
                  onSeleccionar={(id) => setHorasFechaSel(id)}
                />
              </View>
              <View style={styles.horasSelectorGroup}>
                <SelectorDesplegable
                  label="Plantilla de franjas"
                  icono="view-timeline"
                  placeholder="Selecciona una plantilla"
                  tituloLista="Selecciona una plantilla"
                  iconoLista="view-timeline"
                  valorId={plantillaSelId}
                  vacioTexto="Aún no hay plantillas de franjas."
                  vacioAccion={{ texto: 'Crear plantilla', onPress: () => { setHorasModalOpen(false); router.push('/cajas/franjas-horarias'); } }}
                  opciones={plantillas.map((p) => {
                    const preview = p.franjas.slice(0, 3).map((f) => `${f.desde}–${f.hasta}`).join('  ·  ');
                    return {
                      id: p.plantillaId,
                      titulo: p.nombre,
                      subtitulo: `${p.franjas.length} ${p.franjas.length === 1 ? 'franja' : 'franjas'}${preview ? ` · ${preview}${p.franjas.length > 3 ? '…' : ''}` : ''}`,
                      icono: 'schedule' as const,
                    };
                  })}
                  onSeleccionar={(id) => setPlantillaSelId(id)}
                />
              </View>
            </View>

            <TouchableOpacity style={styles.horasGestionarLink} onPress={() => { setHorasModalOpen(false); router.push('/cajas/franjas-horarias'); }}>
              <MaterialIcons name="settings" size={13} color={colors.accent} />
              <Text style={styles.horasGestionarText}>Gestionar plantillas de franjas</Text>
            </TouchableOpacity>

            {horasError ? (
              <Text style={styles.errorText}>{horasError}</Text>
            ) : horasLoading ? (
              <ActivityIndicator size="small" color={colors.accent} style={{ marginVertical: 20 }} />
            ) : !filaHorasSel || !plantillaSel ? (
              <Text style={styles.horasHint}>Elige un día y una plantilla para ver el desglose por franjas.</Text>
            ) : filasFranja && filasFranja.length > 0 ? (
              <ScrollView style={styles.horasTablaScroll} nestedScrollEnabled>
                <View style={styles.horasTablaHeader}>
                  <Text style={[styles.horasHeaderCell, styles.horasColFranja]}>Franja</Text>
                  <Text style={[styles.horasHeaderCell, styles.horasColNum]}>Real</Text>
                  <Text style={[styles.horasHeaderCell, styles.horasColNum]}>Comparativa</Text>
                  <Text style={[styles.horasHeaderCell, styles.horasColNum]}>Desvío</Text>
                  <Text style={[styles.horasHeaderCell, styles.horasColPct]}>%</Text>
                </View>
                {filasFranja.map((f, i) => (
                  <View key={i} style={styles.horasTablaRow}>
                    <Text style={[styles.horasCell, styles.horasColFranja, styles.cellBold]} numberOfLines={1}>{f.label}</Text>
                    <Text style={[styles.horasCell, styles.horasColNum]}>{formatMoneda(f.real)}</Text>
                    <Text style={[styles.horasCell, styles.horasColNum]}>{formatMoneda(f.comparativa)}</Text>
                    <Text style={[styles.horasCell, styles.horasColNum, colorDesvio(f.desvio)]}>{formatMoneda(f.desvio)}</Text>
                    <Text style={[styles.horasCell, styles.horasColPct, colorDesvio(f.desvioPct)]}>{formatPctTicker(f.desvioPct)}</Text>
                  </View>
                ))}
                {horasMeta ? (
                  <View style={styles.horasTotalRow}>
                    <Text style={[styles.horasCell, styles.horasColFranja, styles.cellBold]}>Total día</Text>
                    <Text style={[styles.horasCell, styles.horasColNum, styles.cellBold]}>{formatMoneda(horasMeta.totalReal)}</Text>
                    <Text style={[styles.horasCell, styles.horasColNum, styles.cellBold]}>{formatMoneda(horasMeta.totalComp)}</Text>
                    <Text style={[styles.horasCell, styles.horasColNum]} />
                    <Text style={[styles.horasCell, styles.horasColPct]} />
                  </View>
                ) : null}
              </ScrollView>
            ) : (
              <Text style={styles.horasHint}>La plantilla seleccionada no tiene franjas.</Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <View style={styles.shareCaptureHost} pointerEvents="none">
        {shareCaptureProps ? (
          <View ref={shareExportRef} collapsable={false}>
            <ObjetivosShareExport {...shareCaptureProps} />
          </View>
        ) : null}
      </View>

    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { padding: 24, alignItems: 'center', justifyContent: 'center' },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: SPACING.md, paddingHorizontal: 24 },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: SPACING.md,
  },
  backBtn: { padding: SPACING.xs },
  headerTitle: { flex: 1, fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
  outlineBtnPurple: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADIO_MEDIO,
    backgroundColor: '#f5f3ff', borderWidth: 1, borderColor: '#ddd6fe',
  },
  outlineBtnPurpleText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: '#7c3aed' },
  outlineBtnBlue: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accentMuted, borderWidth: 1, borderColor: '#bae6fd',
  },
  outlineBtnBlueText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },

  toolbar: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    position: 'relative' as const,
    zIndex: 1,
  },
  toolbarOnTop: { zIndex: 50, ...(Platform.OS !== 'web' ? { elevation: 24 } : {}) },
  filaPeriodo: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm },
  filaPeriodoStack: { flexDirection: 'column', alignItems: 'stretch' },
  filaFechas: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, alignItems: 'flex-end' },
  filaFechasStack: { flexDirection: 'column', alignItems: 'stretch' },
  toolbarFilaUnica: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    flexWrap: 'wrap',
  },
  toolbarFilaUnicaStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: SPACING.sm,
  },
  toolbarFiltros: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: SPACING.sm,
    alignItems: 'flex-end',
    flexShrink: 1,
    minWidth: 0,
  },
  toolbarFiltrosStack: {
    flexWrap: 'wrap',
    alignItems: 'stretch',
  },
  toolbarDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: colors.border,
    marginVertical: 2,
    marginHorizontal: 4,
    flexShrink: 0,
  },
  formGroupCompact: { flex: 0, minWidth: 136, maxWidth: 148 },
  formGroupLocalCompact: { flex: 1, minWidth: 130, maxWidth: 200 },
  btnFiltrarIcon: {
    width: 40,
    height: 40,
    borderRadius: RADIO_MEDIO,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    flexShrink: 0,
  },
  formGroupWide: { flex: 2, minWidth: 180 },
  btnFiltrar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.accent, paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: RADIO_MEDIO, minHeight: 40, alignSelf: 'flex-end',
  },
  btnFiltrarDisabled: { opacity: 0.65 },
  btnFiltrarText: { color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, fontSize: fontSizes[13] },
  toolbarHint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, lineHeight: 16 },

  chipRowEstado: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  estadoChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: SPACING.xs, borderRadius: radius.lg, borderWidth: 1,
  },
  estadoChipText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  estadoChipTextSel: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },

  errorBar: {
    marginTop: SPACING.sm, paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.sm,
    backgroundColor: statusColors.danger.bg, borderWidth: 1, borderColor: '#fecaca',
  },
  errorBarText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger },

  split: { flexDirection: 'row', alignSelf: 'stretch' },
  splitStack: { flexDirection: 'column' },
  panelLista: { flex: 1, minWidth: 0, alignSelf: 'stretch' },
  panelListaBorder: { borderRightWidth: 1, borderRightColor: colors.border, maxWidth: 480 },
  panelListaInner: { alignSelf: 'stretch' },
  panelDetalle: {
    flex: 1.2, minWidth: 320, backgroundColor: colors.surface, padding: 14, alignSelf: 'stretch',
  },
  panelDetalleStack: { flex: 1, minWidth: 0, borderTopWidth: 1, borderTopColor: colors.border },

  listContent: { padding: SPACING.md, gap: 10, paddingBottom: 24 },

  visionGlobalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  visionGlobalTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  visionGlobalCompact: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm, backgroundColor: colors.surface },

  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cardActiva: { borderColor: '#7dd3fc', backgroundColor: colors.accentMuted },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.navActive, gap: SPACING.sm,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, flexShrink: 1 },
  badge: { paddingHorizontal: SPACING.sm, paddingVertical: 2, borderRadius: radius.md, borderWidth: 1 },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  dotSem: { width: 8, height: 8, borderRadius: radius.sm, flexShrink: 0 },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: SPACING.sm },
  cardField: { minWidth: 84, marginRight: SPACING.sm },
  cardFieldFull: { width: '100%', marginRight: 0, marginBottom: SPACING.xs },
  cardFieldLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary },
  cardFieldMuted: { color: colors.textMuted },

  mainScroll: { flex: 1 },
  mainScrollContent: { flexGrow: 1, paddingBottom: 24 },
  mainRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', width: '100%' },
  mainRowNarrow: { flexDirection: 'column' },
  /** Panel formulario + widget mes (~40% del ancho; más ancho que antes) */
  leftColumn: {
    flexDirection: 'column',
    gap: SPACING.md,
    flex: 4,
    minWidth: 300,
    maxWidth: 420,
    flexShrink: 0,
  },
  leftColumnNarrow: {
    flex: 0,
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    alignSelf: 'stretch',
  },
  widget: {
    backgroundColor: colors.bg,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'flex-start',
  },
  /** Misma anchura que el resto de widgets de la columna izquierda */
  widgetGenerarComparativa: { alignSelf: 'stretch' },
  widgetNarrow: { alignSelf: 'stretch' },
  /** Tabla comparativa: ~60% del ancho en fila (flex 4 + 6) */
  tableWrapper: { flex: 6, minWidth: 0, flexShrink: 1 },
  tableWrapperNarrow: { flex: 0, width: '100%', minWidth: 0, alignSelf: 'stretch' },
  tableOuterNoHScroll: { width: '100%', minWidth: 0, flex: 1 },
  widgetTitle: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: SPACING.md },
  formRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'flex-end' },
  formGroup: { flex: 1, minWidth: 120 },
  formGroupNarrow: { maxWidth: 320 },
  formLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: SPACING.xs, textTransform: 'uppercase', letterSpacing: 0.3 },
  formInput: {
    fontFamily: fontFamily.regular, fontSize: fontSizes[12],
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    minHeight: 40,
  },
  inputFechaToolbar: {
    width: 136,
    minWidth: 136,
    height: 40,
    minHeight: 40,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  formInputDisabled: { backgroundColor: colors.navActive, color: colors.textMuted },
  btnGenerar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.accent,
    paddingVertical: SPACING.xs,
    paddingHorizontal: 10,
    borderRadius: 5,
  },
  btnGenerarDisabled: { opacity: 0.7 },
  btnGenerarText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  controlBar: { alignSelf: 'stretch', marginBottom: SPACING.md, position: 'relative' as const, zIndex: 1 },
  controlBarOnTop: { zIndex: 50, ...(Platform.OS !== 'web' ? { elevation: 24 } : {}) },
  contentBelow: { position: 'relative' as const, zIndex: 0 },
  sectionLabel: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  controlPeriodRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm },
  chipMes: {
    paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14, // entre radius.lg (12) y radius.xl (16)
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipMesOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipMesText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  chipMesTextOn: { color: colors.surface },
  controlActionsRow: { alignItems: 'center', marginTop: SPACING.xs },
  agrupBtnOutline: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADIO_MEDIO,
    backgroundColor: '#f5f3ff', borderWidth: 1, borderColor: '#ddd6fe',
  },
  agrupBtnOutlineText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: '#7c3aed' },
  descargasAnchor: { position: 'relative' as const },
  descargasBtn: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accentMuted, borderWidth: 1, borderColor: '#bae6fd',
  },
  descargasBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.accent },
  btnRefresh: {
    width: 36, height: 36, borderRadius: RADIO_MEDIO, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accentMuted, borderWidth: 1, borderColor: '#bae6fd',
  },
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kpiRowInline: {
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 'auto',
    flexWrap: 'nowrap',
    gap: SPACING.md,
    minWidth: 280,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    ...(Platform.OS === 'web' ? ({ marginLeft: 'auto' } as object) : {}),
  },
  kpiCard: {
    flex: 1, minWidth: 88, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIO_MEDIO, paddingHorizontal: SPACING.sm, paddingVertical: 6,
  },
  kpiCardCompact: {
    flex: 0,
    flexShrink: 0,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
    minWidth: 72,
    alignItems: 'flex-end',
  },
  kpiLabel: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase' },
  kpiLabelCompact: { textAlign: 'right' as const },
  kpiValue: { fontVariant: ['tabular-nums'], fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginTop: 2 },
  kpiValueCompact: { fontVariant: ['tabular-nums'], fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, marginTop: 1, textAlign: 'right' as const },
  detailSection: { alignSelf: 'stretch' },
  detailHeader: { marginBottom: SPACING.sm },
  detailTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginBottom: SPACING.sm },
  detailTabsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  detailTabInfo: { padding: 6 },
  localesListItemSelected: {
    borderWidth: 2, borderColor: colors.accent, backgroundColor: colors.accentMuted,
  },
  widgetLocales: { alignSelf: 'stretch', minHeight: 48, marginTop: 0, position: 'relative' as const, zIndex: 0 },
  widgetLocalesHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  widgetLocalesTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  widgetLocalesActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  agrupBtn: {
    padding: 6,
    borderRadius: RADIO_MEDIO,
    backgroundColor: '#f5f3ff',
    borderWidth: 1,
    borderColor: '#ddd6fe',
  },
  agrupacionesWrap: { marginBottom: SPACING.xs },
  agrupacionItem: {
    borderLeftWidth: 3,
    paddingLeft: SPACING.sm,
    backgroundColor: '#fafafa',
    borderRadius: radius.sm,
    marginBottom: 6,
  },
  agrupacionNombreWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, marginRight: SPACING.sm },
  agrupacionDot: { width: 10, height: 10, borderRadius: 5 },
  agrupacionNombre: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, flexShrink: 1 },
  agrupacionMeta: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  shareWrap: { position: 'relative', zIndex: 50 },
  shareBtn: {
    padding: 6,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  shareOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.3)' },
  shareMenu: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 200,
    ...(Platform.OS === 'web' && { boxShadow: '0 8px 24px rgba(0,0,0,0.15)' } as object),
  },
  shareMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
  },
  shareMenuItemTextCol: { flex: 1, minWidth: 0 },
  shareMenuHint: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: colors.textMuted, marginTop: 1 },
  shareCaptureHost: {
    position: 'absolute',
    left: -12000,
    top: 0,
    zIndex: -1,
  },
  shareMenuText: { fontSize: fontSizes[12], color: colors.textPrimary, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  shareMenuDivider: { height: 1, backgroundColor: colors.navActive },
  widgetLocalesLoader: { marginVertical: 20 },
  localesListWrap: {},
  localesListItem: {
    marginBottom: 0,
    paddingBottom: 10,
    paddingTop: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  localesListHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.xs },
  localesListNombre: { fontSize: fontSizes[12], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.textPrimary, flex: 1, marginRight: SPACING.sm },
  localesListPct: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight },
  localesListProgressTrack: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  localesListProgressFill: {
    height: '100%',
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  localesListProgressTrackSecondary: {
    marginTop: SPACING.xs,
  },
  localesListProgressFillSecondary: {
    backgroundColor: colors.textMuted,
  },
  localesListHastaAyerInfo: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: SPACING.xs,
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
    gap: SPACING.xs,
  },
  localesListValorLabel: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  localesListValorNum: { fontVariant: ['tabular-nums'], fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  localesListValorSecundario: { color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  syncBadgeOk: { backgroundColor: statusColors.success.bg },
  syncBadgeWarn: { backgroundColor: statusColors.warning.bg },
  syncBadgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  syncBadgeTextOk: { color: colors.success },
  syncBadgeTextWarn: { color: colors.warning },
  localesListHastaAyerLabel: { fontSize: typography.etiqueta.fontSize, color: colors.textPrimary, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  localesListHastaAyerRangoWrap: { position: 'relative' as const, alignSelf: 'flex-start', flexShrink: 0 },
  localesListHastaAyerRango: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, maxWidth: 200 },
  localesListRangoTooltip: {
    position: 'absolute' as const,
    bottom: '100%',
    left: 0,
    marginBottom: SPACING.xs,
    backgroundColor: '#fef08a',
    borderWidth: 1,
    borderColor: '#eab308',
    borderRadius: radius.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    zIndex: 1000,
    maxWidth: 320,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 8,
  },
  localesListRangoTooltipText: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: colors.textPrimary, lineHeight: 16 },
  tickerBadgeSmall: { paddingHorizontal: 6, paddingVertical: 2 },
  tableWithProgress: { width: '100%', alignSelf: 'stretch', minWidth: 0 },
  progressSection: { marginBottom: SPACING.sm },
  progressLocalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  progressLocalTextCol: { flex: 1, minWidth: 0 },
  exportTablaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: '#bae6fd',
    flexShrink: 0,
  },
  exportTablaBtnDisabled: { opacity: 0.55 },
  exportTablaBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  exportTablaBtnTextDisabled: { color: colors.textMuted },
  exportMenuTitle: {
    fontSize: typography.etiqueta.fontSize,
    fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: SPACING.md,
    paddingTop: 10,
    paddingBottom: SPACING.xs,
  },
  progressLocalName: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  progressRegistrosCount: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontStyle: 'italic' },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  progressHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  progressLabel: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  progressPct: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  progressRestanteBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: radius.sm,
  },
  progressRestanteAlcanzado: { backgroundColor: '#d1fae5' },
  progressRestantePendiente: { backgroundColor: statusColors.warning.bg },
  progressRestanteText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  progressTrack: {
    height: 14,
    backgroundColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, marginBottom: SPACING.sm },
  table: {
    width: '100%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    overflow: 'hidden',
    backgroundColor: colors.surface,
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
    alignItems: 'center',
    width: '100%',
    backgroundColor: colors.border,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
  },
  cellHeader: {
    fontSize: typography.etiqueta.fontSize,
    fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight,
    color: colors.textPrimary,
    paddingVertical: SPACING.xs,
    paddingHorizontal: 3,
    flexShrink: 1,
  },
  rowSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    backgroundColor: colors.navActive,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cellSummary: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, paddingVertical: 3, paddingHorizontal: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  /** Fila cuyo campo Fecha coincide con la jornada de negocio actual (corte 09:30, como arqueo de caja). */
  rowJornadaActual: {
    backgroundColor: colors.accentMuted,
    borderLeftWidth: 3,
    borderLeftColor: colors.accentPressed,
  },
  cell: { fontSize: fontSizes.badge, color: colors.textPrimary, paddingVertical: 3, paddingHorizontal: 6, lineHeight: 14 },
  cellBold: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  /** Anchos flex para caber en pantalla sin scroll horizontal */
  cellDia: { flex: 1, minWidth: 38, flexShrink: 1 },
  cellFecha: { flex: 1.15, minWidth: 52, flexShrink: 1 },
  cellFestivo: { flex: 0.7, minWidth: 34, flexShrink: 1 },
  cellNombre: { flex: 1.4, minWidth: 56, flexShrink: 1 },
  cellText: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: colors.textPrimary, lineHeight: 14 },
  nombreFestivoStack: { gap: 2, alignSelf: 'flex-start' },
  nombreFestivoBadge: {
    backgroundColor: '#fce7f3',
    paddingHorizontal: SPACING.xs,
    paddingVertical: 1,
    borderRadius: 3,
    alignSelf: 'flex-start',
  },
  nombreFestivoText: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: '#9d174d', lineHeight: 13 },
  nombreFestivoBadgeComp: {
    backgroundColor: statusColors.warning.bg,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 1,
    borderRadius: 3,
    alignSelf: 'flex-start',
  },
  nombreFestivoTextComp: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: statusColors.warning.text, lineHeight: 13 },
  cellMoneda: { fontVariant: ['tabular-nums'], flex: 1.1, minWidth: 52, flexShrink: 1, textAlign: 'right' },
  cellPct: { flex: 0.9, minWidth: 40, flexShrink: 1, textAlign: 'right' },
  cellPctWrapper: {
    flex: 0.9,
    minWidth: 40,
    flexShrink: 1,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingVertical: 2,
  },
  tickerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    alignSelf: 'flex-end',
    gap: 2,
  },
  massModal: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
  },
  massTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginBottom: SPACING.xs },
  massSubtitle: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginBottom: SPACING.md },
  massSelectAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: SPACING.xs,
  },
  massSelectAllText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginLeft: SPACING.sm },
  massCountText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },
  massListScroll: { maxHeight: 260, marginBottom: SPACING.md },
  massCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.xs,
    gap: SPACING.sm,
  },
  massLocalName: { fontSize: fontSizes[12], color: colors.textPrimary },
  massLocalNameSelected: { color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  massProgressWrap: { marginBottom: SPACING.md },
  massProgressBarBg: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden', marginBottom: SPACING.xs },
  massProgressBarFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 3 },
  massProgressText: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, textAlign: 'center' },
  massActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  massCancelBtn: { paddingVertical: 10, paddingHorizontal: SPACING.lg, borderRadius: RADIO_MEDIO, backgroundColor: colors.navActive },
  massCancelText: { fontSize: fontSizes[13], color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  massDownloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIO_MEDIO,
    backgroundColor: '#7c3aed',
  },
  massDownloadBtnDisabled: { opacity: 0.5 },
  massDownloadText: { fontSize: fontSizes[13], color: colors.surface, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  tickerText: { fontVariant: ['tabular-nums'], fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, letterSpacing: 0.2 },
  parcialBox: {
    marginTop: SPACING.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: SPACING.md,
    alignItems: 'center',
  },
  parcialTitle: {
    fontSize: fontSizes[12],
    fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight,
    color: colors.textMuted,
    marginBottom: SPACING.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  parcialRow: {
    flexDirection: 'row',
    gap: SPACING.lg,
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
  },
  parcialItem: {
    alignItems: 'center',
    minWidth: 80,
  },
  parcialLabel: {
    fontSize: fontSizes.badge,
    fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight,
    color: colors.textMuted,
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  parcialValue: { fontVariant: ['tabular-nums'],
    fontSize: fontSizes[14],
    fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight,
  },
  mediasPorDiaWidget: {
    alignSelf: 'stretch',
    marginTop: 0,
  },
  mediasPorDiaHint: {
    fontFamily: fontFamily.regular, fontSize: fontSizes.badge,
    color: colors.textMuted,
    marginBottom: 10,
    lineHeight: 14,
  },
  mediasPorDiaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 6,
    marginBottom: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 6,
  },
  mediasPorDiaHeaderCell: {
    fontSize: fontSizes.badge,
    fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  mediasPorDiaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
    gap: 6,
  },
  mediasPorDiaCell: {
    fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize,
    color: colors.textPrimary,
  },
  mediasPorDiaColDia: { width: 36, flexShrink: 0 },
  mediasPorDiaDiaNegrita: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  mediasPorDiaRealWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 5,
  },
  mediasPorDiaRealAmount: { textAlign: 'right' as const, flexShrink: 1 },
  mediasPorDiaVarBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexShrink: 0,
  },
  mediasPorDiaVarBadgeUp: {
    backgroundColor: 'rgba(5, 150, 105, 0.14)',
    borderColor: 'rgba(5, 150, 105, 0.35)',
  },
  mediasPorDiaVarBadgeDown: {
    backgroundColor: 'rgba(220, 38, 38, 0.12)',
    borderColor: 'rgba(220, 38, 38, 0.35)',
  },
  mediasPorDiaVarText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  mediasPorDiaVarTextUp: { color: '#047857' },
  mediasPorDiaVarTextDown: { color: statusColors.danger.text },
  mediasPorDiaColNum: { fontVariant: ['tabular-nums'], flex: 1, minWidth: 0, textAlign: 'right' as const },
  horasModal: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 20,
    width: '100%',
    maxWidth: 620,
    maxHeight: '85%',
  },
  horasHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.md },
  horasTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, flex: 1, marginRight: SPACING.sm },
  horasSelectoresRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  horasSelectorGroup: { flex: 1, minWidth: 220 },
  horasGestionarLink: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: 10 },
  horasGestionarText: { fontSize: typography.etiqueta.fontSize, color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  horasHint: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, fontStyle: 'italic', marginVertical: 20, textAlign: 'center' },
  horasTablaScroll: { marginTop: SPACING.md, maxHeight: 360 },
  horasTablaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.border,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 6,
    gap: SPACING.xs,
  },
  horasHeaderCell: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  horasTablaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
    gap: SPACING.xs,
  },
  horasTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 6,
    backgroundColor: colors.bg,
    gap: SPACING.xs,
  },
  horasCell: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary },
  horasColFranja: { flex: 1.8, minWidth: 0 },
  horasColNum: { fontVariant: ['tabular-nums'], flex: 1.1, minWidth: 0, textAlign: 'right' as const },
  horasColPct: { flex: 0.8, minWidth: 0, textAlign: 'right' as const },
});
