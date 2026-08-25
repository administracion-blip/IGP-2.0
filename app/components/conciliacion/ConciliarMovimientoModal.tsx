/**
 * Conciliación de un movimiento bancario contra la(s) factura(s) que propone el
 * backend: pantalla partida con la factura a la izquierda y el apunte del
 * extracto a la derecha.
 *
 * El layout copia el esqueleto de `MultipagoFacturasModal` (overlay + card de
 * 1100 y dos paneles que se apilan con `shouldStackPanels`), que es el patrón ya
 * asentado para modales de dos columnas.
 *
 * Dos casos que no son errores y por eso tienen tratamiento propio:
 * - Repartir menos de lo que queda libre del movimiento: se admite, el
 *   movimiento queda **parcialmente conciliado** y se avisa antes de enviar.
 * - `PARCIAL` (207): unas facturas se pagaron y otras no (el caso real es una
 *   factura metida en una remesa activa). El modal no se cierra: enseña el
 *   desglose y deja reintentar solo lo fallido, que es seguro porque el backend
 *   es idempotente.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatMoneda } from '../../utils/facturacion';
import { formatFecha, formatFechaPagoRow } from '../../utils/formatFecha';
import {
  beneficiarioMovimiento,
  conceptoCortoMovimiento,
  etiquetaBancoMovimiento,
} from '../../lib/banca';
import type { MovimientoBanca } from '../../types/banca';
import {
  aCentimos,
  aEuros,
  estiloNivel,
  etiquetaNivel,
  etiquetaTipoSugerencia,
  necesitaRepaso,
  parseImporte,
  validarReparto,
} from '../../lib/conciliacion';
import type {
  AsignacionAplicada,
  AsignacionFallida,
  AvisoConciliacion,
  RespuestaAplicar,
  RespuestaDescartar,
  ResumenMovimientoConciliado,
  SugerenciaConciliacion,
  SugerenciasDeFactura,
} from '../../types/conciliacion';

/** Lo que el padre necesita para refrescar y avisar al usuario. */
export type ResultadoConciliacion = {
  aplicadas: AsignacionAplicada[];
  avisos: AvisoConciliacion[];
  /** Se cierra con parte de las facturas sin aplicar. */
  parcial: boolean;
  movimiento?: ResumenMovimientoConciliado;
};

type Props = {
  visible: boolean;
  /** Entrada de `porFactura` de la fila pulsada. */
  entrada: SugerenciasDeFactura | null;
  /** Solo cambia los textos: en gasto se paga, en venta se cobra. */
  tipo: 'IN' | 'OUT';
  /** Permiso `facturacion.cobrar_pagar`. */
  puedeConciliar: boolean;
  onClose: () => void;
  /** Se ha aplicado algo: el padre refresca listado y sugerencias. */
  onConciliado: (resultado: ResultadoConciliacion) => void;
  /** La factura ya no se sugerirá para ese movimiento: recargar sugerencias. */
  onDescartada?: (mensaje: string) => void;
};

/** Reintentar repite facturas ya aplicadas: la última respuesta manda. */
function mezclarAplicadas(
  previas: AsignacionAplicada[],
  nuevas: AsignacionAplicada[],
): AsignacionAplicada[] {
  const mapa = new Map<string, AsignacionAplicada>();
  for (const a of previas) mapa.set(a.id_factura, a);
  for (const a of nuevas) mapa.set(a.id_factura, a);
  return [...mapa.values()];
}

