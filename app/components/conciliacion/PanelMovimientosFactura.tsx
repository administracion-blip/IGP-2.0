/**
 * Movimientos bancarios de la sociedad alrededor de la fecha de la factura,
 * con conciliación directa desde el modal de registrar pago.
 *
 * Conciliar aquí no es informativo: `POST /api/banca/conciliacion/aplicar`
 * registra el pago por dentro (ver la cabecera de
 * `api/lib/banca/conciliacion/aplicar.js`) y actualiza saldo y estado. Por eso
 * este panel y el formulario de pago manual son caminos excluyentes, y al
 * conciliar se avisa al padre para que cierre: dejar el formulario abierto
 * invitaría a pagar dos veces.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatMoneda } from '../../utils/facturacion';
import { fechaEmisionFacturaAIso, formatFecha } from '../../utils/formatFecha';
import { RangoFechas } from '../RangoFechas';
import {
  ESTADO_CONCILIACION_PENDIENTE,
  beneficiarioMovimiento,
  conceptoCortoMovimiento,
  estiloBadgeBanco,
  etiquetaBancoMovimiento,
  importeMovimiento,
  queryMovimientos,
  textoBusquedaMovimiento,
} from '../../lib/banca';
import {
  aCentimos,
  aEuros,
  desdeBarridoMovimientosIso,
  movimientoExcluidoPorPatron,
  necesitaRepaso,
  parseImporte,
} from '../../lib/conciliacion';
import type { MovimientoBanca } from '../../types/banca';
import type { RespuestaAplicar } from '../../types/conciliacion';

type Props = {
  /** Factura contra la que se conciliaría. */
  idFactura: string;
  /** Número visible de la factura, solo para mensajes. */
  numeroFactura?: string;
  /** Sociedad del grupo (emisor_id de la factura). Filtra los movimientos. */
  empresaId: string;
  /** 'IN' = factura de gasto (se paga con un cargo). 'OUT' = venta (abono). */
  tipo: 'IN' | 'OUT';
  fechaEmision?: string;
  /** Reservado: el rango por defecto ya no usa el vencimiento (emisión ± márgenes). */
  fechaVencimiento?: string;
  /** Saldo pendiente de la factura, en euros y en positivo. */
  saldoPendiente: number;
  /**
   * Nombre del proveedor (gasto) o del cliente (venta). Se usa para precargar el
   * buscador con las primeras letras útiles y acortar la lista; el campo sigue
   * siendo editable.
   */
  contraparteNombre?: string;
  /** Permiso `facturacion.cobrar_pagar`. */
  puedeConciliar: boolean;
  /** Se ha conciliado: el padre cierra el modal, avisa y refresca. */
  onConciliado: (resumen: {
    importe: number;
    mensaje: string;
    /** El pago está hecho pero el apunte queda descuadrado: avisar, no celebrar. */
    requiereRevision?: boolean;
  }) => void;
  /**
   * Hay una conciliación en vuelo. El padre debe bloquear el formulario manual y
   * el cierre del modal: conciliar ya registra el pago, y pagar a mano encima lo
   * duplicaría sin que la idempotencia del backend lo evite.
   */
  onOcupadoChange?: (ocupado: boolean) => void;
};

/** Casi nunca se paga antes de emitir la factura; 10 días cubren anticipos raros. */
const DIAS_ANTES_EMISION = 10;
/** Margen hacia delante desde la fecha de emisión (no el vencimiento). */
const DIAS_DESPUES_EMISION = 60;
/** Sin ninguna fecha en la factura no hay ancla: se mira el pasado reciente. */
const MESES_SIN_ANCLA = 3;
/** Un céntimo de margen al comparar el importe con el saldo de la factura. */
const TOLERANCIA_CENTIMOS = 1;
/** Letras del nombre de contraparte que se precargan en el buscador. */
const LETRAS_BUSQUEDA_CONTRAPARTE = 6;
/**
 * Páginas que se encadenan solas (≈1000 movimientos con `LIMITE_MOVIMIENTOS`).
 * Con `orden: 'asc'` la primera página ya empieza en la fecha de emisión, que es
 * donde suele estar el pago, así que el tope solo protege de sociedades con
 * muchísimo movimiento: sin él, un rango amplio dejaría el modal pidiendo
 * páginas durante segundos.
 */
