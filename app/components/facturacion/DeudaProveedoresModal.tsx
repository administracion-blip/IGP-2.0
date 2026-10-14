/**
 * Ventana flotante «Deuda con proveedores»: facturas de gasto registradas
 * frente a pagadas, por proveedor y sociedad del grupo. Se abre desde el menú
 * «Más» de Facturas de gasto. Lista de proveedores a la izquierda y facturas
 * del proveedor a la derecha; en teléfono/tablet vertical el detalle ocupa la
 * pantalla completa.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { MIN_TOUCH } from '../../constants/layout';
import { useLocalToast, type ToastType } from '../Toast';
import { RangoFechas } from '../RangoFechas';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { FacturaDetalleModal } from '../FacturaDetalleModal';
import { apiFetch } from '../../utils/api';
import { API_BASE_URL } from '../../utils/apiBaseUrl';
import { esEmpresaSedeGrupoParipe, formatMoneda } from '../../utils/facturacion';
import { formatFecha } from '../../utils/formatFecha';
import { getEmpresaFromCatalog, type EmpresaConTipoRecibo } from '../../utils/empresaTipoRecibo';
import { descargarAdjuntoFacturaRecibida } from '../../lib/descargarAdjuntoFactura';
import {
  agruparFacturasRemesaPorSociedad,
  avisoPagosFacturaEnRemesa,
  type ResultadoCrearRemesas,
} from '../../lib/remesas';
import {
  CHIPS_DEUDA,
  claveProveedorFactura,
  esFacturaRemesableDeuda,
  filtrarPorChip,
  filtrarPorTexto,
  idRemesaActiva,
  mensajeErrorRespuesta,
  rangoPorDefecto,
  saldoPendienteFactura,
  urlDeudaProveedores,
  urlDetalleProveedor,
} from '../../lib/deudaProveedores';
import type {
  ChipDeuda,
  DetalleProveedorResp,
  DeudaProveedoresResp,
  FacturaDeuda,
  SociedadDeuda,
} from '../../types/deudaProveedores';
import { KpisDeuda } from './deuda/KpisDeuda';
import { BarraAntiguedadDeuda } from './deuda/BarraAntiguedadDeuda';
import { TarjetaProveedorDeuda } from './deuda/TarjetaProveedorDeuda';
import { DetalleFacturasProveedor } from './deuda/DetalleFacturasProveedor';
import { PagarFacturaGastoModal } from './PagarFacturaGastoModal';
import { CrearRemesaModal } from './CrearRemesaModal';

type Props = {
  visible: boolean;
  onClose: () => void;
  empresasCatalogo: EmpresaConTipoRecibo[];
  /** Pagos o remesas creados desde la ventana: el listado de origen debe refrescarse. */
  onCambios?: () => void;
};

const TODAS_SOCIEDADES = '__todas__';
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Errores de red / timeout de `apiFetch` llegan en inglés: se traducen a un texto común. */
async function fetchJson<T>(path: string, fallback: string, timeoutMs?: number): Promise<T> {
  let r: Response;
  try {
    r = await apiFetch(path, timeoutMs != null ? { timeoutMs } : {});
  } catch (e) {
    const abortado = e instanceof Error && e.name === 'AbortError';
    throw new Error(abortado ? 'La consulta ha tardado demasiado. Inténtalo de nuevo.' : 'No se pudo conectar con el servidor.');
  }
  if (!r.ok) throw new Error(await mensajeErrorRespuesta(r, fallback));
  return (await r.json()) as T;
}

