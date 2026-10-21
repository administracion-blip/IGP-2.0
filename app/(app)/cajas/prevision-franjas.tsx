import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { SPACING } from '../../constants/layout';
import { apiFetch, errorMessage } from '../../utils/api';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { obtenerPlantillasFranjas, type PlantillaFranjas } from '../../lib/ventasPorHoraApi';
import {
  MAX_DIAS_PREVISION,
  OBJETIVO_EUR_EMP_HORA_DEFECTO,
  calcularPrevision,
  diasEntreIso,
  fechaEs,
  formatEur,
  sumarDiasIso,
  type EscenarioPrevision,
  type PeticionPrevision,
  type ResultadoPrevision,
} from '../../lib/previsionFranjasApi';
import { generarPdfPrevisionFranjas, guardarPdfPrevision } from '../../lib/previsionFranjasPdf';
import { BarraFiltrosPrevision } from '../../components/prevision/FiltrosPrevision';
import { HojaFiltrosPrevision } from '../../components/prevision/HojaFiltrosPrevision';
import { MapaCalorFranjas } from '../../components/prevision/MapaCalorFranjas';
import { KpisPrevision } from '../../components/prevision/KpisPrevision';
import { ModalEscenarios } from '../../components/prevision/ModalEscenarios';
import { PanelLecturaPrevision } from '../../components/prevision/PanelLecturaPrevision';
import { SemanaDiasPrevision } from '../../components/prevision/SemanaDiasPrevision';
import { BotonPrevision } from '../../components/prevision/BotonPrevision';
import {
  altoControl,
  colores,
  estiloCifras,
  etiquetaRangoMeses,
  gapPagina,
  modoPrevision,
  paddingPagina,
  familia, peso,
  radios,
} from '../../components/prevision/tokens';

type LocalApi = { nombre?: string; Nombre?: string; agoraCode?: string; AgoraCode?: string };
type LocalOpcion = { nombre: string; agoraCode: string };

type FiltrosGuardados = {
  fechaDesde: string;
  fechaHasta: string;
  diasExcluidos: string[];
  workplaceIds: string[];
  plantillaId: string;
  objetivo: string;
};

const CLAVE_FILTROS = 'igp.previsionFranjas.filtros';
const MAX_LOCALES = 100;

function leerFiltrosGuardados(): FiltrosGuardados | null {
  if (Platform.OS !== 'web' || typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CLAVE_FILTROS);
    return raw ? (JSON.parse(raw) as FiltrosGuardados) : null;
  } catch {
    return null;
  }
}

function guardarFiltros(f: FiltrosGuardados) {
  if (Platform.OS !== 'web' || typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(CLAVE_FILTROS, JSON.stringify(f));
  } catch {
    /* almacenamiento no disponible */
  }
}

function parseObjetivo(txt: string): number {
  const n = Number(String(txt).replace(',', '.').trim());
  return Number.isFinite(n) ? n : NaN;
}