const MAX_PAGINAS_AUTO = 5;

const FORMAS_JURIDICAS = new Set([
  'sl', 'sa', 'slu', 'sau', 'slne', 'sll', 'scp', 'cb', 'sc', 'snc', 'sce',
  'srl', 'ltd', 'llc', 'inc', 'gmbh', 'sas', 'spa',
]);

function sinAcentos(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Primeras letras útiles del nombre comercial: quita acentos y formas jurídicas
 * (SL, SA…) para que el precargado del buscador tenga más chance de coincidir
 * con el concepto del extracto.
 */
export function textoBusquedaDesdeContraparte(nombre: string | undefined | null): string {
  const crudo = sinAcentos(nombre)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!crudo) return '';

  const tokens = crudo.split(' ').filter((t) => t && !FORMAS_JURIDICAS.has(t));
  const base = (tokens[0] || crudo).replace(/\s+/g, '');
  if (base.length < 3) return '';
  return base.slice(0, LETRAS_BUSQUEDA_CONTRAPARTE);
}

function isoMasDias(iso: string, dias: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

/**
 * Rango por defecto alrededor de la fecha de emisión.
 * No se usa el vencimiento: con plazos largos el `hasta` se iba muy lejos y la
 * lista se llenaba de movimientos que no tienen nada que ver con la factura.
 */
function rangoInicial(fechaEmision?: string): { desde: string; hasta: string } {
  const emision = fechaEmisionFacturaAIso(fechaEmision);
  if (emision) {
    return {
      desde: isoMasDias(emision, -DIAS_ANTES_EMISION),
      hasta: isoMasDias(emision, DIAS_DESPUES_EMISION),
    };
  }
  const hoy = new Date();
  return {
    desde: desdeBarridoMovimientosIso(hoy, MESES_SIN_ANCLA),
    hasta: hoy.toISOString().slice(0, 10),
  };
}

const RE_ISO = /^\d{4}-\d{2}-\d{2}$/;

function etiquetaEstadoMovimiento(estado: string | undefined): string {
  const e = String(estado || '').trim();
  if (e === 'conciliado') return 'Ya conciliado';
  if (e === 'parcial') return 'Conciliado en parte';
  if (e === 'ignorado') return 'Marcado como no factura';
  return '';
}

export function PanelMovimientosFactura({
  idFactura,
  numeroFactura,
  empresaId,
  tipo,
  fechaEmision,
  saldoPendiente,
  contraparteNombre,
  puedeConciliar,
  onConciliado,
  onOcupadoChange,
}: Props) {
  const { isPhone } = useBreakpoint();
  const touchMin = isPhone ? { minHeight: MIN_TOUCH } : null;
  const btnIconoMin = isPhone ? { width: MIN_TOUCH, height: MIN_TOUCH } : null;

  const empresa = String(empresaId || '').trim();
  const rangoDefecto = useMemo(
    () => rangoInicial(fechaEmision),
    [fechaEmision],
  );
  const busquedaDefecto = useMemo(
    () => textoBusquedaDesdeContraparte(contraparteNombre),
    [contraparteNombre],
  );

  const [desde, setDesde] = useState(rangoDefecto.desde);
  const [hasta, setHasta] = useState(rangoDefecto.hasta);
  const [soloPendientes, setSoloPendientes] = useState(true);
  const [busqueda, setBusqueda] = useState(busquedaDefecto);

  const [movimientos, setMovimientos] = useState<MovimientoBanca[]>([]);
  const [cargando, setCargando] = useState(false);
  const [errorCarga, setErrorCarga] = useState('');
  const [hayMas, setHayMas] = useState(false);

  const [seleccionado, setSeleccionado] = useState<MovimientoBanca | null>(null);
  const [importeTexto, setImporteTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [errorConciliar, setErrorConciliar] = useState('');

  useEffect(() => {
    setDesde(rangoDefecto.desde);
    setHasta(rangoDefecto.hasta);
  }, [rangoDefecto]);

  // Solo al cambiar de factura/contraparte: no pisar lo que el usuario esté escribiendo.
  useEffect(() => {
    setBusqueda(busquedaDefecto);
  }, [idFactura, busquedaDefecto]);

  const cargaSeqRef = useRef(0);
  const envioSeqRef = useRef(0);
  const enCursoRef = useRef(false);

  /** El padre bloquea su formulario mientras el POST está en vuelo. */
  useEffect(() => {
    onOcupadoChange?.(enviando);
  }, [enviando, onOcupadoChange]);

  const rangoCompleto = RE_ISO.test(desde) && RE_ISO.test(hasta);

  /**
   * `conservarAviso` sirve al caso de la conciliación que no se ha podido
   * confirmar: se recarga la lista para ver si el apunte ya está conciliado, pero
   * el aviso de «puede haberse completado» tiene que seguir en pantalla.
   */
  const cargar = useCallback(async (opciones?: { conservarAviso?: boolean }) => {
    if (!empresa) {
      setMovimientos([]);
      setErrorCarga('');
      setHayMas(false);
      return;
    }
    // Sin rango completo la consulta se iría sin límite inferior (`queryMovimientos`
    // omite `desde` si viene vacío) y traería el histórico entero de la sociedad.
    if (!rangoCompleto) {
      setMovimientos([]);
      setErrorCarga('');
      setHayMas(false);
      setSeleccionado(null);
      return;
    }
    const secuencia = ++cargaSeqRef.current;
    setCargando(true);
    setErrorCarga('');
    setSeleccionado(null);
    if (!opciones?.conservarAviso) setErrorConciliar('');
    // Fuera del `try` para poder conservarlos si falla una página intermedia.
    const acumulados: MovimientoBanca[] = [];
    let cursor = '';
    try {
      for (let pagina = 1; pagina <= MAX_PAGINAS_AUTO; pagina += 1) {
        const res = await apiFetch(
          queryMovimientos(
            {
              iban: '',
              empresaId: empresa,
              estado: soloPendientes ? ESTADO_CONCILIACION_PENDIENTE : '',
              desde,
              hasta,
            },
            cursor,
            // Del más antiguo al más reciente: el movimiento que paga la factura
            // suele estar justo después de la emisión, y en `desc` el corte de la
            // página lo dejaba fuera.
            { orden: 'asc' },
          ),
        );
        const data = await res.json().catch(() => ({}));
        // Cada iteración vuelve a comprobar la secuencia: si el usuario ha
        // cambiado el rango a mitad del encadenado, mezclar páginas de dos
        // consultas distintas daría una lista falsa.
        if (secuencia !== cargaSeqRef.current) return;
        if (!res.ok) {
          throw new Error(data?.error || 'No se han podido cargar los movimientos');
        }
        if (Array.isArray(data.movimientos)) {
          acumulados.push(...(data.movimientos as MovimientoBanca[]));
        }
        cursor = typeof data.cursor === 'string' ? data.cursor : '';
        if (!cursor) break;
      }
      setMovimientos(acumulados);
      // Solo queda cursor si se agotaron las páginas permitidas: es entonces
      // cuando de verdad hay movimientos sin traer y toca acotar el rango.
      setHayMas(Boolean(cursor));
    } catch (e) {
      if (secuencia !== cargaSeqRef.current) return;
      // Si ya hay páginas traídas, un fallo en la siguiente no debería vaciar la
      // lista: se conserva lo cargado y se marca como incompleta para que salga
      // el aviso de acotar el rango.
      if (acumulados.length > 0) {
        setMovimientos(acumulados);
        setHayMas(true);
        return;
      }
      setMovimientos([]);
      setHayMas(false);
      setErrorCarga(errorMessage(e, 'No se han podido cargar los movimientos'));
    } finally {
      if (secuencia === cargaSeqRef.current) setCargando(false);
    }
  }, [empresa, desde, hasta, soloPendientes, rangoCompleto]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const saldoCentimos = aCentimos(saldoPendiente);

  /**
   * El endpoint no filtra por importe: un gasto solo se paga con un cargo y una
   * venta se cobra con un abono. El backend rechaza el signo contrario
   * (`SIGNO_INCOMPATIBLE`), así que se descarta aquí para no ofrecer imposibles.
   * También se oculta el ruido de la lista negra (traspasos, comisiones…).
   * Los que cuadran con el saldo pendiente van primero.
   */
  const visibles = useMemo(() => {
    const texto = sinAcentos(busqueda.trim().toLowerCase());
    const cuadraConPendiente = (m: MovimientoBanca) =>
      Math.abs(Math.abs(aCentimos(importeMovimiento(m))) - saldoCentimos) <= TOLERANCIA_CENTIMOS;

    return movimientos
      .filter((m) => {
        if (movimientoExcluidoPorPatron(m)) return false;
        const importe = importeMovimiento(m);
        if (tipo === 'IN' ? importe >= 0 : importe <= 0) return false;
        if (!texto) return true;
        return sinAcentos(textoBusquedaMovimiento(m)).includes(texto);
      })
      .sort((a, b) => {
        const ca = cuadraConPendiente(a) ? 0 : 1;
        const cb = cuadraConPendiente(b) ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return String(b.fechaOperacion || '').localeCompare(String(a.fechaOperacion || ''));
      });
  }, [movimientos, busqueda, tipo, saldoCentimos]);

  /** Hay filas del signo correcto (y no excluidas), pero el buscador las ha dejado fuera. */
  const ocultosPorBusqueda = useMemo(() => {
    if (!busqueda.trim() || visibles.length > 0) return 0;
    return movimientos.filter((m) => {
      if (movimientoExcluidoPorPatron(m)) return false;
      const importe = importeMovimiento(m);
      return tipo === 'IN' ? importe < 0 : importe > 0;
    }).length;
  }, [movimientos, busqueda, tipo, visibles.length]);

  const seleccionar = useCallback(
    (mov: MovimientoBanca) => {
      if (enviando) return;
      setErrorConciliar('');
      if (seleccionado?.movementHash === mov.movementHash) {
        setSeleccionado(null);
        return;
      }
      setSeleccionado(mov);
      const propuesta = Math.min(Math.abs(aCentimos(importeMovimiento(mov))), saldoCentimos);
      setImporteTexto(aEuros(Math.max(0, propuesta)).toFixed(2));
    },
    [enviando, seleccionado, saldoCentimos],
  );

  const importeCentimos = aCentimos(parseImporte(importeTexto));
  const movimientoCentimos = seleccionado
    ? Math.abs(aCentimos(importeMovimiento(seleccionado)))
    : 0;

  /**
   * `validarReparto` no sirve aquí: espera una `SugerenciaConciliacion` con
   * `conciliableCentimos`, y estos movimientos vienen crudos, sin saber cuánto
   * tienen ya conciliado. Si el apunte estaba parcialmente repartido, el exceso
   * lo rechaza el backend y se pinta como error.
   */
  const motivoInvalido = useMemo(() => {
    if (!seleccionado) return '';
    if (importeCentimos <= 0) return 'Indica un importe mayor que cero';
    if (importeCentimos > saldoCentimos) {
      return `A esta factura solo le quedan ${formatMoneda(aEuros(saldoCentimos))} por pagar`;
    }
    if (importeCentimos > movimientoCentimos) {
      return `El movimiento es de ${formatMoneda(aEuros(movimientoCentimos))}: no puedes aplicar más`;
    }
    return '';
  }, [seleccionado, importeCentimos, saldoCentimos, movimientoCentimos]);

  const conciliar = useCallback(async () => {
    if (!seleccionado || enCursoRef.current) return;
    if (motivoInvalido) {
      setErrorConciliar(motivoInvalido);
      return;
    }
    const importe = aEuros(importeCentimos);
    const secuencia = ++envioSeqRef.current;
    enCursoRef.current = true;
    setEnviando(true);
    setErrorConciliar('');
    try {
      const res = await apiFetch('/api/banca/conciliacion/aplicar', {
        method: 'POST',
        body: JSON.stringify({
          movementHash: seleccionado.movementHash,
          cuentaRef: seleccionado.cuentaRef,
          fechaOperacion: seleccionado.fechaOperacion,
          asignaciones: [{ id_factura: idFactura, importe }],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as RespuestaAplicar;
      if (secuencia !== envioSeqRef.current) return;

      const aplicadas = Array.isArray(data.aplicadas) ? data.aplicadas : [];
      const fallidas = Array.isArray(data.fallidas) ? data.fallidas : [];
      const avisos = Array.isArray(data.avisos) ? data.avisos : [];
      const totalAplicado = aplicadas.reduce((acc, a) => acc + (Number(a.importe) || 0), 0);

      if (fallidas.length > 0) {
        setErrorConciliar(fallidas[0]?.mensaje || 'No se ha podido conciliar el movimiento');
        return;
      }
      // Sin nada aplicado no hay pago que anunciar: eso es un error normal y se
      // trata más abajo.
      if (necesitaRepaso({ code: data.code, avisos }) && aplicadas.length > 0) {
        onConciliado({
          importe: totalAplicado || importe,
          mensaje:
            'El pago se ha registrado, pero el movimiento ha quedado sin cuadrar. '
            + 'No vuelvas a intentarlo: revísalo en Banca.',
          requiereRevision: true,
        });
        return;
      }
      if (!res.ok || aplicadas.length === 0) {
        setErrorConciliar(
          data.error
            || data.mensaje
            || `No se ha podido conciliar el movimiento (${data.code || res.status})`,
        );
        return;
      }
      const referencia = numeroFactura?.trim();
      onConciliado({
        importe: totalAplicado || importe,
        mensaje:
          `${formatMoneda(totalAplicado || importe)} del movimiento del `
          + `${formatFecha(seleccionado.fechaOperacion)}`
          + `${referencia ? ` · factura ${referencia}` : ''}`,
      });
    } catch (e) {
      if (secuencia !== envioSeqRef.current) return;
      // Un corte de red o el timeout de `apiFetch` no dicen si el servidor llegó
      // a registrar el pago. Decir «no se ha podido» invitaría a pagarlo a mano
      // y duplicarlo, así que se avisa de la duda y se recarga la lista para que
      // el usuario vea si el apunte ya está conciliado.
      const detalle = errorMessage(e, 'No se ha podido confirmar la conciliación').replace(
        /[.\s]+$/,
        '',
      );
      setErrorConciliar(
        `${detalle}. La operación puede haberse completado: comprueba el estado del `
        + `movimiento y de la factura antes de registrar el `
        + `${tipo === 'IN' ? 'pago' : 'cobro'} a mano.`,
      );
      void cargar({ conservarAviso: true });
    } finally {
      enCursoRef.current = false;
      if (secuencia === envioSeqRef.current) setEnviando(false);
    }
  }, [
    seleccionado,
    motivoInvalido,
    importeCentimos,
    idFactura,
    numeroFactura,
    onConciliado,
    tipo,
    cargar,
  ]);

  if (!empresa) {
    return (
      <View style={styles.panel}>
        <View style={styles.avisoBox}>
          <MaterialIcons name="info-outline" size={16} color="#d97706" />
          <Text style={styles.avisoText}>
            Esta factura no tiene sociedad asignada. Sin sociedad no se pueden buscar sus
            movimientos bancarios: complétala en la ficha de la factura.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.intro}>
        {tipo === 'IN'
          ? 'Cargos de la sociedad en el rango de fechas. Si el pago ya está en el banco, concílialo y se registra solo con el importe y la fecha reales.'
          : 'Abonos de la sociedad en el rango de fechas. Si el cobro ya está en el banco, concílialo y se registra solo con el importe y la fecha reales.'}
      </Text>

      {/* Mientras el POST está en vuelo, cualquier cambio de filtro recargaría la
          lista y borraría la selección: el aviso del resultado se perdería. */}
      <RangoFechas
        fill
        editable={!enviando}
        desdeIso={desde}
        hastaIso={hasta}
        onChangeDesde={setDesde}
        onChangeHasta={setHasta}
        style={styles.rango}
      />

      <View style={styles.filtrosRow}>
        <TouchableOpacity
          style={[styles.chip, soloPendientes && styles.chipActivo, touchMin, enviando && styles.controlDeshabilitado]}
          onPress={() => setSoloPendientes((v) => !v)}
          disabled={enviando}
          accessibilityRole="button"
          accessibilityState={{ selected: soloPendientes, disabled: enviando }}
        >
          <MaterialIcons
            name={soloPendientes ? 'check-box' : 'check-box-outline-blank'}
            size={15}
            color={soloPendientes ? '#0369a1' : '#64748b'}
          />
          <Text style={[styles.chipText, soloPendientes && styles.chipTextActivo]}>
            Solo sin conciliar
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btnRecargar, btnIconoMin, (cargando || enviando) && styles.controlDeshabilitado]}
          onPress={() => void cargar()}
          disabled={cargando || enviando}
          accessibilityLabel="Actualizar movimientos"
        >
          <MaterialIcons name="refresh" size={18} color="#0ea5e9" />
        </TouchableOpacity>
      </View>

      <View style={styles.buscadorRow}>
        <TextInput
          style={[styles.buscador, touchMin, enviando && styles.controlDeshabilitado]}
          value={busqueda}
          onChangeText={setBusqueda}
          editable={!enviando}
          placeholder="Buscar por concepto, contraparte, referencia…"
          placeholderTextColor="#94a3b8"
        />
        {busqueda.trim() ? (
          <TouchableOpacity
            style={[styles.btnLimpiarBusqueda, touchMin, enviando && styles.controlDeshabilitado]}
            onPress={() => setBusqueda('')}
            disabled={enviando}
            accessibilityLabel="Vaciar buscador"
          >
            <MaterialIcons name="close" size={16} color="#64748b" />
          </TouchableOpacity>
        ) : null}
      </View>

      {!rangoCompleto ? (
        <View style={styles.avisoBox}>
          <MaterialIcons name="event-busy" size={16} color="#d97706" />
          <Text style={styles.avisoText}>
            Indica las dos fechas del rango (dd/mm/aaaa) para buscar movimientos.
          </Text>
        </View>
      ) : cargando ? (
        <View style={styles.cargando}>
          <ActivityIndicator size="small" color="#0ea5e9" />
          <Text style={styles.cargandoText}>Buscando movimientos…</Text>
        </View>
      ) : errorCarga ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorCarga}</Text>
          <TouchableOpacity style={[styles.btnReintentar, touchMin]} onPress={() => void cargar()}>
            <MaterialIcons name="refresh" size={15} color="#0ea5e9" />
            <Text style={styles.btnReintentarText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : visibles.length === 0 ? (
        <View style={styles.vacioBox}>
          {ocultosPorBusqueda > 0 ? (
            <>
              <Text style={styles.vacioTitulo}>
                Ningún movimiento coincide con «{busqueda.trim()}»
              </Text>
              <Text style={styles.vacioLinea}>
                Hay {ocultosPorBusqueda} movimiento
                {ocultosPorBusqueda === 1 ? '' : 's'} del signo correcto, pero el buscador los
                oculta. Vacía el campo para verlos todos.
              </Text>
              <TouchableOpacity
                style={[styles.btnVaciarFiltro, touchMin]}
                onPress={() => setBusqueda('')}
                disabled={enviando}
              >
                <MaterialIcons name="filter-alt-off" size={15} color="#0ea5e9" />
                <Text style={styles.btnVaciarFiltroText}>Vaciar buscador</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {/* El filtro de signo es de cliente sobre lo que se ha llegado a
                  traer: si se alcanzó el tope de páginas, el movimiento buscado
                  puede haberse quedado fuera y aquí no se puede afirmar que no
                  exista. */}
              {hayMas ? (
                <>
                  <Text style={styles.vacioTitulo}>
                    Ningún movimiento de esta página corresponde a esta factura
                  </Text>
                  <Text style={styles.hayMas}>
                    Hay más movimientos de los que caben: acota el rango de fechas para poder
                    verlos.
                  </Text>
                </>
              ) : (
                <Text style={styles.vacioTitulo}>
                  No hay movimientos que puedan corresponder a esta factura
                </Text>
              )}
              {/* Un panel vacío no significa «el pago no está en el banco»: los
                  movimientos de cuentas cuyo IBAN no está de alta en el maestro de
                  empresas no llevan empresaId y no salen al filtrar por sociedad. */}
              <Text style={styles.vacioLinea}>
                · Puede que el extracto todavía no esté importado.
              </Text>
              <Text style={styles.vacioLinea}>
                {hayMas
                  ? '· Puede que el rango de fechas sea demasiado amplio: acótalo con los campos de arriba.'
                  : '· Puede que el rango de fechas sea corto: amplíalo con los campos de arriba.'}
              </Text>
              <Text style={styles.vacioLinea}>
                · Puede que la cuenta bancaria no esté asignada a esta sociedad; entonces sus
                movimientos no aparecen aquí. Se arregla en Banca → Cargas.
              </Text>
            </>
          )}
        </View>
      ) : (
        <ScrollView style={styles.lista} keyboardShouldPersistTaps="handled">
          {hayMas ? (
            <Text style={styles.hayMas}>
              Hay más movimientos de los que caben: acota el rango de fechas para verlos todos.
            </Text>
          ) : null}
          {visibles.map((mov) => {
            const importe = importeMovimiento(mov);
            const cuadra =
              Math.abs(Math.abs(aCentimos(importe)) - saldoCentimos) <= TOLERANCIA_CENTIMOS;
            const activo = seleccionado?.movementHash === mov.movementHash;
            const estado = etiquetaEstadoMovimiento(mov.estadoConciliacion);
            const contraparte = beneficiarioMovimiento(mov);
            const banco = etiquetaBancoMovimiento(mov);
            const coloresBanco = estiloBadgeBanco(banco);
            const cuentaLimpia = String(mov.iban || mov.cuentaRef || '').replace(/[\s-]/g, '');
            const digitosCuenta = cuentaLimpia.length >= 4 ? cuentaLimpia.slice(-4) : '';
            return (
              <TouchableOpacity
                key={mov.movementHash}
                style={[
                  styles.fila,
                  cuadra && styles.filaCuadra,
                  activo && styles.filaActiva,
                  touchMin,
                ]}
                onPress={() => seleccionar(mov)}
                disabled={enviando}
              >
                <View style={styles.filaCabecera}>
                  <View style={styles.filaCabeceraIzq}>
                    <Text style={styles.filaFecha}>{formatFecha(mov.fechaOperacion)}</Text>
                    <View
                      style={[
                        styles.badgeBanco,
                        { backgroundColor: coloresBanco.fondo, borderColor: coloresBanco.borde },
                      ]}
                    >
                      <Text
                        style={[styles.badgeBancoTexto, { color: coloresBanco.texto }]}
                        numberOfLines={1}
                      >
                        {banco}
                      </Text>
                    </View>
                    {digitosCuenta ? (
                      <Text style={styles.cuentaCorta}>{digitosCuenta}</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.filaImporte, cuadra && styles.filaImporteCuadra]}>
                    {formatMoneda(importe)}
                  </Text>
                </View>
                <Text style={styles.filaConcepto} numberOfLines={2}>
                  {conceptoCortoMovimiento(mov)}
                </Text>
                {contraparte ? (
                  <Text style={styles.filaContraparte} numberOfLines={1}>
                    {contraparte}
                  </Text>
                ) : null}
                {estado || cuadra ? (
                  <View style={styles.filaPie}>
                    {estado ? (
                      <View style={styles.badgeEstado}>
                        <Text style={styles.badgeEstadoText}>{estado}</Text>
                      </View>
                    ) : null}
                    {cuadra ? (
                      <View style={styles.badgeCuadra}>
                        <MaterialIcons name="check-circle" size={12} color="#16a34a" />
                        <Text style={styles.badgeCuadraText}>Cuadra con el pendiente</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {seleccionado ? (
        <View style={styles.conciliarBox}>
          <Text style={styles.conciliarTitulo}>
            Conciliar el movimiento del {formatFecha(seleccionado.fechaOperacion)}
          </Text>
          <View style={styles.conciliarRow}>
            <Text style={styles.conciliarLabel}>Importe a aplicar (€)</Text>
            <TextInput
              style={[styles.conciliarInput, touchMin]}
              value={importeTexto}
              onChangeText={(v) => {
                setImporteTexto(v);
                setErrorConciliar('');
              }}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor="#94a3b8"
              editable={!enviando}
            />
          </View>
          <Text style={styles.conciliarNota}>
            Al conciliar se registra el {tipo === 'IN' ? 'pago' : 'cobro'} automáticamente: no hace
            falta rellenar el formulario.
          </Text>
          {motivoInvalido ? <Text style={styles.errorText}>{motivoInvalido}</Text> : null}
          <TouchableOpacity
            style={[
              styles.btnPrincipal,
              (!puedeConciliar || enviando || !!motivoInvalido) && styles.btnDeshabilitado,
              touchMin,
            ]}
            onPress={() => void conciliar()}
            disabled={!puedeConciliar || enviando || !!motivoInvalido}
          >
            {enviando ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <MaterialIcons name="account-balance" size={18} color="#fff" />
                <Text style={styles.btnPrincipalText}>
                  {puedeConciliar
                    ? 'Conciliar'
                    : `No tienes permiso para registrar ${tipo === 'IN' ? 'pagos' : 'cobros'}`}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Fuera del bloque de selección a propósito: recargar la lista limpia la
          selección, y el resultado del envío tiene que seguir a la vista. */}
      {errorConciliar ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorConciliar}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, minWidth: 0, gap: 8 },
  intro: { fontSize: 11, lineHeight: 16, color: '#64748b' },
  rango: { marginTop: 2 },
  filtrosRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  chipActivo: { borderColor: '#7dd3fc', backgroundColor: '#f0f9ff' },
  chipText: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  chipTextActivo: { color: '#0369a1' },
  controlDeshabilitado: { opacity: 0.5 },
  btnRecargar: {
    marginLeft: 'auto',
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  buscadorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  buscador: {
    flex: 1,
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    color: '#334155',
  },
  btnLimpiarBusqueda: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  btnVaciarFiltro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  btnVaciarFiltroText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },

  cargando: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 16 },
  cargandoText: { fontSize: 12, color: '#64748b' },

  errorBox: {
    gap: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    padding: 10,
  },
  errorText: { fontSize: 11, color: '#dc2626', fontWeight: '600', lineHeight: 16 },
  btnReintentar: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  btnReintentarText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },

  avisoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    padding: 10,
  },
  avisoText: { flex: 1, fontSize: 11, lineHeight: 16, color: '#92400e' },

  vacioBox: {
    gap: 4,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
  },
  vacioTitulo: { fontSize: 12, fontWeight: '700', color: '#334155', marginBottom: 2 },
  vacioLinea: { fontSize: 11, lineHeight: 16, color: '#64748b' },

  lista: { flex: 1, minHeight: 0 },
  hayMas: { fontSize: 11, color: '#d97706', fontWeight: '600', marginBottom: 6 },
  fila: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
    gap: 2,
  },
  filaCuadra: { borderColor: '#16a34a', backgroundColor: '#f0fdf4' },
  filaActiva: { borderColor: '#0ea5e9', borderWidth: 2 },
  filaCabecera: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  filaCabeceraIzq: { flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, minWidth: 0 },
  filaFecha: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  badgeBanco: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 140,
  },
  badgeBancoTexto: { fontSize: 10, fontWeight: '700' },
  cuentaCorta: {
    fontSize: 11,
    fontStyle: 'italic',
    color: '#94a3b8',
  },
  filaImporte: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  filaImporteCuadra: { color: '#16a34a' },
  filaConcepto: { fontSize: 11, lineHeight: 15, color: '#334155' },
  filaContraparte: { fontSize: 11, color: '#475569', fontWeight: '600' },
  filaPie: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  badgeEstado: {
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeEstadoText: { fontSize: 10, fontWeight: '700', color: '#64748b' },
  badgeCuadra: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  badgeCuadraText: { fontSize: 10, fontWeight: '700', color: '#16a34a' },

  conciliarBox: {
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 8,
  },
  conciliarTitulo: { fontSize: 12, fontWeight: '700', color: '#334155' },
  conciliarRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  conciliarLabel: { flex: 1, fontSize: 12, fontWeight: '600', color: '#334155' },
  conciliarInput: {
    width: 110,
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    backgroundColor: '#fff',
    textAlign: 'right',
  },
  conciliarNota: { fontSize: 11, lineHeight: 16, color: '#64748b' },
  btnPrincipal: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#16a34a',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnPrincipalText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  btnDeshabilitado: { opacity: 0.5 },
});
