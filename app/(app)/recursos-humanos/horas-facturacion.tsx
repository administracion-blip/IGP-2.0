/**
 * RRHH — Horas por facturación.
 *
 * Estima las horas de cuadrante "posibles" a partir del facturado comparativa
 * (mismo periodo del año anterior, ajustado por festivos) y un ratio de
 * productividad (€ por hora) configurable por local. Permite agrupar locales y
 * comparar las horas posibles con las horas ya cuadradas (turnos planificados
 * en Factorial HR).
 *
 *   horas_posibles = facturado_comparativa / (€ por hora)
 *
 * Reutiliza:
 *  - `obtenerFilasObjetivos` (facturado real/comparativa por día, vía Ágora).
 *  - `/api/personal/cuadrante` (minutos planificados por local).
 *  - `useAgrupacionesObjetivos` (grupos de locales).
 *  - `useRatiosHoras` (ratio € / hora por local, persistido en ajustes).
 *  - `obtenerVentasPorHora` + plantillas de franjas (desglose horario por día).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';
import { fechaComparacion, obtenerFilasObjetivos } from '../../lib/objetivosFilasApi';
import {
  type Franja,
  type PlantillaFranjas,
  agruparEnFranjas,
  obtenerPlantillasFranjas,
  obtenerVentasPorHora,
} from '../../lib/ventasPorHoraApi';
import { useAgrupacionesObjetivos } from '../../hooks/useAgrupacionesObjetivos';
import { useRatiosHoras } from '../../hooks/useRatiosHoras';
import { fetchImporteHoraDefecto } from '../../lib/personalizacion';
import { SelectorRangoSemana } from '../../components/SelectorRangoSemana';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as XLSX from 'xlsx';
type jsPDF = import('jspdf').jsPDF;

type LocalItem = {
  id_Locales?: string;
  nombre?: string;
  agoraCode?: string;
  AgoraCode?: string;
  factorial_location_id?: string;
  ratio_personal?: string | number;
};

type ResultadoLocal = {
  localId: string;
  nombre: string;
  comparativa: number;
  real: number;
  minutosCuadrante: number | null;
  ratioPersonal: number | null;
  tieneAgora: boolean;
  tieneFactorial: boolean;
};

/** Celda (día × franja): horas posibles y comparativa de esa franja en ese día. */
type CeldaFranja = {
  comparativa: number;
  real: number;
  horasPosibles: number | null;
};

/** Una fila de la matriz = un día concreto del rango, con sus franjas. */
type FilaDiaFranjas = {
  fecha: string;
  fechaComparacion: string;
  celdas: CeldaFranja[];
  totalComparativa: number;
  totalHorasPosibles: number | null;
};

type ResultadoFranjasLocal = {
  localId: string;
  nombre: string;
  ratioPersonal: number | null;
  dias: FilaDiaFranjas[];
  tieneAgora: boolean;
  aviso?: string;
};

const DROPDOWN_Z = 10050;