export function DeudaProveedoresModal({ visible, onClose, empresasCatalogo, onCambios }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { hasPermiso, user } = useAuth();
  const { isPhone, height: winH, shouldStackPanels, shouldStackToolbar } = useBreakpoint();
  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();

  const puedeExportar = hasPermiso('facturacion.ver');
  const puedePagar = hasPermiso('facturacion.cobrar_pagar');
  const puedeRemesar = hasPermiso('remesas.gestionar');
  const puedeVerRemesas = hasPermiso('remesas.ver');

  const apilado = shouldStackPanels;
  const modoTarjetas = isPhone;

  const [desde, setDesde] = useState(() => rangoPorDefecto().desde);
  const [hasta, setHasta] = useState(() => rangoPorDefecto().hasta);
  const [emisorId, setEmisorId] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [busquedaAplicada, setBusquedaAplicada] = useState('');
  const [chip, setChip] = useState<ChipDeuda>('todos');

  const [resumen, setResumen] = useState<DeudaProveedoresResp | null>(null);
  const [loadingResumen, setLoadingResumen] = useState(false);
  const [errorResumen, setErrorResumen] = useState<string | null>(null);
  const [sociedadesConocidas, setSociedadesConocidas] = useState<SociedadDeuda[]>([]);
  const resumenSeq = useRef(0);

  const [claveSel, setClaveSel] = useState<string | null>(null);
  const [detalleMovilAbierto, setDetalleMovilAbierto] = useState(false);
  const [detalle, setDetalle] = useState<DetalleProveedorResp | null>(null);
  const [loadingDetalle, setLoadingDetalle] = useState(false);
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null);
  const detalleSeq = useRef(0);

  const [seleccion, setSeleccion] = useState<Map<string, FacturaDeuda>>(() => new Map());
  const [facturaPagar, setFacturaPagar] = useState<FacturaDeuda | null>(null);
  const [facturaVerId, setFacturaVerId] = useState<string | null>(null);
  const [modalRemesa, setModalRemesa] = useState(false);
  const [exportando, setExportando] = useState(false);

  const rangoValido = ISO_RE.test(desde) && ISO_RE.test(hasta);
  const rangoOrdenado = rangoValido && desde <= hasta;

  useEffect(() => {
    const t = setTimeout(() => setBusquedaAplicada(busqueda), 200);
    return () => clearTimeout(t);
  }, [busqueda]);

  const cargarResumen = useCallback(async () => {
    if (!visible) return;
    const seq = ++resumenSeq.current;
    if (!rangoValido) {
      setErrorResumen('Indica una fecha válida (dd/mm/aaaa)');
      setLoadingResumen(false);
      return;
    }
    if (!rangoOrdenado) {
      setErrorResumen('La fecha «Desde» no puede ser posterior a «Hasta».');
      setLoadingResumen(false);
      return;
    }
    setLoadingResumen(true);
    setErrorResumen(null);
    try {
      const data = await fetchJson<DeudaProveedoresResp>(
        urlDeudaProveedores({ fechaDesde: desde, fechaHasta: hasta, emisorId: emisorId || undefined }),
        'No se pudo cargar la deuda con proveedores.',
      );
      if (seq !== resumenSeq.current) return;
      setResumen(data);
      setSociedadesConocidas((prev) => {
        const map = new Map(prev.map((s) => [s.id, s]));
        for (const s of data.sociedades ?? []) if (s?.id) map.set(s.id, s);
        return [...map.values()];
      });
    } catch (e) {
      if (seq !== resumenSeq.current) return;
      setErrorResumen(e instanceof Error ? e.message : 'No se pudo cargar la deuda con proveedores.');
    } finally {
      if (seq === resumenSeq.current) setLoadingResumen(false);
    }
  }, [visible, desde, hasta, emisorId, rangoValido, rangoOrdenado]);

  useEffect(() => {
    void cargarResumen();
  }, [cargarResumen]);

  const cargarDetalle = useCallback(async () => {
    const seq = ++detalleSeq.current;
    if (!visible || !claveSel || !rangoOrdenado) {
      setDetalle(null);
      setLoadingDetalle(false);
      setErrorDetalle(null);
      return;
    }
    setLoadingDetalle(true);
    setErrorDetalle(null);
    try {
      const data = await fetchJson<DetalleProveedorResp>(
        urlDetalleProveedor(claveSel, { fechaDesde: desde, fechaHasta: hasta, emisorId: emisorId || undefined }),
        'No se pudieron cargar las facturas del proveedor.',
      );
      if (seq !== detalleSeq.current) return;
      setDetalle(data);
    } catch (e) {
      if (seq !== detalleSeq.current) return;
      setDetalle(null);
      setErrorDetalle(e instanceof Error ? e.message : 'No se pudieron cargar las facturas del proveedor.');
    } finally {
      if (seq === detalleSeq.current) setLoadingDetalle(false);
    }
  }, [visible, claveSel, desde, hasta, emisorId, rangoOrdenado]);

  useEffect(() => {
    void cargarDetalle();
  }, [cargarDetalle]);

  // La selección pertenece a un rango/sociedad concretos.
  useEffect(() => {
    setSeleccion(new Map());
  }, [desde, hasta, emisorId]);

  // Con cada detalle nuevo (p. ej. tras pagar) se sustituyen las copias seleccionadas
  // del proveedor visible por los datos frescos y se quitan las que ya no son remesables.
  useEffect(() => {
    if (!detalle) return;
    setSeleccion((prev) => {
      if (prev.size === 0) return prev;
      const clave = detalle.proveedor?.clave;
      const frescas = new Map(detalle.facturas.map((f) => [f.id_factura, f]));
      const next = new Map<string, FacturaDeuda>();
      for (const [id, f] of prev) {
        const fresca = frescas.get(id);
        if (fresca) {
          if (esFacturaRemesableDeuda(fresca)) next.set(id, fresca);
        } else if (claveProveedorFactura(f) !== clave) {
          next.set(id, f);
        }
      }
      return next;
    });
  }, [detalle]);

  const refrescarTodo = useCallback(() => {
    void cargarResumen();
    void cargarDetalle();
    onCambios?.();
  }, [cargarResumen, cargarDetalle, onCambios]);

  const cerrar = useCallback(() => {
    setSeleccion(new Map());
    setFacturaPagar(null);
    setFacturaVerId(null);
    setModalRemesa(false);
    setDetalleMovilAbierto(false);
    onClose();
  }, [onClose]);

  const irA = useCallback(
    (ruta: string) => {
      cerrar();
      router.push(ruta as never);
    },
    [cerrar, router],
  );

  const opcionesSociedad = useMemo<OpcionDesplegable[]>(() => {
    const catalogoConSede = empresasCatalogo.some((e) => String(e.Sede ?? '').trim() !== '');
    let lista = sociedadesConocidas;
    if (catalogoConSede) {
      const delGrupo = lista.filter((s) => {
        const e = getEmpresaFromCatalog(empresasCatalogo, s.id, s.cif);
        return !!e && esEmpresaSedeGrupoParipe(e);
      });
      if (delGrupo.length > 0) lista = delGrupo;
    }
    return [
      { id: TODAS_SOCIEDADES, titulo: 'Todas las sociedades', icono: 'domain' },
      ...[...lista]
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
        .map((s) => ({ id: s.id, titulo: s.nombre, subtitulo: s.cif || undefined, icono: 'business' as const })),
    ];
  }, [sociedadesConocidas, empresasCatalogo]);

  const nombreSociedad = emisorId
    ? sociedadesConocidas.find((s) => s.id === emisorId)?.nombre ?? ''
    : '';

  const proveedores = useMemo(() => resumen?.proveedores ?? [], [resumen]);
  const conteoChips = useMemo(() => {
    const out: Record<ChipDeuda, number> = { todos: 0, con_deuda: 0, vencidos: 0, cuadrados: 0 };
    for (const c of CHIPS_DEUDA) out[c.id] = filtrarPorChip(proveedores, c.id).length;
    return out;
  }, [proveedores]);
  const proveedoresVisibles = useMemo(
    () => filtrarPorTexto(filtrarPorChip(proveedores, chip), busquedaAplicada),
    [proveedores, chip, busquedaAplicada],
  );
  const proveedorSel = useMemo(
    () => proveedores.find((p) => p.clave === claveSel) ?? null,
    [proveedores, claveSel],
  );

  const seleccionadas = useMemo(() => [...seleccion.values()], [seleccion]);
  const importeSeleccion = useMemo(
    () => seleccionadas.reduce((acc, f) => acc + saldoPendienteFactura(f), 0),
    [seleccionadas],
  );
  const facturasRemesa = useMemo(() => seleccionadas.filter(esFacturaRemesableDeuda), [seleccionadas]);

  const onSeleccionarProveedor = useCallback(
    (clave: string) => {
      setClaveSel(clave);
      if (apilado) setDetalleMovilAbierto(true);
    },
    [apilado],
  );

  const toggleSeleccion = useCallback((f: FacturaDeuda) => {
    setSeleccion((prev) => {
      const next = new Map(prev);
      if (next.has(f.id_factura)) next.delete(f.id_factura);
      else next.set(f.id_factura, f);
      return next;
    });
  }, []);

  const toast = useCallback(
    (titulo: string, mensaje: string, tipo: ToastType) => showToast(titulo, mensaje, tipo),
    [showToast],
  );

  const avisarFacturaEnRemesa = useCallback(
    async (f: FacturaDeuda) => {
      const nombre = f.remesaActiva?.nombre?.trim();
      const estado = f.remesaActiva?.estado;
      const incluida = `Incluida en ${nombre ? `«${nombre}»` : 'una remesa activa'}${estado ? ` (${estado})` : ''}.`;
      showToast(
        'En remesa',
        estado === 'Ejecutada'
          ? `${incluida} ${avisoPagosFacturaEnRemesa({ estado: 'Ejecutada' })}`
          : `${incluida} No se pueden registrar, editar ni eliminar pagos manualmente.`,
        'warning',
      );
      const id = idRemesaActiva(f.remesaActiva);
      if (!puedeVerRemesas || !id) return;
      const ir = await confirmar(
        'Factura en remesa',
        `¿Abrir la remesa${nombre ? ` «${nombre}»` : ''}?`,
        { confirmarLabel: 'Ir a remesa' },
      );
      if (ir) irA(`/facturacion/remesas/${id}`);
    },
    [showToast, puedeVerRemesas, confirmar, irA],
  );

  const onPagar = useCallback(
    (f: FacturaDeuda) => {
      if (f.remesaActiva) {
        void avisarFacturaEnRemesa(f);
        return;
      }
      setFacturaPagar(f);
    },
    [avisarFacturaEnRemesa],
  );

  const onDocumento = useCallback(
    async (f: FacturaDeuda) => {
      try {
        const res = await apiFetch(`/api/facturacion/facturas/${f.id_factura}/adjuntos`);
        const data = await res.json();
        const adjuntos = data.adjuntos ?? [];
        if (adjuntos.length === 0) {
          showToast('Sin documento', 'Esta factura no tiene documento adjunto', 'warning');
          return;
        }
        await descargarAdjuntoFacturaRecibida(f.id_factura, adjuntos[0].id);
        showToast('Descargado', 'Documento guardado con id_Documento', 'success');
      } catch (e) {
        showToast('Error', (e as Error).message || 'No se pudo descargar el documento', 'error');
      }
    },
    [showToast],
  );

  const abrirCrearRemesa = () => {
    if (facturasRemesa.length === 0) {
      showToast('Aviso', 'Selecciona facturas pendientes de pago, parcialmente pagadas o vencidas', 'warning');
      return;
    }
    const sinSociedad = agruparFacturasRemesaPorSociedad(facturasRemesa).filter((g) => !g.sociedadId);
    if (sinSociedad.length > 0) {
      showToast(
        'Aviso',
        `${sinSociedad.reduce((n, g) => n + g.facturas.length, 0)} factura(s) sin sociedad ordenante (emisor). Complétalas antes de crear la remesa.`,
        'warning',
      );
      return;
    }
    setModalRemesa(true);
  };

  const onRemesasCreadas = async ({ creadas, totalExcluidas, error }: ResultadoCrearRemesas) => {
    setModalRemesa(false);
    setSeleccion(new Map());
    refrescarTodo();
    const titulo = error
      ? 'Remesas creadas parcialmente'
      : creadas.length === 1 ? 'Remesa creada' : `${creadas.length} remesas creadas`;
    const lineas = creadas.map((r) => `· ${r.nombre}${r.excluidas ? ` (${r.excluidas} excl.)` : ''}`).join('\n');
    let mensaje = totalExcluidas > 0
      ? `${lineas}\n\n${totalExcluidas} factura(s) excluida(s): ya estaban en otra remesa o no se podían remesar.`
      : lineas;
    if (error) {
      mensaje += `\n\nNo se crearon las remesas restantes. ${error}\nRevisa la selección y vuelve a intentarlo con las facturas que faltan.`;
    }
    if (!puedeVerRemesas) {
      await confirmar(titulo, mensaje, { soloAceptar: true });
      return;
    }
    const ir = await confirmar(titulo, mensaje, {
      confirmarLabel: creadas.length === 1 ? 'Ir a la remesa' : 'Ir a remesas',
      cancelarLabel: 'Seguir aquí',
    });
    if (!ir) return;
    irA(creadas.length === 1 ? `/facturacion/remesas/${creadas[0].remesaId}` : '/facturacion/remesas');
  };

  const exportarExcel = async () => {
    if (!resumen || exportando || !rangoOrdenado) return;
    setExportando(true);
    try {
      const completo = await fetchJson<DeudaProveedoresResp>(
        urlDeudaProveedores({ fechaDesde: desde, fechaHasta: hasta, emisorId: emisorId || undefined, incluirFacturas: true }),
        'No se pudo preparar la exportación.',
        120_000,
      );
      const proveedoresFiltrados = filtrarPorTexto(filtrarPorChip(completo.proveedores ?? [], chip), busquedaAplicada);
      const claves = new Set(proveedoresFiltrados.map((p) => p.clave));
      const facturasFiltradas = (completo.facturas ?? []).filter((f) => claves.has(claveProveedorFactura(f)));
      const { exportarDeudaProveedoresExcel } = await import('../../utils/exportFacturasExcel');
      exportarDeudaProveedoresExcel({ ...completo, proveedores: proveedoresFiltrados }, facturasFiltradas);
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo exportar a Excel', 'error');
    } finally {
      setExportando(false);
    }
  };

  const subtitulo = rangoValido
    ? `Del ${formatFecha(desde)} al ${formatFecha(hasta)}${nombreSociedad ? ` · ${nombreSociedad}` : ' · Todas las sociedades'}`
    : 'Indica un rango de fechas';

  const cabecera = (
    <View style={styles.cabecera}>
      <View style={styles.cabeceraIcono}>
        <MaterialIcons name="account-balance-wallet" size={20} color="#0ea5e9" />
      </View>
      <View style={styles.cabeceraTexto}>
        <Text style={styles.titulo} numberOfLines={1}>Deuda con proveedores</Text>
        <View style={styles.subtituloFila}>
          <Text style={styles.subtitulo} numberOfLines={1}>{subtitulo}</Text>
          {loadingResumen && resumen ? <ActivityIndicator size="small" color="#0ea5e9" /> : null}
        </View>
      </View>
      <TouchableOpacity
        style={[styles.btnIcono, isPhone && styles.btnTouch]}
        onPress={refrescarTodo}
        disabled={loadingResumen}
        accessibilityLabel="Actualizar"
      >
        <MaterialIcons name="refresh" size={20} color="#64748b" />
      </TouchableOpacity>
      {Platform.OS === 'web' && puedeExportar ? (
        <TouchableOpacity
          style={[styles.btnExcel, isPhone && styles.btnTouch, (!resumen || exportando) && styles.btnDeshabilitado]}
          onPress={exportarExcel}
          disabled={!resumen || exportando}
          accessibilityLabel="Exportar Excel"
        >
          {exportando ? (
            <ActivityIndicator size="small" color="#059669" />
          ) : (
            <MaterialIcons name="file-download" size={18} color="#059669" />
          )}
          {!isPhone ? <Text style={styles.btnExcelTexto}>Exportar Excel</Text> : null}
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity style={[styles.btnIcono, isPhone && styles.btnTouch]} onPress={cerrar} accessibilityLabel="Cerrar">
        <MaterialIcons name="close" size={22} color="#64748b" />
      </TouchableOpacity>
    </View>
  );

  const filtros = (
    <View style={[styles.filtros, shouldStackToolbar && styles.filtrosApilados]}>
      <View style={[styles.filtrosFila, shouldStackToolbar && styles.filtrosFilaApilada]}>
        <RangoFechas
          desdeIso={desde}
          hastaIso={hasta}
          onChangeDesde={setDesde}
          onChangeHasta={setHasta}
          fill={shouldStackToolbar}
          style={shouldStackToolbar ? styles.anchoCompleto : undefined}
        />
        <SelectorDesplegable
          compact
          icono="business"
          opciones={opcionesSociedad}
          valorId={emisorId || TODAS_SOCIEDADES}
          onSeleccionar={(id) => setEmisorId(id === TODAS_SOCIEDADES ? '' : id)}
          tituloLista="Sociedad del grupo"
          iconoLista="business"
          buscador={opcionesSociedad.length > 8}
          style={shouldStackToolbar ? styles.anchoCompleto : styles.selectorSociedad}
          triggerStyle={isPhone ? { minHeight: MIN_TOUCH } : undefined}
        />
        <View style={[styles.buscador, shouldStackToolbar && styles.anchoCompleto, isPhone && { minHeight: MIN_TOUCH }]}>
          <MaterialIcons name="search" size={16} color="#94a3b8" />
          <TextInput
            style={styles.buscadorInput}
            value={busqueda}
            onChangeText={setBusqueda}
            placeholder="Buscar proveedor o CIF…"
            placeholderTextColor="#94a3b8"
            autoCorrect={false}
          />
          {busqueda ? (
            <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="Limpiar búsqueda">
              <MaterialIcons name="close" size={16} color="#94a3b8" />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
      <View style={styles.chips}>
        {CHIPS_DEUDA.map((c) => {
          const activo = chip === c.id;
          return (
            <TouchableOpacity
              key={c.id}
              style={[styles.chip, activo && styles.chipActivo, isPhone && styles.chipTouch]}
              onPress={() => setChip(c.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: activo }}
            >
              <Text style={[styles.chipTexto, activo && styles.chipTextoActivo]}>
                {c.label}
                {resumen ? ` (${conteoChips[c.id]})` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
        {resumen ? (
          <Text style={styles.chipsNota}>Cuadrado: diferencia de ±{resumen.tolerancia ?? 10} €</Text>
        ) : null}
      </View>
    </View>
  );

  const bloqueResumen = resumen ? (
    <View style={[styles.resumen, !apilado && styles.resumenEscritorio]}>
      <View style={!apilado ? styles.resumenKpis : undefined}>
        <KpisDeuda kpis={resumen.kpis} columnas={isPhone ? 2 : 4} />
      </View>
      <View style={!apilado ? styles.resumenAntiguedad : undefined}>
        <BarraAntiguedadDeuda
          antiguedad={resumen.antiguedad}
          numSinVencimiento={resumen.antiguedad?.numSinVencimiento}
          titulo="Antigüedad de la deuda pendiente"
        />
      </View>
    </View>
  ) : null;

  const listaProveedores = (() => {
    if (errorResumen) {
      return (
        <View style={styles.estado}>
          <MaterialIcons name="error-outline" size={28} color="#dc2626" />
          <Text style={[styles.estadoTexto, { color: '#dc2626' }]}>{errorResumen}</Text>
          {rangoOrdenado ? (
            <TouchableOpacity style={styles.btnReintentar} onPress={() => void cargarResumen()}>
              <MaterialIcons name="refresh" size={16} color="#0ea5e9" />
              <Text style={styles.btnReintentarTexto}>Reintentar</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      );
    }
    if (!resumen) {
      return (
        <View style={styles.estado}>
          <ActivityIndicator size="small" color="#0ea5e9" />
          <Text style={styles.estadoTexto}>Cargando proveedores…</Text>
        </View>
      );
    }
    if (proveedores.length === 0) {
      return (
        <View style={styles.estado}>
          <MaterialIcons name="inbox" size={32} color="#cbd5e1" />
          <Text style={styles.estadoTexto}>No hay facturas en este periodo</Text>
        </View>
      );
    }
    if (proveedoresVisibles.length === 0) {
      return (
        <View style={styles.estado}>
          <MaterialIcons name="search-off" size={32} color="#cbd5e1" />
          <Text style={styles.estadoTexto}>Ningún proveedor coincide con los filtros</Text>
        </View>
      );
    }
    return (
      <View style={[styles.lista, loadingResumen && styles.listaRecargando]}>
        <Text style={styles.listaContador}>
          {proveedoresVisibles.length} proveedor{proveedoresVisibles.length === 1 ? '' : 'es'}
        </Text>
        {proveedoresVisibles.map((p) => (
          <TarjetaProveedorDeuda
            key={p.clave}
            proveedor={p}
            seleccionada={!apilado && p.clave === claveSel}
            comodo={isPhone}
            onPress={onSeleccionarProveedor}
          />
        ))}
      </View>
    );
  })();

  const detalleProveedor = (
    <DetalleFacturasProveedor
      proveedorResumen={proveedorSel}
      detalle={detalle}
      loading={loadingDetalle}
      error={errorDetalle}
      onReintentar={() => void cargarDetalle()}
      modoTarjetas={modoTarjetas}
      seleccion={seleccion}
      puedeSeleccionar={puedeRemesar}
      onToggleSeleccion={toggleSeleccion}
      puedePagar={puedePagar}
      onPagar={onPagar}
      onVer={(f) => setFacturaVerId(f.id_factura)}
      onDocumento={(f) => void onDocumento(f)}
    />
  );

  const barraSeleccion = puedeRemesar && seleccion.size > 0 ? (
    <View style={[styles.barraSeleccion, apilado && { paddingBottom: 10 + insets.bottom }]}>
      <Text style={styles.barraSeleccionTexto} numberOfLines={2}>
        {seleccion.size} seleccionada{seleccion.size === 1 ? '' : 's'} · {formatMoneda(importeSeleccion)}
      </Text>
      <TouchableOpacity
        style={[styles.barraBtnSecundario, isPhone && styles.btnTouch]}
        onPress={() => setSeleccion(new Map())}
        accessibilityLabel="Quitar selección"
      >
        <Text style={styles.barraBtnSecundarioTexto}>Limpiar</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.barraBtn, isPhone && styles.btnTouch, facturasRemesa.length === 0 && styles.btnDeshabilitado]}
        onPress={abrirCrearRemesa}
        disabled={facturasRemesa.length === 0}
        accessibilityLabel="Crear remesa"
      >
        <MaterialIcons name="account-balance" size={16} color="#fff" />
        <Text style={styles.barraBtnTexto}>Crear remesa</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  const cuerpo = apilado ? (
    detalleMovilAbierto ? (
      <View style={styles.flex}>
        <View style={styles.barraVolver}>
          <TouchableOpacity
            style={[styles.btnVolver, { minHeight: MIN_TOUCH }]}
            onPress={() => setDetalleMovilAbierto(false)}
            accessibilityLabel="Volver a proveedores"
          >
            <MaterialIcons name="arrow-back" size={18} color="#0ea5e9" />
            <Text style={styles.btnVolverTexto}>Proveedores</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContenido}>
          {detalleProveedor}
        </ScrollView>
      </View>
    ) : (
      <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContenido} keyboardShouldPersistTaps="handled">
        {filtros}
        {bloqueResumen}
        {listaProveedores}
      </ScrollView>
    )
  ) : (
    <View style={styles.flex}>
      <View style={styles.zonaSuperior}>
        {filtros}
        {bloqueResumen}
      </View>
      <View style={styles.paneles}>
        <View style={[styles.panel, styles.panelLista]}>
          <ScrollView style={styles.flex} contentContainerStyle={styles.panelContenido}>
            {listaProveedores}
          </ScrollView>
        </View>
        <View style={styles.panel}>
          <ScrollView style={styles.flex} contentContainerStyle={styles.panelContenido}>
            {detalleProveedor}
          </ScrollView>
        </View>
      </View>
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cerrar}>
      <View style={[styles.overlay, apilado && styles.overlayTelefono]}>
        <View
          style={[
            styles.tarjeta,
            apilado
              ? [styles.tarjetaTelefono, { paddingTop: insets.top }]
              : { height: Math.round(winH * 0.94) },
          ]}
        >
          {cabecera}
          {cuerpo}
          {barraSeleccion}
        </View>
        {ToastView}
      </View>

      <PagarFacturaGastoModal
        factura={facturaPagar}
        empresasCatalogo={empresasCatalogo}
        onClose={() => setFacturaPagar(null)}
        onPagoRegistrado={refrescarTodo}
        onToast={toast}
      />
      <CrearRemesaModal
        visible={modalRemesa}
        facturas={facturasRemesa}
        empresasCatalogo={empresasCatalogo}
        onClose={() => setModalRemesa(false)}
        onCreadas={(r) => void onRemesasCreadas(r)}
        onFallo={refrescarTodo}
      />
      <FacturaDetalleModal
        apiUrl={API_BASE_URL}
        facturaId={facturaVerId}
        tipoFactura="IN"
        puedeEditar={hasPermiso('facturacion.editar')}
        usuarioId={user?.id_usuario}
        usuarioNombre={user?.Nombre}
        onClose={() => setFacturaVerId(null)}
        onGuardado={refrescarTodo}
        onAbrirCompleto={(id) => irA(`/facturacion/factura-detalle?id=${id}&modo=editar&tipo=IN`)}
      />
      {ConfirmarView}
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  overlayTelefono: { padding: 0 },
  tarjeta: {
    width: '96%',
    maxWidth: 1400,
    backgroundColor: '#e2e8f0',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...(Platform.OS === 'web' ? ({ boxShadow: '0 24px 48px rgba(15,23,42,0.25)' } as object) : { elevation: 24 }),
  },
  tarjetaTelefono: { width: '100%', height: '100%', maxWidth: undefined, borderRadius: 0, borderWidth: 0 },

  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  cabeceraIcono: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cabeceraTexto: { flex: 1, minWidth: 0 },
  titulo: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  subtituloFila: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  subtitulo: { fontSize: 12, color: '#64748b', flexShrink: 1 },
  btnIcono: { padding: 6, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  btnTouch: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH },
  btnExcel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bbf7d0',
    backgroundColor: '#f0fdf4',
  },
  btnExcelTexto: { fontSize: 12, fontWeight: '600', color: '#047857' },
  btnDeshabilitado: { opacity: 0.5 },

  filtros: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    gap: 8,
  },
  filtrosApilados: { gap: 10 },
  filtrosFila: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  filtrosFilaApilada: { flexDirection: 'column', alignItems: 'stretch' },
  anchoCompleto: { width: '100%' },
  selectorSociedad: { minWidth: 220, maxWidth: 300 },
  buscador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexGrow: 1,
    minWidth: 200,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  buscadorInput: {
    flex: 1,
    fontSize: 13,
    color: '#0f172a',
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    justifyContent: 'center',
  },
  chipTouch: { minHeight: MIN_TOUCH, paddingHorizontal: 14 },
  chipActivo: { borderColor: '#0ea5e9', backgroundColor: '#e0f2fe' },
  chipTexto: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  chipTextoActivo: { color: '#0369a1' },
  chipsNota: { fontSize: 12, color: '#94a3b8', marginLeft: 4 },

  resumen: { gap: 10 },
  resumenEscritorio: { flexDirection: 'row', alignItems: 'stretch' },
  resumenKpis: { flex: 3, minWidth: 0 },
  resumenAntiguedad: { flex: 2, minWidth: 0 },

  zonaSuperior: { paddingHorizontal: 12, paddingTop: 12, gap: 10 },
  paneles: { flex: 1, flexDirection: 'row', gap: 12, padding: 12 },
  panel: { flex: 1, minWidth: 0, backgroundColor: '#f8fafc', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  panelLista: {},
  panelContenido: { padding: 10, gap: 10 },
  scrollContenido: { padding: 12, gap: 12 },

  lista: { gap: 8 },
  listaRecargando: { opacity: 0.6 },
  listaContador: { fontSize: 12, color: '#64748b', fontWeight: '600' },
  estado: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 16 },
  estadoTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  btnReintentar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 12 },
  btnReintentarTexto: { fontSize: 13, color: '#0ea5e9', fontWeight: '600' },

  barraVolver: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 8,
  },
  btnVolver: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 8 },
  btnVolverTexto: { fontSize: 14, fontWeight: '700', color: '#0ea5e9' },

  barraSeleccion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#0f172a',
  },
  barraSeleccionTexto: { flex: 1, fontSize: 13, fontWeight: '600', color: '#fff' },
  barraBtnSecundario: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  barraBtnSecundarioTexto: { fontSize: 13, color: '#cbd5e1', fontWeight: '600' },
  barraBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  barraBtnTexto: { fontSize: 13, color: '#fff', fontWeight: '700' },
});
