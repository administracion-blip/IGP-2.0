/**
 * Calendario de actuaciones: vista mes, semana (lunes inicio) o día (agenda del día).
 * En web: tooltip al pasar el ratón sobre un día con detalle de actuaciones.
 */
import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, Image } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { formatFecha } from '../../utils/formatFecha';
import { formatMoneda } from '../../utils/facturacion';
import { API_BASE_URL } from '../../utils/apiBaseUrl';

export type ActuacionCalItem = {
  id_actuacion: string;
  fecha: string;
  hora_inicio?: string;
  id_artista?: string;
  id_local?: string;
  local_nombre_snapshot?: string;
  artista_nombre_snapshot?: string;
  estado?: string;
  importe_final?: number | null;
  importe_previsto?: number | null;
};

const DIAS_SEMANA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const IS_WEB = Platform.OS === 'web';

function padIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Lunes de la semana ISO que contiene `d` */
export function inicioSemanaLunes(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function importeNumerico(a: ActuacionCalItem): number | null {
  if (a.importe_final != null && !Number.isNaN(Number(a.importe_final))) return Number(a.importe_final);
  if (a.importe_previsto != null && !Number.isNaN(Number(a.importe_previsto))) return Number(a.importe_previsto);
  return null;
}

/** Suma importes del día (final o previsto); null si ninguna actuación tiene importe */
function sumaImportesDia(list: ActuacionCalItem[]): number | null {
  let s = 0;
  let any = false;
  for (const a of list) {
    const v = importeNumerico(a);
    if (v != null) {
      s += v;
      any = true;
    }
  }
  return any ? s : null;
}

/** Agrupa por local y suma importes */
function resumenPorLocal(list: ActuacionCalItem[]): { key: string; nombre: string; suma: number | null }[] {
  const m = new Map<string, { nombre: string; suma: number; hasImp: boolean }>();
  for (const a of list) {
    const key = String(a.id_local || '__sin__');
    const nombre = (a.local_nombre_snapshot || a.id_local || 'Sin local').trim();
    const v = importeNumerico(a);
    if (!m.has(key)) m.set(key, { nombre, suma: 0, hasImp: false });
    const e = m.get(key)!;
    if (v != null) {
      e.suma += v;
      e.hasImp = true;
    }
  }
  return Array.from(m.entries()).map(([key, v]) => ({
    key,
    nombre: v.nombre,
    suma: v.hasImp ? v.suma : null,
  }));
}

function precioActuacion(a: ActuacionCalItem): string {
  if (a.importe_final != null && !Number.isNaN(Number(a.importe_final))) {
    return formatMoneda(Number(a.importe_final));
  }
  if (a.importe_previsto != null && !Number.isNaN(Number(a.importe_previsto))) {
    return formatMoneda(Number(a.importe_previsto));
  }
  return '—';
}

/** Orden ascendente por hora de inicio; sin hora al final; desempate por id */
function ordenarPorHoraAsc(list: ActuacionCalItem[]): ActuacionCalItem[] {
  return [...list].sort((a, b) => {
    const ha = String(a.hora_inicio || '').trim();
    const hb = String(b.hora_inicio || '').trim();
    if (!ha && !hb) return String(a.id_actuacion).localeCompare(String(b.id_actuacion));
    if (!ha) return 1;
    if (!hb) return -1;
    const t = ha.localeCompare(hb, undefined, { numeric: true });
    if (t !== 0) return t;
    return String(a.id_actuacion).localeCompare(String(b.id_actuacion));
  });
}

/** Tooltip: locales en orden alfabético; actuaciones por hora ascendente dentro de cada local */
function agruparActuacionesTooltipPorLocal(items: ActuacionCalItem[]): {
  key: string;
  nombre: string;
  items: ActuacionCalItem[];
  sumaLocal: number | null;
}[] {
  const m = new Map<string, { nombre: string; items: ActuacionCalItem[] }>();
  for (const a of items) {
    const key = String(a.id_local || '__sin__');
    const nombre = (a.local_nombre_snapshot || a.id_local || 'Sin local').trim();
    if (!m.has(key)) m.set(key, { nombre, items: [] });
    m.get(key)!.items.push(a);
  }
  return Array.from(m.entries())
    .map(([key, v]) => {
      const ordenados = ordenarPorHoraAsc(v.items);
      return {
        key,
        nombre: v.nombre,
        items: ordenados,
        sumaLocal: sumaImportesDia(ordenados),
      };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
}

type TooltipState = {
  iso: string;
  items: ActuacionCalItem[];
};

type Props = {
  actuaciones: ActuacionCalItem[];
};

export function ActuacionesCalendario({ actuaciones }: Props) {
  const hoy = useMemo(() => new Date(), []);
  const [vista, setVista] = useState<'mes' | 'semana' | 'dia'>('mes');
  const [mesY, setMesY] = useState(() => hoy.getFullYear());
  const [mesM, setMesM] = useState(() => hoy.getMonth());
  const [semanaInicio, setSemanaInicio] = useState(() => inicioSemanaLunes(hoy));
  /** Día mostrado en vista «Día» (medianoche local). */
  const [diaVista, setDiaVista] = useState(() => new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));
  const [dayTooltip, setDayTooltip] = useState<TooltipState | null>(null);
  /** Cache id_artista → URL prefirmada o null (sin imagen); solo vista día. */
  const [artistaImagenUrl, setArtistaImagenUrl] = useState<Record<string, string | null>>({});

  const porFecha = useMemo(() => {
    const m = new Map<string, ActuacionCalItem[]>();
    for (const a of actuaciones) {
      const k = String(a.fecha || '').slice(0, 10);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    for (const arr of m.values()) {
      arr.sort((x, y) => String(x.hora_inicio || '').localeCompare(String(y.hora_inicio || '')));
    }
    return m;
  }, [actuaciones]);

  const showDayTooltip = useCallback((iso: string, list: ActuacionCalItem[]) => {
    if (!IS_WEB || list.length === 0) return;
    setDayTooltip({ iso, items: list });
  }, []);

  const hideDayTooltip = useCallback(() => {
    setDayTooltip(null);
  }, []);

  const diasMesGrid = useMemo(() => {
    const first = new Date(mesY, mesM, 1);
    const last = new Date(mesY, mesM + 1, 0);
    const startPad = first.getDay() === 0 ? 6 : first.getDay() - 1;
    const daysInMonth = last.getDate();
    const cells: { date: Date | null; inMonth: boolean }[] = [];
    for (let i = 0; i < startPad; i++) {
      const d = addDays(first, -(startPad - i));
      cells.push({ date: d, inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: new Date(mesY, mesM, d), inMonth: true });
    }
    while (cells.length % 7 !== 0) {
      const lastCell = cells[cells.length - 1];
      const next = addDays(lastCell.date!, 1);
      cells.push({ date: next, inMonth: false });
    }
    return cells;
  }, [mesY, mesM]);

  const semanaDias = useMemo(() => {
    const out: Date[] = [];
    for (let i = 0; i < 7; i++) out.push(addDays(semanaInicio, i));
    return out;
  }, [semanaInicio]);

  const tituloMes = `${String(mesM + 1).padStart(2, '0')}/${mesY}`;
  const tituloSemana = `${formatFecha(padIso(semanaDias[0]))} – ${formatFecha(padIso(semanaDias[6]))}`;
  const tituloDia = useMemo(() => {
    const s = diaVista.toLocaleDateString('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }, [diaVista]);

  const isoDiaVista = useMemo(() => padIso(diaVista), [diaVista]);
  const actuacionesDiaOrdenadas = useMemo(() => {
    const list = porFecha.get(isoDiaVista) ?? [];
    return ordenarPorHoraAsc(list);
  }, [porFecha, isoDiaVista]);
  const totalDiaVista = useMemo(() => sumaImportesDia(actuacionesDiaOrdenadas), [actuacionesDiaOrdenadas]);

  const gruposDiaPorLocal = useMemo(
    () => agruparActuacionesTooltipPorLocal(actuacionesDiaOrdenadas),
    [actuacionesDiaOrdenadas],
  );

  useEffect(() => {
    if (vista !== 'dia') return;
    const ids = [
      ...new Set(
        actuacionesDiaOrdenadas.map((a) => String(a.id_artista || '').trim()).filter(Boolean),
      ),
    ];
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const updates: Record<string, string | null> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await fetch(`${API_BASE_URL}/api/artistas/${encodeURIComponent(id)}/imagen-url`);
            const d = (await r.json()) as { url?: string | null };
            updates[id] = d.url && typeof d.url === 'string' ? d.url : null;
          } catch {
            updates[id] = null;
          }
        }),
      );
      if (!cancelled) {
        setArtistaImagenUrl((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vista, isoDiaVista, actuacionesDiaOrdenadas]);

  const tooltipTotalDia = useMemo(
    () => (dayTooltip ? sumaImportesDia(dayTooltip.items) : null),
    [dayTooltip],
  );

  const tooltipGruposPorLocal = useMemo(
    () => (dayTooltip ? agruparActuacionesTooltipPorLocal(dayTooltip.items) : []),
    [dayTooltip],
  );

  const prevMes = useCallback(() => {
    if (mesM === 0) {
      setMesY((y) => y - 1);
      setMesM(11);
    } else setMesM((m) => m - 1);
  }, [mesM]);

  const nextMes = useCallback(() => {
    if (mesM === 11) {
      setMesY((y) => y + 1);
      setMesM(0);
    } else setMesM((m) => m + 1);
  }, [mesM]);

  const prevSemana = useCallback(() => setSemanaInicio((s) => addDays(s, -7)), []);
  const nextSemana = useCallback(() => setSemanaInicio((s) => addDays(s, 7)), []);

  const prevDia = useCallback(() => setDiaVista((d) => addDays(d, -1)), []);
  const nextDia = useCallback(() => setDiaVista((d) => addDays(d, 1)), []);

  const irHoyMes = useCallback(() => {
    setMesY(hoy.getFullYear());
    setMesM(hoy.getMonth());
  }, [hoy]);

  const irHoySemana = useCallback(() => setSemanaInicio(inicioSemanaLunes(hoy)), [hoy]);

  const irHoyDia = useCallback(() => {
    setDiaVista(new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));
  }, [hoy]);

  return (
    <View style={styles.root}>
      <View style={styles.modeRow}>
        <TouchableOpacity style={[styles.modeBtn, vista === 'mes' && styles.modeBtnOn]} onPress={() => setVista('mes')}>
          <Text style={[styles.modeBtnText, vista === 'mes' && styles.modeBtnTextOn]}>Mes</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.modeBtn, vista === 'semana' && styles.modeBtnOn]} onPress={() => setVista('semana')}>
          <Text style={[styles.modeBtnText, vista === 'semana' && styles.modeBtnTextOn]}>Semana</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.modeBtn, vista === 'dia' && styles.modeBtnOn]} onPress={() => setVista('dia')}>
          <Text style={[styles.modeBtnText, vista === 'dia' && styles.modeBtnTextOn]}>Día</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.navRow}>
        <TouchableOpacity
          onPress={vista === 'mes' ? prevMes : vista === 'semana' ? prevSemana : prevDia}
          hitSlop={8}
          style={styles.navIconBtn}
        >
          <MaterialIcons name="chevron-left" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <Text style={[styles.navTitle, vista === 'dia' && styles.navTitleDia]} numberOfLines={vista === 'dia' ? 2 : 1}>
          {vista === 'mes' ? tituloMes : vista === 'semana' ? tituloSemana : tituloDia}
        </Text>
        <TouchableOpacity
          onPress={vista === 'mes' ? nextMes : vista === 'semana' ? nextSemana : nextDia}
          hitSlop={8}
          style={styles.navIconBtn}
        >
          <MaterialIcons name="chevron-right" size={22} color="#0ea5e9" />
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={styles.hoyLink}
        onPress={vista === 'mes' ? irHoyMes : vista === 'semana' ? irHoySemana : irHoyDia}
        activeOpacity={0.7}
      >
        <Text style={styles.hoyLinkText}>Hoy</Text>
      </TouchableOpacity>

      {vista === 'mes' ? (
        <ScrollView style={styles.mesScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          <View style={styles.weekdayRow}>
            {DIAS_SEMANA.map((d) => (
              <Text key={d} style={styles.weekdayLbl}>
                {d}
              </Text>
            ))}
          </View>
          {Array.from({ length: Math.ceil(diasMesGrid.length / 7) }, (_, rowIdx) => (
            <View key={rowIdx} style={styles.mesFila}>
              {diasMesGrid.slice(rowIdx * 7, rowIdx * 7 + 7).map((cell, idx) => {
                const gidx = rowIdx * 7 + idx;
                const iso = cell.date ? padIso(cell.date) : '';
                const list = iso ? porFecha.get(iso) ?? [] : [];
                const esHoy =
                  cell.date &&
                  cell.date.getFullYear() === hoy.getFullYear() &&
                  cell.date.getMonth() === hoy.getMonth() &&
                  cell.date.getDate() === hoy.getDate();
                return (
                  <DiaMesCelda
                    key={gidx}
                    cell={cell}
                    iso={iso}
                    list={list}
                    esHoy={!!esHoy}
                    onShowTooltip={showDayTooltip}
                    onHideTooltip={hideDayTooltip}
                  />
                );
              })}
            </View>
          ))}
        </ScrollView>
      ) : vista === 'semana' ? (
        <ScrollView
          style={styles.semanaScroll}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.semanaScrollContent}
        >
          <View style={styles.semanaHorizontalContent}>
            <View style={styles.semanaRow}>
              {semanaDias.map((d, colIdx) => {
                const iso = padIso(d);
                const list = porFecha.get(iso) ?? [];
                const esHoy =
                  d.getFullYear() === hoy.getFullYear() &&
                  d.getMonth() === hoy.getMonth() &&
                  d.getDate() === hoy.getDate();
                const isLast = colIdx === semanaDias.length - 1;
                return (
                  <SemanaDiaColumna
                    key={iso}
                    d={d}
                    iso={iso}
                    list={list}
                    esHoy={esHoy}
                    isLast={isLast}
                    onShowTooltip={showDayTooltip}
                    onHideTooltip={hideDayTooltip}
                  />
                );
              })}
            </View>
          </View>
        </ScrollView>
      ) : (
        <ScrollView style={styles.diaScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          <View
            style={[
              styles.diaBloque,
              diaVista.getFullYear() === hoy.getFullYear() &&
                diaVista.getMonth() === hoy.getMonth() &&
                diaVista.getDate() === hoy.getDate() &&
                styles.diaBloqueHoy,
            ]}
          >
            <View style={styles.diaBloqueResumen}>
              <Text style={styles.diaBloqueResumenLbl}>Total del día</Text>
              {totalDiaVista != null ? (
                <Text style={styles.diaBloqueResumenVal}>{formatMoneda(totalDiaVista)}</Text>
              ) : (
                <Text style={styles.diaBloqueResumenVac}>—</Text>
              )}
            </View>
            {actuacionesDiaOrdenadas.length === 0 ? (
              <Text style={styles.diaVacio}>Sin actuaciones este día.</Text>
            ) : (
              gruposDiaPorLocal.map((grp, gIdx) => (
                <View key={grp.key} style={gIdx > 0 ? styles.diaGrupoSep : undefined}>
                  <View style={styles.diaGrupoHeader}>
                    <MaterialIcons name="place" size={14} color="#0369a1" />
                    <Text style={styles.diaGrupoNombre} numberOfLines={1}>
                      {grp.nombre}
                    </Text>
                    {grp.sumaLocal != null ? (
                      <Text style={styles.diaGrupoSuma}>{formatMoneda(grp.sumaLocal)}</Text>
                    ) : (
                      <Text style={styles.diaGrupoSumaMuted}>—</Text>
                    )}
                  </View>
                  {grp.items.map((a) => {
                    const idArt = String(a.id_artista || '').trim();
                    const imgUrl = idArt ? artistaImagenUrl[idArt] : null;
                    return (
                      <View key={a.id_actuacion} style={styles.diaFilaLinea}>
                        <Text style={styles.diaFilaHora}>{a.hora_inicio?.trim() || '—'}</Text>
                        <View style={styles.diaThumbWrap}>
                          {typeof imgUrl === 'string' && imgUrl.length > 0 ? (
                            <Image
                              source={{ uri: imgUrl }}
                              style={styles.diaThumb}
                              resizeMode="cover"
                              accessibilityLabel="Foto artista"
                            />
                          ) : (
                            <View style={styles.diaThumbPlaceholder}>
                              <MaterialIcons name="person" size={18} color="#94a3b8" />
                            </View>
                          )}
                        </View>
                        <Text style={styles.diaFilaNombre} numberOfLines={1}>
                          {a.artista_nombre_snapshot?.trim() || '(hueco)'}
                        </Text>
                        <View style={styles.diaBadgeCol}>
                          {a.estado?.toLowerCase() === 'asociada' ? (
                            <View style={styles.diaBadgeAsoc}>
                              <Text style={styles.diaBadgeAsocTxt}>Asociada</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={styles.diaFilaImporte}>{precioActuacion(a)}</Text>
                      </View>
                    );
                  })}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      )}

      {IS_WEB && dayTooltip ? (
        <View style={styles.tooltipOverlay} pointerEvents="none">
          <View style={styles.tooltipCard}>
            <View style={styles.tooltipTituloRow}>
              <Text style={styles.tooltipTitulo}>{formatFecha(dayTooltip.iso)}</Text>
              {tooltipTotalDia != null ? (
                <Text style={styles.tooltipTituloTotal}>{formatMoneda(tooltipTotalDia)}</Text>
              ) : null}
            </View>
            <View style={styles.tooltipTableHead}>
              <Text style={[styles.tooltipTh, styles.tooltipColHora]}>Hora</Text>
              <Text style={[styles.tooltipTh, styles.tooltipColArtGrupo]}>Artista</Text>
              <Text style={[styles.tooltipTh, styles.tooltipColImp]}>Importe</Text>
            </View>
            {tooltipGruposPorLocal.map((grp, idx) => (
              <View key={grp.key}>
                <View style={[styles.tooltipLocalHeader, idx > 0 && styles.tooltipLocalHeaderSep]}>
                  <View style={styles.tooltipLocalHeaderRow}>
                    <Text style={styles.tooltipLocalHeaderText} numberOfLines={1}>
                      {grp.nombre}
                    </Text>
                    {grp.sumaLocal != null ? (
                      <Text style={styles.tooltipLocalHeaderSuma}>{formatMoneda(grp.sumaLocal)}</Text>
                    ) : (
                      <Text style={styles.tooltipLocalHeaderSumaMuted}>—</Text>
                    )}
                  </View>
                </View>
                {grp.items.map((a) => (
                  <View key={a.id_actuacion} style={styles.tooltipFila}>
                    <Text
                      style={[styles.tooltipTd, styles.tooltipColHora, IS_WEB && styles.tooltipTdWebOneLine]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {a.hora_inicio || '—'}
                    </Text>
                    <Text
                      style={[styles.tooltipTd, styles.tooltipColArtGrupo, IS_WEB && styles.tooltipTdWebOneLine]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {a.artista_nombre_snapshot?.trim() || '(hueco)'}
                    </Text>
                    <Text
                      style={[styles.tooltipTd, styles.tooltipColImp, styles.tooltipTdImp, IS_WEB && styles.tooltipTdWebOneLine]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {precioActuacion(a)}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

type CeldaProps = {
  cell: { date: Date | null; inMonth: boolean };
  iso: string;
  list: ActuacionCalItem[];
  esHoy: boolean;
  onShowTooltip: (iso: string, list: ActuacionCalItem[]) => void;
  onHideTooltip: () => void;
};

function DiaMesCelda({ cell, iso, list, esHoy, onShowTooltip, onHideTooltip }: CeldaProps) {
  const ref = useRef<View>(null);
  const porLocal = useMemo(() => resumenPorLocal(list), [list]);
  const totalDia = useMemo(() => sumaImportesDia(list), [list]);

  const webHover =
    IS_WEB && list.length > 0
      ? {
          onMouseEnter: () => onShowTooltip(iso, list),
          onMouseLeave: onHideTooltip,
        }
      : {};

  return (
    <View
      ref={ref}
      collapsable={false}
      style={[styles.diaCell, !cell.inMonth && styles.diaCellFuera, esHoy && styles.diaCellHoy]}
      {...(webHover as object)}
    >
      <View style={styles.diaNumRow}>
        <Text style={[styles.diaNum, !cell.inMonth && styles.diaNumFuera]}>{cell.date?.getDate() ?? ''}</Text>
        {totalDia != null ? (
          <Text style={[styles.diaTotalDia, !cell.inMonth && styles.diaNumFuera]} numberOfLines={1}>
            {formatMoneda(totalDia)}
          </Text>
        ) : null}
      </View>
      {porLocal.slice(0, 3).map((r) => (
        <Text key={r.key} style={styles.localResumenLine} numberOfLines={1}>
          {r.nombre}: {r.suma != null ? formatMoneda(r.suma) : '—'}
        </Text>
      ))}
      {porLocal.length > 3 ? (
        <Text style={styles.actMore}>+{porLocal.length - 3} locales</Text>
      ) : null}
    </View>
  );
}

type SemanaColumnaProps = {
  d: Date;
  iso: string;
  list: ActuacionCalItem[];
  esHoy: boolean;
  isLast: boolean;
  onShowTooltip: (iso: string, list: ActuacionCalItem[]) => void;
  onHideTooltip: () => void;
};

function SemanaDiaColumna({ d, iso, list, esHoy, isLast, onShowTooltip, onHideTooltip }: SemanaColumnaProps) {
  const ref = useRef<View>(null);
  const porLocal = useMemo(() => resumenPorLocal(list), [list]);
  const totalDia = useMemo(() => sumaImportesDia(list), [list]);

  const webHover =
    IS_WEB && list.length > 0
      ? {
          onMouseEnter: () => onShowTooltip(iso, list),
          onMouseLeave: onHideTooltip,
        }
      : {};

  return (
    <View
      ref={ref}
      style={[styles.semanaCol, !isLast && styles.semanaColBorder, esHoy && styles.semanaColHoy]}
      collapsable={false}
      {...(webHover as object)}
    >
      <View style={styles.semanaColHeader}>
        <Text style={styles.semanaDiaSem}>{DIAS_SEMANA[d.getDay() === 0 ? 6 : d.getDay() - 1]}</Text>
        <Text style={styles.semanaDiaNum}>{d.getDate()}</Text>
        {totalDia != null ? (
          <Text style={styles.semanaDiaTotal} numberOfLines={1}>
            {formatMoneda(totalDia)}
          </Text>
        ) : null}
      </View>
      <View style={styles.semanaColBody}>
        {list.length === 0 ? (
          <Text style={styles.semanaVacio}>—</Text>
        ) : (
          porLocal.map((r) => (
            <Text key={r.key} style={styles.semanaLocalLine} numberOfLines={2}>
              {r.nombre}: {r.suma != null ? formatMoneda(r.suma) : '—'}
            </Text>
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 200 },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  modeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  modeBtnOn: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  modeBtnText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  modeBtnTextOn: { color: '#0369a1' },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  navIconBtn: { padding: 4 },
  navTitle: { flex: 1, textAlign: 'center', fontSize: 13, fontWeight: '700', color: '#334155' },
  navTitleDia: { fontSize: 12, lineHeight: 16 },
  hoyLink: { alignSelf: 'center', marginBottom: 8 },
  hoyLinkText: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  mesScroll: { flex: 1, maxHeight: Platform.OS === 'web' ? 480 : undefined },
  weekdayRow: { flexDirection: 'row', marginBottom: 4 },
  weekdayLbl: { flex: 1, textAlign: 'center', fontSize: 10, fontWeight: '700', color: '#64748b' },
  mesFila: { flexDirection: 'row' },
  diaCell: {
    flex: 1,
    minHeight: 72,
    borderWidth: 1,
    borderColor: '#f1f5f9',
    padding: 3,
    backgroundColor: '#fff',
  },
  diaCellFuera: { backgroundColor: '#fafafa' },
  diaCellHoy: { backgroundColor: '#f0f9ff', borderColor: '#0ea5e9' },
  diaNumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 2,
    marginBottom: 2,
  },
  diaNum: { fontSize: 10, fontWeight: '700', color: '#334155' },
  diaTotalDia: { fontSize: 7, fontWeight: '700', color: '#0ea5e9', flexShrink: 1, textAlign: 'right' },
  diaNumFuera: { color: '#cbd5e1' },
  localResumenLine: { fontSize: 7, color: '#475569', lineHeight: 10 },
  actMore: { fontSize: 7, color: '#0ea5e9', fontWeight: '600' },
  tooltipOverlay: {
    position: 'fixed' as never,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 99999,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  tooltipCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 12,
    minWidth: 520,
    width: '90%' as never,
    maxWidth: 920,
  },
  tooltipTituloRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  tooltipTitulo: {
    fontSize: 14,
    fontWeight: '700',
    color: '#334155',
    flex: 1,
  },
  tooltipTituloTotal: { fontSize: 14, fontWeight: '700', color: '#0ea5e9' },
  tooltipTableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 6,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  tooltipTh: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  tooltipFila: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  tooltipTd: { fontSize: 12, color: '#334155' },
  /** Web: evita saltos de línea en celdas de la tabla flotante */
  tooltipTdWebOneLine: { whiteSpace: 'nowrap' as never, overflow: 'hidden' as never },
  tooltipTdImp: { fontWeight: '600', color: '#0f172a' },
  tooltipLocalHeader: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: '#f8fafc',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  tooltipLocalHeaderSep: { marginTop: 8 },
  tooltipLocalHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  tooltipLocalHeaderText: { fontSize: 12, fontWeight: '700', color: '#0369a1', flex: 1, minWidth: 0 },
  tooltipLocalHeaderSuma: { fontSize: 12, fontWeight: '700', color: '#0ea5e9', flexShrink: 0 },
  tooltipLocalHeaderSumaMuted: { fontSize: 12, color: '#94a3b8', flexShrink: 0 },
  tooltipColHora: { width: 52, flexShrink: 0, paddingRight: 6 },
  tooltipColArtGrupo: { flex: 1, minWidth: 0, paddingRight: 8 },
  tooltipColImp: { width: 96, flexShrink: 0, textAlign: 'right' },
  semanaScroll: { flex: 1, maxHeight: Platform.OS === 'web' ? 480 : undefined },
  semanaScrollContent: { flexGrow: 1 },
  /** Una fila con los 7 días en columnas (horizontal) */
  semanaHorizontalContent: {
    width: '100%' as never,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  semanaRow: { flexDirection: 'row', alignItems: 'stretch', width: '100%' as never },
  semanaCol: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 4,
    paddingVertical: 6,
    backgroundColor: '#fff',
  },
  semanaColBorder: { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: '#e2e8f0' },
  semanaColHoy: { backgroundColor: '#f0f9ff' },
  semanaColHeader: { alignItems: 'center', marginBottom: 6, gap: 2 },
  semanaColBody: { flex: 1, minHeight: 40 },
  semanaDiaSem: { fontSize: 10, fontWeight: '700', color: '#64748b' },
  semanaDiaNum: { fontSize: 15, fontWeight: '700', color: '#334155' },
  semanaDiaTotal: { fontSize: 8, fontWeight: '700', color: '#0ea5e9', textAlign: 'center' },
  semanaVacio: { fontSize: 11, color: '#cbd5e1', textAlign: 'center' },
  semanaLocalLine: { fontSize: 8, color: '#475569', marginBottom: 3, lineHeight: 11 },
  diaScroll: { flex: 1, maxHeight: Platform.OS === 'web' ? 480 : undefined },
  diaBloque: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#fff',
    padding: 10,
    overflow: 'hidden',
  },
  diaBloqueHoy: { borderColor: '#0ea5e9', backgroundColor: '#f8fafc' },
  diaBloqueResumen: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  diaBloqueResumenLbl: { fontSize: 11, fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 },
  diaBloqueResumenVal: { fontSize: 15, fontWeight: '700', color: '#0ea5e9' },
  diaBloqueResumenVac: { fontSize: 14, color: '#cbd5e1', fontWeight: '600' },
  diaVacio: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', paddingVertical: 16 },
  diaGrupoSep: { marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#e2e8f0' },
  diaGrupoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  diaGrupoNombre: { flex: 1, fontSize: 12, fontWeight: '800', color: '#0369a1', textTransform: 'uppercase', letterSpacing: 0.3 },
  diaGrupoSuma: { fontSize: 12, fontWeight: '700', color: '#0ea5e9' },
  diaGrupoSumaMuted: { fontSize: 12, color: '#94a3b8' },
  diaFilaLinea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  diaFilaHora: {
    width: 42,
    fontSize: 12,
    fontWeight: '700',
    color: '#0369a1',
  },
  diaThumbWrap: { width: 30, height: 30, flexShrink: 0 },
  diaThumb: { width: 30, height: 30, borderRadius: 6, backgroundColor: '#f1f5f9' },
  diaThumbPlaceholder: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  diaFilaNombre: { flex: 1, fontSize: 12, fontWeight: '600', color: '#334155', minWidth: 0 },
  diaBadgeCol: { width: 76, alignItems: 'flex-end', justifyContent: 'center', flexShrink: 0 },
  diaFilaImporte: { width: 72, fontSize: 12, fontWeight: '700', color: '#0f172a', textAlign: 'right', flexShrink: 0 },
  diaBadgeAsoc: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: '#d1fae5',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#a7f3d0',
  },
  diaBadgeAsocTxt: { fontSize: 8, fontWeight: '700', color: '#166534' },
});
