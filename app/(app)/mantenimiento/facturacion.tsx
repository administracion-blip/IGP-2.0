/**
 * Facturación mensual de las reparaciones de mantenimiento.
 *
 * Flujo: elegir periodo (por defecto el mes anterior) → previsualizar lo que se
 * facturaría → confirmar → ver el resultado con enlace a cada factura creada.
 *
 * Contrato del backend en `api/lib/facturacion/facturarMantenimiento.js`:
 * - `GET /api/mantenimiento/facturacion/previsualizar?periodo=AAAA-MM` no escribe nada.
 * - `POST /api/mantenimiento/facturacion/generar` deja las facturas en borrador.
 * Los resultados vienen agrupados por sociedad receptora y, dentro, por local.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { useAjustesFacturacionMantenimiento } from '../../hooks/useAjustesFacturacionMantenimiento';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatMoneda } from '../../utils/facturacion';
import { formatFecha } from '../../utils/formatFecha';
import { MIN_TOUCH } from '../../constants/layout';
import { ExcluidosFacturacionCard } from '../../components/facturacion/ExcluidosFacturacionCard';
import {
  agruparPorMotivo,
  num,
  plural,
  type GrupoExcluidos,
} from '../../lib/facturacionPeriodica';
import {
  desplazarPeriodo,
  labelPeriodo,
  periodoAnteriorMantenimiento,
  periodoDeFecha,
  textoMotivoExclusion,
} from '../../lib/mantenimientoFacturacion';

type ParteDesglose = {
  fecha?: string;
  titulo?: string;
  base?: number;
  iva?: number;
  total?: number;
  lineas?: number;
};

type LocalDesglose = {
  local_id?: string;
  local_nombre?: string;
  base?: number;
  iva?: number;
  total?: number;
  partes?: ParteDesglose[];
};

type FacturaExistente = {
  id_factura?: string;
  numero_factura?: string;
  estado?: string;
  total_factura?: number;
};

type SociedadPrevista = {
  id_empresa: string;
  nombre?: string;
  cif?: string;
  num_partes?: number;
  base?: number;
  iva?: number;
  total?: number;
  descuadre_centimos?: number;
  total_valoraciones?: number;
  locales?: LocalDesglose[];
  aviso?: string;
  facturas_existentes?: FacturaExistente[];
};

type Excluido = {
  motivo?: string;
  motivo_texto?: string;
  detalle?: string;
  ambito?: string;
  local_id?: string;
  local_nombre?: string;
  id_empresa?: string;
  empresa_nombre?: string;
  titulo?: string;
  fecha?: string;
  partes?: number;
};

type Previsualizacion = {
  periodo: string;
  fecha_emision?: string;
  serie?: string;
  emisora?: { id_empresa?: string; nombre?: string; cif?: string };
  sociedades?: SociedadPrevista[];
  total_facturas?: number;
  total_partes?: number;
  total_importe?: number;
  excluidos?: Excluido[];
  error?: string;
};

type FacturaCreada = {
  id_factura: string;
  id_empresa?: string;
  empresa_nombre?: string;
  empresa_cif?: string;
  serie?: string;
  estado?: string;
  fecha_emision?: string;
  base?: number;
  iva?: number;
  total?: number;
  num_partes?: number;
  num_lineas?: number;
  locales?: LocalDesglose[];
  aviso?: string;
};

type Descartado = {
  local_nombre?: string;
  titulo?: string;
  fecha?: string;
  empresa_nombre?: string;
  motivo?: string;
  motivo_texto?: string;
};

type ErrorSociedad = { id_empresa?: string; empresa_nombre?: string; error?: string };

type Resultado = {
  periodo: string;
  serie?: string;
  fecha_emision?: string;
  facturas?: FacturaCreada[];
  total_facturas?: number;
  total_partes?: number;
  total_importe?: number;
  descartados?: Descartado[];
  excluidos?: Excluido[];
  errores?: ErrorSociedad[];
  error?: string;
};

const ERROR_PREVISUALIZAR = 'No se pudo calcular la previsualización de la facturación';
const ERROR_GENERAR = 'No se pudieron generar las facturas de mantenimiento';

/** Quién queda fuera: la sociedad, el local o el parte concreto. */
function etiquetaExcluido(ex: Excluido): string {
  const ambito = String(ex.ambito ?? '').trim();
  const empresa = String(ex.empresa_nombre ?? '').trim();
  const idEmpresa = String(ex.id_empresa ?? '').trim();
  const local = String(ex.local_nombre ?? '').trim() || String(ex.local_id ?? '').trim();
  if (ambito === 'sociedad') {
    return [empresa || 'Sociedad sin nombre', idEmpresa ? `(${idEmpresa})` : ''].filter(Boolean).join(' ');
  }
  if (ambito === 'local') return local || 'Local sin identificar';
  const fecha = String(ex.fecha ?? '').trim();
  return (
    [local, String(ex.titulo ?? '').trim(), fecha ? formatFecha(fecha) : '']
      .filter((p) => p !== '' && p !== '—')
      .join(' · ') || 'Parte sin identificar'
  );
}