/** Ratio personal (%) del local como número 0–100, o null si no está configurado. */
function ratioPersonalDe(l: LocalItem): number | null {
  const raw = l.ratio_personal;
  if (raw == null || String(raw).trim() === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function agoraCodeDe(l: LocalItem): string {
  return String(l.agoraCode ?? l.AgoraCode ?? '').trim();
}

function formatEur(n: number): string {
  return (n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatHoras(h: number | null): string {
  if (h == null) return '—';
  return h.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + ' h';
}

type DeltaBadgeCfg = { bg: string; fg: string };

function deltaBadgeConfig(delta: number): DeltaBadgeCfg {
  if (delta > 0) return { bg: '#dcfce7', fg: '#16a34a' };
  if (delta < 0) return { bg: '#fee2e2', fg: '#dc2626' };
  return { bg: '#f1f5f9', fg: '#64748b' };
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta == null) return <Text style={styles.cellText}>—</Text>;
  const cfg = deltaBadgeConfig(delta);
  return (
    <View style={[styles.deltaBadge, { backgroundColor: cfg.bg }]}>
      <Text style={[styles.deltaBadgeText, { color: cfg.fg }]}>{formatHoras(delta)}</Text>
    </View>
  );
}

function formatFecha(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

const DIAS_SEMANA_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const;

/** "2026-06-30" → "lun 30/06". */
function etiquetaDiaSemanaFecha(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  const dia = DIAS_SEMANA_CORTO[d.getDay()] ?? '';
  const [, m, dd] = iso.split('-');
  return `${dia} ${dd}/${m}`;
}

/** Cabecera de franja en dos líneas: nombre arriba y "(desde–hasta)" debajo. */
function cabeceraFranjaDosLineas(f: Franja): string {
  const rango = `${f.desde}–${f.hasta}`;
  const etq = (f.etiqueta ?? '').trim();
  return etq ? `${etq}\n(${rango})` : rango;
}

/**
 * Input numérico para el ratio €/hora de un local. Confirma en onBlur.
 * Si el local no tiene ratio propio, muestra el importe global por defecto como
 * placeholder (heredado) para dejar claro que se usa ese valor sin fijarlo.
 */
function RatioInput({ valor, defecto, onCommit }: { valor: number; defecto: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(valor > 0 ? String(valor) : '');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(valor > 0 ? String(valor) : '');
  }, [valor, focused]);

  return (
    <TextInput
      style={[styles.ratioInput, valor <= 0 && defecto > 0 && styles.ratioInputHeredado]}
      value={text}
      onChangeText={(t) => setText(t.replace(',', '.').replace(/[^0-9.]/g, ''))}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const n = parseFloat(text);
        onCommit(Number.isFinite(n) && n > 0 ? n : 0);
      }}
      keyboardType="numeric"
      placeholder={defecto > 0 ? String(defecto) : '€/h'}
      placeholderTextColor="#94a3b8"
    />
  );
}

export default function HorasFacturacionScreen() {
  const router = useRouter();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [localesLoading, setLocalesLoading] = useState(true);
  const [localesError, setLocalesError] = useState<string | null>(null);

  const [selectedLocalIds, setSelectedLocalIds] = useState<string[]>([]);
  const [from, setFrom] = useState<string>(() => fechaJornadaNegocioIso());
  const [to, setTo] = useState<string>(() => fechaJornadaNegocioIso());
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [localSearch, setLocalSearch] = useState('');

  const [resultados, setResultados] = useState<ResultadoLocal[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const { agrupaciones } = useAgrupacionesObjetivos();
  const { ratios, guardarRatio } = useRatiosHoras();
  const [importeDefecto, setImporteDefecto] = useState(0);

  // Desglose por franjas día a día (matriz día × franja por local) sobre el rango Desde/Hasta.
  const [plantillas, setPlantillas] = useState<PlantillaFranjas[]>([]);
  const [plantillaFranjasId, setPlantillaFranjasId] = useState('');
  const [resultadosFranjas, setResultadosFranjas] = useState<ResultadoFranjasLocal[] | null>(null);
  const [etiquetasFranjas, setEtiquetasFranjas] = useState<string[]>([]);
  // Franjas crudas de la plantilla usada al calcular (para cabeceras en dos líneas).
  const [franjasUsadas, setFranjasUsadas] = useState<Franja[]>([]);
  const [progresoFranjas, setProgresoFranjas] = useState<{ hechas: number; total: number } | null>(null);
  const [loadingFranjas, setLoadingFranjas] = useState(false);
  const [errorFranjas, setErrorFranjas] = useState<string | null>(null);
  const [franjasExportMenuOpen, setFranjasExportMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchImporteHoraDefecto().then((v) => {
      if (!cancelled) setImporteDefecto(v);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    obtenerPlantillasFranjas()
      .then((p) => {
        if (cancelled) return;
        setPlantillas(p);
        if (p.length === 1) setPlantillaFranjasId(p[0].plantillaId);
      })
      .catch(() => {
        if (!cancelled) setPlantillas([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/locales')
      .then((res) => res.json())
      .then((res: { locales?: LocalItem[]; error?: string }) => {
        if (cancelled) return;
        if (res.error) setLocalesError(res.error);
        else setLocales(res.locales || []);
      })
      .catch((e) => {
        if (!cancelled) setLocalesError(e instanceof Error ? e.message : 'Error de conexión');
      })
      .finally(() => {
        if (!cancelled) setLocalesLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const localById = useMemo(() => {
    const m = new Map<string, LocalItem>();
    for (const l of locales) if (l.id_Locales) m.set(l.id_Locales, l);
    return m;
  }, [locales]);

  const localesFiltrados = useMemo(() => {
    const q = localSearch.trim().toLowerCase();
    const list = !q ? locales : locales.filter((l) => (l.nombre || '').toLowerCase().includes(q));
    return [...list].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));
  }, [locales, localSearch]);

  const selectedSet = useMemo(() => new Set(selectedLocalIds), [selectedLocalIds]);

  const toggleLocal = (id: string) => {
    setSelectedLocalIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return [...s];
    });
  };

  const seleccionarTodosFiltrados = () => {
    setSelectedLocalIds((prev) => {
      const s = new Set(prev);
      for (const l of localesFiltrados) {
        if (l.id_Locales) s.add(l.id_Locales);
      }
      return [...s];
    });
  };

  const quitarSeleccionFiltrados = () => {
    const filtradosIds = new Set(localesFiltrados.map((l) => l.id_Locales).filter(Boolean) as string[]);
    setSelectedLocalIds((prev) => prev.filter((id) => !filtradosIds.has(id)));
  };

  const toggleAgrupacion = (localIds: string[]) => {
    const ids = localIds.filter((id) => localById.has(id));
    const todosDentro = ids.length > 0 && ids.every((id) => selectedSet.has(id));
    setSelectedLocalIds((prev) => {
      const s = new Set(prev);
      if (todosDentro) ids.forEach((id) => s.delete(id));
      else ids.forEach((id) => s.add(id));
      return [...s];
    });
  };

  const etiquetaLocales = useMemo(() => {
    if (selectedLocalIds.length === 0) return 'Selecciona locales…';
    if (selectedLocalIds.length === 1) {
      return localById.get(selectedLocalIds[0])?.nombre || selectedLocalIds[0];
    }
    return `${selectedLocalIds.length} locales seleccionados`;
  }, [selectedLocalIds, localById]);

  const consultar = useCallback(async () => {
    if (selectedLocalIds.length === 0) {
      setError('Selecciona al menos un local');
      return;
    }
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoRe.test(from) || !isoRe.test(to)) {
      setError('Revisa las fechas (dd/mm/aaaa)');
      return;
    }
    if (from > to) {
      setError('La fecha "Desde" debe ser anterior o igual a "Hasta"');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const seleccionados = selectedLocalIds
        .map((id) => localById.get(id))
        .filter((l): l is LocalItem => !!l && !!l.id_Locales);

      // 1) Facturado comparativa por local (Ágora) en paralelo.
      const comparativaPorLocal = await Promise.all(
        seleccionados.map(async (l) => {
          const code = agoraCodeDe(l);
          if (!code) return { localId: l.id_Locales as string, comparativa: 0, real: 0, tieneAgora: false };
          try {
            const filas = await obtenerFilasObjetivos('', code, from, to);
            let comp = 0;
            let real = 0;
            for (const f of filas) {
              comp += f.TotalFacturadoComparativa || 0;
              real += f.TotalFacturadoReal || 0;
            }
            return { localId: l.id_Locales as string, comparativa: comp, real, tieneAgora: true };
          } catch {
            return { localId: l.id_Locales as string, comparativa: 0, real: 0, tieneAgora: false };
          }
        }),
      );

      // 2) Horas cuadradas (minutos planificados) del cuadrante para los locales con Factorial.
      const conFactorial = seleccionados.filter((l) => String(l.factorial_location_id || '').trim() !== '');
      const minutosPorLocal = new Map<string, number>();
      if (conFactorial.length > 0) {
        const listParam = conFactorial.map((l) => encodeURIComponent(l.id_Locales as string)).join(',');
        const qs = `local_ids=${listParam}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        try {
          const res = await apiFetch(`/api/personal/cuadrante?${qs}`);
          const json = await res.json();
          if (res.ok && json?.ok && Array.isArray(json.por_local)) {
            for (const b of json.por_local) {
              minutosPorLocal.set(String(b.local_id), Number(b?.totales?.minutos_planificados) || 0);
            }
          }
        } catch {
          // Sin cuadrante: las horas cuadradas quedan como N/A.
        }
      }

      const compMap = new Map(comparativaPorLocal.map((c) => [c.localId, c]));
      const out: ResultadoLocal[] = seleccionados.map((l) => {
        const id = l.id_Locales as string;
        const c = compMap.get(id);
        const tieneFactorial = String(l.factorial_location_id || '').trim() !== '';
        return {
          localId: id,
          nombre: l.nombre || id,
          comparativa: c?.comparativa ?? 0,
          real: c?.real ?? 0,
          minutosCuadrante: tieneFactorial ? (minutosPorLocal.get(id) ?? 0) : null,
          ratioPersonal: ratioPersonalDe(l),
          tieneAgora: c?.tieneAgora ?? false,
          tieneFactorial,
        };
      });
      setResultados(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
      setResultados(null);
    } finally {
      setLoading(false);
    }
  }, [selectedLocalIds, from, to, localById]);

  // Coste/hora efectivo: el propio del local si existe; si no, el importe global por defecto.
  const ratioEfectivo = useCallback(
    (localId: string): number => {
      const propio = ratios[localId] || 0;
      return propio > 0 ? propio : importeDefecto;
    },
    [ratios, importeDefecto],
  );

  /** Importe del facturado comparativa destinado a personal (€), o null si no hay ratio_personal. */
  const importeAPersonal = useCallback(
    (comparativa: number, ratioPersonal: number | null): number | null => {
      if (ratioPersonal == null || ratioPersonal <= 0) return null;
      return comparativa * (ratioPersonal / 100);
    },
    [],
  );

  const horasPosibles = useCallback(
    (comparativa: number, localId: string, ratioPersonal: number | null): number | null => {
      const importe = importeAPersonal(comparativa, ratioPersonal);
      if (importe == null) return null;
      const coste = ratioEfectivo(localId);
      return coste > 0 ? importe / coste : null;
    },
    [importeAPersonal, ratioEfectivo],
  );

  const plantillaFranjasSel = useMemo(
    () => plantillas.find((p) => p.plantillaId === plantillaFranjasId) ?? null,
    [plantillas, plantillaFranjasId],
  );

  const consultarFranjas = useCallback(async () => {
    if (selectedLocalIds.length === 0) {
      setErrorFranjas('Selecciona al menos un local');
      return;
    }
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoRe.test(from) || !isoRe.test(to)) {
      setErrorFranjas('Revisa las fechas (dd/mm/aaaa)');
      return;
    }
    if (from > to) {
      setErrorFranjas('La fecha "Desde" debe ser anterior o igual a "Hasta"');
      return;
    }
    if (!plantillaFranjasSel || plantillaFranjasSel.franjas.length === 0) {
      setErrorFranjas('Selecciona una plantilla de franjas');
      return;
    }

    // Lista de días del rango (límite de seguridad para no saturar Ágora).
    const dias: string[] = [];
    const cursor = new Date(from + 'T12:00:00');
    const fin = new Date(to + 'T12:00:00');
    while (cursor <= fin) {
      dias.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
    }
    const MAX_DIAS = 31;
    if (dias.length > MAX_DIAS) {
      setErrorFranjas(`El rango es demasiado amplio (máx. ${MAX_DIAS} días). Acórtalo.`);
      return;
    }

    setErrorFranjas(null);
    setLoadingFranjas(true);
    const franjasPlantilla = plantillaFranjasSel.franjas;
    setEtiquetasFranjas(agruparEnFranjas({}, {}, franjasPlantilla).map((f) => f.label));
    setFranjasUsadas(franjasPlantilla);

    try {
      const seleccionados = selectedLocalIds
        .map((id) => localById.get(id))
        .filter((l): l is LocalItem => !!l && !!l.id_Locales);

      // Una "tarea" por cada (local, día) con Ágora. Resolvemos con concurrencia limitada.
      type Tarea = { localId: string; code: string; fecha: string };
      const tareas: Tarea[] = [];
      const conAgora = seleccionados.filter((l) => agoraCodeDe(l) !== '');
      for (const l of conAgora) {
        for (const d of dias) tareas.push({ localId: l.id_Locales as string, code: agoraCodeDe(l), fecha: d });
      }

      setProgresoFranjas({ hechas: 0, total: tareas.length });
      let hechas = 0;
      const celdaPorClave = new Map<string, { fechaComp: string; celdas: CeldaFranja[]; totalComp: number }>();

      const CONCURRENCIA = 4;
      let cursorTarea = 0;
      const worker = async () => {
        while (cursorTarea < tareas.length) {
          const t = tareas[cursorTarea++];
          try {
            const filasObj = await obtenerFilasObjetivos('', t.code, t.fecha, t.fecha);
            const fechaComp = filasObj[0]?.FechaComparacion ?? fechaComparacion(t.fecha);
            const [real, comp] = await Promise.all([
              obtenerVentasPorHora(t.code, t.fecha),
              obtenerVentasPorHora(t.code, fechaComp),
            ]);
            const filasFranja = agruparEnFranjas(real.porHora, comp.porHora, franjasPlantilla);
            const ratioPers = ratioPersonalDe(localById.get(t.localId) as LocalItem);
            const coste = ratioEfectivo(t.localId);
            let totalComp = 0;
            const celdas: CeldaFranja[] = filasFranja.map((f) => {
              totalComp += f.comparativa;
              const importePers = ratioPers != null && ratioPers > 0 ? f.comparativa * (ratioPers / 100) : null;
              const hp = importePers != null && coste > 0 ? importePers / coste : null;
              return { comparativa: f.comparativa, real: f.real, horasPosibles: hp };
            });
            celdaPorClave.set(`${t.localId}|${t.fecha}`, { fechaComp, celdas, totalComp });
          } catch {
            // Día sin datos: se deja sin celda (se mostrará como —).
          } finally {
            hechas++;
            setProgresoFranjas({ hechas, total: tareas.length });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, tareas.length) }, worker));

      const out: ResultadoFranjasLocal[] = seleccionados.map((l) => {
        const id = l.id_Locales as string;
        const nombre = l.nombre || id;
        const code = agoraCodeDe(l);
        const ratioPers = ratioPersonalDe(l);
        const coste = ratioEfectivo(id);
        const hpValido = ratioPers != null && ratioPers > 0 && coste > 0;

        if (!code) {
          return { localId: id, nombre, ratioPersonal: ratioPers, dias: [], tieneAgora: false, aviso: 'Sin código Ágora' };
        }

        const filasDia: FilaDiaFranjas[] = dias.map((d) => {
          const got = celdaPorClave.get(`${id}|${d}`);
          const celdas = got?.celdas ?? franjasPlantilla.map(() => ({ comparativa: 0, real: 0, horasPosibles: hpValido ? 0 : null }));
          let totalHp = 0;
          for (const c of celdas) if (c.horasPosibles != null) totalHp += c.horasPosibles;
          return {
            fecha: d,
            fechaComparacion: got?.fechaComp ?? fechaComparacion(d),
            celdas,
            totalComparativa: got?.totalComp ?? 0,
            totalHorasPosibles: hpValido ? totalHp : null,
          };
        });

        return {
          localId: id,
          nombre,
          ratioPersonal: ratioPers,
          dias: filasDia,
          tieneAgora: true,
          aviso: ratioPers == null ? 'Sin ratio personal (%)' : undefined,
        };
      });

      out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
      setResultadosFranjas(out);
    } catch (e) {
      setErrorFranjas(e instanceof Error ? e.message : 'Error al calcular franjas');
      setResultadosFranjas(null);
    } finally {
      setLoadingFranjas(false);
      setProgresoFranjas(null);
    }
  }, [selectedLocalIds, from, to, plantillaFranjasSel, localById, ratioEfectivo]);

  // Resumen del rango por local × franja: suma de horas posibles y comparativa de cada franja.
  const resumenFranjas = useMemo(() => {
    if (!resultadosFranjas || etiquetasFranjas.length === 0) return null;
    return resultadosFranjas.map((loc) => {
      const horasPorFranja = etiquetasFranjas.map(() => 0);
      const compPorFranja = etiquetasFranjas.map(() => 0);
      let hpValido = false;
      let totalHoras = 0;
      let totalComp = 0;
      for (const dia of loc.dias) {
        dia.celdas.forEach((c, i) => {
          compPorFranja[i] += c.comparativa;
          totalComp += c.comparativa;
          if (c.horasPosibles != null) {
            horasPorFranja[i] += c.horasPosibles;
            totalHoras += c.horasPosibles;
            hpValido = true;
          }
        });
      }
      return {
        localId: loc.localId,
        nombre: loc.nombre,
        tieneAgora: loc.tieneAgora,
        horasPorFranja,
        compPorFranja,
        totalHoras: hpValido ? totalHoras : null,
        totalComp,
      };
    });
  }, [resultadosFranjas, etiquetasFranjas]);

  // Saneado de nombre de hoja Excel (máx. 31 chars, sin : \ / ? * [ ]).
  const sanearHoja = useCallback((nombre: string, idx: number): string => {
    const limpio = nombre.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 28);
    return limpio ? `${idx + 1}. ${limpio}`.slice(0, 31) : `Local ${idx + 1}`;
  }, []);

  const exportarFranjasExcel = useCallback(() => {
    if (!resultadosFranjas || resultadosFranjas.length === 0) return;
    setFranjasExportMenuOpen(false);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `horas_franjas_${stamp}.xlsx`;
    const wb = XLSX.utils.book_new();

    // Hoja resumen: locales × franjas (horas posibles del rango).
    const resumenAoa: (string | number)[][] = [
      ['Horas por franjas — Resumen'],
      ['Periodo', `${formatFecha(from)} → ${formatFecha(to)}`],
      ['Generado', new Date().toLocaleString('es-ES')],
      [],
      ['Local', ...etiquetasFranjas, 'Total horas'],
    ];
    for (const r of resumenFranjas ?? []) {
      resumenAoa.push([
        r.nombre,
        ...r.horasPorFranja.map((h) => (r.tieneAgora && r.totalHoras != null ? round2(h) : (r.tieneAgora ? '' : 'sin Ágora'))),
        r.totalHoras != null ? round2(r.totalHoras) : '',
      ]);
    }
    const wsResumen = XLSX.utils.aoa_to_sheet(resumenAoa);
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // Una hoja por local: matriz días × franjas (horas posibles; comparativa en filas alternas).
    resultadosFranjas.forEach((loc, idx) => {
      const aoa: (string | number)[][] = [
        [loc.nombre],
        ['Periodo', `${formatFecha(from)} → ${formatFecha(to)}`],
        [],
        ['Día', ...etiquetasFranjas, 'Total horas'],
      ];
      if (loc.tieneAgora) {
        for (const d of loc.dias) {
          aoa.push([
            etiquetaDiaSemanaFecha(d.fecha),
            ...d.celdas.map((c) => (c.horasPosibles != null ? round2(c.horasPosibles) : '')),
            d.totalHorasPosibles != null ? round2(d.totalHorasPosibles) : '',
          ]);
          aoa.push([
            '  € comparativa',
            ...d.celdas.map((c) => round2(c.comparativa)),
            round2(d.totalComparativa),
          ]);
        }
        // Sumatorio del rango por franja (horas e importes).
        const res = resumenFranjas?.find((r) => r.localId === loc.localId);
        if (res) {
          aoa.push([]);
          aoa.push([
            'TOTAL horas',
            ...res.horasPorFranja.map((h) => (res.totalHoras != null ? round2(h) : '')),
            res.totalHoras != null ? round2(res.totalHoras) : '',
          ]);
          aoa.push([
            'TOTAL € comparativa',
            ...res.compPorFranja.map((c) => round2(c)),
            round2(res.totalComp),
          ]);
        }
      } else {
        aoa.push([loc.aviso ?? 'Sin datos']);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, sanearHoja(loc.nombre, idx));
    });

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
        .then(() => Sharing.shareAsync(fileUri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: fname,
        }))
        .catch(() => {});
    }
  }, [resultadosFranjas, resumenFranjas, etiquetasFranjas, from, to, sanearHoja]);

  const exportarFranjasPDF = useCallback(async () => {
    if (!resultadosFranjas || resultadosFranjas.length === 0) return;
    setFranjasExportMenuOpen(false);
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `horas_franjas_${stamp}.pdf`;
    const hrs = (n: number | null) => (n != null ? formatHoras(n) : '—');
    // Celda en dos líneas: horas posibles arriba, venta comparativa debajo.
    // Los valores a 0 (o sin dato) se ocultan; si ambos son 0 la celda queda vacía.
    const celdaTexto = (horas: number | null, comp: number) => {
      const hPart = horas != null && horas > 0 ? formatHoras(horas) : '';
      const cPart = comp > 0 ? formatEur(comp) : '';
      return [hPart, cPart].filter(Boolean).join('\n');
    };
    const cabFranjas = franjasUsadas.map(cabeceraFranjaDosLineas);

    const { jsPDF: JsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc: jsPDF = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    const resumenById = new Map((resumenFranjas ?? []).map((r) => [r.localId, r]));

    // Una página por local: matriz días × franjas (sin página de resumen aparte).
    resultadosFranjas.forEach((loc, idx) => {
      if (idx > 0) doc.addPage();
      let yl = 12;
      doc.setFontSize(13);
      doc.setFont('helvetica', 'bold');
      doc.text(loc.nombre, 14, yl);
      yl += 5;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(60);
      doc.text(`Periodo: ${formatFecha(from)} → ${formatFecha(to)}`, 14, yl);
      yl += 4;
      doc.setTextColor(0);

      if (!loc.tieneAgora) {
        doc.setFontSize(10);
        doc.setTextColor(180, 83, 9);
        doc.text(loc.aviso ?? 'Sin datos', 14, yl + 2);
        doc.setTextColor(0);
        return;
      }

      const res = resumenById.get(loc.localId);
      const body = loc.dias.map((d) => [
        etiquetaDiaSemanaFecha(d.fecha),
        ...d.celdas.map((c) => celdaTexto(c.horasPosibles, c.comparativa)),
        celdaTexto(d.totalHorasPosibles, d.totalComparativa),
      ]);
      // Fila de totales del rango por franja + total general del local.
      if (res) {
        body.push([
          'TOTAL',
          ...res.horasPorFranja.map((h, i) => celdaTexto(res.totalHoras != null ? h : null, res.compPorFranja[i] ?? 0)),
          celdaTexto(res.totalHoras, res.totalComp),
        ]);
      }
      const totalRowIndex = body.length - 1;

      autoTable(doc, {
        startY: yl,
        head: [['Día', ...cabFranjas, 'Total']],
        body,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [14, 165, 233] },
        margin: { left: 14, right: 14 },
        didParseCell: (data) => {
          if (data.section === 'body' && res && data.row.index === totalRowIndex) {
            data.cell.styles.fillColor = [224, 242, 254];
            data.cell.styles.textColor = [12, 74, 110];
            data.cell.styles.fontStyle = 'bold';
          }
        },
      });
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
  }, [resultadosFranjas, resumenFranjas, franjasUsadas, from, to]);

  const resultadoMap = useMemo(() => {
    const m = new Map<string, ResultadoLocal>();
    for (const r of resultados || []) m.set(r.localId, r);
    return m;
  }, [resultados]);

  // Totales del pie de la tabla por local.
  const totalesTabla = useMemo(() => {
    if (!resultados) return null;
    let comparativa = 0;
    let real = 0;
    let importePers = 0;
    let importePersValido = false;
    let horasPos = 0;
    let horasPosValida = false;
    let minutos = 0;
    let minutosValido = false;
    for (const r of resultados) {
      comparativa += r.comparativa;
      real += r.real;
      const imp = importeAPersonal(r.comparativa, r.ratioPersonal);
      if (imp != null) { importePers += imp; importePersValido = true; }
      const hp = horasPosibles(r.comparativa, r.localId, r.ratioPersonal);
      if (hp != null) { horasPos += hp; horasPosValida = true; }
      if (r.minutosCuadrante != null) { minutos += r.minutosCuadrante; minutosValido = true; }
    }
    return {
      comparativa,
      real,
      importePersonal: importePersValido ? importePers : null,
      horasPosibles: horasPosValida ? horasPos : null,
      horasCuadradas: minutosValido ? minutos / 60 : null,
    };
  }, [resultados, horasPosibles, importeAPersonal]);

  // Agrupaciones cuyos locales están todos seleccionados (y con datos calculados).
  const gruposVisibles = useMemo(() => {
    if (!resultados) return [];
    return agrupaciones
      .map((ag) => {
        const ids = ag.localIds.filter((id) => resultadoMap.has(id));
        if (ids.length === 0) return null;
        let comparativa = 0;
        let real = 0;
        let importePers = 0;
        let importePersValido = false;
        let horasPos = 0;
        let horasPosValida = false;
        let minutos = 0;
        let minutosValido = false;
        for (const id of ids) {
          const r = resultadoMap.get(id) as ResultadoLocal;
          comparativa += r.comparativa;
          real += r.real;
          const imp = importeAPersonal(r.comparativa, r.ratioPersonal);
          if (imp != null) { importePers += imp; importePersValido = true; }
          const hp = horasPosibles(r.comparativa, id, r.ratioPersonal);
          if (hp != null) { horasPos += hp; horasPosValida = true; }
          if (r.minutosCuadrante != null) { minutos += r.minutosCuadrante; minutosValido = true; }
        }
        return {
          id: ag.id,
          nombre: ag.nombre,
          color: ag.color,
          nLocales: ids.length,
          comparativa,
          real,
          importePersonal: importePersValido ? importePers : null,
          horasPosibles: horasPosValida ? horasPos : null,
          horasCuadradas: minutosValido ? minutos / 60 : null,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g != null);
  }, [agrupaciones, resultados, resultadoMap, horasPosibles, importeAPersonal]);

  // Filas estructuradas reutilizadas por las exportaciones (Excel/PDF).
  const filasExport = useMemo(() => {
    if (!resultados) return [];
    return resultados.map((r) => {
      const imp = importeAPersonal(r.comparativa, r.ratioPersonal);
      const coste = ratioEfectivo(r.localId);
      const hp = horasPosibles(r.comparativa, r.localId, r.ratioPersonal);
      const hc = r.minutosCuadrante != null ? r.minutosCuadrante / 60 : null;
      const delta = hp != null && hc != null ? hp - hc : null;
      return {
        nombre: r.nombre,
        comparativa: r.comparativa,
        real: r.real,
        ratioPersonal: r.ratioPersonal,
        importePersonal: imp,
        costeHora: coste > 0 ? coste : null,
        horasPosibles: hp,
        horasCuadradas: hc,
        delta,
      };
    });
  }, [resultados, importeAPersonal, ratioEfectivo, horasPosibles]);

  const exportarExcel = useCallback(() => {
    if (!resultados || resultados.length === 0) return;
    setExportMenuOpen(false);
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `horas_facturacion_${stamp}.xlsx`;

    const meta: (string | number)[][] = [
      ['Horas por facturación'],
      ['Periodo', `${formatFecha(from)} → ${formatFecha(to)}`],
      ['Generado', new Date().toLocaleString('es-ES')],
      [],
    ];

    const header = ['Local', 'Comparativa (€)', 'Real (€)', 'Ratio personal (%)', '€ a personal', '€/hora', 'Horas posibles', 'Horas cuadradas', 'Δ horas'];
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const body: (string | number)[][] = filasExport.map((f) => [
      f.nombre,
      round2(f.comparativa),
      round2(f.real),
      f.ratioPersonal != null ? f.ratioPersonal : '',
      f.importePersonal != null ? round2(f.importePersonal) : '',
      f.costeHora != null ? f.costeHora : '',
      f.horasPosibles != null ? round2(f.horasPosibles) : '',
      f.horasCuadradas != null ? round2(f.horasCuadradas) : '',
      f.delta != null ? round2(f.delta) : '',
    ]);

    const aoa: (string | number)[][] = [...meta];
    if (gruposVisibles.length > 0) {
      aoa.push(['Agrupaciones']);
      aoa.push(['Agrupación', 'Comparativa (€)', 'Real (€)', '€ a personal', 'Horas posibles', 'Horas cuadradas']);
      for (const g of gruposVisibles) {
        aoa.push([
          g.nombre,
          round2(g.comparativa),
          round2(g.real),
          g.importePersonal != null ? round2(g.importePersonal) : '',
          g.horasPosibles != null ? round2(g.horasPosibles) : '',
          g.horasCuadradas != null ? round2(g.horasCuadradas) : '',
        ]);
      }
      aoa.push([]);
    }
    aoa.push(['Por local']);
    aoa.push(header);
    aoa.push(...body);
    if (totalesTabla && resultados.length > 1) {
      aoa.push([
        'TOTAL',
        round2(totalesTabla.comparativa),
        round2(totalesTabla.real),
        '',
        totalesTabla.importePersonal != null ? round2(totalesTabla.importePersonal) : '',
        '',
        totalesTabla.horasPosibles != null ? round2(totalesTabla.horasPosibles) : '',
        totalesTabla.horasCuadradas != null ? round2(totalesTabla.horasCuadradas) : '',
        '',
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Horas');

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
        .then(() => Sharing.shareAsync(fileUri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: fname,
        }))
        .catch(() => {});
    }
  }, [resultados, filasExport, gruposVisibles, totalesTabla, from, to]);

  const exportarPDF = useCallback(async () => {
    if (!resultados || resultados.length === 0) return;
    setExportMenuOpen(false);
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `horas_facturacion_${stamp}.pdf`;

    const eur = (n: number | null) => (n != null ? formatEur(n) : '—');
    const hrs = (n: number | null) => (n != null ? formatHoras(n) : '—');

    const tDelta = totalesTabla && totalesTabla.horasPosibles != null && totalesTabla.horasCuadradas != null
      ? totalesTabla.horasPosibles - totalesTabla.horasCuadradas
      : null;

    const body = filasExport.map((f) => [
      f.nombre,
      eur(f.comparativa),
      eur(f.real),
      f.ratioPersonal != null ? `${f.ratioPersonal}%` : '—',
      eur(f.importePersonal),
      f.costeHora != null ? `${f.costeHora} €/h` : '—',
      hrs(f.horasPosibles),
      hrs(f.horasCuadradas),
      hrs(f.delta),
    ]);
    if (totalesTabla && resultados.length > 1) {
      body.push([
        'TOTAL',
        eur(totalesTabla.comparativa),
        eur(totalesTabla.real),
        '—',
        eur(totalesTabla.importePersonal),
        '—',
        hrs(totalesTabla.horasPosibles),
        hrs(totalesTabla.horasCuadradas),
        hrs(tDelta),
      ]);
    }

    const COL_DELTA = 8;
    const verdeFill: [number, number, number] = [220, 252, 231];
    const rojoFill: [number, number, number] = [254, 226, 226];
    const grisFill: [number, number, number] = [241, 245, 249];
    const verdeText: [number, number, number] = [22, 163, 74];
    const rojoText: [number, number, number] = [220, 38, 38];
    const grisText: [number, number, number] = [100, 116, 139];

    const aplicarEstiloDeltaPdf = (styles: { fontStyle?: string; fillColor?: [number, number, number]; textColor?: [number, number, number] }, delta: number | null) => {
      if (delta == null) return;
      styles.fontStyle = 'bold';
      if (delta > 0) {
        styles.fillColor = verdeFill;
        styles.textColor = verdeText;
      } else if (delta < 0) {
        styles.fillColor = rojoFill;
        styles.textColor = rojoText;
      } else {
        styles.fillColor = grisFill;
        styles.textColor = grisText;
      }
    };

    const { jsPDF: JsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc: jsPDF = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    let y = 12;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Horas por facturación', 14, y);
    y += 6;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60);
    doc.text(`Periodo: ${formatFecha(from)} → ${formatFecha(to)}`, 14, y);
    y += 4;
    doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
    y += 5;
    doc.setTextColor(0);

    if (gruposVisibles.length > 0) {
      autoTable(doc, {
        startY: y,
        head: [['Agrupación', 'Comparativa', 'Real', '€ a personal', 'Horas posibles', 'Horas cuadradas']],
        body: gruposVisibles.map((g) => [
          g.nombre,
          eur(g.comparativa),
          eur(g.real),
          eur(g.importePersonal),
          hrs(g.horasPosibles),
          hrs(g.horasCuadradas),
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [14, 165, 233] },
        margin: { left: 14, right: 14 },
      });
      const after = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
      y = (after?.finalY ?? y) + 6;
    }

    autoTable(doc, {
      startY: y,
      head: [['Local', 'Comparativa', 'Real', 'Ratio pers.', '€ a personal', '€/hora', 'Horas posibles', 'Horas cuadradas', 'Δ']],
      body,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [14, 165, 233] },
      margin: { left: 14, right: 14 },
      didParseCell: (data) => {
        if (data.column.index !== COL_DELTA || data.section !== 'body') return;
        const delta = data.row.index < filasExport.length
          ? filasExport[data.row.index]?.delta ?? null
          : tDelta;
        aplicarEstiloDeltaPdf(data.cell.styles, delta);
      },
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
  }, [resultados, filasExport, gruposVisibles, totalesTabla, from, to]);

  if (localesLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando locales…</Text>
      </View>
    );
  }

  if (localesError) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{localesError}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Horas por facturación</Text>
          <Text style={styles.subtitle}>Horas posibles por periodo y desglose por franjas de un día</Text>
        </View>
      </View>

      {localDropdownOpen && Platform.OS === 'web' && (
        <Pressable style={styles.dropdownBackdrop} onPress={() => setLocalDropdownOpen(false)} />
      )}

      <View style={[styles.filtersBlock, localDropdownOpen && styles.filtersBlockOnTop]}>
        <View style={[styles.filtersRow, localDropdownOpen && styles.filtersRowOnTop]}>
          <View style={[styles.filterField, styles.filterFieldLocals]}>
            <Text style={styles.filterLabel}>Locales</Text>
            <View style={styles.localPickerAnchor}>
              <TouchableOpacity
                style={[styles.formInput, styles.formInputRow]}
                onPress={() => setLocalDropdownOpen((o) => !o)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.formInputText, selectedLocalIds.length === 0 && styles.formInputPlaceholder]}
                  numberOfLines={1}
                >
                  {etiquetaLocales}
                </Text>
                <MaterialIcons name={localDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
              </TouchableOpacity>
              {localDropdownOpen && (
                <View style={styles.dropdownWrap}>
                  <TextInput
                    style={styles.dropdownSearch}
                    value={localSearch}
                    onChangeText={setLocalSearch}
                    placeholder="Buscar local…"
                    placeholderTextColor="#94a3b8"
                  />
                  <View style={styles.dropdownBulkRow}>
                    <TouchableOpacity onPress={seleccionarTodosFiltrados} style={styles.dropdownBulkBtn}>
                      <MaterialIcons name="done-all" size={14} color="#0ea5e9" />
                      <Text style={styles.dropdownBulkText}>Todos (lista)</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={quitarSeleccionFiltrados} style={styles.dropdownBulkBtn}>
                      <MaterialIcons name="remove-done" size={14} color="#64748b" />
                      <Text style={[styles.dropdownBulkText, { color: '#64748b' }]}>Quitar lista</Text>
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={styles.dropdownScroll} keyboardShouldPersistTaps="handled">
                    {localesFiltrados.length === 0 ? (
                      <View style={styles.dropdownOption}>
                        <Text style={styles.dropdownOptionText}>Sin resultados</Text>
                      </View>
                    ) : (
                      localesFiltrados.map((l, idx) => {
                        const id = l.id_Locales || '';
                        const on = id && selectedSet.has(id);
                        return (
                          <TouchableOpacity
                            key={id || `loc-${idx}`}
                            style={styles.dropdownOptionRow}
                            onPress={() => id && toggleLocal(id)}
                            activeOpacity={0.7}
                          >
                            <MaterialIcons
                              name={on ? 'check-box' : 'check-box-outline-blank'}
                              size={20}
                              color={on ? '#0ea5e9' : '#94a3b8'}
                            />
                            <Text style={styles.dropdownOptionText} numberOfLines={1}>{l.nombre || '—'}</Text>
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </ScrollView>
                </View>
              )}
            </View>
          </View>

          <View style={[styles.filterField, { minWidth: 132 }]}>
            <Text style={styles.filterLabel}>Desde</Text>
            <InputFecha style={styles.inputDmy} valueIso={from} onChangeIso={setFrom} />
          </View>

          <View style={[styles.filterField, { minWidth: 132 }]}>
            <Text style={styles.filterLabel}>Hasta</Text>
            <InputFecha style={styles.inputDmy} valueIso={to} onChangeIso={setTo} />
          </View>

          <TouchableOpacity
            style={[styles.consultarBtn, (loading || selectedLocalIds.length === 0) && styles.consultarBtnDisabled]}
            onPress={consultar}
            disabled={loading || selectedLocalIds.length === 0}
            activeOpacity={0.7}
          >
            {loading ? <ActivityIndicator size="small" color="#fff" /> : <MaterialIcons name="calculate" size={16} color="#fff" />}
            <Text style={styles.consultarBtnText}>{loading ? 'Calculando…' : 'Calcular'}</Text>
          </TouchableOpacity>
        </View>

        <View style={[styles.presetRow, localDropdownOpen && styles.agrupChipsRowBehind]}>
          <SelectorRangoSemana from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        </View>

        {agrupaciones.length > 0 && (
          <View style={[styles.agrupChipsRow, localDropdownOpen && styles.agrupChipsRowBehind]}>
            <Text style={styles.agrupChipsLabel}>Agrupaciones:</Text>
            {agrupaciones.map((ag) => {
              const ids = ag.localIds.filter((id) => localById.has(id));
              const activa = ids.length > 0 && ids.every((id) => selectedSet.has(id));
              return (
                <TouchableOpacity
                  key={ag.id}
                  style={[styles.agrupChip, activa && { backgroundColor: ag.color, borderColor: ag.color }]}
                  onPress={() => toggleAgrupacion(ag.localIds)}
                  activeOpacity={0.7}
                >
                  {!activa && <View style={[styles.agrupChipDot, { backgroundColor: ag.color }]} />}
                  <Text style={[styles.agrupChipText, activa && { color: '#fff' }]}>{ag.nombre}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <MaterialIcons name="error-outline" size={16} color="#dc2626" />
          <Text style={styles.errorBarText}>{error}</Text>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 24 }}>
        {resultados ? (
          <>
          <View style={styles.resultadosHeader}>
            <Text style={styles.rangoText}>
              {formatFecha(from)} → {formatFecha(to)} · {resultados.length} local{resultados.length !== 1 ? 'es' : ''}
            </Text>
            <View style={styles.exportAnchor}>
              <TouchableOpacity style={styles.exportMainBtn} onPress={() => setExportMenuOpen((o) => !o)} activeOpacity={0.7}>
                <MaterialIcons name="download" size={16} color="#0ea5e9" />
                <Text style={styles.exportMainBtnText}>Descargas</Text>
                <MaterialIcons name={exportMenuOpen ? 'expand-less' : 'expand-more'} size={16} color="#0ea5e9" />
              </TouchableOpacity>
              {exportMenuOpen && (
                <View style={styles.exportMenu}>
                  <TouchableOpacity style={styles.exportMenuItem} onPress={exportarExcel} activeOpacity={0.7}>
                    <MaterialIcons name="grid-on" size={16} color="#16a34a" />
                    <Text style={styles.exportMenuItemText}>Excel (.xlsx)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.exportMenuItem, styles.exportMenuItemLast]} onPress={exportarPDF} activeOpacity={0.7}>
                    <MaterialIcons name="picture-as-pdf" size={16} color="#dc2626" />
                    <Text style={styles.exportMenuItemText}>PDF (.pdf)</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>

          {resultados.some((r) => r.ratioPersonal == null) && (
            <View style={styles.avisoRatio}>
              <MaterialIcons name="info-outline" size={16} color="#b45309" />
              <Text style={styles.avisoRatioText}>
                Hay locales sin “Ratio personal (%)” configurado; no se calculan sus horas. Defínelo en el módulo de Locales.
              </Text>
              <TouchableOpacity style={styles.avisoRatioBtn} onPress={() => router.push('/locales' as never)} activeOpacity={0.7}>
                <MaterialIcons name="open-in-new" size={14} color="#0ea5e9" />
                <Text style={styles.avisoRatioBtnText}>Ir a Locales</Text>
              </TouchableOpacity>
            </View>
          )}

          {gruposVisibles.length > 0 && (
            <View style={styles.seccion}>
              <Text style={styles.seccionTitulo}>Agrupaciones</Text>
              {gruposVisibles.map((g) => {
                const delta = g.horasPosibles != null && g.horasCuadradas != null ? g.horasPosibles - g.horasCuadradas : null;
                return (
                  <View key={g.id} style={[styles.grupoCard, { borderLeftColor: g.color }]}>
                    <View style={styles.grupoHeader}>
                      <Text style={styles.grupoNombre}>{g.nombre}</Text>
                      <Text style={styles.grupoMeta}>{g.nLocales} local{g.nLocales !== 1 ? 'es' : ''}</Text>
                    </View>
                    <View style={styles.grupoMetricsRow}>
                      <Metric label="Comparativa" value={formatEur(g.comparativa)} />
                      <Metric label="Real" value={formatEur(g.real)} />
                      <Metric label="€ a personal" value={g.importePersonal != null ? formatEur(g.importePersonal) : '—'} />
                      <Metric label="Horas posibles" value={formatHoras(g.horasPosibles)} strong />
                      <Metric label="Horas cuadradas" value={formatHoras(g.horasCuadradas)} />
                      <View style={styles.metric}>
                        <Text style={styles.metricLabel}>Δ posibles − cuadradas</Text>
                        <DeltaBadge delta={delta} />
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          <View style={styles.seccion}>
            <Text style={styles.seccionTitulo}>Por local</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                <View style={styles.tableHeader}>
                  <View style={[styles.cellHeader, { width: 200 }]}><Text style={styles.cellHeaderText}>Local</Text></View>
                  <View style={[styles.cellHeader, { width: 120 }]}><Text style={styles.cellHeaderText}>Comparativa</Text></View>
                  <View style={[styles.cellHeader, { width: 120 }]}><Text style={styles.cellHeaderText}>Real</Text></View>
                  <View style={[styles.cellHeader, { width: 80 }]}><Text style={styles.cellHeaderText}>Ratio pers.</Text></View>
                  <View style={[styles.cellHeader, { width: 110 }]}><Text style={styles.cellHeaderText}>€ a personal</Text></View>
                  <View style={[styles.cellHeader, { width: 90 }]}><Text style={styles.cellHeaderText}>€ / hora</Text></View>
                  <View style={[styles.cellHeader, { width: 110 }]}><Text style={styles.cellHeaderText}>Horas posibles</Text></View>
                  <View style={[styles.cellHeader, { width: 110 }]}><Text style={styles.cellHeaderText}>Horas cuadradas</Text></View>
                  <View style={[styles.cellHeader, { width: 90 }]}><Text style={styles.cellHeaderText}>Δ</Text></View>
                </View>
                {resultados.map((r, idx) => {
                  const imp = importeAPersonal(r.comparativa, r.ratioPersonal);
                  const hp = horasPosibles(r.comparativa, r.localId, r.ratioPersonal);
                  const hc = r.minutosCuadrante != null ? r.minutosCuadrante / 60 : null;
                  const delta = hp != null && hc != null ? hp - hc : null;
                  const sinRatio = r.ratioPersonal == null;
                  return (
                    <View key={r.localId} style={[styles.row, { backgroundColor: idx % 2 === 0 ? '#fff' : '#f8fafc' }]}>
                      <View style={[styles.cell, { width: 200, alignItems: 'flex-start' }]}>
                        <Text style={styles.cellTextNombre} numberOfLines={1}>{r.nombre}</Text>
                        {!r.tieneAgora && <Text style={styles.cellSubtext}>sin Ágora</Text>}
                        {!r.tieneFactorial && <Text style={styles.cellSubtext}>sin Factorial</Text>}
                        {sinRatio && <Text style={styles.cellSubtextWarn}>sin ratio personal</Text>}
                      </View>
                      <View style={[styles.cell, { width: 120 }]}><Text style={styles.cellText}>{formatEur(r.comparativa)}</Text></View>
                      <View style={[styles.cell, { width: 120 }]}><Text style={styles.cellText}>{formatEur(r.real)}</Text></View>
                      <View style={[styles.cell, { width: 80 }]}><Text style={styles.cellText}>{r.ratioPersonal != null ? `${r.ratioPersonal}%` : '—'}</Text></View>
                      <View style={[styles.cell, { width: 110 }]}><Text style={styles.cellText}>{imp != null ? formatEur(imp) : '—'}</Text></View>
                      <View style={[styles.cell, { width: 90 }]}>
                        <RatioInput valor={ratios[r.localId] || 0} defecto={importeDefecto} onCommit={(n) => guardarRatio(r.localId, n)} />
                      </View>
                      <View style={[styles.cell, { width: 110 }]}><Text style={[styles.cellText, styles.cellStrong]}>{formatHoras(hp)}</Text></View>
                      <View style={[styles.cell, { width: 110 }]}><Text style={styles.cellText}>{formatHoras(hc)}</Text></View>
                      <View style={[styles.cell, styles.cellDelta]}>
                        <DeltaBadge delta={delta} />
                      </View>
                    </View>
                  );
                })}
                {totalesTabla && resultados.length > 1 && (() => {
                  const tDelta = totalesTabla.horasPosibles != null && totalesTabla.horasCuadradas != null
                    ? totalesTabla.horasPosibles - totalesTabla.horasCuadradas
                    : null;
                  return (
                    <View style={[styles.row, styles.rowTotal]}>
                      <View style={[styles.cell, { width: 200, alignItems: 'flex-start' }]}><Text style={styles.cellTotalText}>Total</Text></View>
                      <View style={[styles.cell, { width: 120 }]}><Text style={styles.cellTotalText}>{formatEur(totalesTabla.comparativa)}</Text></View>
                      <View style={[styles.cell, { width: 120 }]}><Text style={styles.cellTotalText}>{formatEur(totalesTabla.real)}</Text></View>
                      <View style={[styles.cell, { width: 80 }]}><Text style={styles.cellTotalText}>—</Text></View>
                      <View style={[styles.cell, { width: 110 }]}><Text style={styles.cellTotalText}>{totalesTabla.importePersonal != null ? formatEur(totalesTabla.importePersonal) : '—'}</Text></View>
                      <View style={[styles.cell, { width: 90 }]}><Text style={styles.cellTotalText}>—</Text></View>
                      <View style={[styles.cell, { width: 110 }]}><Text style={styles.cellTotalText}>{formatHoras(totalesTabla.horasPosibles)}</Text></View>
                      <View style={[styles.cell, { width: 110 }]}><Text style={styles.cellTotalText}>{formatHoras(totalesTabla.horasCuadradas)}</Text></View>
                      <View style={[styles.cell, styles.cellDelta]}>
                        <DeltaBadge delta={tDelta} />
                      </View>
                    </View>
                  );
                })()}
              </View>
            </ScrollView>
            <Text style={styles.ayudaText}>
              € a personal = facturado comparativa × (Ratio personal % del local). Horas posibles = € a personal ÷ (€ por hora). El € por hora se guarda por local. Δ = horas posibles − horas ya cuadradas.
            </Text>
          </View>
          </>
        ) : null}

        <View style={styles.seccionFranjas}>
          <View style={styles.franjasTituloRow}>
            <View style={{ flex: 1, minWidth: 200 }}>
              <Text style={styles.seccionTitulo}>Desglose por franjas, día a día</Text>
              <Text style={styles.seccionSubtitulo}>
                Horas posibles por tramo horario para cada día del rango (Desde/Hasta), por local. Usa la venta comparativa con la misma lógica que Cajas → Objetivos.
              </Text>
            </View>
            {resultadosFranjas && resultadosFranjas.length > 0 ? (
              <View style={styles.exportAnchor}>
                <TouchableOpacity style={styles.exportMainBtn} onPress={() => setFranjasExportMenuOpen((o) => !o)} activeOpacity={0.7}>
                  <MaterialIcons name="download" size={16} color="#0ea5e9" />
                  <Text style={styles.exportMainBtnText}>Descargas</Text>
                  <MaterialIcons name={franjasExportMenuOpen ? 'expand-less' : 'expand-more'} size={16} color="#0ea5e9" />
                </TouchableOpacity>
                {franjasExportMenuOpen && (
                  <View style={styles.exportMenu}>
                    <TouchableOpacity style={styles.exportMenuItem} onPress={exportarFranjasExcel} activeOpacity={0.7}>
                      <MaterialIcons name="grid-on" size={16} color="#16a34a" />
                      <Text style={styles.exportMenuItemText}>Excel (.xlsx)</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.exportMenuItem, styles.exportMenuItemLast]} onPress={exportarFranjasPDF} activeOpacity={0.7}>
                      <MaterialIcons name="picture-as-pdf" size={16} color="#dc2626" />
                      <Text style={styles.exportMenuItemText}>PDF (.pdf)</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ) : null}
          </View>

          <View style={styles.franjasToolbar}>
            <View style={[styles.filterField, { flex: 1, minWidth: 220, maxWidth: 360 }]}>
              <Text style={styles.filterLabel}>Plantilla de franjas</Text>
              <SelectorDesplegable
                placeholder="Selecciona plantilla…"
                icono="view-timeline"
                tituloLista="Plantilla de franjas"
                iconoLista="view-timeline"
                valorId={plantillaFranjasId || null}
                vacioTexto="Aún no hay plantillas de franjas."
                vacioAccion={{
                  texto: 'Crear plantilla',
                  onPress: () => router.push('/cajas/franjas-horarias' as never),
                }}
                opciones={plantillas.map((p) => {
                  const preview = p.franjas.slice(0, 3).map((f) => `${f.desde}–${f.hasta}`).join(' · ');
                  return {
                    id: p.plantillaId,
                    titulo: p.nombre,
                    subtitulo: `${p.franjas.length} ${p.franjas.length === 1 ? 'franja' : 'franjas'}${preview ? ` · ${preview}${p.franjas.length > 3 ? '…' : ''}` : ''}`,
                    icono: 'schedule' as const,
                  };
                })}
                onSeleccionar={setPlantillaFranjasId}
              />
            </View>
            <TouchableOpacity
              style={[styles.consultarBtn, (loadingFranjas || selectedLocalIds.length === 0) && styles.consultarBtnDisabled]}
              onPress={consultarFranjas}
              disabled={loadingFranjas || selectedLocalIds.length === 0}
              activeOpacity={0.7}
            >
              {loadingFranjas ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialIcons name="schedule" size={16} color="#fff" />
              )}
              <Text style={styles.consultarBtnText}>
                {loadingFranjas
                  ? progresoFranjas
                    ? `Calculando… ${progresoFranjas.hechas}/${progresoFranjas.total}`
                    : 'Calculando…'
                  : 'Calcular franjas'}
              </Text>
            </TouchableOpacity>
          </View>

          {errorFranjas ? (
            <View style={styles.errorBar}>
              <MaterialIcons name="error-outline" size={16} color="#dc2626" />
              <Text style={styles.errorBarText}>{errorFranjas}</Text>
            </View>
          ) : null}

          {resultadosFranjas && resultadosFranjas.length > 0 ? (
            resultadosFranjas.map((loc) => (
              <View key={loc.localId} style={styles.franjasLocalCard}>
                <View style={styles.franjasLocalHeader}>
                  <Text style={styles.franjasLocalNombre}>{loc.nombre}</Text>
                  {loc.tieneAgora ? (
                    <Text style={styles.franjasLocalMeta}>
                      {formatFecha(from)} → {formatFecha(to)}
                      {loc.ratioPersonal != null ? ` · ${loc.ratioPersonal}% personal` : ''}
                    </Text>
                  ) : (
                    <Text style={styles.franjasLocalAviso}>{loc.aviso ?? 'Sin datos'}</Text>
                  )}
                </View>
                {loc.tieneAgora && loc.dias.length > 0 ? (
                  <>
                    <ScrollView horizontal showsHorizontalScrollIndicator>
                      <View>
                        <View style={styles.tableHeader}>
                          <View style={[styles.cellHeader, { width: 130 }]}><Text style={styles.cellHeaderText}>Día</Text></View>
                          {etiquetasFranjas.map((et) => (
                            <View key={et} style={[styles.cellHeader, { width: 110 }]}>
                              <Text style={styles.cellHeaderText} numberOfLines={2}>{et}</Text>
                            </View>
                          ))}
                          <View style={[styles.cellHeader, { width: 90 }]}><Text style={styles.cellHeaderText}>Total día</Text></View>
                        </View>
                        {loc.dias.map((d, idx) => (
                          <View key={d.fecha} style={[styles.row, { backgroundColor: idx % 2 === 0 ? '#fff' : '#f8fafc' }]}>
                            <View style={[styles.cell, { width: 130, alignItems: 'flex-start' }]}>
                              <Text style={styles.cellTextNombre}>{etiquetaDiaSemanaFecha(d.fecha)}</Text>
                            </View>
                            {d.celdas.map((c, ci) => (
                              <View key={ci} style={[styles.cell, { width: 110 }]}>
                                <Text style={[styles.cellText, styles.cellStrong]}>{formatHoras(c.horasPosibles)}</Text>
                                <Text style={styles.cellSubComp}>{formatEur(c.comparativa)}</Text>
                              </View>
                            ))}
                            <View style={[styles.cell, { width: 90 }]}>
                              <Text style={[styles.cellText, styles.cellStrong]}>{formatHoras(d.totalHorasPosibles)}</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                    {loc.aviso ? <Text style={styles.franjasLocalAviso}>{loc.aviso}</Text> : null}
                    <Text style={styles.franjasCeldaLeyenda}>En cada celda: horas posibles (arriba) y venta comparativa de esa franja (abajo).</Text>
                  </>
                ) : loc.tieneAgora ? (
                  <Text style={styles.franjasHint}>Sin datos para este local en el rango.</Text>
                ) : null}
              </View>
            ))
          ) : !loadingFranjas && !errorFranjas ? (
            <Text style={styles.franjasHint}>
              Elige locales y rango arriba, una plantilla de franjas y pulsa «Calcular franjas».
            </Text>
          ) : null}

          <Text style={styles.ayudaText}>
            Horas posibles por franja = (comparativa de la franja × ratio personal %) ÷ (€/hora del local). Usa los mismos ratios que el resumen por periodo. Máx. 31 días por consulta.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Metric({ label, value, strong, color }: { label: string; value: string; strong?: boolean; color?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, strong && styles.metricValueStrong, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },

  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  backBtn: { width: 36, height: 36, borderRadius: 8, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 12, color: '#94a3b8', marginTop: 2 },

  dropdownBackdrop: {
    ...Platform.select({
      web: { position: 'fixed' as const, left: 0, right: 0, top: 0, bottom: 0, zIndex: DROPDOWN_Z - 1 },
      default: {},
    }),
  },

  filtersBlock: { marginBottom: 8, position: 'relative' as const, zIndex: 1, overflow: 'visible' as const },
  filtersBlockOnTop: { zIndex: DROPDOWN_Z, ...(Platform.OS !== 'web' ? { elevation: 24 } : {}) },
  filtersRow: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12, overflow: 'visible' as const },
  filtersRowOnTop: { position: 'relative' as const, zIndex: DROPDOWN_Z + 2 },
  filterField: { flexShrink: 0 },
  filterFieldLocals: { minWidth: 260, flexGrow: 0, ...(Platform.OS === 'web' ? { maxWidth: 380 } : {}) },
  localPickerAnchor: { position: 'relative' as const },
  filterLabel: { fontSize: 10, fontWeight: '500', color: '#475569', marginBottom: 4 },

  formInput: {
    backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0',
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, color: '#334155', minHeight: 32,
  },
  formInputRow: { flexDirection: 'row', alignItems: 'center' },
  formInputText: { fontSize: 13, color: '#334155', flex: 1 },
  formInputPlaceholder: { color: '#94a3b8' },

  inputDmy: {
    backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0',
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, color: '#334155', minHeight: 32,
  },

  dropdownWrap: {
    marginTop: 4, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', maxHeight: 300,
    position: 'absolute' as const, top: '100%', left: 0, right: 0, zIndex: DROPDOWN_Z + 1,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }
      : { elevation: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 16 }),
  },
  dropdownSearch: {
    paddingVertical: 6, paddingHorizontal: 8, fontSize: 11, color: '#334155',
    backgroundColor: '#f8fafc', borderBottomWidth: 1, borderBottomColor: '#e2e8f0',
  },
  dropdownBulkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 6, paddingHorizontal: 8,
    borderBottomWidth: 1, borderBottomColor: '#f1f5f9', backgroundColor: '#fff',
  },
  dropdownBulkBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dropdownBulkText: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  dropdownScroll: { maxHeight: 240 },
  dropdownOption: { paddingVertical: 8, paddingHorizontal: 10 },
  dropdownOptionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 10,
    borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  dropdownOptionText: { fontSize: 12, color: '#334155', flex: 1 },

  consultarBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14,
    borderRadius: 8, backgroundColor: '#0ea5e9', minHeight: 32,
  },
  consultarBtnDisabled: { opacity: 0.5 },
  consultarBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  presetRow: { marginTop: 10, position: 'relative' as const, zIndex: 1 },
  agrupChipsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 10, position: 'relative' as const, zIndex: 1 },
  agrupChipsRowBehind: { zIndex: 0 },
  agrupChipsLabel: { fontSize: 11, color: '#64748b', fontWeight: '600', marginRight: 2 },
  agrupChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 10,
    borderRadius: 14, borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#fff',
  },
  agrupChipDot: { width: 8, height: 8, borderRadius: 4 },
  agrupChipText: { fontSize: 11, color: '#334155', fontWeight: '600' },

  errorBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fee2e2', borderWidth: 1, borderColor: '#fecaca',
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, marginBottom: 8,
  },
  errorBarText: { fontSize: 12, color: '#dc2626', flex: 1 },

  scroll: { flex: 1, position: 'relative' as const, zIndex: 0 },
  resultadosHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: 8, marginBottom: 8,
    position: 'relative' as const, zIndex: 30,
  },
  rangoText: { fontSize: 12, color: '#64748b' },
  exportAnchor: { position: 'relative' as const, zIndex: 20 },
  exportMainBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8,
    borderWidth: 1, borderColor: '#bae6fd', backgroundColor: '#e0f2fe',
  },
  exportMainBtnText: { fontSize: 12, fontWeight: '700', color: '#0ea5e9' },
  exportMenu: {
    position: 'absolute' as const, top: '100%', right: 0, marginTop: 4,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8,
    minWidth: 150, overflow: 'hidden', zIndex: 21,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }
      : { elevation: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.16, shadowRadius: 12 }),
  },
  exportMenuItem: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 9, paddingHorizontal: 12,
    borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  exportMenuItemLast: { borderBottomWidth: 0 },
  exportMenuItemText: { fontSize: 12, color: '#334155', fontWeight: '600' },

  seccion: { marginBottom: 16 },
  seccionTitulo: { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 8 },
  seccionSubtitulo: { fontSize: 12, color: '#64748b', marginBottom: 10, marginTop: -4 },
  seccionFranjas: {
    marginTop: 8,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  franjasTituloRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, zIndex: 20 },
  franjasToolbar: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12, marginBottom: 12 },
  franjasLocalCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  franjasLocalHeader: { marginBottom: 8 },
  franjasLocalNombre: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  franjasLocalMeta: { fontSize: 11, color: '#64748b', marginTop: 2 },
  franjasLocalAviso: { fontSize: 11, color: '#b45309', marginTop: 4 },
  franjasHint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginVertical: 8 },
  franjasCeldaLeyenda: { fontSize: 10, color: '#94a3b8', fontStyle: 'italic', marginTop: 6 },
  cellSubComp: { fontSize: 9, color: '#94a3b8', marginTop: 1 },

  grupoCard: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderLeftWidth: 4,
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  grupoHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  grupoNombre: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  grupoMeta: { fontSize: 11, color: '#94a3b8' },
  grupoMetricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },

  metric: { minWidth: 110 },
  metricLabel: { fontSize: 10, color: '#94a3b8', marginBottom: 2 },
  metricValue: { fontSize: 14, color: '#334155', fontWeight: '600' },
  metricValueStrong: { fontSize: 16, fontWeight: '700', color: '#0ea5e9' },

  tableHeader: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderBottomWidth: 1, borderBottomColor: '#cbd5e1' },
  cellHeader: { paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: '#cbd5e1', justifyContent: 'center' },
  cellHeaderText: { fontSize: 10, fontWeight: '600', color: '#334155' },

  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  rowTotal: { backgroundColor: '#e0f2fe', borderTopWidth: 2, borderTopColor: '#bae6fd' },
  cellTotalText: { fontSize: 11, fontWeight: '700', color: '#0c4a6e' },
  cell: { paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: '#e2e8f0', justifyContent: 'center', alignItems: 'flex-start' },
  cellText: { fontSize: 11, color: '#475569' },
  cellStrong: { fontWeight: '700', color: '#0c4a6e' },
  cellTextNombre: { fontSize: 11, fontWeight: '600', color: '#334155' },
  cellSubtext: { fontSize: 8, color: '#f59e0b', marginTop: 2 },
  cellSubtextWarn: { fontSize: 8, color: '#dc2626', marginTop: 2, fontWeight: '600' },
  cellDelta: { width: 90, alignItems: 'center' },
  deltaBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'center',
  },
  deltaBadgeText: { fontSize: 10, fontWeight: '600' },

  avisoRatio: {
    flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    backgroundColor: '#fef3c7', borderWidth: 1, borderColor: '#fde68a',
    borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 10,
  },
  avisoRatioText: { fontSize: 12, color: '#92400e', flex: 1, minWidth: 180 },
  avisoRatioBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8,
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#0ea5e9',
  },
  avisoRatioBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },

  ratioInput: {
    backgroundColor: '#fff', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 6,
    paddingHorizontal: 6, paddingVertical: 3, fontSize: 11, color: '#334155', minWidth: 70,
  },
  ratioInputHeredado: { borderStyle: 'dashed' as const, backgroundColor: '#f8fafc' },

  ayudaText: { fontSize: 10, color: '#94a3b8', marginTop: 8, fontStyle: 'italic' },
});
