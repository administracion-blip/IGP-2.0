/**
 * Facturación mensual de compras: ventas internas del grupo y abonos de rappel.
 *
 * Flujo: elegir periodo (por defecto el mes anterior) → previsualizar lo que se
 * facturaría → confirmar → ver el resultado con enlace a cada factura creada.
 * Es la misma herramienta que `app/(app)/mantenimiento/facturacion.tsx`, con dos
 * diferencias de fondo:
 *
 * - Aquí la **emisora también varía**, así que la unidad de facturación es el
 *   par emisora–receptora y la previsualización tiene que dejar claro quién
 *   factura a quién antes que cualquier otra cosa.
 * - Hay **dos documentos distintos** (factura de ventas internas y abono de
 *   rappel, con series y signos distintos) y por eso hay dos pestañas: cada una
 *   con su previsualización y su único botón de generar, para que nunca haya
 *   duda de qué documento se está creando.
 *
 * Contrato del backend en `api/routes/comprasFacturacion.js`. El flujo de rappel
 * puede no estar desplegado todavía: su pestaña lo detecta y lo cuenta, en vez
 * de romper la pantalla.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useAjustesFacturacionCompras } from '../../hooks/useAjustesFacturacionCompras';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatMoneda } from '../../utils/facturacion';
import { formatFecha } from '../../utils/formatFecha';
import { formatId6 } from '../../utils/idFormat';
import { MIN_TOUCH } from '../../constants/layout';
import { ExcluidosFacturacionCard } from '../../components/facturacion/ExcluidosFacturacionCard';
import {
  desplazarPeriodo,
  labelPeriodo,
  num,
  periodoAnterior,
  periodoDeFecha,
  plural,
  totalExcluidos,
} from '../../lib/facturacionPeriodica';
import {
  ENDPOINTS_FACTURACION_COMPRAS,
  clasificarExcluidosCompras,
  documentosDe,
  esFlujoNoDisponible,
  type FacturaCompras,
  type FlujoFacturacionCompras,
  type LocalDestinoDesglose,
  type PrevisualizacionCompras,
  type ResultadoCompras,
} from '../../lib/comprasFacturacion';

/** Textos de cada flujo: lo único que cambia entre las dos pestañas. */
const TEXTOS: Record<
  FlujoFacturacionCompras,
  {
    pestana: string;
    icono: React.ComponentProps<typeof MaterialIcons>['name'];
    titulo: string;
    explicacion: string;
    botonGenerar: string;
    tituloConfirmar: string;
    documento: [string, string];
    /** Participio concordado: «factura creada» / «abono creado». */
    creado: [string, string];
    /** Lado derecho del par de sociedades: «Factura a» / «Abona a». */
    verboPar: string;
    lineasTitulo: string;
    /** Pedidos que no aportan importe a este flujo: lo normal en el rappel. */
    sinImporte: [string, string];
    vacio: string;
    vacioDetalle: string;
    errorPrevisualizar: string;
    errorGenerar: string;
    noDisponible: string;
  }
> = {
  ventas: {
    pestana: 'Ventas internas',
    icono: 'local-shipping',
    titulo: 'Ventas internas del grupo',
    explicacion:
      'Los pedidos servidos desde un almacén a los locales se facturan una vez al mes: la sociedad que sirve la mercancía factura a la sociedad que la recibe. Se crea una factura por cada par de sociedades, con las líneas agrupadas por local de origen y tipo de IVA.',
    botonGenerar: 'Generar facturas',
    tituloConfirmar: 'Generar las facturas de ventas internas',
    documento: ['factura', 'facturas'],
    creado: ['factura creada', 'facturas creadas'],
    verboPar: 'Factura a',
    lineasTitulo: 'Líneas de la factura, por local de origen',
    sinImporte: ['pedido sin importe que facturar', 'pedidos sin importe que facturar'],
    vacio: 'No hay pedidos pendientes de facturar en',
    vacioDetalle:
      'Todos los pedidos completados de este periodo están ya facturados, o todavía no hay ninguno. No es un error.',
    errorPrevisualizar: 'No se pudo calcular la previsualización de las ventas internas',
    errorGenerar: 'No se pudieron generar las facturas de ventas internas',
    noDisponible: 'La facturación de ventas internas no está disponible en el servidor.',
  },
  rappel: {
    pestana: 'Abonos de rappel',
    icono: 'savings',
    titulo: 'Abonos de rappel',
    explicacion:
      'El rappel del periodo se devuelve al local en un documento aparte de la factura de venta, con su propia serie e importes negativos: es una rectificativa por diferencias del periodo, no de una factura concreta. Se crea un abono por cada par de sociedades y también nace en borrador.',
    botonGenerar: 'Generar abonos',
    tituloConfirmar: 'Generar los abonos de rappel',
    documento: ['abono', 'abonos'],
    creado: ['abono creado', 'abonos creados'],
    verboPar: 'Abona a',
    lineasTitulo: 'Líneas del abono, por local de origen',
    sinImporte: ['pedido sin rappel, lo habitual', 'pedidos sin rappel, lo habitual'],
    vacio: 'No hay rappel pendiente de abonar en',
    vacioDetalle:
      'Todo el rappel de este periodo está ya abonado, o todavía no hay pedidos con rappel. No es un error.',
    errorPrevisualizar: 'No se pudo calcular la previsualización de los abonos de rappel',
    errorGenerar: 'No se pudieron generar los abonos de rappel',
    noDisponible:
      'Los abonos de rappel todavía no están disponibles en el servidor: la facturación de ventas internas sí funciona y puedes usarla desde la otra pestaña.',
  },
};

type EstadoFlujo = {
  /** Último periodo para el que se lanzó la carga: evita reintentos en bucle. */
  intentoPeriodo: string;
  /** Periodo de los datos que hay en pantalla. */
  periodoCargado: string;
  previsualizacion: PrevisualizacionCompras | null;
  cargando: boolean;
  error: string | null;
  /** El servidor no conoce la ruta: el flujo no está desplegado todavía. */
  noDisponible: boolean;
  generando: boolean;
  errorGenerar: string | null;
  resultado: ResultadoCompras | null;
};

