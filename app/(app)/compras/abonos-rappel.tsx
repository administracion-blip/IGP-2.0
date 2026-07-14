import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { TablaBasica } from '../../components/TablaBasica';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { valorEnLocal } from '../../utils/valorEnLocal';
import { formatMoneda } from '../../utils/formatMoneda';
import { formatFecha, formatCreadoEn } from '../../utils/formatFecha';
import { apiFetch } from '../../utils/api';

type Local = Record<string, string | number | undefined>;
type FilaAbono = Record<string, string | number | undefined>;

export type ModoInforme = 'abonos' | 'ventas';

type ModoConfig = {
  modo: ModoInforme;
  titulo: string;
  subtitle: string;
  metricaCol: string;
  negativo: boolean;
  colorImporte: string;
  bannerBg: string;
  bannerBorder: string;
  bannerLabel: string;
  bannerValor: string;
  baseLabel: string;
  totalLabel: string;
  sheetName: string;
  filePrefix: string;
  pdfTitulo: string;
  pdfDesgloseFill: [number, number, number];
  emptyMsg: string;
  emptyFilterMsg: string;
  desgloseVacio: string;
  selectEmpresaMsg: string;
};

const MODO_CONFIG: Record<ModoInforme, ModoConfig> = {
  abonos: {
    modo: 'abonos',
    titulo: 'Abonos por rappel',
    subtitle: 'Lo que el almacén debe abonar al local por rappels, por periodo.',
    metricaCol: 'Abono',
    negativo: true,
    colorImporte: '#dc2626',
    bannerBg: '#fef2f2',
    bannerBorder: '#fecaca',
    bannerLabel: '#7f1d1d',
    bannerValor: '#dc2626',
    baseLabel: 'Base abono',
    totalLabel: 'Total con IVA incluido',
    sheetName: 'Abonos',
    filePrefix: 'abonos_rappel',
    pdfTitulo: 'Abonos por rappel',
    pdfDesgloseFill: [220, 38, 38],
    emptyMsg: 'No hay abonos por rappel en este periodo',
    emptyFilterMsg: 'Ninguna línea coincide con el filtro',
    desgloseVacio: 'Sin líneas con abono en el periodo',
    selectEmpresaMsg: 'Selecciona una empresa para ver sus abonos por rappel.',
  },
  ventas: {
    modo: 'ventas',
    titulo: 'Ventas por empresa',
    subtitle: 'Lo que el almacén central debe cobrar a la sociedad. El periodo se calcula por la fecha en que el almacén completó cada pedido.',
    metricaCol: 'Total',
    negativo: false,
    colorImporte: '#0369a1',
    bannerBg: '#eff6ff',
    bannerBorder: '#bfdbfe',
    bannerLabel: '#1e3a8a',
    bannerValor: '#0369a1',
    baseLabel: 'Base ventas',
    totalLabel: 'Total a cobrar (IVA incl.)',
    sheetName: 'Ventas',
    filePrefix: 'ventas_empresa',
    pdfTitulo: 'Ventas por empresa',
    pdfDesgloseFill: [3, 105, 161],
    emptyMsg: 'No hay ventas completadas en este periodo',
    emptyFilterMsg: 'Ninguna línea coincide con el filtro',
    desgloseVacio: 'Sin líneas de venta en el periodo',
    selectEmpresaMsg: 'Selecciona una empresa para ver sus ventas a cobrar.',
  },
};

const TODOS_LOCALES_ID = '__todos__';

function columnasModo(modo: ModoInforme, metricaCol: string): string[] {
  if (modo === 'ventas') {
    return ['Pedido', 'Local', 'CompletadoEn', 'Fecha', 'Producto', 'ID', 'IVA', 'Cantidad', metricaCol];
  }
  return ['Pedido', 'Local', 'Fecha', 'CreadoEn', 'Producto', 'ID', 'IVA', 'Cantidad', metricaCol];
}

function columnasExportModo(modo: ModoInforme, metricaCol: string): string[] {
  if (modo === 'ventas') {
    return ['Pedido', 'Local', 'Completado el', 'Fecha pedido', 'Producto', 'ID', 'IVA %', 'Cantidad', metricaCol, 'Cuota IVA', 'Total con IVA'];
  }
  return ['Pedido', 'Local', 'Fecha', 'Creado en', 'Producto', 'ID', 'IVA %', 'Cantidad', metricaCol, 'Cuota IVA', 'Total con IVA'];
}

