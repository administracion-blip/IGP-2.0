import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { formatMoneda } from '../../utils/formatMoneda';
import { formatFecha } from '../../utils/formatFecha';
import { InformeResumenRico } from './InformeResumenRico';

const C = {
  sky: '#0ea5e9',
  skyBg: '#e0f2fe',
  skySoft: '#f0f9ff',
  muted: '#94a3b8',
  slate: '#64748b',
  text: '#0f172a',
  textSec: '#475569',
  border: '#e2e8f0',
  borderSky: '#bae6fd',
  warningBg: '#fef3c7',
  warning: '#b45309',
  white: '#ffffff',
} as const;

const PAGE_SIZE = 50;
/** Filas por bloque de captura: 500 en un canvas petaba (Cocina / YTD). */
const PAGE_SIZE_PDF = 40;

function pdfAttrs(section: string): object {
  if (Platform.OS !== 'web') return {};
  return { dataSet: { pdfSection: section } } as object;
}

function pdfLocalAttrs(localId: string, localNombre: string): object {
  if (Platform.OS !== 'web') return {};
  return { dataSet: { pdfLocal: localId, pdfLocalNombre: localNombre } } as object;
}

export type ArticuloVentas = {
  productId?: string;
  nombre?: string;
  productName?: string;
  familyId?: string;
  familyName?: string;
  unidades?: number;
  importe?: number;
  pctImporte?: number;
  pctUnidades?: number;
};

export type FamiliaSubtotal = {
  familyId?: string;
  familyName?: string;
  unidades?: number;
  importe?: number;
  pctImporte?: number;
  pctUnidades?: number;
  numArticulos?: number;
};

export type DatosVentasPorArticulo = {
  meta?: {
    fechaDesde?: string;
    fechaHasta?: string;
    locales?: { localId?: string; nombre?: string }[];
    familiasFiltro?: string[];
    gruposAplicados?: { id?: string; nombre?: string }[];
    agruparPorLocal?: boolean;
    orden?: string;
    truncado?: boolean;
    generadoEn?: string;
  };
  totales?: {
    unidades?: number;
    importe?: number;
    numArticulos?: number;
    numFamilias?: number;
  };
  porFamilia?: FamiliaSubtotal[];
  articulos?: ArticuloVentas[];
  porLocal?: {
    localId?: string;
    nombre?: string;
    totales?: DatosVentasPorArticulo['totales'];
    articulos?: ArticuloVentas[];
    porFamilia?: FamiliaSubtotal[];
  }[];
  avisos?: string[];
};

type Props = {
  datos: DatosVentasPorArticulo;
  resumen?: string | null;
  modoPdf?: boolean;
};

export type LocalVentasPorArticulo = NonNullable<DatosVentasPorArticulo['porLocal']>[number];

function slugParte(valor: string, max: number): string {
  const s = String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^\w-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return (s || 'local').slice(0, max);
}

export function localVentasTieneDatos(loc: LocalVentasPorArticulo | null | undefined): boolean {
  if (!loc) return false;
  if ((loc.articulos || []).length > 0) return true;
  const u = Number(loc.totales?.unidades);
  const imp = Number(loc.totales?.importe);
  return (Number.isFinite(u) && u > 0) || (Number.isFinite(imp) && Math.abs(imp) > 0.001);
}

/** `{local}_Ventas_por_articulo_{desde}_{hasta}` */
export function slugPdfVentasArticuloLocal(
  localNombre: string,
  fechaDesde?: string,
  fechaHasta?: string,
): string {
  const local = slugParte(localNombre, 32);
  const d1 = String(fechaDesde || '').slice(0, 10);
  const d2 = String(fechaHasta || '').slice(0, 10);
  const rango = [d1, d2].filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).join('_');
  return [local, 'Ventas_por_articulo', rango].filter(Boolean).join('_');
}

function nombreArticulo(a: ArticuloVentas): string {
  return String(a.nombre || a.productName || a.productId || '—').trim() || '—';
}

function formatPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