/** Los excluidos se agrupan por motivo: el mismo texto repetido N veces no se lee. */
function agruparExcluidos(excluidos: Excluido[]): GrupoExcluidos[] {
  return agruparPorMotivo(excluidos, {
    motivo: (ex) => String(ex.motivo ?? '').trim(),
    texto: (ex) => textoMotivoExclusion(ex.motivo, ex.motivo_texto),
    item: (ex) => {
      const partes = num(ex.partes);
      return {
        etiqueta: etiquetaExcluido(ex),
        detalle: String(ex.detalle ?? '').trim() || undefined,
        recuento: partes > 0 ? `${partes} ${plural(partes, 'parte', 'partes')}` : undefined,
      };
    },
  });
}

export default function FacturacionMantenimientoScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { isCompact } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();
  const {
    ajustes,
    loading: cargandoAjustes,
    error: errorAjustes,
  } = useAjustesFacturacionMantenimiento();

  const [periodo, setPeriodo] = useState(() => periodoAnteriorMantenimiento());
  const [previsualizacion, setPrevisualizacion] = useState<Previsualizacion | null>(null);
  const [cargandoPrevisualizacion, setCargandoPrevisualizacion] = useState(true);
  const [errorPrevisualizacion, setErrorPrevisualizacion] = useState<string | null>(null);
  const [generando, setGenerando] = useState(false);
  const [errorGenerar, setErrorGenerar] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [sociedadesPlegadas, setSociedadesPlegadas] = useState<Set<string>>(new Set());

  const puedeFacturar = hasPermiso('mantenimiento.facturar');
  const periodoMaximo = periodoDeFecha();
  const esPeriodoPorDefecto = periodo === periodoAnteriorMantenimiento();

  const cargarPrevisualizacion = useCallback(
    async (objetivo: string) => {
      setCargandoPrevisualizacion(true);
      setErrorPrevisualizacion(null);
      try {
        const res = await apiFetch(
          `/api/mantenimiento/facturacion/previsualizar?periodo=${encodeURIComponent(objetivo)}`,
        );
        const data = (await res.json()) as Previsualizacion;
        if (!res.ok || data.error) {
          setPrevisualizacion(null);
          setErrorPrevisualizacion(data.error ?? ERROR_PREVISUALIZAR);
          return;
        }
        setPrevisualizacion(data);
      } catch (e) {
        setPrevisualizacion(null);
        setErrorPrevisualizacion(errorMessage(e, ERROR_PREVISUALIZAR));
      } finally {
        setCargandoPrevisualizacion(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!puedeFacturar) return;
    void cargarPrevisualizacion(periodo);
  }, [puedeFacturar, periodo, cargarPrevisualizacion]);

  const sociedades = useMemo(() => previsualizacion?.sociedades ?? [], [previsualizacion]);
  const excluidosPrevistos = useMemo(
    () => agruparExcluidos(previsualizacion?.excluidos ?? []),
    [previsualizacion],
  );
  const excluidosResultado = useMemo(
    () => agruparExcluidos(resultado?.excluidos ?? []),
    [resultado],
  );

  const totalFacturas = num(previsualizacion?.total_facturas ?? sociedades.length);
  const totalPartes = num(previsualizacion?.total_partes);
  const totalImporte = num(previsualizacion?.total_importe);
  const sinNadaQueFacturar =
    previsualizacion !== null && sociedades.length === 0 && excluidosPrevistos.length === 0;

  const cambiarPeriodo = useCallback((meses: number) => {
    setResultado(null);
    setErrorGenerar(null);
    setPeriodo((actual) => {
      const siguiente = desplazarPeriodo(actual, meses);
      return siguiente > periodoDeFecha() ? actual : siguiente;
    });
  }, []);

  const togglePlegada = useCallback((idEmpresa: string) => {
    setSociedadesPlegadas((prev) => {
      const next = new Set(prev);
      if (next.has(idEmpresa)) next.delete(idEmpresa);
      else next.add(idEmpresa);
      return next;
    });
  }, []);

  const generar = useCallback(async () => {
    if (sociedades.length === 0) return;
    const confirmado = await confirmar(
      'Generar facturas de mantenimiento',
      `Se crearán ${totalFacturas} ${plural(totalFacturas, 'factura', 'facturas')} en borrador por ` +
        `${formatMoneda(totalImporte)} (IVA incluido), con ${totalPartes} ` +
        `${plural(totalPartes, 'parte', 'partes')} de ${labelPeriodo(periodo)}. ` +
        'Son documentos contables: revisa el desglose antes de continuar.',
      { confirmarLabel: 'Generar facturas' },
    );
    if (!confirmado) return;

    setGenerando(true);
    setErrorGenerar(null);
    try {
      const res = await apiFetch('/api/mantenimiento/facturacion/generar', {
        method: 'POST',
        body: JSON.stringify({ periodo }),
      });
      const data = (await res.json()) as Resultado;
      if (!res.ok || data.error) {
        setErrorGenerar(data.error ?? ERROR_GENERAR);
        // El servidor puede haber escrito parte del lote: la previsualización manda.
        void cargarPrevisualizacion(periodo);
        return;
      }
      setResultado(data);
      void cargarPrevisualizacion(periodo);
    } catch (e) {
      setErrorGenerar(errorMessage(e, ERROR_GENERAR));
      void cargarPrevisualizacion(periodo);
    } finally {
      setGenerando(false);
    }
  }, [
    sociedades.length,
    confirmar,
    totalFacturas,
    totalImporte,
    totalPartes,
    periodo,
    cargarPrevisualizacion,
  ]);

  const abrirFactura = useCallback(
    (idFactura: string) => {
      router.push(`/facturacion/factura-detalle?id=${idFactura}&modo=editar&tipo=OUT` as never);
    },
    [router],
  );

  if (!puedeFacturar) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={32} color="#94a3b8" />
        <Text style={styles.sinPermisoText}>No tienes permiso para facturar mantenimiento.</Text>
      </View>
    );
  }

  const renderDesgloseLocales = (locales: LocalDesglose[]) => (
    <View style={styles.localesBlock}>
      {locales.map((local, iLocal) => (
        <View key={`${local.local_id ?? iLocal}`} style={styles.localBlock}>
          <View style={styles.localHeader}>
            <MaterialIcons name="store" size={14} color="#0369a1" />
            <Text style={styles.localNombre} numberOfLines={1}>
              {String(local.local_nombre ?? local.local_id ?? 'Sin local')}
            </Text>
            <Text style={styles.localTotal}>{formatMoneda(num(local.total))}</Text>
          </View>
          {(local.partes ?? []).map((parte, iParte) => (
            <View key={`${local.local_id ?? iLocal}-${iParte}`} style={styles.parteRow}>
              <Text style={styles.parteFecha}>{formatFecha(parte.fecha)}</Text>
              <Text style={styles.parteTitulo} numberOfLines={1}>
                {String(parte.titulo ?? '').trim() || 'Reparación sin título'}
              </Text>
              <Text style={styles.parteTotal}>{formatMoneda(num(parte.total))}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );

  const renderExcluidos = (grupos: GrupoExcluidos[]) => (
    <ExcluidosFacturacionCard
      grupos={grupos}
      titulo="Fuera de la facturación"
      intro="Estas reparaciones no se facturan. Corrige el dato que falta y volverán a entrar en la próxima tanda: nada se pierde."
    />
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/mantenimiento/incidencias' as never)}
          style={styles.backBtn}
          accessibilityLabel="Volver"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={styles.headerTextBlock}>
          <Text style={styles.title}>Facturación de mantenimiento</Text>
          <Text style={styles.subtitle}>
            La sede central factura cada mes a las sociedades de los locales las reparaciones ya
            valoradas. Las facturas se crean en borrador: no consumen numeración hasta que se emiten.
          </Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => void cargarPrevisualizacion(periodo)}
          disabled={cargandoPrevisualizacion || generando}
          accessibilityLabel="Actualizar previsualización"
        >
          {cargandoPrevisualizacion ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="refresh" size={22} color="#0ea5e9" />
          )}
        </TouchableOpacity>
      </View>

      <View style={[styles.toolbar, isCompact && styles.toolbarStacked]}>
        <View style={styles.periodoNav}>
          <TouchableOpacity
            style={styles.periodoNavBtn}
            onPress={() => cambiarPeriodo(-1)}
            disabled={generando}
            accessibilityLabel="Mes anterior"
          >
            <MaterialIcons name="chevron-left" size={22} color="#334155" />
          </TouchableOpacity>
          <View style={styles.periodoLabelWrap}>
            <Text style={styles.periodoLabel} numberOfLines={1}>
              {labelPeriodo(periodo)}
            </Text>
            {esPeriodoPorDefecto ? (
              <Text style={styles.periodoHint}>Mes anterior</Text>
            ) : (
              <TouchableOpacity
                onPress={() => {
                  setResultado(null);
                  setErrorGenerar(null);
                  setPeriodo(periodoAnteriorMantenimiento());
                }}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              >
                <Text style={styles.periodoLink}>Ir al mes anterior</Text>
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={[styles.periodoNavBtn, periodo >= periodoMaximo && styles.periodoNavBtnDisabled]}
            onPress={() => cambiarPeriodo(1)}
            disabled={generando || periodo >= periodoMaximo}
            accessibilityLabel="Mes siguiente"
          >
            <MaterialIcons
              name="chevron-right"
              size={22}
              color={periodo >= periodoMaximo ? '#cbd5e1' : '#334155'}
            />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[
            styles.generarBtn,
            (sociedades.length === 0 || cargandoPrevisualizacion || generando) &&
              styles.generarBtnDisabled,
          ]}
          onPress={() => void generar()}
          disabled={sociedades.length === 0 || cargandoPrevisualizacion || generando}
          activeOpacity={0.8}
        >
          {generando ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <MaterialIcons name="receipt-long" size={18} color="#fff" />
          )}
          <Text style={styles.generarBtnText}>
            {generando ? 'Generando…' : 'Generar facturas'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Si la configuración no se pudo leer no se dice nada: afirmar que la
          generación automática está desactivada sin saberlo engaña al usuario. */}
      {!cargandoAjustes && !errorAjustes ? (
        <View style={styles.automaticoChip}>
          <View style={[styles.automaticoDot, ajustes.enabled ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.automaticoText}>
            {ajustes.enabled
              ? `Generación automática activa: cada día ${ajustes.diaGeneracion} a las ${ajustes.hora}. Serie ${ajustes.serie}.`
              : `Generación automática desactivada: solo se factura cuando alguien pulsa «Generar facturas». Serie ${ajustes.serie}.`}
          </Text>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {errorGenerar ? (
          <View style={styles.errorBox}>
            <MaterialIcons name="error-outline" size={18} color="#dc2626" />
            <Text style={styles.errorBoxText}>{errorGenerar}</Text>
            <TouchableOpacity
              onPress={() => setErrorGenerar(null)}
              style={styles.errorCerrarBtn}
              accessibilityLabel="Cerrar aviso"
            >
              <MaterialIcons name="close" size={16} color="#dc2626" />
            </TouchableOpacity>
          </View>
        ) : null}

        {resultado ? (
          <View
            style={[
              styles.resultadoCard,
              num(resultado.total_facturas) === 0 && styles.resultadoCardNeutro,
            ]}
          >
            <View style={styles.resultadoHeader}>
              <MaterialIcons
                name={num(resultado.total_facturas) === 0 ? 'info-outline' : 'task-alt'}
                size={20}
                color={num(resultado.total_facturas) === 0 ? '#475569' : '#047857'}
              />
              <Text
                style={[
                  styles.resultadoTitulo,
                  num(resultado.total_facturas) === 0 && styles.resultadoTextoNeutro,
                ]}
              >
                {num(resultado.total_facturas) === 0
                  ? `No se ha creado ninguna factura de ${labelPeriodo(resultado.periodo)}`
                  : `${num(resultado.total_facturas)} ${plural(num(resultado.total_facturas), 'factura creada', 'facturas creadas')} en borrador · ${formatMoneda(num(resultado.total_importe))}`}
              </Text>
            </View>
            <Text
              style={[
                styles.resultadoSub,
                num(resultado.total_facturas) === 0 && styles.resultadoTextoNeutro,
              ]}
            >
              {`Periodo ${labelPeriodo(resultado.periodo)} · ${num(resultado.total_partes)} ${plural(num(resultado.total_partes), 'parte facturado', 'partes facturados')}`}
              {resultado.fecha_emision ? ` · fecha de emisión ${formatFecha(resultado.fecha_emision)}` : ''}
              {resultado.serie ? ` · serie ${resultado.serie}` : ''}
            </Text>

            {(resultado.facturas ?? []).map((factura) => (
              <View key={factura.id_factura} style={styles.facturaCreadaRow}>
                <View style={styles.facturaCreadaBody}>
                  <Text style={styles.facturaCreadaNombre} numberOfLines={2}>
                    {String(factura.empresa_nombre ?? '').trim() || factura.id_empresa}
                  </Text>
                  <Text style={styles.facturaCreadaMeta}>
                    {[
                      String(factura.empresa_cif ?? '').trim(),
                      `${num(factura.num_partes)} ${plural(num(factura.num_partes), 'parte', 'partes')}`,
                      `${num(factura.num_lineas)} ${plural(num(factura.num_lineas), 'línea', 'líneas')}`,
                      String(factura.estado ?? '').trim() || 'borrador',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  {factura.aviso ? (
                    <Text style={styles.facturaCreadaAviso}>{factura.aviso}</Text>
                  ) : null}
                </View>
                <Text style={styles.facturaCreadaTotal}>{formatMoneda(num(factura.total))}</Text>
                <TouchableOpacity
                  style={styles.abrirFacturaBtn}
                  onPress={() => abrirFactura(factura.id_factura)}
                  activeOpacity={0.8}
                >
                  <MaterialIcons name="open-in-new" size={15} color="#0369a1" />
                  <Text style={styles.abrirFacturaText}>Abrir factura</Text>
                </TouchableOpacity>
              </View>
            ))}

            {(resultado.errores ?? []).length > 0 ? (
              <View style={styles.resultadoBloqueError}>
                <Text style={styles.resultadoBloqueTitulo}>
                  Sociedades que no se pudieron facturar
                </Text>
                {(resultado.errores ?? []).map((err, i) => (
                  <Text key={`err-${i}`} style={styles.resultadoBloqueTexto}>
                    {`${String(err.empresa_nombre ?? err.id_empresa ?? 'Sociedad')}: ${String(err.error ?? 'error desconocido')}`}
                  </Text>
                ))}
                <Text style={styles.resultadoBloqueNota}>
                  Sus reparaciones han quedado libres y entrarán en la próxima generación.
                </Text>
              </View>
            ) : null}

            {(resultado.descartados ?? []).length > 0 ? (
              <View style={styles.resultadoBloqueAviso}>
                <Text style={styles.resultadoBloqueTitulo}>
                  {`Partes descartados por cambios simultáneos (${(resultado.descartados ?? []).length})`}
                </Text>
                <Text style={styles.resultadoBloqueNota}>
                  Alguien los modificó mientras se generaba la factura, así que no se han cobrado.
                  Vuelve a facturar el periodo para incluirlos.
                </Text>
                {(resultado.descartados ?? []).map((d, i) => (
                  <Text key={`desc-${i}`} style={styles.resultadoBloqueTexto}>
                    {[
                      String(d.local_nombre ?? '').trim(),
                      String(d.titulo ?? '').trim(),
                      d.fecha ? formatFecha(d.fecha) : '',
                    ]
                      .filter((p) => p !== '' && p !== '—')
                      .join(' · ')}
                  </Text>
                ))}
              </View>
            ) : null}

            {excluidosResultado.length > 0 ? renderExcluidos(excluidosResultado) : null}

            <TouchableOpacity
              style={styles.resultadoCerrarBtn}
              onPress={() => setResultado(null)}
              activeOpacity={0.8}
            >
              <MaterialIcons name="visibility" size={16} color="#0369a1" />
              <Text style={styles.resultadoCerrarText}>Volver a la previsualización</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {errorPrevisualizacion ? (
          <View style={styles.errorPanel}>
            <MaterialIcons name="error-outline" size={28} color="#dc2626" />
            <Text style={styles.errorPanelText}>{errorPrevisualizacion}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => void cargarPrevisualizacion(periodo)}
            >
              <Text style={styles.retryBtnText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        ) : cargandoPrevisualizacion && previsualizacion === null ? (
          <View style={styles.loadingPanel}>
            <ActivityIndicator size="large" color="#0ea5e9" />
            <Text style={styles.loadingText}>Calculando lo que se facturaría…</Text>
          </View>
        ) : sinNadaQueFacturar ? (
          <View style={styles.vacioPanel}>
            <MaterialIcons name="inbox" size={40} color="#94a3b8" />
            <Text style={styles.vacioTitulo}>
              {`No hay reparaciones pendientes de facturar en ${labelPeriodo(periodo)}`}
            </Text>
            <Text style={styles.vacioSub}>
              Todo lo valorado de este periodo ya está facturado, o todavía no hay reparaciones
              valoradas. No es un error.
            </Text>
          </View>
        ) : (
          <>
            {sociedades.length > 0 ? (
              <>
                <View style={styles.resumenRow}>
                  <View style={styles.resumenChip}>
                    <Text style={styles.resumenChipLabel}>Facturas</Text>
                    <Text style={styles.resumenChipValor}>{totalFacturas}</Text>
                  </View>
                  <View style={styles.resumenChip}>
                    <Text style={styles.resumenChipLabel}>Partes</Text>
                    <Text style={styles.resumenChipValor}>{totalPartes}</Text>
                  </View>
                  <View style={[styles.resumenChip, styles.resumenChipTotal]}>
                    <Text style={styles.resumenChipLabel}>Total con IVA</Text>
                    <Text style={[styles.resumenChipValor, styles.resumenChipValorTotal]}>
                      {formatMoneda(totalImporte)}
                    </Text>
                  </View>
                </View>
                <Text style={styles.resumenNota}>
                  {[
                    previsualizacion?.fecha_emision
                      ? `Fecha de emisión y de operación: ${formatFecha(previsualizacion.fecha_emision)}`
                      : '',
                    previsualizacion?.serie ? `serie ${previsualizacion.serie}` : '',
                    previsualizacion?.emisora?.nombre
                      ? `emite ${previsualizacion.emisora.nombre}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </>
            ) : null}

            {sociedades.map((soc) => {
              const plegada = sociedadesPlegadas.has(soc.id_empresa);
              const descuadre = num(soc.descuadre_centimos);
              return (
                <View key={soc.id_empresa} style={styles.sociedadCard}>
                  <TouchableOpacity
                    style={styles.sociedadHeader}
                    onPress={() => togglePlegada(soc.id_empresa)}
                    activeOpacity={0.75}
                  >
                    <MaterialIcons
                      name={plegada ? 'expand-more' : 'expand-less'}
                      size={20}
                      color="#64748b"
                    />
                    <View style={styles.sociedadIdentidad}>
                      <Text style={styles.sociedadNombre} numberOfLines={2}>
                        {String(soc.nombre ?? '').trim() || soc.id_empresa}
                      </Text>
                      <Text style={styles.sociedadMeta}>
                        {[
                          String(soc.cif ?? '').trim() || 'sin CIF',
                          soc.id_empresa,
                          `${num(soc.num_partes)} ${plural(num(soc.num_partes), 'parte', 'partes')}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <View style={styles.sociedadImportes}>
                      <Text style={styles.sociedadTotal}>{formatMoneda(num(soc.total))}</Text>
                      <Text style={styles.sociedadDesglose}>
                        {`Base ${formatMoneda(num(soc.base))} · IVA ${formatMoneda(num(soc.iva))}`}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  {soc.aviso ? (
                    <View style={styles.avisoBox}>
                      <MaterialIcons name="info-outline" size={15} color="#b45309" />
                      <Text style={styles.avisoBoxText}>{soc.aviso}</Text>
                    </View>
                  ) : null}

                  {descuadre !== 0 ? (
                    <Text style={styles.descuadreText}>
                      {`La factura difiere en ${descuadre} céntimos de la suma de las valoraciones (${formatMoneda(num(soc.total_valoraciones))}): mantenimiento y facturación redondean distinto. No bloquea la emisión.`}
                    </Text>
                  ) : null}

                  {!plegada ? renderDesgloseLocales(soc.locales ?? []) : null}
                </View>
              );
            })}

            {excluidosPrevistos.length > 0 ? renderExcluidos(excluidosPrevistos) : null}
          </>
        )}
      </ScrollView>

      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, backgroundColor: '#ffffff', minHeight: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  sinPermisoText: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 10 },
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
  headerTextBlock: { flex: 1, minWidth: 0 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', lineHeight: 18, marginTop: 2 },
  refreshBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
  },
  toolbarStacked: { flexDirection: 'column', alignItems: 'stretch' },
  periodoNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  periodoNavBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  periodoNavBtnDisabled: { opacity: 0.6 },
  periodoLabelWrap: { minWidth: 150, alignItems: 'center', gap: 1 },
  periodoLabel: { fontSize: 15, fontWeight: '700', color: '#334155', textTransform: 'capitalize' },
  periodoHint: { fontSize: 10, color: '#94a3b8', fontWeight: '600' },
  periodoLink: { fontSize: 10, color: '#0ea5e9', fontWeight: '700' },
  generarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#0ea5e9',
  },
  generarBtnDisabled: { backgroundColor: '#94a3b8' },
  generarBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  automaticoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
    paddingVertical: 5,
    paddingHorizontal: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  automaticoDot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: '#16a34a' },
  dotOff: { backgroundColor: '#94a3b8' },
  automaticoText: { flex: 1, minWidth: 0, fontSize: 11, color: '#64748b', lineHeight: 15 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24, gap: 10 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
  },
  errorBoxText: { flex: 1, minWidth: 0, fontSize: 12, color: '#dc2626', lineHeight: 17 },
  errorCerrarBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  errorPanel: { alignItems: 'center', gap: 10, paddingVertical: 32 },
  errorPanelText: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  retryBtn: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
  },
  retryBtnText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
  loadingPanel: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  loadingText: { fontSize: 13, color: '#64748b' },
  vacioPanel: { alignItems: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 16 },
  vacioTitulo: { fontSize: 15, fontWeight: '600', color: '#475569', textAlign: 'center' },
  vacioSub: { fontSize: 13, color: '#94a3b8', textAlign: 'center', maxWidth: 420, lineHeight: 18 },
  resumenRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  resumenChip: {
    minWidth: 110,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    gap: 2,
  },
  resumenChipTotal: { backgroundColor: '#f0f9ff', borderColor: '#bae6fd' },
  resumenChipLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  resumenChipValor: { fontSize: 17, fontWeight: '800', color: '#334155' },
  resumenChipValorTotal: { color: '#0369a1' },
  resumenNota: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },
  sociedadCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    backgroundColor: '#fff',
    padding: 10,
    gap: 8,
  },
  sociedadHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sociedadIdentidad: { flex: 1, minWidth: 0, gap: 2 },
  sociedadNombre: { fontSize: 14, fontWeight: '700', color: '#334155' },
  sociedadMeta: { fontSize: 11, color: '#94a3b8' },
  sociedadImportes: { alignItems: 'flex-end', gap: 2, flexShrink: 0 },
  sociedadTotal: { fontSize: 16, fontWeight: '800', color: '#0f766e' },
  sociedadDesglose: { fontSize: 10, color: '#94a3b8' },
  avisoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
  },
  avisoBoxText: { flex: 1, minWidth: 0, fontSize: 11, color: '#92400e', lineHeight: 15 },
  descuadreText: { fontSize: 10, color: '#b45309', lineHeight: 14 },
  localesBlock: { gap: 8 },
  localBlock: {
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    paddingTop: 6,
    gap: 3,
  },
  localHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  localNombre: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700', color: '#0369a1' },
  localTotal: { fontSize: 12, fontWeight: '700', color: '#475569' },
  parteRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 20 },
  parteFecha: { width: 78, fontSize: 11, color: '#94a3b8', flexShrink: 0 },
  parteTitulo: { flex: 1, minWidth: 0, fontSize: 11, color: '#475569' },
  parteTotal: { fontSize: 11, fontWeight: '600', color: '#475569', flexShrink: 0 },
  resultadoCard: {
    borderWidth: 1,
    borderColor: '#a7f3d0',
    borderRadius: 12,
    backgroundColor: '#f0fdf4',
    padding: 12,
    gap: 8,
  },
  resultadoCardNeutro: { borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  resultadoTextoNeutro: { color: '#475569' },
  resultadoHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  resultadoTitulo: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '700', color: '#065f46' },
  resultadoSub: { fontSize: 11, color: '#047857', lineHeight: 16 },
  facturaCreadaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d1fae5',
    backgroundColor: '#fff',
  },
  facturaCreadaBody: { flex: 1, minWidth: 160, gap: 2 },
  facturaCreadaNombre: { fontSize: 13, fontWeight: '700', color: '#334155' },
  facturaCreadaMeta: { fontSize: 10, color: '#94a3b8' },
  facturaCreadaAviso: { fontSize: 10, color: '#b45309', lineHeight: 14 },
  facturaCreadaTotal: { fontSize: 14, fontWeight: '800', color: '#0f766e', flexShrink: 0 },
  abrirFacturaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    flexShrink: 0,
  },
  abrirFacturaText: { fontSize: 11, fontWeight: '700', color: '#0369a1' },
  resultadoBloqueError: {
    gap: 3,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  resultadoBloqueAviso: {
    gap: 3,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fde68a',
    backgroundColor: '#fffbeb',
  },
  resultadoBloqueTitulo: { fontSize: 12, fontWeight: '700', color: '#92400e' },
  resultadoBloqueTexto: { fontSize: 11, color: '#78350f', lineHeight: 16 },
  resultadoBloqueNota: { fontSize: 10, color: '#a16207', lineHeight: 14 },
  resultadoCerrarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    alignSelf: 'flex-start',
  },
  resultadoCerrarText: { fontSize: 12, fontWeight: '700', color: '#0369a1' },
});