const ESTADO_INICIAL: EstadoFlujo = {
  intentoPeriodo: '',
  periodoCargado: '',
  previsualizacion: null,
  cargando: false,
  error: null,
  noDisponible: false,
  generando: false,
  errorGenerar: null,
  resultado: null,
};

const ESTADOS_INICIALES: Record<FlujoFacturacionCompras, EstadoFlujo> = {
  ventas: ESTADO_INICIAL,
  rappel: ESTADO_INICIAL,
};

/**
 * Tira la previsualización a la basura tras una generación fallida: el servidor
 * puede haber creado parte del lote, así que las cifras de pantalla ya no son
 * ciertas. Hay que borrar **también** `periodoCargado`, porque el efecto de
 * carga sale por esa condición: invalidar solo `intentoPeriodo` no recargaba
 * nada y dejaba el botón de generar activo prometiendo facturas ya emitidas.
 */
const INVALIDAR: Partial<EstadoFlujo> = {
  previsualizacion: null,
  periodoCargado: '',
  intentoPeriodo: '',
};

/** Nombre de la sociedad y, entre paréntesis, su CIF o su id del maestro. */
function etiquetaSociedad(nombre?: string, cif?: string, id?: string): { nombre: string; meta: string } {
  const idTexto = String(id ?? '').trim();
  return {
    nombre: String(nombre ?? '').trim() || (idTexto ? `Sociedad ${formatId6(idTexto)}` : 'Sociedad sin nombre'),
    meta: [String(cif ?? '').trim(), idTexto ? formatId6(idTexto) : ''].filter(Boolean).join(' · '),
  };
}

