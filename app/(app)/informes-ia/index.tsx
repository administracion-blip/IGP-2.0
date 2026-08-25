import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useIaGruposFamilias } from '../../hooks/useIaGruposFamilias';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { InputFecha } from '../../components/InputFecha';
import { RangoFechas } from '../../components/RangoFechas';
import { CollapsibleSection } from '../../components/CollapsibleSection';
import { VistaDiaADia, type DatosDiaADia } from '../../components/informes-ia/VistaDiaADia';
import {
  VistaVentasPorArticulo,
  type DatosVentasPorArticulo,
  localVentasTieneDatos,
  slugPdfVentasArticuloLocal,
} from '../../components/informes-ia/VistaVentasPorArticulo';
import { IaGruposFamiliasModal } from '../../components/informes-ia/IaGruposFamiliasModal';
import { InformeResumenRico } from '../../components/informes-ia/InformeResumenRico';
import {
  ObjetivoFacturacionHoyBox,
  tieneObjetivoFacturacionHoyUtil,
} from '../../components/informes-ia/ObjetivoFacturacionHoyBox';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatId6 } from '../../utils/idFormat';
import { fechaInformeDiaAnteriorIso } from '../../lib/jornadaNegocio';
import { stripObjetivoFacturacionHoyMarkdown } from '../../lib/stripObjetivoFacturacionHoyMarkdown';
import { descargarPdfInformeIa } from '../../lib/informesIaPdf';
import { descargarPdfDesdeNodo } from '../../lib/informesIaPdfCapture';
import { MIN_TOUCH } from '../../constants/layout';

type OpcionParam = { valor: string; etiqueta: string };

type ParametroTipo =
  | 'fecha'
  | 'local'
  | 'texto'
  | 'numero'
  | 'opcion'
  | 'locales'
  | 'familias'
  | 'grupos_familias';

type ParametroDef = {
  nombre: string;
  tipo: ParametroTipo;
  requerido?: boolean;
  etiqueta?: string;
  defecto?: string | number;
  opciones?: OpcionParam[];
};

const PARAMS_ESPECIALES_VENTAS = new Set<ParametroTipo>(['locales', 'familias', 'grupos_familias']);

type VentasArticuloParams = {
  fechaDesde: string;
  fechaHasta: string;
  localIds: string[];
  familiaIds: string[];
  grupoIds: string[];
  agruparPorLocal: boolean;
};

function hoyIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function inicioAnoIsoLocal(): string {
  return `${new Date().getFullYear()}-01-01`;
}

function ventasParamsDefault(): VentasArticuloParams {
  return {
    fechaDesde: inicioAnoIsoLocal(),
    fechaHasta: hoyIsoLocal(),
    localIds: [],
    familiaIds: [],
    grupoIds: [],
    agruparPorLocal: false,
  };
}

function esSeleccionTodos(ids: string[], totalDisponibles: number): boolean {
  return ids.length === 0 || (totalDisponibles > 0 && ids.length === totalDisponibles);
}

type Fuente = {
  clave: string;
  nombre: string;
  descripcion: string;
  permiso: string;
  parametros: ParametroDef[];
};

type Informe = {
  informeId: string;
  fuente: string;
  parametros: Record<string, unknown>;
  promptId?: string;
  promptNombre?: string;
  resumen: string | null;
  datosJson?: unknown;
  modelo?: string | null;
  costeTokens?: { prompt: number; completion: number };
  generadoPorNombre?: string;
  generadoEn: string;
};

type Plantilla = {
  promptId: string;
  nombre: string;
  instrucciones: string;
  esDefault?: boolean;
  deCodigo?: boolean;
};

type LocalItem = {
  id_Locales?: string | number;
  nombre?: string;
  Nombre?: string;
  sede?: string;
  Sede?: string;
};

function esLocalSedeGrupoParipe(loc: LocalItem): boolean {
  const s = String(loc.sede ?? loc.Sede ?? '').toUpperCase();
  return s.includes('PARIPE');
}

const FUENTE_LABELS_PDF: Record<string, string> = {
  dia_a_dia: 'Día a día',
  objetivos_mes: 'Objetivos del mes',
  ventas_hora: 'Ventas por hora',
  compras_variaciones: 'Variaciones de compras',
  ventas_por_articulo: 'Ventas por artículo',
};

function etiquetaFuentePdf(clave?: string): string {
  if (!clave) return 'Informe';
  return FUENTE_LABELS_PDF[clave] || clave.replace(/_/g, ' ');
}