export default function ConciliarMovimientoModal({
  visible,
  entrada,
  tipo,
  puedeConciliar,
  onClose,
  onConciliado,
  onDescartada,
}: Props) {
  const { height: winH } = useWindowDimensions();
  const { shouldStackPanels, isPhone } = useBreakpoint();
  const apilado = shouldStackPanels;

  const [indice, setIndice] = useState(0);
  /** Reparto en curso, en texto, por id de factura. */
  const [importes, setImportes] = useState<Record<string, string>>({});
  const [enviando, setEnviando] = useState(false);
  const [descartando, setDescartando] = useState(false);
  const [confirmandoDescarte, setConfirmandoDescarte] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [resultado, setResultado] = useState<RespuestaAplicar | null>(null);
  const [aplicadasAcum, setAplicadasAcum] = useState<AsignacionAplicada[]>([]);

  /**
   * Solo la última petición lanzada puede escribir en el estado: si el usuario
   * cambia de sugerencia o cierra mientras responde el backend, la respuesta
   * vieja pintaría un resultado que ya no corresponde.
   */
  const secuenciaRef = useRef(0);
  const enCursoRef = useRef(false);

  const sugerencias = entrada?.sugerencias ?? [];
  const sugerencia: SugerenciaConciliacion | null = sugerencias[indice] ?? null;

  useEffect(() => {
    if (!visible) return;
    secuenciaRef.current += 1;
    setIndice(0);
    setResultado(null);
    setErrorEnvio(null);
    setAplicadasAcum([]);
    setConfirmandoDescarte(false);
  }, [visible, entrada]);

  // Cada sugerencia trae su propio reparto propuesto por el backend.
  useEffect(() => {
    if (!sugerencia) return;
    const inicial: Record<string, string> = {};
    for (const f of sugerencia.facturas || []) {
      inicial[f.id_factura] = aEuros(f.asignadoCentimos).toFixed(2);
    }
    setImportes(inicial);
    setErrorEnvio(null);
  }, [sugerencia]);

  const importesEuros = useMemo(() => {
    const mapa: Record<string, number> = {};
    for (const f of sugerencia?.facturas || []) {
      mapa[f.id_factura] = parseImporte(importes[f.id_factura]);
    }
    return mapa;
  }, [sugerencia, importes]);

  const totalRepartidoCentimos = useMemo(
    () =>
      (sugerencia?.facturas || []).reduce(
        (acc, f) => acc + Math.max(0, aCentimos(importesEuros[f.id_factura])),
        0,
      ),
    [sugerencia, importesEuros],
  );

  const validacion = useMemo(
    () => (sugerencia ? validarReparto(sugerencia, importesEuros) : null),
    [sugerencia, importesEuros],
  );

  const libreTrasRepartoCentimos = (sugerencia?.conciliableCentimos ?? 0) - totalRepartidoCentimos;
  const quedaParcial = Boolean(validacion?.ok) && libreTrasRepartoCentimos > 0;

  /**
   * `MovimientoDeSugerencia` trae los mismos nombres de campo que el ítem del
   * extracto, así que se completa con la clave y se le pasa a los helpers de
   * `lib/banca` en vez de duplicar aquí el criterio por formato.
   */
  const movimientoBanca: MovimientoBanca = useMemo(
    () => ({
      ...(sugerencia?.movimiento ?? {}),
      movementHash: sugerencia?.movementHash ?? '',
      cuentaRef: sugerencia?.cuentaRef,
      fechaOperacion: sugerencia?.fechaOperacion,
      importe: sugerencia?.importe,
    }),
    [sugerencia],
  );

  const etiquetaContraparte = tipo === 'IN' ? 'Proveedor' : 'Cliente';
  const etiquetaCobro = tipo === 'IN' ? 'pago' : 'cobro';
  const touchMin = isPhone ? { minHeight: MIN_TOUCH } : null;

  const cerrar = useCallback(() => {
    if (enviando || descartando) return;
    secuenciaRef.current += 1;
    if (aplicadasAcum.length > 0) {
      onConciliado({
        aplicadas: aplicadasAcum,
        avisos: resultado?.avisos ?? [],
        // Un movimiento que queda para repasar tampoco es un cierre limpio: el
        // padre debe avisar, no celebrar.
        parcial: (resultado?.fallidas?.length ?? 0) > 0 || necesitaRepaso(resultado),
        movimiento: resultado?.movimiento,
      });
      return;
    }
    onClose();
  }, [enviando, descartando, aplicadasAcum, resultado, onConciliado, onClose]);

  const enviar = useCallback(
    async (soloIds?: string[]) => {
      if (!sugerencia || enCursoRef.current) return;
      const chequeo = validarReparto(sugerencia, importesEuros);
      if (!chequeo.ok) {
        setErrorEnvio(chequeo.motivo);
        return;
      }
      const asignaciones = (sugerencia.facturas || [])
        .filter((f) => !soloIds || soloIds.includes(f.id_factura))
        .map((f) => ({
          id_factura: f.id_factura,
          importe: aEuros(aCentimos(importesEuros[f.id_factura])),
        }))
        .filter((a) => a.importe > 0);

      if (asignaciones.length === 0) {
        setErrorEnvio('Asigna algún importe antes de conciliar');
        return;
      }

      const secuencia = ++secuenciaRef.current;
      enCursoRef.current = true;
      setEnviando(true);
      setErrorEnvio(null);
      try {
        const res = await apiFetch('/api/banca/conciliacion/aplicar', {
          method: 'POST',
          body: JSON.stringify({
            movementHash: sugerencia.movementHash,
            cuentaRef: sugerencia.cuentaRef,
            fechaOperacion: sugerencia.fechaOperacion,
            asignaciones,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as RespuestaAplicar;
        if (secuencia !== secuenciaRef.current) return;

        const aplicadas = Array.isArray(data.aplicadas) ? data.aplicadas : [];
        const fallidas = Array.isArray(data.fallidas) ? data.fallidas : [];
        const avisos = Array.isArray(data.avisos) ? data.avisos : [];
        const acumuladas = mezclarAplicadas(aplicadasAcum, aplicadas);
        setAplicadasAcum(acumuladas);

        // Ni éxito ni error: el dinero está aplicado, pero el apunte queda para
        // repasar. Reenviar no lo arregla —la factura ya está cobrada—, así que
        // se corta aquí en vez de dejar el botón invitando.
        const repaso = necesitaRepaso({ ...data, avisos }) && acumuladas.length > 0;

        if (repaso || fallidas.length > 0) {
          setResultado({ ...data, aplicadas: acumuladas, fallidas, avisos });
          return;
        }
        if (!res.ok || acumuladas.length === 0) {
          setErrorEnvio(
            data.error || data.mensaje || `No se pudo registrar el ${etiquetaCobro} (${data.code || res.status})`,
          );
          return;
        }
        onConciliado({
          aplicadas: acumuladas,
          avisos,
          parcial: false,
          movimiento: data.movimiento,
        });
      } catch (e) {
        if (secuencia !== secuenciaRef.current) return;
        setErrorEnvio(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        enCursoRef.current = false;
        if (secuencia === secuenciaRef.current) setEnviando(false);
      }
    },
    [sugerencia, importesEuros, aplicadasAcum, etiquetaCobro, onConciliado],
  );

  const descartar = useCallback(async () => {
    if (!sugerencia || !entrada || enCursoRef.current) return;
    const secuencia = ++secuenciaRef.current;
    enCursoRef.current = true;
    setDescartando(true);
    setErrorEnvio(null);
    try {
      const res = await apiFetch('/api/banca/conciliacion/descartar', {
        method: 'POST',
        body: JSON.stringify({
          movementHash: sugerencia.movementHash,
          cuentaRef: sugerencia.cuentaRef,
          id_factura: entrada.id_factura,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as RespuestaDescartar;
      if (secuencia !== secuenciaRef.current) return;
      if (!res.ok) {
        setErrorEnvio(data.error || data.mensaje || 'No se pudo descartar la sugerencia');
        return;
      }
      setConfirmandoDescarte(false);
      onDescartada?.('Esta factura ya no se sugerirá para ese movimiento');
    } catch (e) {
      if (secuencia !== secuenciaRef.current) return;
      setErrorEnvio(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      enCursoRef.current = false;
      if (secuencia === secuenciaRef.current) setDescartando(false);
    }
  }, [sugerencia, entrada, onDescartada]);

  if (!visible) return null;

  const colores = estiloNivel(sugerencia?.nivel ?? 'baja');
  const hayRevisionPendiente = (sugerencia?.facturas || []).some((f) => f.pendienteRevision);
  const fallidas: AsignacionFallida[] = resultado?.fallidas ?? [];
  const avisosResultado: AvisoConciliacion[] = resultado?.avisos ?? [];
  const conflictoMovimiento = resultado?.code === 'CONFLICTO_MOVIMIENTO';
  const movimientoParaRepasar = necesitaRepaso(resultado);
  const ocupado = enviando || descartando;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={cerrar}>
      <Pressable
        style={[styles.overlay, apilado && styles.overlayFull]}
        onPress={cerrar}
      >
        <Pressable
          style={[
            styles.wrap,
            apilado ? styles.wrapFull : { maxHeight: winH * 0.94 },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={[styles.card, apilado && styles.cardFull]}>
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={styles.title}>Conciliar movimiento bancario</Text>
                <Text style={styles.subtitle}>
                  {sugerencia
                    ? `${formatFecha(sugerencia.fechaOperacion)} · ${formatMoneda(sugerencia.importe)} · quedan libres ${formatMoneda(sugerencia.conciliable)}`
                    : 'Sin movimientos candidatos'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={cerrar}
                disabled={ocupado}
                hitSlop={10}
                accessibilityLabel="Cerrar"
                style={touchMin}
              >
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            {sugerencias.length > 1 && !resultado ? (
              <View style={styles.selectorWrap}>
                <Text style={styles.selectorLabel}>
                  {sugerencias.length} movimientos candidatos
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {sugerencias.map((s, i) => {
                    const c = estiloNivel(s.nivel);
                    const activo = i === indice;
                    return (
                      <TouchableOpacity
                        key={s.clave}
                        onPress={() => setIndice(i)}
                        disabled={ocupado}
                        style={[
                          styles.chipSugerencia,
                          { borderColor: c.borde, backgroundColor: c.fondo },
                          activo && styles.chipSugerenciaActivo,
                          touchMin,
                        ]}
                      >
                        <MaterialIcons name="account-balance" size={13} color={c.texto} />
                        <Text style={[styles.chipSugerenciaText, { color: c.texto }]}>
                          {formatFecha(s.fechaOperacion)} · {formatMoneda(s.conciliable)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}

            {!sugerencia ? (
              <View style={styles.vacio}>
                <Text style={styles.vacioText}>
                  No hay ningún movimiento bancario que corresponda a esta factura.
                </Text>
              </View>
            ) : resultado ? (
              <ScrollView style={styles.resultadoScroll} contentContainerStyle={styles.resultadoContent}>
                <View style={styles.resultadoCabecera}>
                  <MaterialIcons
                    name={aplicadasAcum.length > 0 ? 'error-outline' : 'highlight-off'}
                    size={20}
                    color={aplicadasAcum.length > 0 ? '#d97706' : '#dc2626'}
                  />
                  <Text style={styles.resultadoTitulo}>
                    {aplicadasAcum.length === 0
                      ? `No se ha registrado ningún ${etiquetaCobro}`
                      : movimientoParaRepasar && fallidas.length === 0
                        ? 'Revisa el movimiento en banca'
                        : 'Conciliación parcial: revisa lo que ha fallado'}
                  </Text>
                </View>

                {conflictoMovimiento ? (
                  <View style={styles.bloqueAviso}>
                    <Text style={styles.bloqueLinea}>
                      {resultado.mensaje
                        || resultado.error
                        || `El ${etiquetaCobro} se ha registrado, pero no ha podido anotarse en el `
                          + 'movimiento porque otra persona lo estaba cambiando a la vez.'}
                    </Text>
                    <Text style={styles.bloqueNota}>
                      No vuelvas a enviarlo: la factura ya está al corriente y se duplicaría el
                      trabajo. Lo que queda es cuadrar el movimiento desde banca.
                    </Text>
                  </View>
                ) : null}

                {aplicadasAcum.length > 0 ? (
                  <View style={styles.bloqueOk}>
                    <Text style={styles.bloqueTitulo}>Aplicadas</Text>
                    {aplicadasAcum.map((a) => (
                      <Text key={a.id_factura} style={styles.bloqueLinea}>
                        · {etiquetaFactura(sugerencia, a.id_factura)} — {formatMoneda(a.importe)}
                        {a.idempotente ? ' (ya estaba aplicada)' : ''}
                        {a.estadoFactura ? ` · ${a.estadoFactura}` : ''}
                      </Text>
                    ))}
                  </View>
                ) : null}

                {fallidas.length > 0 ? (
                  <View style={styles.bloqueError}>
                    <Text style={styles.bloqueTitulo}>Sin aplicar</Text>
                    {fallidas.map((f) => (
                      <Text key={f.id_factura} style={styles.bloqueLinea}>
                        · {etiquetaFactura(sugerencia, f.id_factura)} — {f.mensaje}
                      </Text>
                    ))}
                    <Text style={styles.bloqueNota}>
                      Puedes reintentar solo lo que ha fallado: lo ya aplicado no se duplica.
                    </Text>
                  </View>
                ) : null}

                {avisosResultado.length > 0 ? (
                  <View style={styles.bloqueAviso}>
                    <Text style={styles.bloqueTitulo}>Avisos</Text>
                    {avisosResultado.map((a, i) => (
                      <Text key={`${a.code}-${a.id_factura ?? i}`} style={styles.bloqueLinea}>
                        · {a.mensaje}
                      </Text>
                    ))}
                  </View>
                ) : null}

                {resultado.movimiento ? (
                  <Text style={styles.resultadoMovimiento}>
                    Movimiento {resultado.movimiento.estadoConciliacion} · conciliado{' '}
                    {formatMoneda(resultado.movimiento.conciliado)} · libre{' '}
                    {formatMoneda(resultado.movimiento.libre)}
                  </Text>
                ) : null}
              </ScrollView>
            ) : (
              <View style={[styles.body, apilado && styles.bodyApilado]}>
                {/* Izquierda: factura(s) y reparto */}
                <View style={[styles.panelFacturas, apilado && styles.panelApilado]}>
                  <Text style={styles.panelTitulo}>
                    {sugerencia.facturas.length > 1
                      ? `Facturas (${sugerencia.facturas.length})`
                      : 'Factura'}
                  </Text>

                  {hayRevisionPendiente ? (
                    <View style={styles.avisoRevision}>
                      <MaterialIcons name="warning-amber" size={16} color="#d97706" />
                      <Text style={styles.avisoRevisionText}>
                        Hay facturas pendientes de validar. Se puede conciliar, pero conviene
                        revisarlas antes.
                      </Text>
                    </View>
                  ) : null}

                  <ScrollView style={styles.panelScroll} keyboardShouldPersistTaps="handled">
                    {sugerencia.facturas.map((f) => (
                      <View
                        key={f.id_factura}
                        style={[
                          styles.facturaCard,
                          f.id_factura === entrada?.id_factura && styles.facturaCardFoco,
                        ]}
                      >
                        <View style={styles.facturaCabecera}>
                          <Text style={styles.facturaNumero} numberOfLines={1}>
                            {f.numero?.trim() || f.id_factura}
                          </Text>
                          {f.pendienteRevision ? (
                            <View style={styles.badgeRevision}>
                              <Text style={styles.badgeRevisionText}>Sin validar</Text>
                            </View>
                          ) : null}
                        </View>

                        <Dato etiqueta="Empresa" valor={f.emisor_nombre?.trim() || '—'} />
                        <Dato etiqueta={etiquetaContraparte} valor={f.empresa_nombre?.trim() || '—'} />
                        <Dato etiqueta="Emisión" valor={formatFechaPagoRow(f.fecha_emision)} />
                        <Dato etiqueta="Vencimiento" valor={formatFechaPagoRow(f.fecha_vencimiento)} />
                        <Dato etiqueta="Saldo pendiente" valor={formatMoneda(f.saldoPendiente)} />

                        <View style={styles.repartoRow}>
                          <Text style={styles.repartoLabel}>Importe a aplicar (€)</Text>
                          <TextInput
                            style={[styles.repartoInput, touchMin]}
                            value={importes[f.id_factura] ?? ''}
                            onChangeText={(v) =>
                              setImportes((prev) => ({ ...prev, [f.id_factura]: v }))
                            }
                            keyboardType="decimal-pad"
                            placeholder="0.00"
                            placeholderTextColor="#94a3b8"
                            editable={!ocupado}
                          />
                        </View>
                        <Text style={styles.repartoResto}>
                          Quedará pendiente{' '}
                          {formatMoneda(
                            Math.max(
                              0,
                              aEuros(
                                f.saldoPendienteCentimos -
                                  Math.max(0, aCentimos(importesEuros[f.id_factura])),
                              ),
                            ),
                          )}
                        </Text>
                      </View>
                    ))}
                  </ScrollView>
                </View>

                {/* Derecha: movimiento del extracto */}
                <View style={[styles.panelMovimiento, apilado && styles.panelApilado]}>
                  <View style={styles.panelTituloRow}>
                    <Text style={styles.panelTitulo}>Movimiento bancario</Text>
                    <View
                      style={[
                        styles.badgeNivel,
                        { backgroundColor: colores.fondo, borderColor: colores.borde },
                      ]}
                    >
                      <Text style={[styles.badgeNivelText, { color: colores.texto }]}>
                        {etiquetaNivel(sugerencia.nivel)} · {etiquetaTipoSugerencia(sugerencia.tipo)}
                      </Text>
                    </View>
                  </View>

                  <ScrollView style={styles.panelScroll} keyboardShouldPersistTaps="handled">
                    <Dato etiqueta="Fecha de operación" valor={formatFecha(sugerencia.fechaOperacion)} />
                    <Dato etiqueta="Importe" valor={formatMoneda(sugerencia.importe)} />
                    <Dato etiqueta="Libre para conciliar" valor={formatMoneda(sugerencia.conciliable)} />
                    <Dato etiqueta="Concepto" valor={conceptoCortoMovimiento(movimientoBanca)} multilinea />
                    <Dato
                      etiqueta="Contraparte"
                      valor={beneficiarioMovimiento(movimientoBanca) || '—'}
                      multilinea
                    />
                    <Dato
                      etiqueta="Cuenta"
                      valor={`${movimientoBanca.iban || sugerencia.cuentaRef || '—'} · ${etiquetaBancoMovimiento(movimientoBanca)}`}
                      multilinea
                    />
                    <Dato etiqueta="Sociedad" valor={movimientoBanca.empresaNombre || '—'} />

                    {sugerencia.motivos && sugerencia.motivos.length > 0 ? (
                      <View style={styles.motivosWrap}>
                        <Text style={styles.motivosTitulo}>Por qué se propone</Text>
                        {sugerencia.motivos.map((m, i) => (
                          <View key={`${i}-${m}`} style={styles.motivoFila}>
                            <MaterialIcons name="check-circle" size={14} color="#16a34a" />
                            <Text style={styles.motivoText}>{m}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </ScrollView>
                </View>
              </View>
            )}

            <View style={styles.footer}>
              {sugerencia && !resultado ? (
                <View style={styles.footerTotales}>
                  <Text style={styles.footerTotalText}>
                    Repartido:{' '}
                    <Text style={styles.footerTotalStrong}>
                      {formatMoneda(aEuros(totalRepartidoCentimos))}
                    </Text>
                  </Text>
                  <Text style={styles.footerTotalText}>
                    Queda libre del movimiento:{' '}
                    <Text style={styles.footerTotalStrong}>
                      {formatMoneda(aEuros(Math.max(0, libreTrasRepartoCentimos)))}
                    </Text>
                  </Text>
                  {validacion && !validacion.ok ? (
                    <Text style={styles.footerError}>{validacion.motivo}</Text>
                  ) : quedaParcial ? (
                    <Text style={styles.footerAviso}>
                      El movimiento quedará parcialmente conciliado.
                    </Text>
                  ) : null}
                  {errorEnvio ? <Text style={styles.footerError}>{errorEnvio}</Text> : null}
                  {!puedeConciliar ? (
                    <Text style={styles.footerAviso}>
                      No tienes permiso para registrar {etiquetaCobro}s.
                    </Text>
                  ) : null}
                </View>
              ) : (
                <View style={styles.footerTotales}>
                  {errorEnvio ? <Text style={styles.footerError}>{errorEnvio}</Text> : null}
                  {!puedeConciliar ? (
                    <Text style={styles.footerAviso}>
                      No tienes permiso para registrar {etiquetaCobro}s.
                    </Text>
                  ) : null}
                </View>
              )}

              <View style={styles.footerBotones}>
                <TouchableOpacity
                  style={[styles.btnSecundario, touchMin]}
                  onPress={cerrar}
                  disabled={ocupado}
                >
                  <Text style={styles.btnSecundarioText}>
                    {aplicadasAcum.length > 0 ? 'Cerrar' : 'Cancelar'}
                  </Text>
                </TouchableOpacity>

                {sugerencia && !resultado ? (
                  confirmandoDescarte ? (
                    <TouchableOpacity
                      style={[styles.btnPeligro, touchMin]}
                      onPress={descartar}
                      disabled={ocupado}
                    >
                      {descartando ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.btnPeligroText}>Confirmar descarte</Text>
                      )}
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.btnSecundario, touchMin]}
                      onPress={() => setConfirmandoDescarte(true)}
                      disabled={ocupado}
                    >
                      <MaterialIcons name="block" size={16} color="#b91c1c" />
                      <Text style={[styles.btnSecundarioText, styles.btnDescartarText]}>
                        No es de esta factura
                      </Text>
                    </TouchableOpacity>
                  )
                ) : null}

                {sugerencia && resultado && fallidas.length > 0 ? (
                  <TouchableOpacity
                    style={[
                      styles.btnPrincipal,
                      (!puedeConciliar || ocupado) && styles.btnDeshabilitado,
                      touchMin,
                    ]}
                    onPress={() => enviar(fallidas.map((f) => f.id_factura))}
                    disabled={!puedeConciliar || ocupado}
                  >
                    {enviando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons name="refresh" size={18} color="#fff" />
                        <Text style={styles.btnPrincipalText}>Reintentar lo fallido</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : null}

                {sugerencia && !resultado ? (
                  <TouchableOpacity
                    style={[
                      styles.btnPrincipal,
                      (!puedeConciliar || ocupado || !validacion?.ok) && styles.btnDeshabilitado,
                      touchMin,
                    ]}
                    onPress={() => enviar()}
                    disabled={!puedeConciliar || ocupado || !validacion?.ok}
                  >
                    {enviando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons name="account-balance" size={18} color="#fff" />
                        <Text style={styles.btnPrincipalText}>Conciliar</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : null}
              </View>

              {confirmandoDescarte && !resultado ? (
                <Text style={styles.footerAviso}>
                  Esta factura dejará de sugerirse para este movimiento.
                </Text>
              ) : null}
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Número de la factura dentro de la sugerencia, para los mensajes del resultado. */
function etiquetaFactura(sugerencia: SugerenciaConciliacion, idFactura: string): string {
  const f = (sugerencia.facturas || []).find((x) => x.id_factura === idFactura);
  return f?.numero?.trim() || idFactura;
}

function Dato({
  etiqueta,
  valor,
  multilinea = false,
}: {
  etiqueta: string;
  valor: string;
  multilinea?: boolean;
}) {
  return (
    <View style={styles.datoFila}>
      <Text style={styles.datoEtiqueta}>{etiqueta}</Text>
      <Text style={styles.datoValor} numberOfLines={multilinea ? 3 : 1}>
        {valor || '—'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  overlayFull: { padding: 0 },
  wrap: { width: '96%', maxWidth: 1100, flex: 1, alignSelf: 'center' },
  wrapFull: { width: '100%', maxWidth: undefined, flex: 1 },
  card: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardFull: { borderRadius: 0, borderWidth: 0 },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerText: { flex: 1, paddingRight: 8 },
  title: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  subtitle: { marginTop: 2, fontSize: 12, color: '#64748b' },

  selectorWrap: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  selectorLabel: { fontSize: 11, color: '#64748b', marginBottom: 6, fontWeight: '600' },
  chipSugerencia: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 6,
  },
  chipSugerenciaActivo: { borderColor: '#0ea5e9', borderWidth: 2 },
  chipSugerenciaText: { fontSize: 11, fontWeight: '600' },

  body: { flex: 1, flexDirection: 'row', minHeight: 0 },
  bodyApilado: { flexDirection: 'column' },
  panelFacturas: {
    flex: 1,
    minWidth: 0,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    padding: 12,
  },
  panelMovimiento: { flex: 1, minWidth: 0, padding: 12 },
  panelApilado: { borderRightWidth: 0, flex: 1 },
  panelScroll: { flex: 1 },
  panelTituloRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 6,
  },
  panelTitulo: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  badgeNivel: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    marginBottom: 8,
  },
  badgeNivelText: { fontSize: 11, fontWeight: '700' },

  avisoRevision: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
  },
  avisoRevisionText: { flex: 1, fontSize: 11, color: '#92400e', lineHeight: 15 },

  facturaCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  facturaCardFoco: { borderColor: '#7dd3fc' },
  facturaCabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 6,
  },
  facturaNumero: { flex: 1, fontSize: 13, fontWeight: '700', color: '#0f172a' },
  badgeRevision: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeRevisionText: { fontSize: 10, fontWeight: '700', color: '#d97706' },

  datoFila: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 3,
  },
  datoEtiqueta: { width: 118, fontSize: 11, color: '#64748b', fontWeight: '600' },
  datoValor: { flex: 1, fontSize: 12, color: '#0f172a' },

  repartoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  repartoLabel: { flex: 1, fontSize: 12, fontWeight: '600', color: '#334155' },
  repartoInput: {
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
  repartoResto: { marginTop: 4, fontSize: 11, color: '#64748b' },

  motivosWrap: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 10,
  },
  motivosTitulo: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 6,
  },
  motivoFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 4 },
  motivoText: { flex: 1, fontSize: 12, color: '#334155', lineHeight: 17 },

  vacio: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  vacioText: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },

  resultadoScroll: { flex: 1 },
  resultadoContent: { padding: 16, gap: 10 },
  resultadoCabecera: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  resultadoTitulo: { flex: 1, fontSize: 14, fontWeight: '700', color: '#0f172a' },
  bloqueOk: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 8,
    padding: 10,
  },
  bloqueError: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    padding: 10,
  },
  bloqueAviso: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    padding: 10,
  },
  bloqueTitulo: { fontSize: 12, fontWeight: '700', color: '#334155', marginBottom: 4 },
  bloqueLinea: { fontSize: 12, color: '#334155', lineHeight: 18 },
  bloqueNota: { marginTop: 6, fontSize: 11, color: '#64748b', fontStyle: 'italic' },
  resultadoMovimiento: { fontSize: 11, color: '#64748b' },

  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  footerTotales: { flex: 1, gap: 2, minWidth: 200 },
  footerTotalText: { fontSize: 13, color: '#475569' },
  footerTotalStrong: { fontWeight: '700', color: '#0f172a' },
  footerError: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  footerAviso: { fontSize: 12, color: '#d97706', fontWeight: '600' },
  footerBotones: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  btnSecundario: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  btnSecundarioText: { fontSize: 13, fontWeight: '600', color: '#475569' },
  btnDescartarText: { color: '#b91c1c' },
  btnPeligro: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#dc2626',
  },
  btnPeligroText: { fontSize: 13, fontWeight: '700', color: '#fff' },
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