export default function FacturacionComprasScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { isCompact } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();
  const {
    ajustes,
    ultimoPeriodoGenerado,
    loading: cargandoAjustes,
    error: errorAjustes,
  } = useAjustesFacturacionCompras();

  const [flujo, setFlujo] = useState<FlujoFacturacionCompras>('ventas');
  const [periodo, setPeriodo] = useState(() => periodoAnterior());
  const [estados, setEstados] = useState(ESTADOS_INICIALES);
  const [facturasPlegadas, setFacturasPlegadas] = useState<Set<string>>(new Set());

  const puedeFacturar = hasPermiso('compras.facturar');
  /** Hasta el mes en curso se puede navegar para consultar el avance parcial. */
  const periodoMaximo = periodoDeFecha();
  const periodoEnCurso = periodoDeFecha();
  const esMesEnCurso = periodo === periodoEnCurso;
  const textos = TEXTOS[flujo];
  const estado = estados[flujo];
  const serie = flujo === 'ventas' ? ajustes.serieVentas : ajustes.serieRappel;

  const parchear = useCallback(
    (destino: FlujoFacturacionCompras, patch: Partial<EstadoFlujo>) => {
      setEstados((prev) => ({ ...prev, [destino]: { ...prev[destino], ...patch } }));
    },
    [],
  );

  /**
   * Periodo de la última previsualización lanzada en cada flujo. La consulta
   * escanea los pedidos y puede tardar, así que una respuesta puede llegar
   * cuando el usuario ya ha cambiado de mes: sin este contraste, los importes
   * de junio se quedarían pintados bajo la etiqueta de mayo y se generaría mayo
   * con las cifras del mes equivocado.
   */
  const peticionVigente = useRef<Record<FlujoFacturacionCompras, string>>({ ventas: '', rappel: '' });

  const cargarPrevisualizacion = useCallback(
    async (destino: FlujoFacturacionCompras, objetivo: string) => {
      peticionVigente.current[destino] = objetivo;
      parchear(destino, { cargando: true, error: null, noDisponible: false, intentoPeriodo: objetivo });
      /** Falso si mientras se esperaba se lanzó otra carga de este flujo. */
      const vigente = () => peticionVigente.current[destino] === objetivo;
      try {
        const res = await apiFetch(
          `${ENDPOINTS_FACTURACION_COMPRAS[destino].previsualizar}?periodo=${encodeURIComponent(objetivo)}`,
        );
        if (!vigente()) return;
        if (esFlujoNoDisponible(res.status)) {
          parchear(destino, { cargando: false, noDisponible: true, previsualizacion: null, periodoCargado: '' });
          return;
        }
        const data = (await res.json()) as PrevisualizacionCompras;
        if (!vigente()) return;
        if (!res.ok || data.error) {
          parchear(destino, {
            cargando: false,
            previsualizacion: null,
            periodoCargado: '',
            error: data.error ?? TEXTOS[destino].errorPrevisualizar,
          });
          return;
        }
        parchear(destino, { cargando: false, previsualizacion: data, periodoCargado: objetivo });
      } catch (e) {
        if (!vigente()) return;
        parchear(destino, {
          cargando: false,
          previsualizacion: null,
          periodoCargado: '',
          error: errorMessage(e, TEXTOS[destino].errorPrevisualizar),
        });
      }
    },
    [parchear],
  );

  // Solo se carga la pestaña visible; la otra espera a que se abra. Volver a
  // intentar el mismo periodo tras un fallo es cosa del botón «Reintentar».
  useEffect(() => {
    if (!puedeFacturar) return;
    const actual = estados[flujo];
    if (actual.cargando || actual.generando) return;
    if (actual.periodoCargado === periodo || actual.intentoPeriodo === periodo) return;
    void cargarPrevisualizacion(flujo, periodo);
  }, [puedeFacturar, flujo, periodo, estados, cargarPrevisualizacion]);

  /**
   * Segunda barrera contra los datos de otro mes: aunque el contraste de
   * `peticionVigente` ya descarta las respuestas tardías, aquí no se pinta nada
   * que no lleve la etiqueta del periodo que hay seleccionado.
   */
  const previsualizacion = estado.periodoCargado === periodo ? estado.previsualizacion : null;
  const resultado = estado.resultado;
  const facturas = useMemo(() => documentosDe(previsualizacion), [previsualizacion]);
  const facturasCreadas = useMemo(() => documentosDe(resultado), [resultado]);

  const excluidosPrevistos = useMemo(
    () => clasificarExcluidosCompras(previsualizacion?.excluidos ?? []),
    [previsualizacion],
  );
  const excluidosResultado = useMemo(
    () => clasificarExcluidosCompras(resultado?.excluidos ?? []),
    [resultado],
  );

  const totalFacturas = num(previsualizacion?.total_facturas ?? facturas.length);
  const totalPedidos = num(previsualizacion?.total_pedidos);
  const totalImporte = num(previsualizacion?.total_importe);
  const pendientesAnteriores = useMemo(
    () => (previsualizacion?.pendientes_periodos_anteriores ?? []).filter((p) => num(p.pedidos) > 0),
    [previsualizacion],
  );
  const pedidosPendientesAnteriores = pendientesAnteriores.reduce((s, p) => s + num(p.pedidos), 0);
  const sinNadaQueFacturar =
    previsualizacion !== null &&
    facturas.length === 0 &&
    totalExcluidos(excluidosPrevistos.correccion) === 0;

  /**
   * Con el resultado en pantalla la previsualización ya es historia: se oculta y
   * no se puede volver a generar sin recalcularla. Si no, el usuario dispararía
   * una segunda tanda leyendo cifras que ya se facturaron.
   */
  const generarBloqueado =
    esMesEnCurso ||
    facturas.length === 0 ||
    estado.cargando ||
    estado.generando ||
    resultado !== null;

  /**
   * Alguna pestaña está generando. Se mira en las dos y no solo en la visible:
   * cambiar de pestaña no cancela la generación en vuelo, y si entretanto se
   * cambiara de mes su resultado aterrizaría bajo un periodo que no es el suyo.
   */
  const generandoAlguno = estados.ventas.generando || estados.rappel.generando;

  const irAPeriodo = useCallback(
    (objetivo: string) => {
      if (generandoAlguno) return;
      setEstados(ESTADOS_INICIALES);
      setFacturasPlegadas(new Set());
      setPeriodo(objetivo);
    },
    [generandoAlguno],
  );

  const cambiarPeriodo = useCallback(
    (meses: number) => {
      const siguiente = desplazarPeriodo(periodo, meses);
      if (siguiente > periodoMaximo) return;
      irAPeriodo(siguiente);
    },
    [periodo, periodoMaximo, irAPeriodo],
  );

  /** Recalcula el periodo y deja de mostrar el resultado de la última tanda. */
  const refrescar = useCallback(() => {
    parchear(flujo, { resultado: null, errorGenerar: null });
    void cargarPrevisualizacion(flujo, periodo);
  }, [flujo, periodo, parchear, cargarPrevisualizacion]);

  const togglePlegada = useCallback((clave: string) => {
    setFacturasPlegadas((prev) => {
      const next = new Set(prev);
      if (next.has(clave)) next.delete(clave);
      else next.add(clave);
      return next;
    });
  }, []);

  const generar = useCallback(async () => {
    if (esMesEnCurso || facturas.length === 0) return;
    const [uno, varios] = textos.documento;
    const pares = facturas.length === 1 ? 'un par de sociedades' : `${facturas.length} pares de sociedades`;
    /**
     * Pares que ya tienen documento de este periodo. Es el dato que distingue
     * «recojo los pedidos que faltaban» de «creo un segundo documento a la misma
     * sociedad», así que tiene que estar en lo que el usuario confirma.
     */
    const conDocumento = facturas.filter((f) => (f.facturas_existentes ?? []).length > 0).length;
    const confirmado = await confirmar(
      textos.tituloConfirmar,
      `Se crearán ${totalFacturas} ${plural(totalFacturas, uno, varios)} en borrador entre ${pares}, ` +
        `por un total de ${formatMoneda(totalImporte)} (IVA incluido), con ${totalPedidos} ` +
        `${plural(totalPedidos, 'pedido', 'pedidos')} de ${labelPeriodo(periodo)}.` +
        (previsualizacion?.serie ? ` Serie ${previsualizacion.serie}.` : '') +
        (previsualizacion?.fecha_emision
          ? ` Fecha de emisión: ${formatFecha(previsualizacion.fecha_emision)}.`
          : '') +
        (conDocumento > 0
          ? ` Atención: ${conDocumento === 1 ? 'uno de los pares' : `${conDocumento} de los pares`} ya ` +
            `${plural(conDocumento, 'tiene', 'tienen')} ${plural(conDocumento, uno, varios)} de este periodo, ` +
            `así que lo que se cree ahora será un documento aparte con los pedidos que faltaban ` +
            '(en la lista sale marcado con «Ya existe…»).'
          : '') +
        ' Son documentos fiscales y los pedidos incluidos quedarán bloqueados: revisa el desglose antes de continuar.',
      { confirmarLabel: textos.botonGenerar },
    );
    if (!confirmado) return;

    const destino = flujo;
    parchear(destino, { generando: true, errorGenerar: null });
    try {
      const res = await apiFetch(ENDPOINTS_FACTURACION_COMPRAS[destino].generar, {
        method: 'POST',
        body: JSON.stringify({ periodo }),
      });
      if (esFlujoNoDisponible(res.status)) {
        parchear(destino, { generando: false, noDisponible: true });
        return;
      }
      const data = (await res.json()) as ResultadoCompras;
      if (!res.ok || data.error) {
        parchear(destino, { generando: false, errorGenerar: data.error ?? TEXTOS[destino].errorGenerar, ...INVALIDAR });
        return;
      }
      parchear(destino, { generando: false, resultado: data });
    } catch (e) {
      parchear(destino, {
        generando: false,
        errorGenerar: errorMessage(e, TEXTOS[destino].errorGenerar),
        ...INVALIDAR,
      });
    }
  }, [
    facturas,
    textos,
    confirmar,
    totalFacturas,
    totalImporte,
    totalPedidos,
    periodo,
    esMesEnCurso,
    previsualizacion,
    flujo,
    parchear,
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
        <Text style={styles.sinPermisoText}>
          No tienes permiso para generar la facturación mensual de compras.
        </Text>
      </View>
    );
  }

  /** Desglose por local de destino, con los pedidos que se le imputan. */
  const renderLocalesDestino = (locales: LocalDestinoDesglose[]) => (
    <View style={styles.bloqueDetalle}>
      <Text style={styles.bloqueTitulo}>Pedidos por local que recibe</Text>
      {locales.map((local, iLocal) => (
        <View key={`${local.local_id ?? iLocal}`} style={styles.localBlock}>
          <View style={styles.localHeader}>
            <MaterialIcons name="store" size={14} color="#0369a1" />
            <Text style={styles.localNombre} numberOfLines={1}>
              {String(local.local_nombre ?? local.local_id ?? 'Sin local')}
            </Text>
            <Text style={styles.localTotal}>{formatMoneda(num(local.base))}</Text>
          </View>
          {(local.pedidos ?? []).map((pedido, iPedido) => (
            <View key={`${local.local_id ?? iLocal}-${pedido.id ?? iPedido}`} style={styles.pedidoRow}>
              <Text style={styles.pedidoFecha}>
                {pedido.fecha_texto ? pedido.fecha_texto : formatFecha(pedido.fecha)}
              </Text>
              <Text style={styles.pedidoId} numberOfLines={1}>
                {String(pedido.id ?? '').trim() || 'Pedido sin id'}
              </Text>
              <Text style={styles.pedidoOrigen} numberOfLines={1}>
                {String(pedido.origen_nombre ?? '').trim()}
              </Text>
              <Text style={styles.pedidoTotal}>{formatMoneda(num(pedido.base))}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );

  /**
   * Tarjeta de una factura, prevista o creada. Lo primero es el par de
   * sociedades: es lo que el usuario va a querer comprobar antes que nada.
   */
  const renderFactura = (factura: FacturaCompras, indice: number, creada: boolean) => {
    const clave = `${flujo}-${creada ? 'creada' : 'prevista'}-${factura.id_factura ?? ''}-${factura.id_empresa_emisora ?? ''}-${factura.id_empresa ?? ''}-${indice}`;
    const plegada = facturasPlegadas.has(clave);
    const emisora = etiquetaSociedad(
      factura.empresa_emisora_nombre,
      factura.empresa_emisora_cif,
      factura.id_empresa_emisora,
    );
    const receptora = etiquetaSociedad(factura.empresa_nombre, factura.empresa_cif, factura.id_empresa);
    const descuadre = num(factura.descuadre_centimos);
    const numPedidos = num(factura.num_pedidos);
    const idFactura = String(factura.id_factura ?? '').trim();

    return (
      <View key={clave} style={[styles.facturaCard, creada && styles.facturaCardCreada]}>
        <TouchableOpacity
          style={styles.facturaHeader}
          onPress={() => togglePlegada(clave)}
          activeOpacity={0.75}
          accessibilityLabel={plegada ? 'Mostrar el desglose' : 'Ocultar el desglose'}
        >
          <MaterialIcons name={plegada ? 'expand-more' : 'expand-less'} size={20} color="#64748b" />
          <View style={[styles.parBlock, isCompact && styles.parBlockStacked]}>
            <View style={styles.parLado}>
              <Text style={styles.parEtiqueta}>Emite</Text>
              <Text style={styles.parNombre} numberOfLines={2}>
                {emisora.nombre}
              </Text>
              {emisora.meta ? <Text style={styles.parMeta}>{emisora.meta}</Text> : null}
            </View>
            <MaterialIcons
              name={isCompact ? 'arrow-downward' : 'arrow-forward'}
              size={18}
              color="#0ea5e9"
              style={styles.parFlecha}
            />
            <View style={styles.parLado}>
              <Text style={styles.parEtiqueta}>{textos.verboPar}</Text>
              <Text style={styles.parNombre} numberOfLines={2}>
                {receptora.nombre}
              </Text>
              {receptora.meta ? <Text style={styles.parMeta}>{receptora.meta}</Text> : null}
            </View>
          </View>
          <View style={styles.facturaImportes}>
            <Text style={styles.facturaTotal}>{formatMoneda(num(factura.total))}</Text>
            <Text style={styles.facturaDesglose}>
              {`Base ${formatMoneda(num(factura.base))} · IVA ${formatMoneda(num(factura.iva))}`}
            </Text>
            <Text style={styles.facturaDesglose}>
              {[
                `${numPedidos} ${plural(numPedidos, 'pedido', 'pedidos')}`,
                num(factura.num_lineas) > 0
                  ? `${num(factura.num_lineas)} ${plural(num(factura.num_lineas), 'línea', 'líneas')}`
                  : '',
                String(factura.estado ?? '').trim(),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        </TouchableOpacity>

        {idFactura ? (
          <TouchableOpacity
            style={styles.abrirFacturaBtn}
            onPress={() => abrirFactura(idFactura)}
            activeOpacity={0.8}
          >
            <MaterialIcons name="open-in-new" size={15} color="#0369a1" />
            <Text style={styles.abrirFacturaText}>{`Abrir ${textos.documento[0]}`}</Text>
          </TouchableOpacity>
        ) : null}

        {factura.aviso ? (
          <View style={styles.avisoBox}>
            <MaterialIcons name="info-outline" size={15} color="#b45309" />
            <Text style={styles.avisoBoxText}>{factura.aviso}</Text>
          </View>
        ) : null}

        {descuadre !== 0 ? (
          <Text style={styles.descuadreText}>
            {`La base queda ${Math.abs(descuadre)} ${plural(Math.abs(descuadre), 'céntimo', 'céntimos')} ` +
              `${descuadre > 0 ? 'por encima' : 'por debajo'} de la del informe por empresa ` +
              `(${formatMoneda(num(factura.base_informe))}): el informe suma en crudo y el documento redondea ` +
              'cada línea. No bloquea la emisión.'}
          </Text>
        ) : null}

        {plegada ? null : (
          <>
            {(factura.impuestos ?? []).length > 0 ? (
              <View style={styles.impuestosRow}>
                {(factura.impuestos ?? []).map((imp, i) => (
                  <View key={`imp-${i}`} style={styles.impuestoChip}>
                    <Text style={styles.impuestoChipTipo}>{`IVA ${num(imp.tipo_iva)}%`}</Text>
                    <Text style={styles.impuestoChipValor}>
                      {`${formatMoneda(num(imp.base))} + ${formatMoneda(num(imp.cuota))}`}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {(factura.origenes ?? []).length > 0 ? (
              <View style={styles.bloqueDetalle}>
                <Text style={styles.bloqueTitulo}>{textos.lineasTitulo}</Text>
                {(factura.origenes ?? []).map((origen, i) => (
                  <View key={`${origen.origen_clave ?? i}`} style={styles.origenRow}>
                    <MaterialIcons name="warehouse" size={14} color="#0f766e" />
                    <Text style={styles.origenNombre} numberOfLines={1}>
                      {String(origen.origen_nombre ?? '').trim() || 'Origen sin nombre'}
                    </Text>
                    <Text style={styles.origenPedidos}>
                      {`${num(origen.num_pedidos)} ${plural(num(origen.num_pedidos), 'pedido', 'pedidos')}`}
                    </Text>
                    <Text style={styles.origenBase}>{formatMoneda(num(origen.base))}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {(factura.locales ?? []).length > 0 ? renderLocalesDestino(factura.locales ?? []) : null}
          </>
        )}
      </View>
    );
  };

  const renderExcluidos = (grupos: ReturnType<typeof clasificarExcluidosCompras>) => (
    <>
      <ExcluidosFacturacionCard
        grupos={grupos.correccion}
        titulo="Pendiente de corregir para poder emitir"
        intro={`Estos pedidos se quedan fuera porque falta un dato. Corrígelo y vuelve a generar este mismo periodo: nada se pierde, la generación es repetible y solo recoge lo que aún no tiene ${textos.documento[0]}.`}
        tono="aviso"
      />
      <ExcluidosFacturacionCard
        grupos={grupos.informativos}
        titulo="Fuera de esta tanda, sin nada que corregir"
        intro="Se informa para que cuadren las cifras, pero no requiere ninguna acción: son pedidos que por su naturaleza no generan documento."
        tono="info"
        plegadoInicial
      />
    </>
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/compras' as never)}
          style={styles.backBtn}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityLabel="Volver a Compras"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={styles.headerTextBlock}>
          <Text style={styles.title}>Facturación mensual de compras</Text>
          <Text style={styles.subtitle}>
            Las facturas y los abonos se crean en borrador: no consumen numeración hasta que se
            emiten, y hasta entonces se pueden revisar y corregir en Facturación.
          </Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={refrescar}
          disabled={estado.cargando || estado.generando}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityLabel="Actualizar previsualización"
        >
          {estado.cargando ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <MaterialIcons name="refresh" size={22} color="#0ea5e9" />
          )}
        </TouchableOpacity>
      </View>

      {/* Dos documentos fiscales distintos, dos pestañas: un solo botón de
          generar visible a la vez para que no haya duda de qué se crea. */}
      <View style={styles.pestanas}>
        {(Object.keys(TEXTOS) as FlujoFacturacionCompras[]).map((id) => {
          const activa = id === flujo;
          const estadoPestana = estados[id];
          const previstas = num(
            estadoPestana.previsualizacion?.total_facturas ??
              documentosDe(estadoPestana.previsualizacion).length,
          );
          return (
            <TouchableOpacity
              key={id}
              style={[styles.pestana, activa && styles.pestanaActiva]}
              onPress={() => setFlujo(id)}
              activeOpacity={0.8}
              accessibilityLabel={TEXTOS[id].pestana}
            >
              <MaterialIcons
                name={TEXTOS[id].icono}
                size={16}
                color={activa ? '#0369a1' : '#94a3b8'}
              />
              <Text style={[styles.pestanaText, activa && styles.pestanaTextActiva]}>
                {TEXTOS[id].pestana}
              </Text>
              {estadoPestana.noDisponible ? (
                <MaterialIcons name="cloud-off" size={14} color="#94a3b8" />
              ) : previstas > 0 ? (
                <View style={styles.pestanaBadge}>
                  <Text style={styles.pestanaBadgeText}>{previstas}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={[styles.toolbar, isCompact && styles.toolbarStacked]}>
        <View style={styles.periodoNav}>
          <TouchableOpacity
            style={[styles.periodoNavBtn, generandoAlguno && styles.periodoNavBtnDisabled]}
            onPress={() => cambiarPeriodo(-1)}
            disabled={generandoAlguno}
            accessibilityLabel="Mes anterior"
          >
            <MaterialIcons name="chevron-left" size={22} color="#334155" />
          </TouchableOpacity>
          <View style={styles.periodoLabelWrap}>
            <Text style={styles.periodoLabel} numberOfLines={1}>
              {labelPeriodo(periodo)}
            </Text>
            {esMesEnCurso ? (
              <Text style={styles.periodoHint}>Mes en curso · solo consulta</Text>
            ) : (
              <TouchableOpacity
                onPress={() => irAPeriodo(periodoEnCurso)}
                disabled={generandoAlguno}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              >
                <Text style={[styles.periodoLink, generandoAlguno && styles.periodoLinkDisabled]}>
                  Ir al mes en curso
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={[
              styles.periodoNavBtn,
              (periodo >= periodoMaximo || generandoAlguno) && styles.periodoNavBtnDisabled,
            ]}
            onPress={() => cambiarPeriodo(1)}
            disabled={generandoAlguno || periodo >= periodoMaximo}
            accessibilityLabel={
              periodo >= periodoMaximo
                ? 'No hay meses futuros'
                : 'Mes siguiente'
            }
          >
            <MaterialIcons
              name="chevron-right"
              size={22}
              color={periodo >= periodoMaximo ? '#cbd5e1' : '#334155'}
            />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.generarBtn, generarBloqueado && styles.generarBtnDisabled]}
          onPress={() => void generar()}
          disabled={generarBloqueado}
          activeOpacity={0.8}
        >
          {estado.generando ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <MaterialIcons name="receipt-long" size={18} color="#fff" />
          )}
          <Text style={styles.generarBtnText}>
            {estado.generando ? 'Generando…' : textos.botonGenerar}
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.explicacion}>{textos.explicacion}</Text>

      {/* Sin esta frase, la flecha bloqueada parece un fallo de la pantalla. */}
      {esMesEnCurso ? (
        <View style={styles.periodoNota}>
          <MaterialIcons name="event-busy" size={14} color="#64748b" />
          <Text style={styles.periodoNotaText}>
            {`${labelPeriodo(periodo)} está en curso: puedes consultar lo completado hasta hoy, pero la facturación se hará al cerrar el mes. Generar ahora congelaría los pedidos del resto del mes.`}
          </Text>
        </View>
      ) : null}

      {/* Si la configuración no se pudo leer no se dice nada: afirmar que la
          generación automática está desactivada sin saberlo engaña al usuario. */}
      {!cargandoAjustes && !errorAjustes ? (
        <View style={styles.automaticoChip}>
          <View style={[styles.automaticoDot, ajustes.enabled ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.automaticoText}>
            {(ajustes.enabled
              ? `Generación automática activa: cada día ${ajustes.diaGeneracion} a las ${ajustes.hora}. Serie ${serie}.`
              : `Generación automática desactivada: solo se genera cuando alguien pulsa «${textos.botonGenerar}». Serie ${serie}.`) +
              (ultimoPeriodoGenerado ? ` Último periodo generado: ${labelPeriodo(ultimoPeriodoGenerado)}.` : '')}
          </Text>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {estado.errorGenerar ? (
          <View style={styles.errorBox}>
            <MaterialIcons name="error-outline" size={18} color="#dc2626" />
            <View style={styles.errorBoxBody}>
              <Text style={styles.errorBoxText}>{estado.errorGenerar}</Text>
              <Text style={styles.errorBoxNota}>
                Puede que se haya creado parte del lote, así que las cifras anteriores ya no valen y
                se están recalculando: lo que abajo siga apareciendo es lo que queda pendiente, y lo
                que ya tenga documento habrá desaparecido de la lista.
              </Text>
              <TouchableOpacity
                style={styles.errorBoxLink}
                onPress={() => router.push('/facturacion/facturas-venta' as never)}
                activeOpacity={0.8}
              >
                <MaterialIcons name="open-in-new" size={14} color="#b91c1c" />
                <Text style={styles.errorBoxLinkText}>Ver en Facturación los documentos emitidos</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              onPress={() => parchear(flujo, { errorGenerar: null })}
              style={styles.errorCerrarBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
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
            {resultado.interrumpida ? (
              <View style={styles.interrumpidaBox}>
                <MaterialIcons name="pause-circle-filled" size={18} color="#b91c1c" />
                <Text style={styles.interrumpidaText}>
                  La generación se paró antes de terminar. Lo que aparece abajo es lo que sí se ha
                  creado; el resto de pedidos ha quedado libre y entrará al volver a generar este
                  periodo.
                </Text>
              </View>
            ) : null}

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
                  ? `No se ha creado ningún documento de ${labelPeriodo(resultado.periodo)}`
                  : `${num(resultado.total_facturas)} ${plural(num(resultado.total_facturas), textos.creado[0], textos.creado[1])} en borrador · ${formatMoneda(num(resultado.total_importe))}`}
              </Text>
            </View>
            <Text
              style={[
                styles.resultadoSub,
                num(resultado.total_facturas) === 0 && styles.resultadoTextoNeutro,
              ]}
            >
              {[
                `Periodo ${labelPeriodo(resultado.periodo)}`,
                `${num(resultado.total_pedidos)} ${plural(num(resultado.total_pedidos), 'pedido incluido', 'pedidos incluidos')}`,
                resultado.fecha_emision ? `emisión ${formatFecha(resultado.fecha_emision)}` : '',
                resultado.serie ? `serie ${resultado.serie}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>

            {facturasCreadas.map((factura, i) => renderFactura(factura, i, true))}

            {(resultado.errores ?? []).length > 0 ? (
              <View style={styles.resultadoBloqueError}>
                <Text style={styles.resultadoBloqueTitulo}>
                  {`Pares de sociedades que quedaron sin documento (${(resultado.errores ?? []).length})`}
                </Text>
                {(resultado.errores ?? []).map((err, i) => (
                  <Text key={`err-${i}`} style={styles.resultadoBloqueTexto}>
                    {`${String(err.empresa_emisora_nombre ?? err.id_empresa_emisora ?? 'Sociedad')} → ${String(err.empresa_nombre ?? err.id_empresa ?? 'Sociedad')}: ${String(err.error ?? 'error desconocido')}`}
                  </Text>
                ))}
                <Text style={styles.resultadoBloqueNota}>
                  Sus pedidos han quedado libres: no se ha creado ningún documento para ellos y
                  entrarán en la próxima generación de este periodo.
                </Text>
              </View>
            ) : null}

            {(resultado.descartados ?? []).length > 0 ? (
              <View style={styles.resultadoBloqueAviso}>
                <Text style={styles.resultadoBloqueTitulo}>
                  {`Pedidos descartados por cambios simultáneos (${(resultado.descartados ?? []).length})`}
                </Text>
                <Text style={styles.resultadoBloqueNota}>
                  Alguien los modificó mientras se generaba el documento, así que no se han
                  facturado. Vuelve a generar el periodo para incluirlos.
                </Text>
                {(resultado.descartados ?? []).map((d, i) => (
                  <Text key={`desc-${i}`} style={styles.resultadoBloqueTexto}>
                    {[
                      String(d.pedido_id ?? '').trim(),
                      String(d.local_nombre ?? '').trim(),
                      d.fecha ? formatFecha(d.fecha) : '',
                    ]
                      .filter((p) => p !== '' && p !== '—')
                      .join(' · ')}
                  </Text>
                ))}
              </View>
            ) : null}

            {renderExcluidos(excluidosResultado)}

            <TouchableOpacity
              style={styles.resultadoCerrarBtn}
              onPress={refrescar}
              activeOpacity={0.8}
            >
              <MaterialIcons name="visibility" size={16} color="#0369a1" />
              <Text style={styles.resultadoCerrarText}>Recalcular lo que queda pendiente</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Con el resultado delante no se repite la previsualización: son las
            mismas cifras ya facturadas y confundirían sobre qué queda por hacer. */}
        {resultado ? null : estado.noDisponible ? (
          <View style={styles.noDisponiblePanel}>
            <MaterialIcons name="cloud-off" size={36} color="#94a3b8" />
            <Text style={styles.noDisponibleTitulo}>{textos.noDisponible}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => void cargarPrevisualizacion(flujo, periodo)}
            >
              <Text style={styles.retryBtnText}>Volver a comprobar</Text>
            </TouchableOpacity>
          </View>
        ) : estado.error ? (
          <View style={styles.errorPanel}>
            <MaterialIcons name="error-outline" size={28} color="#dc2626" />
            <Text style={styles.errorPanelText}>{estado.error}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => void cargarPrevisualizacion(flujo, periodo)}
            >
              <Text style={styles.retryBtnText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        ) : estado.cargando && previsualizacion === null ? (
          <View style={styles.loadingPanel}>
            <ActivityIndicator size="large" color="#0ea5e9" />
            <Text style={styles.loadingText}>Calculando lo que se facturaría…</Text>
          </View>
        ) : (
          <>
            {facturas.length > 0 ? (
              <>
                <View style={styles.resumenRow}>
                  <View style={styles.resumenChip}>
                    <Text style={styles.resumenChipLabel}>
                      {totalFacturas === 1 ? textos.documento[0] : textos.documento[1]}
                    </Text>
                    <Text style={styles.resumenChipValor}>{totalFacturas}</Text>
                  </View>
                  <View style={styles.resumenChip}>
                    <Text style={styles.resumenChipLabel}>Pedidos</Text>
                    <Text style={styles.resumenChipValor}>{totalPedidos}</Text>
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
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </>
            ) : null}

            {/* Un hueco de meses anteriores solo se recupera volviendo a generar
                ese periodo, así que se ofrece el salto en un toque. */}
            {pendientesAnteriores.length > 0 ? (
              <View style={styles.pendientesCard}>
                <View style={styles.pendientesHeader}>
                  <MaterialIcons name="history" size={18} color="#b45309" />
                  <Text style={styles.pendientesTitulo}>
                    {`${pedidosPendientesAnteriores} ${plural(pedidosPendientesAnteriores, 'pedido', 'pedidos')} sin facturar de meses anteriores`}
                  </Text>
                </View>
                <Text style={styles.pendientesIntro}>
                  No entran en esta tanda: cada pedido se factura en el mes de su fecha. Abre el
                  periodo que falte y genéralo cuando esté corregido.
                </Text>
                <View style={styles.pendientesChips}>
                  {pendientesAnteriores.map((p) => (
                    <TouchableOpacity
                      key={String(p.periodo)}
                      style={[styles.pendienteChip, generandoAlguno && styles.pendienteChipDisabled]}
                      onPress={() => irAPeriodo(String(p.periodo))}
                      disabled={generandoAlguno}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.pendienteChipText}>
                        {`${labelPeriodo(String(p.periodo))} · ${num(p.pedidos)}`}
                      </Text>
                      <MaterialIcons name="arrow-forward" size={13} color="#92400e" />
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ) : null}

            {sinNadaQueFacturar && pendientesAnteriores.length === 0 ? (
              <View style={styles.vacioPanel}>
                <MaterialIcons name="inbox" size={40} color="#94a3b8" />
                <Text style={styles.vacioTitulo}>{`${textos.vacio} ${labelPeriodo(periodo)}`}</Text>
                <Text style={styles.vacioSub}>{textos.vacioDetalle}</Text>
              </View>
            ) : null}

            {facturas.map((factura, i) => renderFactura(factura, i, false))}

            {renderExcluidos(excluidosPrevistos)}

            {previsualizacion ? (
              <Text style={styles.pieNota}>
                {[
                  `${num(previsualizacion.pedidos_revisados)} ${plural(num(previsualizacion.pedidos_revisados), 'pedido completado revisado', 'pedidos completados revisados')} del periodo`,
                  previsualizacion.inicio_seleccion && previsualizacion.corte_seleccion
                    ? `desde ${formatFecha(previsualizacion.inicio_seleccion)} hasta el ${formatFecha(previsualizacion.corte_seleccion)} sin incluir`
                    : '',
                  num(previsualizacion.no_facturables?.misma_sociedad) > 0
                    ? `${num(previsualizacion.no_facturables?.misma_sociedad)} entre almacenes de la misma sociedad, que no generan documento`
                    : '',
                  num(previsualizacion.no_facturables?.devoluciones) > 0
                    ? `${num(previsualizacion.no_facturables?.devoluciones)} ${plural(num(previsualizacion.no_facturables?.devoluciones), 'devolución', 'devoluciones')}`
                    : '',
                  num(previsualizacion.no_facturables?.sin_importe) > 0
                    ? `${num(previsualizacion.no_facturables?.sin_importe)} ${plural(num(previsualizacion.no_facturables?.sin_importe), textos.sinImporte[0], textos.sinImporte[1])}`
                    : '',
                  num(previsualizacion.lineas_sin_importe) > 0
                    ? `${num(previsualizacion.lineas_sin_importe)} ${plural(num(previsualizacion.lineas_sin_importe), 'línea sin importe ignorada', 'líneas sin importe ignoradas')}`
                    : '',
                  num(previsualizacion.lineas_iva_desde_producto) > 0
                    ? `${num(previsualizacion.lineas_iva_desde_producto)} ${plural(num(previsualizacion.lineas_iva_desde_producto), 'línea con el IVA tomado del maestro de productos', 'líneas con el IVA tomado del maestro de productos')}`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
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
  pestanas: { flexDirection: 'row', gap: 6, marginBottom: 10, flexWrap: 'wrap' },
  pestana: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  pestanaActiva: { borderColor: '#bae6fd', backgroundColor: '#f0f9ff' },
  pestanaText: { fontSize: 13, fontWeight: '600', color: '#94a3b8' },
  pestanaTextActiva: { color: '#0369a1', fontWeight: '700' },
  pestanaBadge: {
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 10,
    backgroundColor: '#0ea5e9',
    alignItems: 'center',
  },
  pestanaBadgeText: { fontSize: 10, fontWeight: '800', color: '#fff' },
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
  periodoLinkDisabled: { color: '#cbd5e1' },
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
  explicacion: { fontSize: 12, color: '#64748b', lineHeight: 17, marginBottom: 8 },
  periodoNota: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginBottom: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
  },
  periodoNotaText: { flex: 1, minWidth: 0, fontSize: 11, color: '#64748b', lineHeight: 15 },
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
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
  },
  errorBoxBody: { flex: 1, minWidth: 0, gap: 2 },
  errorBoxText: { fontSize: 12, color: '#dc2626', lineHeight: 17 },
  errorBoxNota: { fontSize: 11, color: '#b91c1c', lineHeight: 15 },
  errorBoxLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    minHeight: MIN_TOUCH,
  },
  errorBoxLinkText: { fontSize: 11, color: '#b91c1c', fontWeight: '700', textDecorationLine: 'underline' },
  errorCerrarBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  errorPanel: { alignItems: 'center', gap: 10, paddingVertical: 32 },
  errorPanelText: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  noDisponiblePanel: { alignItems: 'center', gap: 10, paddingVertical: 32, paddingHorizontal: 16 },
  noDisponibleTitulo: {
    fontSize: 14,
    color: '#475569',
    textAlign: 'center',
    maxWidth: 460,
    lineHeight: 20,
  },
  retryBtn: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
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
  pendientesCard: {
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 12,
    backgroundColor: '#fffbeb',
    padding: 12,
    gap: 6,
  },
  pendientesHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pendientesTitulo: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '700', color: '#92400e' },
  pendientesIntro: { fontSize: 11, color: '#a16207', lineHeight: 16 },
  pendientesChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pendienteChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fef3c7',
  },
  pendienteChipDisabled: { opacity: 0.45 },
  pendienteChipText: { fontSize: 11, fontWeight: '700', color: '#92400e', textTransform: 'capitalize' },
  facturaCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    backgroundColor: '#fff',
    padding: 10,
    gap: 8,
  },
  facturaCardCreada: { borderColor: '#a7f3d0' },
  facturaHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  parBlock: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  parBlockStacked: { flexDirection: 'column', alignItems: 'flex-start', gap: 4 },
  parLado: { flex: 1, minWidth: 0, gap: 1 },
  parEtiqueta: {
    fontSize: 9,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  parNombre: { fontSize: 14, fontWeight: '700', color: '#334155' },
  parMeta: { fontSize: 10, color: '#94a3b8' },
  parFlecha: { flexShrink: 0 },
  facturaImportes: { alignItems: 'flex-end', gap: 2, flexShrink: 0 },
  facturaTotal: { fontSize: 16, fontWeight: '800', color: '#0f766e' },
  facturaDesglose: { fontSize: 10, color: '#94a3b8' },
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
    alignSelf: 'flex-start',
  },
  abrirFacturaText: { fontSize: 11, fontWeight: '700', color: '#0369a1' },
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
  impuestosRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  impuestoChip: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    gap: 1,
  },
  impuestoChipTipo: { fontSize: 10, fontWeight: '700', color: '#475569' },
  impuestoChipValor: { fontSize: 10, color: '#64748b' },
  bloqueDetalle: { gap: 4, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#f1f5f9' },
  bloqueTitulo: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  origenRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  origenNombre: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700', color: '#0f766e' },
  origenPedidos: { fontSize: 10, color: '#94a3b8', flexShrink: 0 },
  origenBase: { fontSize: 12, fontWeight: '700', color: '#475569', flexShrink: 0 },
  localBlock: { gap: 3, paddingTop: 4 },
  localHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  localNombre: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: '700', color: '#0369a1' },
  localTotal: { fontSize: 12, fontWeight: '700', color: '#475569' },
  pedidoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 20 },
  pedidoFecha: { width: 78, fontSize: 11, color: '#94a3b8', flexShrink: 0 },
  pedidoId: { width: 110, fontSize: 11, color: '#475569', flexShrink: 0 },
  pedidoOrigen: { flex: 1, minWidth: 0, fontSize: 11, color: '#94a3b8' },
  pedidoTotal: { fontSize: 11, fontWeight: '600', color: '#475569', flexShrink: 0 },
  pieNota: { fontSize: 10, color: '#94a3b8', lineHeight: 15 },
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
  interrumpidaBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  interrumpidaText: { flex: 1, minWidth: 0, fontSize: 11, color: '#b91c1c', lineHeight: 16 },
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