function formatUnidades(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('es-ES', { maximumFractionDigits: 3 });
}

export function VistaVentasPorArticulo({ datos, resumen, modoPdf = false }: Props) {
  const { shouldStackPanels } = useBreakpoint();
  const [page, setPage] = useState(0);
  const [pageLocal, setPageLocal] = useState<Record<string, number>>({});

  const articulos = datos.articulos || [];
  const porFamilia = datos.porFamilia || [];
  const porLocalRaw = Array.isArray(datos.porLocal) ? datos.porLocal : [];
  const porLocal = modoPdf ? porLocalRaw.filter(localVentasTieneDatos) : porLocalRaw;
  const agruparPorLocal = Boolean(datos.meta?.agruparPorLocal && porLocal.length > 0);
  const totales = datos.totales;
  const avisos = [
    ...(Array.isArray(datos.avisos) ? datos.avisos : []),
  ].filter(Boolean);
  const meta = datos.meta;

  const pageSize = modoPdf ? PAGE_SIZE_PDF : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(articulos.length / pageSize));
  const pageSafe = modoPdf ? 0 : Math.min(page, totalPages - 1);

  const rangoFechas =
    meta?.fechaDesde || meta?.fechaHasta
      ? `${meta.fechaDesde ? formatFecha(meta.fechaDesde) : '—'} → ${meta.fechaHasta ? formatFecha(meta.fechaHasta) : '—'}`
      : null;

  const renderCabecera = (tituloExtra?: string) => (
    <View style={styles.cabecera} {...pdfAttrs(tituloExtra ? `cabecera-${tituloExtra}` : 'cabecera')}>
      <View style={styles.cabeceraIcon}>
        <MaterialIcons name="inventory-2" size={22} color="#0369a1" />
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={styles.cabeceraTitulo}>
          Ventas por artículo{tituloExtra ? ` · ${tituloExtra}` : ''}
        </Text>
        <View style={styles.cabeceraChips}>
          {rangoFechas ? (
            <View style={styles.metaChip}>
              <MaterialIcons name="date-range" size={13} color="#0369a1" />
              <Text style={styles.metaChipText}>{rangoFechas}</Text>
            </View>
          ) : null}
          {meta?.locales?.length && !tituloExtra ? (
            <View style={[styles.metaChip, styles.metaChipMuted]}>
              <MaterialIcons name="store" size={13} color={C.slate} />
              <Text style={styles.metaChipTextMuted}>
                {meta.locales.length === 1
                  ? meta.locales[0].nombre || '1 local'
                  : `${meta.locales.length} locales`}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );

  const renderKpis = (
    t: DatosVentasPorArticulo['totales'] | undefined,
    listaArts: ArticuloVentas[],
    sectionId: string,
  ) => {
    if (!t) return null;
    return (
      <View
        style={[styles.kpiRow, shouldStackPanels && styles.kpiRowStack]}
        {...pdfAttrs(sectionId)}
      >
        <View style={[styles.kpiCard, shouldStackPanels && styles.kpiCardStack]}>
          <Text style={styles.kpiLabel}>Artículos</Text>
          <Text style={styles.kpiValor}>
            {(t.numArticulos ?? listaArts.length).toLocaleString('es-ES')}
          </Text>
          {t.numFamilias != null ? (
            <Text style={styles.kpiSub}>
              {t.numFamilias.toLocaleString('es-ES')} familias
            </Text>
          ) : null}
        </View>
        <View style={[styles.kpiCard, shouldStackPanels && styles.kpiCardStack]}>
          <Text style={styles.kpiLabel}>Unidades</Text>
          <Text style={styles.kpiValor}>{formatUnidades(t.unidades)}</Text>
        </View>
        <View style={[styles.kpiCard, shouldStackPanels && styles.kpiCardStack]}>
          <Text style={styles.kpiLabel}>Importe</Text>
          <Text style={styles.kpiValorGrande}>{formatMoneda(t.importe)}</Text>
        </View>
      </View>
    );
  };

  const renderFilasArticulos = (lista: ArticuloVentas[], keyPrefix: string) => (
    <>
      <View style={styles.tablaHead}>
        <Text style={[styles.th, styles.colNombre]}>Artículo</Text>
        <Text style={[styles.th, styles.colFamArt]}>Familia</Text>
        <Text style={[styles.th, styles.colNum]}>Unid.</Text>
        <Text style={[styles.th, styles.colNum]}>Importe</Text>
        <Text style={[styles.th, styles.colPct]}>% unid.</Text>
        <Text style={[styles.th, styles.colPct]}>% imp.</Text>
      </View>
      {lista.map((a, i) => (
        <View
          key={`${keyPrefix}-${a.productId || i}`}
          style={[styles.tablaRow, i % 2 === 1 && styles.tablaRowAlt]}
        >
          <Text style={[styles.td, styles.colNombre]} numberOfLines={2}>
            {nombreArticulo(a)}
          </Text>
          <Text style={[styles.td, styles.colFamArt]} numberOfLines={1}>
            {a.familyName || 'Sin familia'}
          </Text>
          <Text style={[styles.td, styles.colNum]}>{formatUnidades(a.unidades)}</Text>
          <Text style={[styles.td, styles.colNum]}>{formatMoneda(a.importe)}</Text>
          <Text style={[styles.td, styles.colPct]}>{formatPct(a.pctUnidades)}</Text>
          <Text style={[styles.td, styles.colPct]}>{formatPct(a.pctImporte)}</Text>
        </View>
      ))}
    </>
  );

  const renderTablaArticulos = (
    lista: ArticuloVentas[],
    opts?: { keyPrefix?: string; pageKey?: string; pdfSectionBase?: string },
  ) => {
    const keyPrefix = opts?.keyPrefix || 'art';
    const pageKey = opts?.pageKey;
    const curPage = pageKey ? pageLocal[pageKey] || 0 : pageSafe;
    const pages = Math.max(1, Math.ceil(lista.length / pageSize));
    const safe = modoPdf ? 0 : Math.min(curPage, pages - 1);
    const sectionBase = opts?.pdfSectionBase || keyPrefix;

    if (lista.length === 0) {
      return <Text style={styles.vacio}>No hay artículos en el periodo seleccionado.</Text>;
    }

    if (modoPdf) {
      const chunks: ArticuloVentas[][] = [];
      for (let i = 0; i < lista.length; i += PAGE_SIZE_PDF) {
        chunks.push(lista.slice(i, i + PAGE_SIZE_PDF));
      }
      return (
        <>
          {chunks.map((chunk, ci) => (
            <View key={`${keyPrefix}-pdf-${ci}`} {...pdfAttrs(`${sectionBase}-${ci + 1}`)}>
              {renderFilasArticulos(chunk, `${keyPrefix}-${ci}`)}
            </View>
          ))}
        </>
      );
    }

    const rows = lista.slice(safe * pageSize, safe * pageSize + pageSize);

    return (
      <>
        {renderFilasArticulos(rows, keyPrefix)}
        {pages > 1 && pageKey ? (
          <View style={styles.paginacion}>
            <TouchableOpacity
              style={[styles.pageBtn, safe <= 0 && styles.pageBtnDisabled]}
              disabled={safe <= 0}
              onPress={() =>
                setPageLocal((prev) => ({ ...prev, [pageKey]: Math.max(0, safe - 1) }))
              }
            >
              <MaterialIcons name="chevron-left" size={18} color="#0369a1" />
              <Text style={styles.pageBtnText}>Anterior</Text>
            </TouchableOpacity>
            <Text style={styles.pageInfo}>
              {safe + 1} / {pages}
            </Text>
            <TouchableOpacity
              style={[styles.pageBtn, safe >= pages - 1 && styles.pageBtnDisabled]}
              disabled={safe >= pages - 1}
              onPress={() =>
                setPageLocal((prev) => ({
                  ...prev,
                  [pageKey]: Math.min(pages - 1, safe + 1),
                }))
              }
            >
              <Text style={styles.pageBtnText}>Siguiente</Text>
              <MaterialIcons name="chevron-right" size={18} color="#0369a1" />
            </TouchableOpacity>
          </View>
        ) : null}
      </>
    );
  };

  const renderAvisos = (sectionId: string) =>
    avisos.length > 0 ? (
      <View style={styles.avisosBox} {...pdfAttrs(sectionId)}>
        <MaterialIcons name="info-outline" size={16} color={C.warning} />
        <View style={{ flex: 1, gap: 4 }}>
          {avisos.map((a, i) => (
            <Text key={`aviso-${i}`} style={styles.avisoText}>
              {a}
            </Text>
          ))}
        </View>
      </View>
    ) : null;

  const renderResumen = (sectionId: string) =>
    resumen ? (
      <View style={styles.resumenBox} {...pdfAttrs(sectionId)}>
        <Text style={styles.resumenTitulo}>Resumen IA</Text>
        <InformeResumenRico texto={resumen} />
      </View>
    ) : null;

  return (
    <View style={styles.wrap}>
      {!(modoPdf && agruparPorLocal) ? (
        <>
          {renderCabecera()}
          {renderAvisos('avisos')}
          {renderResumen('resumen-ia')}
          {renderKpis(totales, articulos, 'kpis')}
        </>
      ) : null}

      {porFamilia.length > 0 && !agruparPorLocal ? (
        <View style={styles.bloque} {...pdfAttrs('familias')}>
          <Text style={styles.bloqueTitulo}>Subtotales por familia (orden uds.)</Text>
          <View style={styles.tablaHead}>
            <Text style={[styles.th, styles.colFam]}>Familia</Text>
            <Text style={[styles.th, styles.colNum]}>Arts.</Text>
            <Text style={[styles.th, styles.colNum]}>Unid.</Text>
            <Text style={[styles.th, styles.colNum]}>Importe</Text>
            <Text style={[styles.th, styles.colPct]}>% unid.</Text>
          </View>
          {porFamilia.map((f, i) => (
            <View
              key={f.familyId || `fam-${i}`}
              style={[styles.tablaRow, i % 2 === 1 && styles.tablaRowAlt]}
            >
              <Text style={[styles.td, styles.colFam]} numberOfLines={2}>
                {f.familyName || f.familyId || 'Sin familia'}
              </Text>
              <Text style={[styles.td, styles.colNum]}>
                {(f.numArticulos ?? 0).toLocaleString('es-ES')}
              </Text>
              <Text style={[styles.td, styles.colNum]}>{formatUnidades(f.unidades)}</Text>
              <Text style={[styles.td, styles.colNum]}>{formatMoneda(f.importe)}</Text>
              <Text style={[styles.td, styles.colPct]}>{formatPct(f.pctUnidades)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {agruparPorLocal ? (
        porLocal.map((loc) => {
          const lid = String(loc.localId || loc.nombre || 'local');
          const nombreLoc = String(loc.nombre || lid).trim() || lid;
          return (
            <View
              key={lid}
              style={[styles.bloque, modoPdf && styles.bloquePdfLocal]}
              {...pdfLocalAttrs(lid, nombreLoc)}
            >
              {modoPdf ? (
                <>
                  {renderCabecera(nombreLoc)}
                  {renderAvisos(`avisos-${lid}`)}
                  {renderResumen(`resumen-ia-${lid}`)}
                  {renderKpis(loc.totales, loc.articulos || [], `kpis-${lid}`)}
                </>
              ) : (
                <Text style={styles.bloqueTitulo}>
                  {nombreLoc}
                  {loc.totales?.unidades != null
                    ? ` · ${formatUnidades(loc.totales.unidades)} uds · ${formatMoneda(loc.totales.importe)}`
                    : ''}
                </Text>
              )}
              {renderTablaArticulos(loc.articulos || [], {
                keyPrefix: `loc-${lid}`,
                pageKey: lid,
                pdfSectionBase: `articulos-${lid}`,
              })}
            </View>
          );
        })
      ) : (
        <View style={styles.bloque} {...pdfAttrs('articulos-titulo')}>
          <Text style={styles.bloqueTitulo}>
            Artículos (orden uds.)
            {articulos.length > 0
              ? ` (${articulos.length.toLocaleString('es-ES')})`
              : ''}
          </Text>
          {renderTablaArticulos(articulos, { pageKey: undefined, pdfSectionBase: 'articulos' })}
          {!modoPdf && totalPages > 1 ? (
            <View style={styles.paginacion}>
              <TouchableOpacity
                style={[styles.pageBtn, pageSafe <= 0 && styles.pageBtnDisabled]}
                disabled={pageSafe <= 0}
                onPress={() => setPage((p) => Math.max(0, p - 1))}
              >
                <MaterialIcons name="chevron-left" size={18} color="#0369a1" />
                <Text style={styles.pageBtnText}>Anterior</Text>
              </TouchableOpacity>
              <Text style={styles.pageInfo}>
                {pageSafe + 1} / {totalPages}
              </Text>
              <TouchableOpacity
                style={[styles.pageBtn, pageSafe >= totalPages - 1 && styles.pageBtnDisabled]}
                disabled={pageSafe >= totalPages - 1}
                onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                <Text style={styles.pageBtnText}>Siguiente</Text>
                <MaterialIcons name="chevron-right" size={18} color="#0369a1" />
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    backgroundColor: C.skySoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.borderSky,
  },
  cabeceraIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.skyBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cabeceraTitulo: { fontSize: 16, fontWeight: '800', color: C.text },
  cabeceraChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: C.white,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: C.borderSky,
  },
  metaChipMuted: { borderColor: C.border, backgroundColor: '#f8fafc' },
  metaChipText: { fontSize: 11, color: '#0369a1', fontWeight: '600' },
  metaChipTextMuted: { fontSize: 11, color: C.slate, fontWeight: '600' },
  avisosBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    backgroundColor: C.warningBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  avisoText: { fontSize: 12, color: C.warning, lineHeight: 17 },
  resumenBox: {
    backgroundColor: '#fef9c3',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  resumenTitulo: { fontSize: 13, fontWeight: '800', color: '#854d0e' },
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kpiRowStack: { flexDirection: 'column' },
  kpiCard: {
    flex: 1,
    minWidth: 120,
    backgroundColor: C.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
  },
  kpiCardStack: { width: '100%', flex: undefined },
  kpiLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: C.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  kpiValor: { fontSize: 18, fontWeight: '800', color: C.text },
  kpiValorGrande: { fontSize: 18, fontWeight: '800', color: '#0369a1' },
  kpiSub: { fontSize: 11, color: C.muted, marginTop: 2 },
  bloque: {
    backgroundColor: C.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    padding: 10,
    gap: 6,
  },
  bloquePdfLocal: { gap: 12, padding: 12 },
  bloqueTitulo: {
    fontSize: 12,
    fontWeight: '800',
    color: C.textSec,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  tablaHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: '#f8fafc',
    borderRadius: 6,
  },
  tablaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  tablaRowAlt: { backgroundColor: C.skySoft },
  th: { fontSize: 10, fontWeight: '700', color: C.slate, textTransform: 'uppercase' },
  td: { fontSize: 12, color: C.text },
  colFam: { flex: 1.4, minWidth: 80 },
  colFamArt: { flex: 1, minWidth: 70 },
  colNombre: { flex: 1.6, minWidth: 90 },
  colNum: { width: 72, textAlign: 'right' },
  colPct: { width: 56, textAlign: 'right' },
  paginacion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  pageBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 6 },
  pageBtnDisabled: { opacity: 0.4 },
  pageBtnText: { fontSize: 12, color: '#0369a1', fontWeight: '600' },
  pageInfo: { fontSize: 12, color: C.slate, fontWeight: '600' },
  vacio: { fontSize: 12, color: C.muted, fontStyle: 'italic', paddingVertical: 6 },
});