export default function PrevisionFranjasScreen() {
  const router = useRouter();
  const { hasPermiso, localPermitido, permisosStatus } = useAuth();
  const { width } = useBreakpoint();
  const modo = modoPrevision(width);
  const alto = altoControl(modo);
  const pad = paddingPagina(modo);
  const gap = gapPagina(modo);
  const { confirmar, ConfirmarView } = useConfirmar();
  const puedeVer = hasPermiso('prevision.ver');
  const puedeGlobal = hasPermiso('prevision.escenarios_globales');

  const [guardados] = useState<FiltrosGuardados | null>(() => leerFiltrosGuardados());
  const hoy = useMemo(() => fechaJornadaNegocioIso(), []);

  const [fechaDesde, setFechaDesde] = useState(guardados?.fechaDesde ?? hoy);
  const [fechaHasta, setFechaHasta] = useState(guardados?.fechaHasta ?? sumarDiasIso(hoy, 6));
  const [excluidos, setExcluidos] = useState<string[]>(guardados?.diasExcluidos ?? []);
  const [workplaceIds, setWorkplaceIds] = useState<string[]>(guardados?.workplaceIds ?? []);
  const [plantillaId, setPlantillaId] = useState(guardados?.plantillaId ?? '');
  const [objetivoTxt, setObjetivoTxt] = useState(guardados?.objetivo ?? String(OBJETIVO_EUR_EMP_HORA_DEFECTO));

  const [locales, setLocales] = useState<LocalOpcion[]>([]);
  const [cargandoLocales, setCargandoLocales] = useState(true);
  const [plantillas, setPlantillas] = useState<PlantillaFranjas[]>([]);
  const [cargandoPlantillas, setCargandoPlantillas] = useState(true);
  const [errorMaestros, setErrorMaestros] = useState<string | null>(null);

  const [resultado, setResultado] = useState<ResultadoPrevision | null>(null);
  const [peticionUsada, setPeticionUsada] = useState<PeticionPrevision | null>(null);
  const [calculando, setCalculando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localActivo, setLocalActivo] = useState<string | null>(null);
  const [escenariosOpen, setEscenariosOpen] = useState(false);
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false);
  const [generandoPdf, setGenerandoPdf] = useState(false);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setCargandoLocales(true);
    apiFetch('/api/locales')
      .then((res) => res.json())
      .then((data: { locales?: LocalApi[] }) => {
        if (cancelado) return;
        const lista = (Array.isArray(data.locales) ? data.locales : [])
          .map((l) => ({
            nombre: String(l.nombre ?? l.Nombre ?? '').trim(),
            agoraCode: String(l.agoraCode ?? l.AgoraCode ?? '').trim(),
          }))
          .filter((l) => l.agoraCode && l.nombre && localPermitido(l.nombre))
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
        setLocales(lista);
        const disponibles = new Set(lista.map((l) => l.agoraCode));
        setWorkplaceIds((prev) => {
          const validos = prev.filter((w) => disponibles.has(w));
          return validos.length > 0 ? validos : lista.map((l) => l.agoraCode);
        });
      })
      .catch((e) => !cancelado && setErrorMaestros(errorMessage(e, 'No se pudieron cargar los locales')))
      .finally(() => !cancelado && setCargandoLocales(false));
    return () => {
      cancelado = true;
    };
  }, [puedeVer, localPermitido]);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setCargandoPlantillas(true);
    obtenerPlantillasFranjas()
      .then((lista) => {
        if (cancelado) return;
        setPlantillas(lista);
        setPlantillaId((prev) => (prev && lista.some((p) => p.plantillaId === prev) ? prev : lista[0]?.plantillaId ?? ''));
      })
      .catch((e) => !cancelado && setErrorMaestros(errorMessage(e, 'No se pudieron cargar las plantillas')))
      .finally(() => !cancelado && setCargandoPlantillas(false));
    return () => {
      cancelado = true;
    };
  }, [puedeVer]);

  const diasRango = useMemo(() => diasEntreIso(fechaDesde, fechaHasta), [fechaDesde, fechaHasta]);

  const construirPeticion = useCallback((): { peticion?: PeticionPrevision; error?: string } => {
    if (diasRango.length === 0) return { error: 'Indica una fecha válida (dd/mm/aaaa) y un rango Desde ≤ Hasta.' };
    if (diasRango.length > MAX_DIAS_PREVISION) return { error: `El rango no puede superar ${MAX_DIAS_PREVISION} días.` };
    const enRango = new Set(diasRango);
    const diasExcluidos = excluidos.filter((d) => enRango.has(d));
    if (diasExcluidos.length >= diasRango.length) return { error: 'Selecciona al menos un día del rango.' };
    if (workplaceIds.length === 0) return { error: 'Selecciona al menos un local.' };
    if (workplaceIds.length > MAX_LOCALES) return { error: `No se pueden calcular más de ${MAX_LOCALES} locales a la vez.` };
    if (!plantillaId) return { error: 'Elige una plantilla de franjas.' };
    const objetivo = parseObjetivo(objetivoTxt);
    if (!(objetivo > 0)) return { error: 'El objetivo €/empleado·hora debe ser un número mayor que 0.' };
    return {
      peticion: { fechaDesde, fechaHasta, diasExcluidos, workplaceIds, plantillaId, objetivoEurEmpHora: objetivo },
    };
  }, [diasRango, excluidos, workplaceIds, plantillaId, objetivoTxt, fechaDesde, fechaHasta]);

  const ejecutarCalculo = useCallback(async (peticion: PeticionPrevision) => {
    setCalculando(true);
    setError(null);
    try {
      const r = await calcularPrevision(peticion);
      setResultado(r);
      setPeticionUsada(peticion);
      setLocalActivo((prev) => (prev && r.locales.some((l) => l.workplaceId === prev) ? prev : r.locales[0]?.workplaceId ?? null));
      guardarFiltros({
        fechaDesde: peticion.fechaDesde,
        fechaHasta: peticion.fechaHasta,
        diasExcluidos: peticion.diasExcluidos,
        workplaceIds: peticion.workplaceIds,
        plantillaId: peticion.plantillaId,
        objetivo: String(peticion.objetivoEurEmpHora),
      });
    } catch (e) {
      const msg = errorMessage(e, 'No se pudo calcular la previsión');
      setError(
        e instanceof Error && e.name === 'AbortError'
          ? 'El cálculo ha tardado demasiado. Vuelve a intentarlo: el histórico ya traído se aprovecha.'
          : msg,
      );
    } finally {
      setCalculando(false);
    }
  }, []);

  const onCalcular = () => {
    const { peticion, error: err } = construirPeticion();
    if (!peticion) {
      setError(err ?? 'Revisa los filtros.');
      return;
    }
    void ejecutarCalculo(peticion);
  };

  const onCalcularHoja = () => {
    setFiltrosAbiertos(false);
    onCalcular();
  };

  const onCargarEscenario = (esc: EscenarioPrevision) => {
    const disponibles = new Set(locales.map((l) => l.agoraCode));
    const wps = esc.workplaceIds.filter((w) => disponibles.has(w));
    setFechaDesde(esc.fechaDesde);
    setFechaHasta(esc.fechaHasta);
    setExcluidos(esc.diasExcluidos);
    setWorkplaceIds(wps);
    setPlantillaId(esc.plantillaId);
    setObjetivoTxt(String(esc.objetivoEurEmpHora));
    setEscenariosOpen(false);
    if (wps.length === 0) {
      setError('El escenario no tiene ninguno de tus locales. Selecciona los locales y pulsa «Calcular».');
      return;
    }
    if (!plantillas.some((p) => p.plantillaId === esc.plantillaId)) {
      setError('La plantilla del escenario ya no existe. Elige otra y pulsa «Calcular».');
      return;
    }
    void ejecutarCalculo({
      fechaDesde: esc.fechaDesde,
      fechaHasta: esc.fechaHasta,
      diasExcluidos: esc.diasExcluidos,
      workplaceIds: wps,
      plantillaId: esc.plantillaId,
      objetivoEurEmpHora: esc.objetivoEurEmpHora,
    });
  };

  const descargarPdf = async () => {
    if (!resultado || !peticionUsada) return;
    setGenerandoPdf(true);
    try {
      const doc = await generarPdfPrevisionFranjas(resultado, {
        fechaDesde: peticionUsada.fechaDesde,
        fechaHasta: peticionUsada.fechaHasta,
        objetivoEurEmpHora: peticionUsada.objetivoEurEmpHora,
        diasExcluidos: peticionUsada.diasExcluidos.length,
      });
      await guardarPdfPrevision(doc, peticionUsada.fechaDesde, peticionUsada.fechaHasta);
    } catch (e) {
      console.error('[prevision-franjas] PDF', e);
      await confirmar('No se pudo generar el PDF', errorMessage(e, 'Error al generar el PDF.'), { soloAceptar: true });
    } finally {
      setGenerandoPdf(false);
    }
  };

  const filtrosActuales: PeticionPrevision = useMemo(() => {
    const enRango = new Set(diasRango);
    const objetivo = parseObjetivo(objetivoTxt);
    return {
      fechaDesde,
      fechaHasta,
      diasExcluidos: excluidos.filter((d) => enRango.has(d)),
      workplaceIds,
      plantillaId,
      objetivoEurEmpHora: objetivo > 0 ? objetivo : OBJETIVO_EUR_EMP_HORA_DEFECTO,
    };
  }, [diasRango, excluidos, workplaceIds, plantillaId, objetivoTxt, fechaDesde, fechaHasta]);

  const opcionesLocales = useMemo(
    () => locales.map((l) => ({ id: l.agoraCode, titulo: l.nombre })),
    [locales],
  );
  const opcionesPlantillas = useMemo(
    () =>
      plantillas.map((p) => ({
        id: p.plantillaId,
        titulo: p.nombre,
        subtitulo: p.franjas.map((f) => `${f.desde}–${f.hasta}`).join(' · '),
      })),
    [plantillas],
  );

  const nombrePlantilla = plantillas.find((p) => p.plantillaId === plantillaId)?.nombre;
  const subtitulo = `${fechaEs(fechaDesde)} – ${fechaEs(fechaHasta)} · ${nombrePlantilla || 'Elige una plantilla'}`;
  const resumenMovil = `${etiquetaRangoMeses(fechaDesde, fechaHasta)} · ${workplaceIds.length} ${workplaceIds.length === 1 ? 'local' : 'locales'} · ${nombrePlantilla || 'Sin plantilla'}`;

  const vacioPlantillas = hasPermiso('objetivos.ver')
    ? { texto: 'Gestionar plantillas', onPress: () => router.push('/cajas/franjas-horarias') }
    : undefined;

  const local = resultado?.locales.find((l) => l.workplaceId === localActivo) ?? resultado?.locales[0] ?? null;
  const hayPendientes =
    !!resultado && (resultado.pendientes > 0 || resultado.locales.some((l) => l.dias.some((d) => d.motivo === 'pendiente')));

  const filtrosComunes = {
    fechaDesde,
    fechaHasta,
    onChangeDesde: setFechaDesde,
    onChangeHasta: setFechaHasta,
    excluidos,
    onChangeExcluidos: setExcluidos,
    locales: opcionesLocales,
    workplaceIds,
    onChangeLocales: setWorkplaceIds,
    cargandoLocales,
    plantillas: opcionesPlantillas,
    plantillaId,
    onChangePlantilla: setPlantillaId,
    cargandoPlantillas,
    vacioPlantillas,
    objetivoTxt,
    onChangeObjetivo: setObjetivoTxt,
    calculando,
    errorMaestros,
  };

  if (!puedeVer && (permisosStatus === 'idle' || permisosStatus === 'loading')) {
    return (
      <View style={styles.sinPermiso}>
        <ActivityIndicator color={colores.acento} />
      </View>
    );
  }

  if (!puedeVer) {
    return (
      <View style={styles.sinPermiso}>
        <Text style={styles.sinPermisoText}>No tienes permiso para ver la previsión de ventas por franjas.</Text>
        <BotonPrevision
          titulo="Volver a Cajas"
          variante="secundario"
          alto={alto}
          onPress={() => router.replace('/cajas')}
        />
      </View>
    );
  }

  return (
    <View style={styles.raiz}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollInner} keyboardShouldPersistTaps="handled">
        <View style={[styles.pagina, { paddingHorizontal: pad, paddingTop: modo === 'movil' ? 8 : 20, gap }]}>
          <Cabecera
            modo={modo}
            alto={alto}
            subtitulo={subtitulo}
            onVolver={() => router.replace('/cajas')}
            onEscenarios={() => setEscenariosOpen(true)}
            onPdf={() => void descargarPdf()}
            pdfDisabled={!resultado || generandoPdf}
            pdfCargando={generandoPdf}
          />

          {modo === 'movil' ? (
            <View style={styles.resumen}>
              <View style={styles.resumenTextos}>
                <Text style={styles.resumenLinea} numberOfLines={1}>{resumenMovil}</Text>
                <Text style={styles.resumenCoste}>{`Coste ${objetivoTxt.trim() || '—'} €/h`}</Text>
              </View>
              <BotonPrevision
                titulo="Filtros"
                variante="secundario"
                alto={alto}
                icono="tune"
                onPress={() => setFiltrosAbiertos(true)}
              />
            </View>
          ) : (
            <BarraFiltrosPrevision
              {...filtrosComunes}
              modo={modo}
              alto={alto}
              onCalcular={onCalcular}
            />
          )}

          {error ? (
            <View style={styles.estado}>
              <Text style={styles.errorTexto}>{error}</Text>
            </View>
          ) : null}

          {calculando ? (
            <View style={styles.estado}>
              <ActivityIndicator color={colores.acento} />
              <Text style={styles.estadoTexto}>
                Calculando la previsión… puede tardar si hay que traer histórico de Ágora.
              </Text>
            </View>
          ) : !resultado ? (
            <View style={styles.estado}>
              <Text style={styles.estadoTitulo}>Elige el periodo, los locales y la plantilla y pulsa «Calcular»</Text>
              <Text style={styles.estadoTexto}>
                La previsión de cada día es la venta real de su fecha comparativa (la de la tabla de festivos o, si no hay,
                el mismo día del año anterior), repartida en las franjas de la plantilla. El personal sugerido sale de dividir
                la venta de cada franja entre el objetivo €/empleado·hora y sus horas.
              </Text>
            </View>
          ) : (
            <View style={[styles.resultado, { gap }]}>
              {hayPendientes || resultado.avisos.length > 0 ? (
                <View style={styles.aviso}>
                  <View style={styles.avisoTextos}>
                    {resultado.avisos.map((a, i) => (
                      <Text key={i} style={styles.avisoTexto}>{a}</Text>
                    ))}
                    {hayPendientes && resultado.avisos.length === 0 ? (
                      <Text style={styles.avisoTexto}>Hay días pendientes de completar el histórico.</Text>
                    ) : null}
                  </View>
                  {hayPendientes && peticionUsada ? (
                    <BotonPrevision
                      titulo="Volver a calcular"
                      variante="secundario"
                      alto={alto}
                      onPress={() => void ejecutarCalculo(peticionUsada)}
                    />
                  ) : null}
                </View>
              ) : null}

              {resultado.locales.length === 0 ? (
                <View style={styles.estado}>
                  <Text style={styles.estadoTexto}>No hay locales en el resultado.</Text>
                </View>
              ) : (
                <>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={modo === 'movil' ? { marginHorizontal: -pad } : undefined}
                    contentContainerStyle={[styles.tabs, modo === 'movil' && { paddingHorizontal: pad }]}
                  >
                    {resultado.locales.map((l) => {
                      const activo = l.workplaceId === local?.workplaceId;
                      return (
                        <TouchableOpacity
                          key={l.workplaceId}
                          style={[styles.tab, activo && styles.tabActivo, modo !== 'escritorio' && styles.tabTactil]}
                          onPress={() => setLocalActivo(l.workplaceId)}
                          accessibilityRole="tab"
                          accessibilityState={{ selected: activo }}
                        >
                          <Text style={[styles.tabText, activo && styles.tabTextActivo]} numberOfLines={1}>{l.nombre}</Text>
                          <Text style={[styles.tabSub, estiloCifras, activo && styles.tabTextActivo]}>
                            {formatEur(l.kpis.ventaPrevista)}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>

                  {local && resultado ? (
                    <View style={{ gap }}>
                      <KpisPrevision kpis={local.kpis} modo={modo} />
                      {modo === 'escritorio' ? (
                        <View style={styles.filaPrincipal}>
                          <View style={styles.mapaFlex}>
                            <MapaCalorFranjas
                              local={local}
                              franjas={resultado.plantilla.franjas}
                              hoyJornada={resultado.hoyJornada}
                              modo="escritorio"
                            />
                          </View>
                          <PanelLecturaPrevision local={local} franjas={resultado.plantilla.franjas} modo="escritorio" />
                        </View>
                      ) : modo === 'tablet' ? (
                        <View style={{ gap }}>
                          <MapaCalorFranjas
                            local={local}
                            franjas={resultado.plantilla.franjas}
                            hoyJornada={resultado.hoyJornada}
                            modo="tablet"
                          />
                          <PanelLecturaPrevision local={local} franjas={resultado.plantilla.franjas} modo="tablet" />
                        </View>
                      ) : (
                        <View style={{ gap }}>
                          <SemanaDiasPrevision
                            local={local}
                            franjas={resultado.plantilla.franjas}
                            hoyJornada={resultado.hoyJornada}
                          />
                          <PanelLecturaPrevision local={local} franjas={resultado.plantilla.franjas} modo="movil" />
                        </View>
                      )}
                    </View>
                  ) : null}
                </>
              )}
            </View>
          )}
        </View>
      </ScrollView>

      {modo === 'movil' ? (
        <HojaFiltrosPrevision
          {...filtrosComunes}
          visible={filtrosAbiertos}
          onClose={() => setFiltrosAbiertos(false)}
          onCalcular={onCalcularHoja}
        />
      ) : null}

      <ModalEscenarios
        visible={escenariosOpen}
        onClose={() => setEscenariosOpen(false)}
        filtros={filtrosActuales}
        onCargar={onCargarEscenario}
        puedeGlobal={puedeGlobal}
      />
      {ConfirmarView}
    </View>
  );
}

function Cabecera({
  modo,
  alto,
  subtitulo,
  onVolver,
  onEscenarios,
  onPdf,
  pdfDisabled,
  pdfCargando,
}: {
  modo: ReturnType<typeof modoPrevision>;
  alto: number;
  subtitulo: string;
  onVolver: () => void;
  onEscenarios: () => void;
  onPdf: () => void;
  pdfDisabled: boolean;
  pdfCargando: boolean;
}) {
  const titulo = (
    <View style={styles.tituloBloque}>
      <TouchableOpacity
        onPress={onVolver}
        accessibilityLabel="Volver a Cajas"
        accessibilityRole="button"
        style={[styles.volver, { width: alto, height: alto }]}
      >
        <MaterialIcons name="arrow-back" size={20} color={colores.textoSecundario} />
      </TouchableOpacity>
      <View style={styles.tituloTextos}>
        <Text style={[styles.titulo, { fontSize: modo === 'movil' ? 26 : 28 }]}>Previsión</Text>
        <Text style={styles.subtitulo} numberOfLines={2}>{subtitulo}</Text>
      </View>
    </View>
  );
  const acciones = (
    <View style={[styles.acciones, modo === 'movil' && styles.accionesMovil]}>
      <BotonPrevision
        titulo="Escenarios"
        variante="secundario"
        alto={alto}
        onPress={onEscenarios}
        style={modo === 'movil' ? styles.accionMovil : undefined}
      />
      <BotonPrevision
        titulo="PDF"
        variante="primario"
        alto={alto}
        onPress={onPdf}
        disabled={pdfDisabled}
        cargando={pdfCargando}
        style={modo === 'movil' ? styles.accionMovil : undefined}
      />
    </View>
  );
  if (modo === 'movil') {
    return (
      <View style={styles.cabeceraMovil}>
        {titulo}
        {acciones}
      </View>
    );
  }
  return (
    <View style={styles.cabecera}>
      {titulo}
      {acciones}
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: {
    flex: 1,
    backgroundColor: colores.lienzo,
    marginHorizontal: -(SPACING.sm + 2),
  },
  scroll: { flex: 1, backgroundColor: colores.lienzo },
  scrollInner: { alignItems: 'center' },
  pagina: { width: '100%', maxWidth: 1440, paddingBottom: 40 },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  cabeceraMovil: { gap: 12 },
  tituloBloque: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0 },
  tituloTextos: { flexShrink: 1, minWidth: 0, gap: 2 },
  volver: { alignItems: 'center', justifyContent: 'center' },
  titulo: { fontFamily: familia.titulo, fontWeight: peso.titulo, color: colores.texto },
  subtitulo: { fontFamily: familia.regular, fontSize: 13, color: colores.textoSecundario },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accionesMovil: { width: '100%' },
  accionMovil: { flex: 1 },
  resumen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  resumenTextos: { flex: 1, minWidth: 0, gap: 2 },
  resumenLinea: { fontSize: 13, fontFamily: familia.semibold, fontWeight: peso.semibold, color: colores.texto },
  resumenCoste: { fontFamily: familia.regular, fontSize: 12, color: colores.textoSecundario },
  estado: {
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
    paddingHorizontal: 20,
    paddingVertical: 22,
    gap: 8,
  },
  estadoTitulo: { fontSize: 15, fontFamily: familia.semibold, fontWeight: peso.semibold, color: colores.texto },
  estadoTexto: { fontSize: 13, lineHeight: 19, color: colores.textoSecundario },
  errorTexto: { fontFamily: familia.regular, fontSize: 13, lineHeight: 19, color: colores.negativa },
  resultado: { position: 'relative', zIndex: 0 },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  avisoTextos: { flex: 1, minWidth: 180, gap: 2 },
  avisoTexto: { fontFamily: familia.regular, fontSize: 13, lineHeight: 18, color: colores.festivoTexto },
  tabs: { gap: 4, alignItems: 'stretch' },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radios.control,
    justifyContent: 'center',
    maxWidth: 220,
  },
  tabTactil: { minHeight: 44 },
  tabActivo: { backgroundColor: colores.acento },
  tabText: { fontSize: 14, fontFamily: familia.semibold, fontWeight: peso.semibold, color: colores.textoPestana },
  tabTextActivo: { color: colores.textoSobreAcento },
  tabSub: { fontFamily: familia.regular, fontSize: 12, color: colores.textoPestana, marginTop: 1 },
  filaPrincipal: { flexDirection: 'row', alignItems: 'flex-start', gap: 20 },
  mapaFlex: { flex: 1, minWidth: 0 },
  sinPermiso: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: colores.lienzo,
  },
  sinPermisoText: { fontFamily: familia.regular, fontSize: 14, color: colores.textoPestana, textAlign: 'center' },
});