function normalizarEmpresa(val: string | number | undefined | null): string {
  return String(val ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
const MESES = [
  { id: '', label: 'Año completo' },
  { id: '01', label: 'Ene' }, { id: '02', label: 'Feb' }, { id: '03', label: 'Mar' },
  { id: '04', label: 'Abr' }, { id: '05', label: 'May' }, { id: '06', label: 'Jun' },
  { id: '07', label: 'Jul' }, { id: '08', label: 'Ago' }, { id: '09', label: 'Sep' },
  { id: '10', label: 'Oct' }, { id: '11', label: 'Nov' }, { id: '12', label: 'Dic' },
];

function mesEnCurso(): string {
  return String(new Date().getMonth() + 1).padStart(2, '0');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type FilaDesgloseIva = {
  label: string;
  vatRate: number | null;
  base: number;
  cuotaIva: number;
  totalConIva: number;
};

function importeFila(item: FilaAbono): number {
  return Number(valorEnLocal(item, 'Importe') ?? valorEnLocal(item, 'TotalRappel') ?? 0);
}

function calcularDesgloseIva(items: FilaAbono[]): { filas: FilaDesgloseIva[]; totalBase: number; totalCuota: number; totalConIva: number } {
  const map = new Map<string, { vatRate: number | null; base: number; cuotaIva: number }>();
  for (const it of items) {
    const base = importeFila(it);
    // Incluye importes negativos (devoluciones): restan en el desglose.
    if (base === 0) continue;
    const vRaw = valorEnLocal(it, 'VatRate');
    const vatRate = vRaw != null && vRaw !== '' && !Number.isNaN(Number(vRaw)) ? Number(vRaw) : null;
    const key = vatRate != null ? String(vatRate) : 'none';
    const prev = map.get(key) ?? { vatRate, base: 0, cuotaIva: 0 };
    const cuota = vatRate != null ? round2(base * vatRate) : 0;
    map.set(key, {
      vatRate,
      base: round2(prev.base + base),
      cuotaIva: round2(prev.cuotaIva + cuota),
    });
  }
  const filas = Array.from(map.values())
    .map((g) => ({
      label: g.vatRate != null ? `IVA ${g.vatRate * 100}%` : 'Sin IVA',
      vatRate: g.vatRate,
      base: g.base,
      cuotaIva: g.cuotaIva,
      totalConIva: round2(g.base + g.cuotaIva),
    }))
    .sort((a, b) => {
      if (a.vatRate == null) return 1;
      if (b.vatRate == null) return -1;
      return a.vatRate - b.vatRate;
    });
  const totalBase = round2(filas.reduce((s, f) => s + f.base, 0));
  const totalCuota = round2(filas.reduce((s, f) => s + f.cuotaIva, 0));
  return { filas, totalBase, totalCuota, totalConIva: round2(totalBase + totalCuota) };
}

function formatImporte(val: number, negativo: boolean): string {
  // En abonos el importe se muestra como crédito (negativo); en ventas tal cual.
  // Una devolución llega con signo opuesto y se refleja correctamente.
  const signed = negativo ? -val : val;
  return formatMoneda(signed);
}

function importeNum(val: number, negativo: boolean): number {
  return negativo ? -val : val;
}

function exportFileSlug(nombre: string): string {
  return nombre.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 48) || 'local';
}

function periodoExportLabel(anio: string, mes: string): string {
  if (!mes) return anio;
  const m = MESES.find((x) => x.id === mes);
  return `${m?.label ?? mes}/${anio}`;
}

function ivaPctLabel(vatRate: number | null): string {
  if (vatRate == null) return '—';
  return `${vatRate * 100}%`;
}

function importesLinea(item: FilaAbono): { base: number; vatRate: number | null; cuotaIva: number; totalConIva: number } {
  const base = importeFila(item);
  const vRaw = valorEnLocal(item, 'VatRate');
  const vatRate = vRaw != null && vRaw !== '' && !Number.isNaN(Number(vRaw)) ? Number(vRaw) : null;
  const cuotaIva = vatRate != null ? round2(base * vatRate) : 0;
  return { base, vatRate, cuotaIva, totalConIva: round2(base + cuotaIva) };
}

function filaExportCeldas(item: FilaAbono, modo: ModoInforme, negativo: boolean): (string | number)[] {
  const { base, vatRate, cuotaIva, totalConIva } = importesLinea(item);
  const filaBase = [
    String(valorEnLocal(item, 'PedidoId') ?? ''),
    String(valorEnLocal(item, 'LocalNombre') ?? valorEnLocal(item, 'LocalId') ?? ''),
  ];
  const filaFechas = modo === 'ventas'
    ? [
        formatCreadoEn(valorEnLocal(item, 'CompletadoEn') as string | undefined),
        formatFecha(valorEnLocal(item, 'Fecha') as string | undefined),
      ]
    : [
        formatFecha(valorEnLocal(item, 'Fecha') as string | undefined),
        formatCreadoEn(valorEnLocal(item, 'CreadoEn') as string | undefined),
      ];
  return [
    ...filaBase,
    ...filaFechas,
    String(valorEnLocal(item, 'ProductoNombre') ?? valorEnLocal(item, 'ProductId') ?? ''),
    String(valorEnLocal(item, 'ProductId') ?? ''),
    vatRate != null ? round2(vatRate * 100) : '',
    Number(valorEnLocal(item, 'Cantidad') ?? 0),
    importeNum(base, negativo),
    importeNum(cuotaIva, negativo),
    importeNum(totalConIva, negativo),
  ];
}

function filaExportTexto(item: FilaAbono, modo: ModoInforme, negativo: boolean): string[] {
  const { base, vatRate, cuotaIva, totalConIva } = importesLinea(item);
  const filaBase = [
    String(valorEnLocal(item, 'PedidoId') ?? '—'),
    String(valorEnLocal(item, 'LocalNombre') ?? valorEnLocal(item, 'LocalId') ?? '—'),
  ];
  const filaFechas = modo === 'ventas'
    ? [
        formatCreadoEn(valorEnLocal(item, 'CompletadoEn') as string | undefined),
        formatFecha(valorEnLocal(item, 'Fecha') as string | undefined),
      ]
    : [
        formatFecha(valorEnLocal(item, 'Fecha') as string | undefined),
        formatCreadoEn(valorEnLocal(item, 'CreadoEn') as string | undefined),
      ];
  return [
    ...filaBase,
    ...filaFechas,
    String(valorEnLocal(item, 'ProductoNombre') ?? valorEnLocal(item, 'ProductId') ?? '—'),
    String(valorEnLocal(item, 'ProductId') ?? '—'),
    ivaPctLabel(vatRate),
    String(valorEnLocal(item, 'Cantidad') ?? 0),
    formatImporte(base, negativo),
    formatImporte(cuotaIva, negativo),
    formatImporte(totalConIva, negativo),
  ];
}

export function InformeImporteEmpresa({ modo }: { modo: ModoInforme }) {
  const cfg = MODO_CONFIG[modo];
  const COLUMNAS = useMemo(() => columnasModo(cfg.modo, cfg.metricaCol), [cfg.modo, cfg.metricaCol]);
  const COLUMNAS_EXPORT = useMemo(() => columnasExportModo(cfg.modo, cfg.metricaCol), [cfg.modo, cfg.metricaCol]);
  const router = useRouter();
  const { localPermitido } = useAuth();
  const { shouldStackToolbar, shouldStackPanels } = useBreakpoint();

  const [locales, setLocales] = useState<Local[]>([]);
  const [empresa, setEmpresa] = useState('');
  const [localId, setLocalId] = useState('');
  const anioActual = new Date().getFullYear();
  const [anio, setAnio] = useState(String(anioActual));
  const [mes, setMes] = useState(mesEnCurso);

  const [items, setItems] = useState<FilaAbono[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  useEffect(() => {
    apiFetch('/api/locales')
      .then((r) => r.json())
      .then((data) => {
        const all: Local[] = data.locales || [];
        setLocales(all.filter((l) => localPermitido(String(valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? '').trim())));
      })
      .catch(() => setLocales([]));
  }, [localPermitido]);

  // Empresas derivadas del campo `empresa` de los locales permitidos (enlace por nombre,
  // consistente con lo que guarda igp_Locales). Cada empresa lista sus locales.
  const empresas = useMemo(() => {
    const map = new Map<string, { nombre: string; locales: { id: string; nombre: string }[] }>();
    for (const l of locales) {
      const nombreEmpresa = String(valorEnLocal(l, 'empresa') ?? valorEnLocal(l, 'Empresa') ?? '').trim();
      if (!nombreEmpresa) continue;
      const key = normalizarEmpresa(nombreEmpresa);
      const idLoc = String(valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'Id_Locales') ?? valorEnLocal(l, 'Id') ?? '').trim();
      const nombreLoc = String(valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? idLoc).trim();
      if (!map.has(key)) map.set(key, { nombre: nombreEmpresa, locales: [] });
      if (idLoc) map.get(key)!.locales.push({ id: idLoc, nombre: nombreLoc || idLoc });
    }
    return Array.from(map.values())
      .map((e) => ({
        ...e,
        locales: e.locales.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })),
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
  }, [locales]);

  const localesDeEmpresa = useMemo(() => {
    if (!empresa) return [];
    const found = empresas.find((e) => normalizarEmpresa(e.nombre) === normalizarEmpresa(empresa));
    return found?.locales ?? [];
  }, [empresas, empresa]);

  const nombreLocalSel = useMemo(() => {
    if (!localId) return '';
    return localesDeEmpresa.find((l) => l.id === localId)?.nombre ?? localId;
  }, [localesDeEmpresa, localId]);

  const ambitoLabel = useMemo(
    () => (localId ? nombreLocalSel : 'Todos los locales'),
    [localId, nombreLocalSel],
  );

  const cargar = useCallback(() => {
    if (!empresa) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ empresa, anio, modo });
    if (localId) params.set('local', localId);
    if (mes) params.set('mes', mes);
    apiFetch(`/api/pedidos/abonos?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          setItems([]);
          return;
        }
        setItems(Array.isArray(data.items) ? data.items : []);
      })
      .catch((e) => setError(e.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [empresa, localId, anio, mes, modo]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const itemsFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      `${valorEnLocal(it, 'PedidoId') ?? ''} ${valorEnLocal(it, 'LocalNombre') ?? ''} ${valorEnLocal(it, 'ProductoNombre') ?? ''} ${valorEnLocal(it, 'ProductId') ?? ''}`.toLowerCase().includes(q),
    );
  }, [items, filtroBusqueda]);

  const desgloseIva = useMemo(() => calcularDesgloseIva(itemsFiltrados), [itemsFiltrados]);
  const hayFiltroBusqueda = filtroBusqueda.trim().length > 0;

  const getValorCelda = useCallback((item: FilaAbono, col: string): string => {
    if (col === 'Pedido') return String(valorEnLocal(item, 'PedidoId') ?? '—');
    if (col === 'Local') return String(valorEnLocal(item, 'LocalNombre') ?? valorEnLocal(item, 'LocalId') ?? '—');
    if (col === 'Fecha') return formatFecha(valorEnLocal(item, 'Fecha') as string | undefined);
    if (col === 'CompletadoEn') return formatCreadoEn(valorEnLocal(item, 'CompletadoEn') as string | undefined);
    if (col === 'CreadoEn') return formatCreadoEn(valorEnLocal(item, 'CreadoEn') as string | undefined);
    if (col === 'Producto') return String(valorEnLocal(item, 'ProductoNombre') ?? valorEnLocal(item, 'ProductId') ?? '—');
    if (col === 'ID') return String(valorEnLocal(item, 'ProductId') ?? '—');
    if (col === 'IVA') {
      const v = valorEnLocal(item, 'VatRate');
      if (v == null || v === '') return '—';
      const n = Number(v);
      return Number.isNaN(n) ? '—' : `${n * 100}%`;
    }
    if (col === 'Cantidad') return String(valorEnLocal(item, 'Cantidad') ?? 0);
    if (col === cfg.metricaCol) {
      return formatImporte(importeFila(item), cfg.negativo);
    }
    return '—';
  }, [cfg.metricaCol, cfg.negativo]);

  const anios = useMemo(() => [anioActual, anioActual - 1, anioActual - 2].map(String), [anioActual]);

  const opcionesAnio = useMemo(
    () => anios.map((a) => ({ id: a, titulo: a, icono: 'event' as const })),
    [anios],
  );

  const opcionesMes = useMemo(
    () => MESES.map((m) => ({
      id: m.id || '__all__',
      titulo: m.label,
      icono: 'date-range' as const,
    })),
    [],
  );

  const opcionesEmpresas = useMemo(
    () => empresas.map((e, idx) => ({ id: e.nombre || `emp-${idx}`, titulo: e.nombre || '—', icono: 'business' as const })),
    [empresas],
  );

  const opcionesLocales = useMemo(
    () => [
      { id: TODOS_LOCALES_ID, titulo: 'Todos los locales', icono: 'select-all' as const },
      ...localesDeEmpresa.map((loc) => ({ id: loc.id, titulo: loc.nombre || loc.id, icono: 'store' as const })),
    ],
    [localesDeEmpresa],
  );

  const periodoLabel = useMemo(() => periodoExportLabel(anio, mes), [anio, mes]);

  const exportarExcel = useCallback(() => {
    if (itemsFiltrados.length === 0) return;
    setExportMenuOpen(false);
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = exportFileSlug([empresa, localId ? nombreLocalSel : ''].filter(Boolean).join('_'));
    const periodoSlug = mes ? `${anio}_${mes}` : anio;
    const fname = `${cfg.filePrefix}_${slug}_${periodoSlug}_${stamp}.xlsx`;

    const meta: (string | number)[][] = [
      [cfg.titulo],
      ['Empresa', empresa],
      ['Ámbito', ambitoLabel],
      ['Periodo', periodoLabel],
      ...(hayFiltroBusqueda ? [['Filtro búsqueda', filtroBusqueda.trim()]] : []),
      ['Generado', new Date().toLocaleString('es-ES')],
      [cfg.baseLabel, importeNum(desgloseIva.totalBase, cfg.negativo)],
      ['Total cuota IVA', importeNum(desgloseIva.totalCuota, cfg.negativo)],
      [cfg.totalLabel, importeNum(desgloseIva.totalConIva, cfg.negativo)],
      [],
      ['Detalle'],
      [...COLUMNAS_EXPORT],
      ...itemsFiltrados.map((it) => filaExportCeldas(it, cfg.modo, cfg.negativo)),
      [],
      ['Desglose por IVA'],
      ['Tipo IVA', 'Base', 'Cuota IVA', 'Total con IVA'],
      ...desgloseIva.filas.map((f) => [
        f.label,
        importeNum(f.base, cfg.negativo),
        importeNum(f.cuotaIva, cfg.negativo),
        importeNum(f.totalConIva, cfg.negativo),
      ]),
      [
        'TOTAL',
        importeNum(desgloseIva.totalBase, cfg.negativo),
        importeNum(desgloseIva.totalCuota, cfg.negativo),
        importeNum(desgloseIva.totalConIva, cfg.negativo),
      ],
    ];

    const ws = XLSX.utils.aoa_to_sheet(meta);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cfg.sheetName);

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
          }),
        )
        .catch(() => {});
    }
  }, [
    cfg,
    itemsFiltrados,
    empresa,
    localId,
    nombreLocalSel,
    ambitoLabel,
    periodoLabel,
    hayFiltroBusqueda,
    filtroBusqueda,
    desgloseIva,
    anio,
    mes,
  ]);

  const exportarPDF = useCallback(async () => {
    if (itemsFiltrados.length === 0) return;
    setExportMenuOpen(false);
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = exportFileSlug([empresa, localId ? nombreLocalSel : ''].filter(Boolean).join('_'));
    const periodoSlug = mes ? `${anio}_${mes}` : anio;
    const fname = `${cfg.filePrefix}_${slug}_${periodoSlug}_${stamp}.pdf`;

    const { jsPDF: JsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    let y = 12;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text(cfg.pdfTitulo, 14, y);
    y += 6;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60);
    doc.text(`Empresa: ${empresa}`, 14, y);
    y += 4;
    doc.text(`Ámbito: ${ambitoLabel}`, 14, y);
    y += 4;
    doc.text(`Periodo: ${periodoLabel}`, 14, y);
    y += 4;
    if (hayFiltroBusqueda) {
      doc.text(`Filtro: ${filtroBusqueda.trim()}`, 14, y);
      y += 4;
    }
    doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
    y += 4;
    doc.text(`${cfg.baseLabel}: ${formatImporte(desgloseIva.totalBase, cfg.negativo)} · ${cfg.totalLabel}: ${formatImporte(desgloseIva.totalConIva, cfg.negativo)}`, 14, y);
    y += 6;
    doc.setTextColor(0);

    autoTable(doc, {
      startY: y,
      head: [[...COLUMNAS_EXPORT]],
      body: itemsFiltrados.map((it) => filaExportTexto(it, cfg.modo, cfg.negativo)),
      styles: { fontSize: 7 },
      headStyles: { fillColor: [14, 165, 233] },
      margin: { left: 14, right: 14 },
    });

    const afterDetalle = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    y = (afterDetalle?.finalY ?? y) + 8;

    autoTable(doc, {
      startY: y,
      head: [['Desglose por IVA', 'Base', 'Cuota IVA', 'Total con IVA']],
      body: [
        ...desgloseIva.filas.map((f) => [f.label, formatImporte(f.base, cfg.negativo), formatImporte(f.cuotaIva, cfg.negativo), formatImporte(f.totalConIva, cfg.negativo)]),
        ['TOTAL', formatImporte(desgloseIva.totalBase, cfg.negativo), formatImporte(desgloseIva.totalCuota, cfg.negativo), formatImporte(desgloseIva.totalConIva, cfg.negativo)],
      ],
      styles: { fontSize: 8 },
      headStyles: { fillColor: cfg.pdfDesgloseFill },
      margin: { left: 14, right: 14 },
    });

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
  }, [
    cfg,
    itemsFiltrados,
    empresa,
    localId,
    nombreLocalSel,
    ambitoLabel,
    periodoLabel,
    hayFiltroBusqueda,
    filtroBusqueda,
    desgloseIva,
    anio,
    mes,
  ]);

  const puedeExportar = Boolean(empresa) && !loading && itemsFiltrados.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Volver</Text>
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>{cfg.titulo}</Text>
          <Text style={styles.subtitle}>{cfg.subtitle}</Text>
        </View>
      </View>

      <View style={[styles.toolbarRow, shouldStackToolbar && styles.toolbarRowStack]}>
        <View style={styles.toolbarFieldEmpresa}>
          <SelectorDesplegable
            label="Empresa"
            placeholder="Seleccionar empresa"
            icono="business"
            tituloLista="Selecciona una empresa"
            iconoLista="business"
            buscador
            valorId={empresa || null}
            opciones={opcionesEmpresas}
            onSeleccionar={(id) => { setEmpresa(id); setLocalId(''); setExportMenuOpen(false); }}
          />
        </View>
        <View style={styles.toolbarFieldLocal}>
          <SelectorDesplegable
            label="Local"
            placeholder="Todos los locales"
            icono="store"
            tituloLista="Filtrar por local"
            iconoLista="store"
            buscador
            disabled={!empresa}
            valorId={localId || TODOS_LOCALES_ID}
            opciones={opcionesLocales}
            onSeleccionar={(id) => { setLocalId(id === TODOS_LOCALES_ID ? '' : id); setExportMenuOpen(false); }}
          />
        </View>
        <View style={styles.toolbarFieldAnio}>
          <SelectorDesplegable
            label="Año"
            placeholder="Año"
            icono="event"
            tituloLista="Selecciona el año"
            iconoLista="event"
            valorId={anio}
            opciones={opcionesAnio}
            onSeleccionar={(id) => { setAnio(id); setExportMenuOpen(false); }}
          />
        </View>
        <View style={styles.toolbarFieldMes}>
          <SelectorDesplegable
            label="Mes"
            placeholder="Mes"
            icono="date-range"
            tituloLista="Selecciona el mes"
            iconoLista="date-range"
            valorId={mes || '__all__'}
            opciones={opcionesMes}
            onSeleccionar={(id) => { setMes(id === '__all__' ? '' : id); setExportMenuOpen(false); }}
          />
        </View>
        <View style={styles.toolbarDescargas}>
          <Text style={styles.toolbarDescargasLabel}>Exportar</Text>
          <View style={styles.exportAnchor}>
            <TouchableOpacity
              style={[styles.exportMainBtn, !puedeExportar && styles.exportMainBtnDisabled]}
              onPress={() => setExportMenuOpen((o) => !o)}
              disabled={!puedeExportar}
              activeOpacity={0.7}
            >
              <MaterialIcons name="download" size={16} color={puedeExportar ? '#0ea5e9' : '#94a3b8'} />
              <Text style={[styles.exportMainBtnText, !puedeExportar && styles.exportMainBtnTextDisabled]}>Descargas</Text>
              <MaterialIcons name={exportMenuOpen ? 'expand-less' : 'expand-more'} size={16} color={puedeExportar ? '#0ea5e9' : '#94a3b8'} />
            </TouchableOpacity>
            {exportMenuOpen && puedeExportar ? (
              <>
                <Pressable style={styles.exportOverlay} onPress={() => setExportMenuOpen(false)} />
                <View style={styles.exportMenu}>
                  <TouchableOpacity style={styles.exportMenuItem} onPress={exportarExcel} activeOpacity={0.7}>
                    <MaterialIcons name="table-chart" size={16} color="#16a34a" />
                    <Text style={styles.exportMenuItemText}>Excel (.xlsx)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.exportMenuItem, styles.exportMenuItemLast]} onPress={exportarPDF} activeOpacity={0.7}>
                    <MaterialIcons name="picture-as-pdf" size={16} color="#dc2626" />
                    <Text style={styles.exportMenuItemText}>PDF (.pdf)</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </View>

      {empresa ? (
        <View style={[styles.totalBanner, shouldStackPanels && styles.totalBannerStack, { backgroundColor: cfg.bannerBg, borderColor: cfg.bannerBorder }]}>
          <View style={styles.totalBannerCol}>
            <Text style={[styles.totalLabel, { color: cfg.bannerLabel }]}>
              {cfg.baseLabel} · {ambitoLabel} ({periodoLabel})
              {hayFiltroBusqueda ? ' · filtrado' : ''}
            </Text>
            {loading ? (
              <ActivityIndicator size="small" color={cfg.bannerValor} />
            ) : (
              <Text style={[styles.totalValor, { color: cfg.bannerValor }]}>{formatImporte(desgloseIva.totalBase, cfg.negativo)}</Text>
            )}
          </View>
          <View style={[styles.totalBannerSep, shouldStackPanels && styles.totalBannerSepStack, { backgroundColor: cfg.bannerBorder }]} />
          <View style={styles.totalBannerCol}>
            <Text style={[styles.totalLabel, { color: cfg.bannerLabel }]}>{cfg.totalLabel}</Text>
            {loading ? (
              <ActivityIndicator size="small" color={cfg.bannerValor} />
            ) : (
              <Text style={[styles.totalValor, { color: cfg.bannerValor }]}>{formatImporte(desgloseIva.totalConIva, cfg.negativo)}</Text>
            )}
          </View>
        </View>
      ) : null}

      {!empresa ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>{cfg.selectEmpresaMsg}</Text>
        </View>
      ) : (
        <TablaBasica<FilaAbono>
          title={cfg.titulo}
          onBack={() => router.back()}
          hideHeader
          hideToolbarActions
          columnas={[...COLUMNAS]}
          datos={itemsFiltrados}
          getValorCelda={getValorCelda}
          loading={loading}
          error={error}
          onRetry={cargar}
          filtroBusqueda={filtroBusqueda}
          onFiltroChange={setFiltroBusqueda}
          selectedRowIndex={selectedRowIndex}
          onSelectRow={setSelectedRowIndex}
          onCrear={() => {}}
          onEditar={() => {}}
          onBorrar={() => {}}
          getColumnCellStyle={(col) => {
            if (col === 'ID') return { cell: { width: 64 } };
            if (col === 'IVA') return { cell: { width: 52 }, text: { textAlign: 'right' } };
            if (col === 'Cantidad') return { cell: { width: 60 }, text: { textAlign: 'right' } };
            if (col === cfg.metricaCol) return { cell: { width: 78 }, text: { color: cfg.colorImporte, fontWeight: '700', textAlign: 'right' } };
            return undefined;
          }}
          emptyMessage={cfg.emptyMsg}
          emptyFilterMessage={cfg.emptyFilterMsg}
          rightPanel={
            <View style={styles.desglosePanel}>
              <Text style={styles.desgloseTitulo}>Desglose por IVA</Text>
              {hayFiltroBusqueda ? (
                <Text style={styles.desgloseHint}>Según búsqueda y filtros activos</Text>
              ) : (
                <Text style={styles.desgloseHint}>Según empresa, local, año y mes seleccionados</Text>
              )}
              {loading ? (
                <ActivityIndicator size="small" color="#64748b" style={styles.desgloseLoader} />
              ) : desgloseIva.filas.length === 0 ? (
                <Text style={styles.desgloseVacio}>{cfg.desgloseVacio}</Text>
              ) : (
                <ScrollView style={styles.desgloseScroll} showsVerticalScrollIndicator>
                  {desgloseIva.filas.map((f) => (
                    <View key={f.label} style={styles.desgloseBloque}>
                      <Text style={styles.desgloseTipo}>{f.label}</Text>
                      <View style={styles.desgloseFila}>
                        <Text style={styles.desgloseEtq}>Base</Text>
                        <Text style={styles.desgloseImp}>{formatImporte(f.base, cfg.negativo)}</Text>
                      </View>
                      <View style={styles.desgloseFila}>
                        <Text style={styles.desgloseEtq}>Cuota IVA</Text>
                        <Text style={styles.desgloseImp}>{formatImporte(f.cuotaIva, cfg.negativo)}</Text>
                      </View>
                      <View style={styles.desgloseFila}>
                        <Text style={styles.desgloseEtqSub}>Subtotal</Text>
                        <Text style={[styles.desgloseImpSub, { color: cfg.colorImporte }]}>{formatImporte(f.totalConIva, cfg.negativo)}</Text>
                      </View>
                    </View>
                  ))}
                  <View style={styles.desgloseTotales}>
                    <View style={styles.desgloseFila}>
                      <Text style={styles.desgloseEtqTotal}>Total base</Text>
                      <Text style={styles.desgloseImpTotal}>{formatImporte(desgloseIva.totalBase, cfg.negativo)}</Text>
                    </View>
                    <View style={styles.desgloseFila}>
                      <Text style={styles.desgloseEtqTotal}>Total cuota IVA</Text>
                      <Text style={styles.desgloseImpTotal}>{formatImporte(desgloseIva.totalCuota, cfg.negativo)}</Text>
                    </View>
                    <View style={styles.desgloseFila}>
                      <Text style={[styles.desgloseEtqGrand, { color: cfg.bannerLabel }]}>Total con IVA</Text>
                      <Text style={[styles.desgloseImpGrand, { color: cfg.colorImporte }]}>{formatImporte(desgloseIva.totalConIva, cfg.negativo)}</Text>
                    </View>
                  </View>
                </ScrollView>
              )}
            </View>
          }
        />
      )}
    </View>
  );
}

export default function AbonosRappelScreen() {
  return <InformeImporteEmpresa modo="abonos" />;
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10 },
  backBtn: { paddingVertical: 4, paddingHorizontal: 8, marginTop: 2 },
  backText: { fontSize: 14, color: '#0ea5e9', fontWeight: '600' },
  headerTextWrap: { flex: 1, minWidth: 0 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    marginBottom: 12,
    zIndex: 50,
    flexWrap: 'wrap',
  },
  toolbarRowStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  toolbarFieldEmpresa: { flex: 1, minWidth: 160, maxWidth: 320 },
  toolbarFieldLocal: { flex: 1, minWidth: 150, maxWidth: 280 },
  toolbarFieldAnio: { width: 108, flexShrink: 0 },
  toolbarFieldMes: { width: 128, flexShrink: 0 },
  toolbarDescargas: { flexShrink: 0, alignItems: 'flex-start' },
  toolbarDescargasLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  exportAnchor: { position: 'relative' as const, zIndex: 60 },
  exportMainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#e0f2fe',
    minHeight: 46,
  },
  exportMainBtnDisabled: { borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  exportMainBtnText: { fontSize: 12, fontWeight: '700', color: '#0ea5e9' },
  exportMainBtnTextDisabled: { color: '#94a3b8' },
  exportOverlay: {
    ...Platform.select({
      web: { position: 'fixed' as const, left: 0, right: 0, top: 0, bottom: 0, zIndex: 39 },
      default: { position: 'absolute' as const, left: -2000, right: -2000, top: -2000, bottom: -2000 },
    }),
  },
  exportMenu: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    marginTop: 4,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    minWidth: 168,
    overflow: 'hidden',
    zIndex: 41,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }
      : { elevation: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.16, shadowRadius: 12 }),
  },
  exportMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  exportMenuItemLast: { borderBottomWidth: 0 },
  exportMenuItemText: { fontSize: 12, color: '#334155', fontWeight: '600' },
  totalBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
    gap: 16,
  },
  totalBannerStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  totalBannerCol: { flex: 1, gap: 4 },
  totalBannerSep: { width: 1, alignSelf: 'stretch', backgroundColor: '#fecaca' },
  totalBannerSepStack: {
    width: '100%',
    height: 1,
    alignSelf: 'stretch',
  },
  totalLabel: { fontSize: 12, fontWeight: '600', color: '#7f1d1d' },
  totalValor: { fontSize: 18, fontWeight: '800', color: '#dc2626' },
  desglosePanel: {
    flex: 1,
    minHeight: 200,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
  },
  desgloseTitulo: { fontSize: 14, fontWeight: '700', color: '#334155', marginBottom: 4 },
  desgloseHint: { fontSize: 11, color: '#94a3b8', marginBottom: 10 },
  desgloseLoader: { marginTop: 16 },
  desgloseVacio: { fontSize: 13, color: '#94a3b8', marginTop: 8 },
  desgloseScroll: { flex: 1 },
  desgloseBloque: {
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  desgloseTipo: { fontSize: 12, fontWeight: '700', color: '#475569', marginBottom: 6 },
  desgloseFila: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  desgloseEtq: { fontSize: 12, color: '#64748b' },
  desgloseImp: { fontSize: 12, color: '#334155', fontWeight: '500' },
  desgloseEtqSub: { fontSize: 12, color: '#64748b', fontWeight: '600' },
  desgloseImpSub: { fontSize: 12, color: '#dc2626', fontWeight: '700' },
  desgloseTotales: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: 2,
    borderTopColor: '#e2e8f0',
    gap: 4,
  },
  desgloseEtqTotal: { fontSize: 12, color: '#475569', fontWeight: '600' },
  desgloseImpTotal: { fontSize: 12, color: '#334155', fontWeight: '600' },
  desgloseEtqGrand: { fontSize: 13, color: '#7f1d1d', fontWeight: '700' },
  desgloseImpGrand: { fontSize: 15, color: '#dc2626', fontWeight: '800' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48 },
  emptyText: { fontSize: 14, color: '#94a3b8' },
});