function fechaParametroInforme(informe: Informe): string {
  const params = informe.parametros || {};
  const fechaParam = params.fecha;
  if (typeof fechaParam === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fechaParam)) {
    const [y, m, d] = fechaParam.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  const desde = params.fechaDesde;
  const hasta = params.fechaHasta;
  if (
    typeof desde === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(desde) &&
    typeof hasta === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(hasta)
  ) {
    const [y1, m1, d1] = desde.slice(0, 10).split('-');
    const [y2, m2, d2] = hasta.slice(0, 10).split('-');
    return `${d1}/${m1}/${y1} – ${d2}/${m2}/${y2}`;
  }
  const dj = informe.datosJson as { fecha?: string; meta?: { fechaDesde?: string; fechaHasta?: string } } | undefined;
  if (dj?.fecha && /^\d{4}-\d{2}-\d{2}/.test(dj.fecha)) {
    const [y, m, d] = dj.fecha.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  if (dj?.meta?.fechaDesde && dj?.meta?.fechaHasta) {
    const [y1, m1, d1] = String(dj.meta.fechaDesde).slice(0, 10).split('-');
    const [y2, m2, d2] = String(dj.meta.fechaHasta).slice(0, 10).split('-');
    return `${d1}/${m1}/${y1} – ${d2}/${m2}/${y2}`;
  }
  if (informe.generadoEn) {
    try {
      return new Date(informe.generadoEn).toLocaleDateString('es-ES');
    } catch {
      /* ignore */
    }
  }
  return new Date().toLocaleDateString('es-ES');
}

function slugPdfCaptura(informe: Informe): string {
  const fuente = String(informe.fuente || 'informe')
    .replace(/\s+/g, '_')
    .replace(/[^\w\-]/g, '')
    .slice(0, 24);
  const id = String(informe.informeId || '').slice(0, 8) || 'sinid';
  return `informe_ia_${fuente}_${id}`;
}

function fechaHora(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function InformesIaScreen() {
  const router = useRouter();
  const { fuente: fuenteParam } = useLocalSearchParams<{ fuente?: string }>();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackPanels } = useBreakpoint();
  const {
    grupos: iaGrupos,
    familias: iaFamilias,
    loadingGrupos: loadingIaGrupos,
    loadingFamilias: loadingIaFamilias,
    cargarGrupos: cargarIaGrupos,
    cargarFamilias: cargarIaFamilias,
    guardarGrupo: guardarIaGrupo,
    borrarGrupo: borrarIaGrupo,
  } = useIaGruposFamilias();

  const [fuentes, setFuentes] = useState<Fuente[]>([]);
  const [iaDisponible, setIaDisponible] = useState(true);
  const [fuenteClave, setFuenteClave] = useState('');
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
  const [ventasParams, setVentasParams] = useState<VentasArticuloParams>(ventasParamsDefault);
  const [busquedaLocales, setBusquedaLocales] = useState('');
  const [busquedaFamilias, setBusquedaFamilias] = useState('');
  const [modalGruposOpen, setModalGruposOpen] = useState(false);
  const [plantillas, setPlantillas] = useState<Plantilla[]>([]);
  const [promptId, setPromptId] = useState('default');

  const [loadingFuentes, setLoadingFuentes] = useState(true);
  const [generando, setGenerando] = useState(false);
  const [exportandoPdf, setExportandoPdf] = useState(false);
  const [informe, setInforme] = useState<Informe | null>(null);
  const [historial, setHistorial] = useState<Informe[]>([]);
  const [error, setError] = useState<string | null>(null);
  const capturaPdfRef = useRef<View>(null);

  const puedeVer = hasPermiso('ia.informes');
  const puedeGestionar = hasPermiso('ia.prompts_gestionar');
  const puedeAjustes = hasPermiso('ia.ajustes');
  const esVentasArticulo = fuenteClave === 'ventas_por_articulo';

  const fuente = useMemo(
    () => fuentes.find((f) => f.clave === fuenteClave) || null,
    [fuentes, fuenteClave],
  );

  const localesPermitidos = useMemo(
    () =>
      locales
        .map((l) => ({ id: formatId6(l.id_Locales), nombre: String(l.nombre ?? l.Nombre ?? '').trim() }))
        .filter((l) => l.nombre && localPermitido(l.nombre))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [locales, localPermitido],
  );

  /** Universo ventas por artículo: solo sede Grupo Paripe ∩ locales del usuario. */
  const localesGrupoParipe = useMemo(
    () =>
      locales
        .filter(esLocalSedeGrupoParipe)
        .map((l) => ({ id: formatId6(l.id_Locales), nombre: String(l.nombre ?? l.Nombre ?? '').trim() }))
        .filter((l) => l.nombre && localPermitido(l.nombre))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [locales, localPermitido],
  );

  const localesFiltrados = useMemo(() => {
    const base = fuenteClave === 'ventas_por_articulo' ? localesGrupoParipe : localesPermitidos;
    const q = busquedaLocales.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (l) => l.nombre.toLowerCase().includes(q) || l.id.toLowerCase().includes(q),
    );
  }, [fuenteClave, localesGrupoParipe, localesPermitidos, busquedaLocales]);

  const familiasFiltradas = useMemo(() => {
    const q = busquedaFamilias.trim().toLowerCase();
    if (!q) return iaFamilias;
    return iaFamilias.filter(
      (f) => f.nombre.toLowerCase().includes(q) || f.id.toLowerCase().includes(q),
    );
  }, [iaFamilias, busquedaFamilias]);

  const objetivoFacturacionHoyData = useMemo(() => {
    if (informe?.fuente !== 'dia_a_dia' || !informe.datosJson) return null;
    return (informe.datosJson as DatosDiaADia).objetivoFacturacionHoy ?? null;
  }, [informe]);

  const resumenDiaSinObjetivoFacturacion = useMemo(() => {
    if (informe?.fuente !== 'dia_a_dia') return informe?.resumen || '';
    // Solo recortar el subapartado IA si vamos a pintar el recuadro (evita perder texto en informes viejos / objetivo 0).
    if (tieneObjetivoFacturacionHoyUtil(objetivoFacturacionHoyData)) {
      return stripObjetivoFacturacionHoyMarkdown(informe.resumen);
    }
    return informe?.resumen || '';
  }, [informe, objetivoFacturacionHoyData]);

  useEffect(() => {
    setLoadingFuentes(true);
    apiFetch('/api/ia/fuentes')
      .then((r) => r.json())
      .then((d) => {
        const list: Fuente[] = Array.isArray(d.fuentes) ? d.fuentes : [];
        setFuentes(list);
        setIaDisponible(d.iaDisponible !== false);
        const preseleccion = typeof fuenteParam === 'string' ? fuenteParam : '';
        if (preseleccion && list.some((f) => f.clave === preseleccion)) {
          setFuenteClave(preseleccion);
        } else if (list.length === 1) {
          setFuenteClave(list[0].clave);
        }
      })
      .catch((e) => setError(errorMessage(e, 'No se pudieron cargar las fuentes')))
      .finally(() => setLoadingFuentes(false));
  }, [fuenteParam]);

  useEffect(() => {
    apiFetch('/api/locales')
      .then((r) => r.json())
      .then((d) => setLocales(Array.isArray(d.locales) ? d.locales : []))
      .catch(() => setLocales([]));
  }, []);

  const cargarHistorial = useCallback((clave: string) => {
    if (!clave) return;
    apiFetch(`/api/ia/informes?fuente=${encodeURIComponent(clave)}`)
      .then((r) => r.json())
      .then((d) => setHistorial(Array.isArray(d.informes) ? d.informes : []))
      .catch(() => setHistorial([]));
  }, []);

  const cargarPlantillas = useCallback((clave: string) => {
    if (!clave) return;
    apiFetch(`/api/ia/prompts?fuente=${encodeURIComponent(clave)}`)
      .then((r) => r.json())
      .then((d) => {
        const list: Plantilla[] = Array.isArray(d.plantillas) ? d.plantillas : [];
        setPlantillas(list);
        const porDefecto = list.find((p) => p.esDefault) || list[0];
        setPromptId(porDefecto ? porDefecto.promptId : 'default');
      })
      .catch(() => {
        setPlantillas([]);
        setPromptId('default');
      });
  }, []);

  useEffect(() => {
    setInforme(null);
    setError(null);
    setBusquedaLocales('');
    setBusquedaFamilias('');
    setModalGruposOpen(false);

    if (fuenteClave === 'ventas_por_articulo') {
      setVentasParams(ventasParamsDefault());
      setParams({});
      void cargarIaFamilias();
      void cargarIaGrupos();
    } else {
      const defs = fuentes.find((f) => f.clave === fuenteClave)?.parametros || [];
      const inicial: Record<string, string> = {};
      for (const p of defs) {
        if (PARAMS_ESPECIALES_VENTAS.has(p.tipo)) continue;
        if (p.defecto != null) {
          inicial[p.nombre] = String(p.defecto);
        } else if (p.tipo === 'fecha') {
          inicial[p.nombre] = fechaInformeDiaAnteriorIso();
        }
      }
      setParams(inicial);
    }

    if (fuenteClave) {
      cargarHistorial(fuenteClave);
      cargarPlantillas(fuenteClave);
    } else {
      setHistorial([]);
      setPlantillas([]);
      setPromptId('default');
    }
  }, [fuenteClave, fuentes, cargarHistorial, cargarPlantillas, cargarIaFamilias, cargarIaGrupos]);

  function toggleIdInList(
    key: 'localIds' | 'familiaIds',
    id: string,
    opts?: { totalDisponibles?: number },
  ) {
    setVentasParams((prev) => {
      const list = prev[key];
      const enModoTodos = list.length === 0;
      if (enModoTodos) {
        // Salir de «todos» y quedarse solo con este id
        return { ...prev, [key]: [id] };
      }
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      // Si se desmarcan todos los individuales → volver a «todos» (vacío)
      if (next.length === 0) return { ...prev, [key]: [] };
      const total = opts?.totalDisponibles ?? 0;
      if (total > 0 && next.length >= total) return { ...prev, [key]: [] };
      return { ...prev, [key]: next };
    });
  }

  function marcarTodosLocales() {
    setVentasParams((prev) => ({ ...prev, localIds: [] }));
  }

  function marcarTodasFamilias() {
    setVentasParams((prev) => ({
      ...prev,
      familiaIds: [],
      grupoIds: [],
    }));
  }

  function toggleGrupo(grupoId: string, _familiaIdsGrupo: string[]) {
    setVentasParams((prev) => {
      const activo = prev.grupoIds.includes(grupoId);
      return {
        ...prev,
        grupoIds: activo
          ? prev.grupoIds.filter((x) => x !== grupoId)
          : [...prev.grupoIds, grupoId],
      };
    });
  }

  async function generar(force = false) {
    if (!fuente) {
      setError('Selecciona una fuente');
      return;
    }

    let parametros: Record<string, unknown> = params;
    if (fuente.clave === 'ventas_por_articulo') {
      if (!ventasParams.fechaDesde || !ventasParams.fechaHasta) {
        setError('Indica un rango de fechas válido');
        return;
      }
      parametros = {
        fechaDesde: ventasParams.fechaDesde,
        fechaHasta: ventasParams.fechaHasta,
        localIds: ventasParams.localIds,
        familiaIds: ventasParams.familiaIds,
        grupoIds: ventasParams.grupoIds,
        agruparPorLocal: ventasParams.agruparPorLocal,
      };
    } else {
      for (const p of fuente.parametros) {
        if (PARAMS_ESPECIALES_VENTAS.has(p.tipo)) continue;
        if (p.requerido && !params[p.nombre]) {
          setError(`Falta el parámetro: ${p.etiqueta || p.nombre}`);
          return;
        }
      }
    }

    setGenerando(true);
    setError(null);
    try {
      const r = await apiFetch('/api/ia/informes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fuente: fuente.clave, parametros, promptId, force }),
        timeoutMs: 120_000,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo generar el informe');
      setInforme(d.informe as Informe);
      cargarHistorial(fuente.clave);
    } catch (e) {
      setError(errorMessage(e, 'Error al generar el informe'));
    } finally {
      setGenerando(false);
    }
  }

  async function abrirInforme(id: string) {
    if (!fuente) return;
    setError(null);
    try {
      const r = await apiFetch(`/api/ia/informes/${encodeURIComponent(id)}?fuente=${encodeURIComponent(fuente.clave)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo abrir el informe');
      setInforme(d.informe as Informe);
    } catch (e) {
      setError(errorMessage(e, 'Error al abrir el informe'));
    }
  }

  async function descargarPdf() {
    if (!informe || exportandoPdf) return;
    setExportandoPdf(true);
    setError(null);
    try {
      if (Platform.OS === 'web' && capturaPdfRef.current) {
        // modoPdf=true re-renderiza todas las gráficas; esperar paint
        const esperaMs =
          informe.fuente === 'dia_a_dia' || informe.fuente === 'ventas_por_articulo' ? 400 : 150;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            setTimeout(resolve, esperaMs);
          });
        });
        const node = capturaPdfRef.current as unknown as HTMLElement;

        const datosVentas =
          informe.fuente === 'ventas_por_articulo' &&
          informe.datosJson &&
          typeof informe.datosJson === 'object'
            ? (informe.datosJson as DatosVentasPorArticulo)
            : null;
        const localesConDatos = (datosVentas?.porLocal || []).filter(localVentasTieneDatos);
        const bloquesLocal = Array.from(
          node.querySelectorAll('[data-pdf-local]'),
        ) as HTMLElement[];

        if (datosVentas?.meta?.agruparPorLocal && bloquesLocal.length > 0) {
          if (localesConDatos.length === 0) {
            throw new Error('Ningún local tiene datos para exportar.');
          }
          const desde = datosVentas.meta?.fechaDesde;
          const hasta = datosVentas.meta?.fechaHasta;
          for (let i = 0; i < localesConDatos.length; i += 1) {
            const loc = localesConDatos[i];
            const lid = String(loc.localId || loc.nombre || '');
            const el =
              bloquesLocal.find((n) => n.getAttribute('data-pdf-local') === lid) ||
              bloquesLocal[i];
            if (!el) continue;
            const nombre =
              el.getAttribute('data-pdf-local-nombre') || loc.nombre || lid || `local_${i + 1}`;
            // eslint-disable-next-line no-await-in-loop
            await descargarPdfDesdeNodo(el, slugPdfVentasArticuloLocal(nombre, desde, hasta), {
              anadirFechaHoy: false,
            });
            if (i < localesConDatos.length - 1) {
              // eslint-disable-next-line no-await-in-loop
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 350);
              });
            }
          }
        } else {
          await descargarPdfDesdeNodo(node, slugPdfCaptura(informe));
        }
      } else {
        await descargarPdfInformeIa(informe);
      }
    } catch (e) {
      setError(errorMessage(e, 'No se pudo generar el PDF'));
    } finally {
      setExportandoPdf(false);
    }
  }

  async function onGuardarGrupoIa(input: {
    id?: string;
    nombre: string;
    familiaIds: string[];
    orden?: number;
    activo?: boolean;
  }) {
    await guardarIaGrupo(input);
    await cargarIaGrupos();
  }

  async function onBorrarGrupoIa(id: string) {
    await borrarIaGrupo(id);
    setVentasParams((prev) => ({
      ...prev,
      grupoIds: prev.grupoIds.filter((x) => x !== id),
    }));
    await cargarIaGrupos();
  }

  if (!puedeVer) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para ver Informes IA.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.formMax}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
              <MaterialIcons name="arrow-back" size={22} color="#334155" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Informes IA</Text>
              <Text style={styles.subtitle}>Resúmenes redactados sobre cifras deterministas</Text>
            </View>
            {puedeGestionar ? (
              <TouchableOpacity
                style={styles.gestionBtn}
                onPress={() => router.push('/informes-ia/plantillas' as never)}
              >
                <MaterialIcons name="tune" size={18} color="#0369a1" />
                <Text style={styles.gestionText}>Plantillas</Text>
              </TouchableOpacity>
            ) : null}
            {puedeAjustes ? (
              <TouchableOpacity
                style={styles.gestionBtn}
                onPress={() => router.push('/informes-ia/ajustes' as never)}
              >
                <MaterialIcons name="settings" size={18} color="#0369a1" />
                <Text style={styles.gestionText}>Ajustes</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {!iaDisponible ? (
            <View style={styles.avisoBox}>
              <MaterialIcons name="info-outline" size={18} color="#b45309" />
              <Text style={styles.avisoText}>
                La IA no está configurada en el servidor. Verás los datos en modo tabla, sin redacción.
              </Text>
            </View>
          ) : null}

          {loadingFuentes ? (
            <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 16 }} />
          ) : fuentes.length === 0 ? (
            <Text style={styles.hint}>No tienes fuentes de informe disponibles.</Text>
          ) : (
            <>
              <View style={[styles.panelRow, shouldStackPanels && styles.panelCol]}>
                <View style={[styles.field, styles.fieldWide]}>
                  <Text style={styles.label}>Fuente</Text>
                  <SelectorDesplegable
                    icono="insights"
                    iconoLista="insights"
                    tituloLista="Fuente de datos"
                    placeholder="Selecciona una fuente"
                    valorId={fuenteClave}
                    opciones={fuentes.map((f) => ({
                      id: f.clave,
                      titulo: f.nombre,
                      icono: 'insights' as const,
                    }))}
                    onSeleccionar={setFuenteClave}
                  />
                  {fuente?.descripcion ? (
                    <Text style={styles.fuenteDesc}>{fuente.descripcion}</Text>
                  ) : null}
                </View>

                {esVentasArticulo ? (
                  <>
                    <View style={[styles.field, styles.fieldWide]}>
                      <Text style={styles.label}>Periodo</Text>
                      <RangoFechas
                        desdeIso={ventasParams.fechaDesde}
                        hastaIso={ventasParams.fechaHasta}
                        onChangeDesde={(iso) =>
                          setVentasParams((prev) => ({ ...prev, fechaDesde: iso }))
                        }
                        onChangeHasta={(iso) =>
                          setVentasParams((prev) => ({ ...prev, fechaHasta: iso }))
                        }
                        fill
                      />
                    </View>

                    <View style={[styles.field, styles.fieldWide, styles.multiField]}>
                      <View style={styles.multiHead}>
                        <Text style={styles.label}>
                          Locales
                          {esSeleccionTodos(ventasParams.localIds, localesGrupoParipe.length)
                            ? ' · todos'
                            : ` (${ventasParams.localIds.length})`}
                        </Text>
                        <TouchableOpacity onPress={marcarTodosLocales} style={styles.chipTodos}>
                          <Text style={styles.chipTodosText}>Todos</Text>
                        </TouchableOpacity>
                      </View>
                      <TextInput
                        style={styles.searchInput}
                        value={busquedaLocales}
                        onChangeText={setBusquedaLocales}
                        placeholder="Buscar local…"
                        placeholderTextColor="#94a3b8"
                      />
                      <ScrollView
                        style={styles.multiList}
                        nestedScrollEnabled
                        keyboardShouldPersistTaps="handled"
                      >
                        {(() => {
                          const todosLoc = esSeleccionTodos(
                            ventasParams.localIds,
                            localesGrupoParipe.length,
                          );
                          return (
                            <>
                              <TouchableOpacity
                                style={[styles.checkRow, todosLoc && styles.checkRowSel]}
                                onPress={marcarTodosLocales}
                              >
                                <MaterialIcons
                                  name={todosLoc ? 'check-box' : 'check-box-outline-blank'}
                                  size={18}
                                  color={todosLoc ? '#0ea5e9' : '#94a3b8'}
                                />
                                <Text
                                  style={[styles.checkText, todosLoc && styles.checkTextSel]}
                                  numberOfLines={1}
                                >
                                  Todos mis locales (Grupo Paripe)
                                </Text>
                              </TouchableOpacity>
                              {localesFiltrados.map((l) => {
                                const sel = todosLoc || ventasParams.localIds.includes(l.id);
                                return (
                                  <TouchableOpacity
                                    key={l.id}
                                    style={[styles.checkRow, sel && styles.checkRowSel]}
                                    onPress={() =>
                                      toggleIdInList('localIds', l.id, {
                                        totalDisponibles: localesGrupoParipe.length,
                                      })
                                    }
                                  >
                                    <MaterialIcons
                                      name={sel ? 'check-box' : 'check-box-outline-blank'}
                                      size={18}
                                      color={sel ? '#0ea5e9' : '#94a3b8'}
                                    />
                                    <Text
                                      style={[styles.checkText, sel && styles.checkTextSel]}
                                      numberOfLines={1}
                                    >
                                      {l.nombre}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </>
                          );
                        })()}
                      </ScrollView>
                    </View>

                    <View style={[styles.field, styles.fieldWide, styles.multiField]}>
                      <View style={styles.multiHead}>
                        <Text style={styles.label}>
                          Familias
                          {esSeleccionTodos(ventasParams.familiaIds, iaFamilias.length) &&
                          ventasParams.grupoIds.length === 0
                            ? ' · todas'
                            : ventasParams.familiaIds.length > 0 || ventasParams.grupoIds.length > 0
                              ? ` (${ventasParams.familiaIds.length}${ventasParams.grupoIds.length ? ` +${ventasParams.grupoIds.length} grup.` : ''})`
                              : ' · todas'}
                        </Text>
                        <TouchableOpacity onPress={marcarTodasFamilias} style={styles.chipTodos}>
                          <Text style={styles.chipTodosText}>Todas</Text>
                        </TouchableOpacity>
                      </View>
                      <TextInput
                        style={styles.searchInput}
                        value={busquedaFamilias}
                        onChangeText={setBusquedaFamilias}
                        placeholder="Buscar familia…"
                        placeholderTextColor="#94a3b8"
                      />
                      {loadingIaFamilias ? (
                        <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 8 }} />
                      ) : (
                        <ScrollView
                          style={styles.multiList}
                          nestedScrollEnabled
                          keyboardShouldPersistTaps="handled"
                        >
                          {(() => {
                            const todasFam =
                              ventasParams.grupoIds.length === 0 &&
                              esSeleccionTodos(ventasParams.familiaIds, iaFamilias.length);
                            return (
                              <>
                                <TouchableOpacity
                                  style={[styles.checkRow, todasFam && styles.checkRowSel]}
                                  onPress={marcarTodasFamilias}
                                >
                                  <MaterialIcons
                                    name={todasFam ? 'check-box' : 'check-box-outline-blank'}
                                    size={18}
                                    color={todasFam ? '#0ea5e9' : '#94a3b8'}
                                  />
                                  <Text
                                    style={[styles.checkText, todasFam && styles.checkTextSel]}
                                    numberOfLines={1}
                                  >
                                    Todas las familias
                                  </Text>
                                </TouchableOpacity>
                                {familiasFiltradas.map((f) => {
                                  const sel = todasFam || ventasParams.familiaIds.includes(f.id);
                                  return (
                                    <TouchableOpacity
                                      key={f.id}
                                      style={[styles.checkRow, sel && styles.checkRowSel]}
                                      onPress={() =>
                                        toggleIdInList('familiaIds', f.id, {
                                          totalDisponibles: iaFamilias.length,
                                        })
                                      }
                                    >
                                      <MaterialIcons
                                        name={sel ? 'check-box' : 'check-box-outline-blank'}
                                        size={18}
                                        color={sel ? '#0ea5e9' : '#94a3b8'}
                                      />
                                      <Text
                                        style={[styles.checkText, sel && styles.checkTextSel]}
                                        numberOfLines={1}
                                      >
                                        {f.nombre}
                                      </Text>
                                    </TouchableOpacity>
                                  );
                                })}
                              </>
                            );
                          })()}
                        </ScrollView>
                      )}
                    </View>

                    <View style={[styles.field, styles.fieldWide]}>
                      <TouchableOpacity
                        style={[
                          styles.checkRow,
                          ventasParams.agruparPorLocal && styles.checkRowSel,
                          { borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
                        ]}
                        onPress={() =>
                          setVentasParams((prev) => ({
                            ...prev,
                            agruparPorLocal: !prev.agruparPorLocal,
                          }))
                        }
                      >
                        <MaterialIcons
                          name={
                            ventasParams.agruparPorLocal
                              ? 'check-box'
                              : 'check-box-outline-blank'
                          }
                          size={18}
                          color={ventasParams.agruparPorLocal ? '#0ea5e9' : '#94a3b8'}
                        />
                        <View style={{ flex: 1 }}>
                          <Text
                            style={[
                              styles.checkText,
                              ventasParams.agruparPorLocal && styles.checkTextSel,
                            ]}
                          >
                            Agrupar resumen por local
                          </Text>
                          <Text style={styles.hintInline}>
                            El resumen IA y las tablas se desglosan por local (ranking en
                            unidades).
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </View>

                    <View style={[styles.field, styles.fieldWide]}>
                      <View style={styles.multiHead}>
                        <Text style={styles.label}>Agrupaciones</Text>
                        <TouchableOpacity
                          style={styles.gestionarBtn}
                          onPress={() => setModalGruposOpen(true)}
                        >
                          <MaterialIcons name="folder-special" size={14} color="#0369a1" />
                          <Text style={styles.gestionarText}>Gestionar agrupaciones</Text>
                        </TouchableOpacity>
                      </View>
                      {loadingIaGrupos ? (
                        <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 6 }} />
                      ) : iaGrupos.length === 0 ? (
                        <Text style={styles.hintInline}>
                          Sin agrupaciones. Crea una desde «Gestionar agrupaciones».
                        </Text>
                      ) : (
                        <View style={styles.chipsRow}>
                          {iaGrupos.map((g) => {
                            const activo = ventasParams.grupoIds.includes(g.id);
                            return (
                              <TouchableOpacity
                                key={g.id}
                                style={[styles.grupoChip, activo && styles.grupoChipOn]}
                                onPress={() => toggleGrupo(g.id, g.familiaIds)}
                              >
                                <MaterialIcons
                                  name={activo ? 'check-circle' : 'radio-button-unchecked'}
                                  size={14}
                                  color={activo ? '#0369a1' : '#94a3b8'}
                                />
                                <Text
                                  style={[styles.grupoChipText, activo && styles.grupoChipTextOn]}
                                  numberOfLines={1}
                                >
                                  {g.nombre}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      )}
                    </View>
                  </>
                ) : (
                  (fuente?.parametros || [])
                    .filter((p) => !PARAMS_ESPECIALES_VENTAS.has(p.tipo))
                    .map((p) => (
                      <View key={p.nombre} style={styles.field}>
                        <Text style={styles.label}>
                          {p.etiqueta || p.nombre}
                          {p.requerido ? ' *' : ''}
                        </Text>
                        {p.tipo === 'local' ? (
                          <SelectorDesplegable
                            icono="store"
                            iconoLista="store"
                            tituloLista="Local"
                            placeholder="Todos mis locales"
                            buscador
                            buscadorPlaceholder="Buscar local…"
                            valorId={params[p.nombre] || ''}
                            opciones={[
                              { id: '', titulo: 'Todos mis locales', icono: 'apps' as const },
                              ...localesPermitidos.map((l) => ({
                                id: l.id,
                                titulo: l.nombre,
                                subtitulo: `ID ${l.id}`,
                                icono: 'store' as const,
                              })),
                            ]}
                            onSeleccionar={(id) => setParams((prev) => ({ ...prev, [p.nombre]: id }))}
                          />
                        ) : p.tipo === 'fecha' ? (
                          <InputFecha
                            valueIso={params[p.nombre] || ''}
                            onChangeIso={(iso) => setParams((prev) => ({ ...prev, [p.nombre]: iso }))}
                            placeholder="dd/mm/aaaa"
                          />
                        ) : p.tipo === 'opcion' ? (
                          <SelectorDesplegable
                            icono="tune"
                            iconoLista="tune"
                            tituloLista={p.etiqueta || p.nombre}
                            placeholder="Selecciona una opción"
                            valorId={params[p.nombre] || ''}
                            opciones={(p.opciones || []).map((o) => ({
                              id: o.valor,
                              titulo: o.etiqueta,
                              icono: 'tune' as const,
                            }))}
                            onSeleccionar={(id) => setParams((prev) => ({ ...prev, [p.nombre]: id }))}
                          />
                        ) : p.tipo === 'numero' ? (
                          <TextInput
                            style={styles.numInput}
                            value={params[p.nombre] || ''}
                            onChangeText={(t) =>
                              setParams((prev) => ({ ...prev, [p.nombre]: t.replace(/[^0-9]/g, '') }))
                            }
                            keyboardType="number-pad"
                            placeholder={p.defecto != null ? String(p.defecto) : ''}
                            placeholderTextColor="#94a3b8"
                          />
                        ) : (
                          <TextInput
                            style={styles.numInput}
                            value={params[p.nombre] || ''}
                            onChangeText={(t) => setParams((prev) => ({ ...prev, [p.nombre]: t }))}
                            placeholder={p.etiqueta || p.nombre}
                            placeholderTextColor="#94a3b8"
                          />
                        )}
                      </View>
                    ))
                )}

                {fuente ? (
                  <View style={styles.field}>
                    <Text style={styles.label}>Plantilla de redacción</Text>
                    <SelectorDesplegable
                      icono="article"
                      iconoLista="article"
                      tituloLista="Plantilla"
                      placeholder="Plantilla"
                      valorId={promptId}
                      opciones={plantillas.map((p) => ({
                        id: p.promptId,
                        titulo: p.nombre,
                        subtitulo: p.deCodigo ? 'Por defecto (código)' : p.esDefault ? 'Predeterminada' : undefined,
                        icono: 'article' as const,
                      }))}
                      onSeleccionar={setPromptId}
                    />
                  </View>
                ) : null}
              </View>

              <TouchableOpacity
                style={[styles.btnGenerar, (generando || !fuente) && styles.btnGenerarDisabled]}
                onPress={() => generar(false)}
                disabled={generando || !fuente}
              >
                {generando ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <MaterialIcons name="auto-awesome" size={18} color="#fff" />
                    <Text style={styles.btnGenerarText}>Ejecutar informe</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )}

          {error ? (
            <View style={styles.errBox}>
              <MaterialIcons name="error-outline" size={18} color="#dc2626" />
              <Text style={styles.errText}>{error}</Text>
            </View>
          ) : null}

          {informe ? (
            <View style={styles.resultCard}>
              <View style={styles.resultHead}>
                <MaterialIcons name="description" size={18} color="#0369a1" />
                <Text style={styles.resultTitle}>Informe</Text>
                <TouchableOpacity
                  onPress={descargarPdf}
                  disabled={exportandoPdf || !informe}
                  style={[styles.regenerarBtn, (exportandoPdf || !informe) && styles.btnDisabled]}
                >
                  {exportandoPdf ? (
                    <ActivityIndicator size="small" color="#0369a1" />
                  ) : (
                    <MaterialIcons name="picture-as-pdf" size={16} color="#0369a1" />
                  )}
                  <Text style={styles.regenerarText}>{exportandoPdf ? 'PDF…' : 'Descargar PDF'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => generar(true)} disabled={generando} style={styles.regenerarBtn}>
                  <MaterialIcons name="refresh" size={16} color="#0369a1" />
                  <Text style={styles.regenerarText}>Regenerar</Text>
                </TouchableOpacity>
              </View>

              <View
                ref={capturaPdfRef}
                collapsable={false}
                style={styles.capturaPdf}
              >
                {informe.fuente === 'dia_a_dia' ? (
                  <>
                    <View
                      {...(Platform.OS === 'web'
                        ? ({ dataSet: { pdfSection: 'titulo-informe' } } as object)
                        : {})}
                    >
                      <Text style={styles.capturaTitulo}>
                        Informes IA · {etiquetaFuentePdf(informe.fuente)} · {fechaParametroInforme(informe)}
                      </Text>
                    </View>
                    {informe.datosJson ? (
                      <VistaDiaADia
                        datos={informe.datosJson as DatosDiaADia}
                        modoPdf={exportandoPdf}
                      />
                    ) : null}
                    <View
                      style={styles.resumenDiaBox}
                      {...(Platform.OS === 'web'
                        ? ({ dataSet: { pdfSection: 'resumen-ia' } } as object)
                        : {})}
                    >
                      <Text style={styles.resumenDiaTitulo}>Acciones y foco del día</Text>
                      {informe.resumen ? (
                        resumenDiaSinObjetivoFacturacion ? (
                          <InformeResumenRico texto={resumenDiaSinObjetivoFacturacion} />
                        ) : null
                      ) : (
                        <Text style={styles.hint}>
                          Sin redacción (IA no configurada). Consulta los datos arriba.
                        </Text>
                      )}
                      {tieneObjetivoFacturacionHoyUtil(objetivoFacturacionHoyData) ? (
                        <ObjetivoFacturacionHoyBox data={objetivoFacturacionHoyData} />
                      ) : null}
                    </View>
                  </>
                ) : informe.fuente === 'ventas_por_articulo' && informe.datosJson ? (
                  <>
                    <Text style={styles.capturaTitulo}>
                      Informes IA · {etiquetaFuentePdf(informe.fuente)} · {fechaParametroInforme(informe)}
                    </Text>
                    <VistaVentasPorArticulo
                      datos={informe.datosJson as DatosVentasPorArticulo}
                      resumen={informe.resumen}
                      modoPdf={exportandoPdf}
                    />
                  </>
                ) : (
                  <>
                    <Text style={styles.capturaTitulo}>
                      Informes IA · {etiquetaFuentePdf(informe.fuente)} · {fechaParametroInforme(informe)}
                    </Text>
                    {informe.resumen ? (
                      <InformeResumenRico texto={informe.resumen} />
                    ) : (
                      <Text style={styles.hint}>
                        Sin redacción (IA no configurada). Consulta los datos abajo.
                      </Text>
                    )}
                  </>
                )}
              </View>

              <CollapsibleSection
                title="Ver datos (JSON)"
                defaultOpen={
                  !informe.resumen &&
                  !(
                    (informe.fuente === 'dia_a_dia' || informe.fuente === 'ventas_por_articulo') &&
                    !!informe.datosJson
                  )
                }
              >
                <Text style={styles.jsonText}>{JSON.stringify(informe.datosJson ?? {}, null, 2)}</Text>
              </CollapsibleSection>

              <Text style={styles.meta}>
                {informe.modelo ? `Modelo ${informe.modelo} · ` : ''}
                {informe.costeTokens
                  ? `${informe.costeTokens.prompt + informe.costeTokens.completion} tokens · `
                  : ''}
                {fechaHora(informe.generadoEn)}
              </Text>
            </View>
          ) : null}

          {historial.length > 0 ? (
            <View style={styles.histBlock}>
              <Text style={styles.sectionLabel}>Informes anteriores</Text>
              {historial.map((h) => (
                <TouchableOpacity key={h.informeId} style={styles.histRow} onPress={() => abrirInforme(h.informeId)}>
                  <MaterialIcons name="history" size={16} color="#64748b" />
                  <Text style={styles.histText} numberOfLines={1}>
                    {fechaHora(h.generadoEn)}
                    {h.generadoPorNombre ? ` · ${h.generadoPorNombre}` : ''}
                  </Text>
                  <MaterialIcons name="chevron-right" size={18} color="#cbd5e1" />
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          <View style={{ height: 32 }} />
        </View>
      </ScrollView>

      <IaGruposFamiliasModal
        visible={modalGruposOpen}
        onClose={() => setModalGruposOpen(false)}
        grupos={iaGrupos}
        familias={iaFamilias}
        familiaIdsIniciales={ventasParams.familiaIds}
        loading={loadingIaGrupos || loadingIaFamilias}
        onGuardar={onGuardarGrupoIa}
        onBorrar={onBorrarGrupoIa}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  scrollContent: { padding: 16, alignItems: 'center' },
  formMax: { width: '100%', maxWidth: 900 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  gestionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#e0f2fe',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  gestionText: { fontSize: 13, color: '#0369a1', fontWeight: '600' },
  avisoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    marginBottom: 12,
  },
  avisoText: { flex: 1, fontSize: 12, color: '#92400e' },
  panelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  panelCol: { flexDirection: 'column' },
  field: { flexGrow: 1, minWidth: 200, marginBottom: 4 },
  fieldWide: { flexBasis: '100%', minWidth: '100%' },
  fuenteDesc: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 18,
    color: '#64748b',
    flexShrink: 1,
    width: '100%',
    maxWidth: '100%',
    ...(Platform.OS === 'web' ? ({ wordBreak: 'break-word' } as object) : null),
  },
  multiField: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
  },
  multiHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  searchInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#1e293b',
    marginBottom: 6,
  },
  multiList: { maxHeight: 160 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 4,
    minHeight: MIN_TOUCH,
    borderRadius: 6,
  },
  checkRowSel: { backgroundColor: '#f0f9ff' },
  checkText: { flex: 1, fontSize: 13, color: '#475569' },
  checkTextSel: { color: '#0369a1', fontWeight: '600' },
  chipTodos: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#e0f2fe',
  },
  chipTodosText: { fontSize: 11, fontWeight: '700', color: '#0369a1' },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  grupoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    maxWidth: '100%',
    minHeight: MIN_TOUCH,
  },
  grupoChipOn: { borderColor: '#7dd3fc', backgroundColor: '#e0f2fe' },
  grupoChipText: { fontSize: 12, color: '#64748b', fontWeight: '600', maxWidth: 180 },
  grupoChipTextOn: { color: '#0369a1' },
  gestionarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  gestionarText: { fontSize: 11, color: '#0369a1', fontWeight: '700' },
  hintInline: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  label: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase' },
  numInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1e293b',
  },
  btnGenerar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingVertical: 14,
    marginBottom: 12,
  },
  btnGenerarDisabled: { opacity: 0.6 },
  btnGenerarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8, marginBottom: 12 },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  hint: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', marginVertical: 8 },
  resultCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginBottom: 14,
  },
  resultHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  resultTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: '#334155' },
  regenerarBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  regenerarText: { fontSize: 12, color: '#0369a1', fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
  capturaPdf: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 8,
    overflow: 'visible',
  },
  capturaTitulo: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 10,
  },
  resumenDiaBox: {
    marginTop: 8,
    backgroundColor: '#fef9c3',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  resumenDiaTitulo: {
    fontSize: 13,
    fontWeight: '800',
    color: '#854d0e',
    marginBottom: 2,
  },
  jsonText: {
    fontSize: 11,
    color: '#334155',
    fontFamily: 'monospace',
    backgroundColor: '#f1f5f9',
    borderRadius: 6,
    padding: 10,
  },
  meta: { fontSize: 11, color: '#94a3b8', marginTop: 10 },
  histBlock: { marginTop: 4 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  histText: { flex: 1, fontSize: 12, color: '#475569' },
  errorText: { padding: 16, color: '#b91c1c' },
});
