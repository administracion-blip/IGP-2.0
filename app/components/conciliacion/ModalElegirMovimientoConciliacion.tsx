/**
 * Elige un movimiento bancario para conciliar varias facturas marcadas a mano.
 * Los filtros copian los de la conciliación de una sola factura: empresa, rango
 * alrededor de la emisión, solo pendientes, signo y el importe que cuadra arriba.
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
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatMoneda } from '../../utils/facturacion';
import { fechaEmisionFacturaAIso, formatFecha } from '../../utils/formatFecha';
import { RangoFechas } from '../RangoFechas';
import {
  ESTADO_CONCILIACION_PENDIENTE,
  conceptoCortoMovimiento,
  importeMovimiento,
  queryMovimientos,
  textoBusquedaMovimiento,
} from '../../lib/banca';
import {
  aCentimos,
  desdeBarridoMovimientosIso,
  movimientoExcluidoPorPatron,
} from '../../lib/conciliacion';
import { textoBusquedaDesdeContraparte } from './PanelMovimientosFactura';
import type { FacturaListado } from '../../types/factura';
import type { SugerenciasDeFactura } from '../../types/conciliacion';
import {
  construirEntradaManual,
  emisorComun,
  facturasConciliables,
  libreCentimos,
  sumaSeleccion,
  type MovimientoConciliable,
} from '../../lib/seleccionFacturasConciliacion';

type Props = {
  visible: boolean;
  tipo: 'IN' | 'OUT';
  facturas: FacturaListado[];
  onClose: () => void;
  onElegido: (entrada: SugerenciasDeFactura) => void;
};

/** Igual que el panel de una factura: 10 días antes y 60 después de emitir. */
const DIAS_ANTES_EMISION = 10;
const DIAS_DESPUES_EMISION = 60;
const MESES_SIN_ANCLA = 3;
const TOLERANCIA_CENTIMOS = 1;
const MAX_PAGINAS_AUTO = 5;

function isoMasDias(iso: string, dias: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

function sinAcentos(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Unión de los rangos de cada factura: de la emisión más antigua a la más reciente. */
function rangoDeFacturas(facturas: FacturaListado[]): { desde: string; hasta: string } {
  const emisiones = facturas
    .map((f) => fechaEmisionFacturaAIso(f.fecha_emision))
    .filter((iso): iso is string => Boolean(iso))
    .sort();
  if (emisiones.length === 0) {
    const hoy = new Date();
    return {
      desde: desdeBarridoMovimientosIso(hoy, MESES_SIN_ANCLA),
      hasta: hoy.toISOString().slice(0, 10),
    };
  }
  return {
    desde: isoMasDias(emisiones[0], -DIAS_ANTES_EMISION),
    hasta: isoMasDias(emisiones[emisiones.length - 1], DIAS_DESPUES_EMISION),
  };
}

function nombreContraparteComun(facturas: FacturaListado[]): string {
  const nombres = new Set(
    facturas.map((f) => String(f.empresa_nombre || '').trim().toLowerCase()).filter(Boolean),
  );
  if (nombres.size !== 1) return '';
  return String(facturas.find((f) => String(f.empresa_nombre || '').trim())?.empresa_nombre || '');
}

export default function ModalElegirMovimientoConciliacion({
  visible,
  tipo,
  facturas,
  onClose,
  onElegido,
}: Props) {
  const utiles = useMemo(() => facturasConciliables(facturas), [facturas]);
  const empresaId = emisorComun(utiles);
  const suma = useMemo(() => sumaSeleccion(utiles), [utiles]);
  const rangoDefecto = useMemo(() => rangoDeFacturas(utiles), [utiles]);
  const busquedaDefecto = useMemo(
    () => textoBusquedaDesdeContraparte(nombreContraparteComun(utiles)),
    [utiles],
  );

  const [desde, setDesde] = useState(rangoDefecto.desde);
  const [hasta, setHasta] = useState(rangoDefecto.hasta);
  const [soloPendientes, setSoloPendientes] = useState(true);
  const [busqueda, setBusqueda] = useState(busquedaDefecto);
  const [movimientos, setMovimientos] = useState<MovimientoConciliable[]>([]);
  const [cargando, setCargando] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [error, setError] = useState('');
  const [elegido, setElegido] = useState<string | null>(null);
  const cargaSeqRef = useRef(0);

  useEffect(() => {
    if (!visible) return;
    setDesde(rangoDefecto.desde);
    setHasta(rangoDefecto.hasta);
    setBusqueda(busquedaDefecto);
    setSoloPendientes(true);
    setElegido(null);
  }, [visible, rangoDefecto.desde, rangoDefecto.hasta, busquedaDefecto]);

  const rangoCompleto = /^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(hasta);

  const cargar = useCallback(async () => {
    if (!visible) return;
    if (!empresaId || !rangoCompleto) {
      cargaSeqRef.current += 1;
      setMovimientos([]);
      setHayMas(false);
      setError('');
      setElegido(null);
      setCargando(false);
      return;
    }
    const secuencia = ++cargaSeqRef.current;
    setCargando(true);
    setError('');
    setElegido(null);
    const acumulados: MovimientoConciliable[] = [];
    let cursor = '';
    try {
      for (let pagina = 0; pagina < MAX_PAGINAS_AUTO; pagina += 1) {
        const res = await apiFetch(queryMovimientos(
          {
            iban: '',
            empresaId,
            estado: soloPendientes ? ESTADO_CONCILIACION_PENDIENTE : '',
            desde,
            hasta,
          },
          cursor,
          { orden: 'asc' },
        ));
        const data = await res.json().catch(() => ({}));
        if (secuencia !== cargaSeqRef.current) return;
        if (!res.ok) throw new Error(data?.error || 'No se han podido cargar los movimientos');
        if (Array.isArray(data.movimientos)) {
          acumulados.push(...(data.movimientos as MovimientoConciliable[]));
        }
        cursor = typeof data.cursor === 'string' ? data.cursor : '';
        if (!cursor) break;
      }
      setMovimientos(acumulados);
      setHayMas(Boolean(cursor));
    } catch (e) {
      if (secuencia !== cargaSeqRef.current) return;
      if (acumulados.length > 0) {
        setMovimientos(acumulados);
        setHayMas(true);
        return;
      }
      setMovimientos([]);
      setHayMas(false);
      setError(errorMessage(e, 'No se han podido cargar los movimientos'));
    } finally {
      if (secuencia === cargaSeqRef.current) setCargando(false);
    }
  }, [visible, empresaId, desde, hasta, soloPendientes, rangoCompleto]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const saldoCentimos = aCentimos(suma.pendiente);

  const visibles = useMemo(() => {
    const texto = sinAcentos(busqueda.trim().toLowerCase());
    const cuadra = (m: MovimientoConciliable) =>
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
        const ca = cuadra(a) ? 0 : 1;
        const cb = cuadra(b) ? 0 : 1;
        if (ca !== cb) return ca - cb;
        return String(b.fechaOperacion || '').localeCompare(String(a.fechaOperacion || ''));
      });
  }, [movimientos, busqueda, tipo, saldoCentimos]);

  const confirmar = () => {
    const mov = movimientos.find((m) => m.movementHash === elegido);
    if (!mov) return;
    onElegido(construirEntradaManual(tipo, facturas, mov));
  };

  const etiqueta = tipo === 'IN' ? 'cargo' : 'abono';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.titulo}>Conciliar {utiles.length} factura{utiles.length === 1 ? '' : 's'}</Text>
              <Text style={styles.subtitulo}>
                Pendiente {formatMoneda(suma.pendiente)}. El {etiqueta} que coincide con esa suma sale el primero.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Cerrar" style={styles.cerrar}>
              <MaterialIcons name="close" size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          {!empresaId ? (
            <Text style={styles.aviso}>Las facturas marcadas no son de la misma empresa.</Text>
          ) : (
            <>
              <RangoFechas
                fill
                desdeIso={desde}
                hastaIso={hasta}
                onChangeDesde={setDesde}
                onChangeHasta={setHasta}
                style={styles.rango}
              />
              <View style={styles.filtros}>
                <TouchableOpacity
                  style={[styles.chip, soloPendientes && styles.chipActivo]}
                  onPress={() => setSoloPendientes((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: soloPendientes }}
                >
                  <MaterialIcons
                    name={soloPendientes ? 'check-box' : 'check-box-outline-blank'}
                    size={15}
                    color={soloPendientes ? '#0369a1' : '#64748b'}
                  />
                  <Text style={[styles.chipText, soloPendientes && styles.chipTextActivo]}>Solo sin conciliar</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.busqueda}>
                <MaterialIcons name="search" size={18} color="#94a3b8" />
                <TextInput
                  style={styles.busquedaInput}
                  value={busqueda}
                  onChangeText={setBusqueda}
                  placeholder="Buscar por concepto, contraparte, referencia…"
                  placeholderTextColor="#94a3b8"
                />
              </View>
              {cargando ? (
                <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 24 }} />
              ) : error ? (
                <Text style={styles.aviso}>{error}</Text>
              ) : visibles.length === 0 ? (
                <Text style={styles.aviso}>
                  {hayMas
                    ? 'Hay más movimientos de los que caben: acota el rango de fechas para verlos.'
                    : `No hay ${etiqueta}s de esta empresa en el rango de fechas.`}
                </Text>
              ) : (
                <ScrollView style={styles.lista}>
                  {hayMas ? (
                    <Text style={styles.hayMas}>
                      Hay más movimientos de los que caben: acota el rango de fechas para verlos todos.
                    </Text>
                  ) : null}
                  {visibles.map((m) => {
                    const activo = elegido === m.movementHash;
                    const cuadra = Math.abs(Math.abs(aCentimos(importeMovimiento(m))) - saldoCentimos) <= TOLERANCIA_CENTIMOS;
                    const libre = libreCentimos(m) / 100;
                    return (
                      <TouchableOpacity
                        key={m.movementHash}
                        style={[styles.fila, activo && styles.filaActiva]}
                        onPress={() => setElegido(m.movementHash)}
                      >
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.filaConcepto} numberOfLines={1}>
                            {conceptoCortoMovimiento(m) || 'Sin concepto'}
                            {cuadra ? ' · Cuadra' : ''}
                          </Text>
                          <Text style={styles.filaMeta}>
                            {formatFecha(m.fechaOperacion || '')} · libre {formatMoneda(libre)}
                          </Text>
                        </View>
                        <Text style={styles.filaImporte}>{formatMoneda(importeMovimiento(m))}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </>
          )}

          <View style={styles.footer}>
            <TouchableOpacity style={styles.btnSec} onPress={onClose}>
              <Text style={styles.btnSecText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btnPri, !elegido && styles.btnOff]}
              disabled={!elegido}
              onPress={confirmar}
            >
              <Text style={styles.btnPriText}>Repartir importe</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '80%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eef1f5',
    padding: 16,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 12 },
  titulo: { fontSize: 16, fontWeight: '700', color: '#334155' },
  subtitulo: { fontSize: 12, color: '#64748b', marginTop: 2, lineHeight: 16 },
  cerrar: { padding: 4 },
  rango: { marginBottom: 8 },
  filtros: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  chipActivo: { borderColor: '#7dd3fc', backgroundColor: '#f0f9ff' },
  chipText: { fontSize: 12, color: '#64748b' },
  chipTextActivo: { color: '#0369a1', fontWeight: '600' },
  busqueda: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#eef1f5',
    borderRadius: 8,
    paddingHorizontal: 8,
    height: 36,
    marginBottom: 8,
  },
  busquedaInput: { flex: 1, fontSize: 13, color: '#334155', paddingVertical: 0 },
  lista: { maxHeight: 320 },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eef1f5',
  },
  filaActiva: { backgroundColor: '#e0f2fe', borderRadius: 8 },
  filaConcepto: { fontSize: 13, color: '#334155', fontWeight: '600' },
  filaMeta: { fontSize: 11, color: '#64748b', marginTop: 2 },
  filaImporte: { fontSize: 13, fontWeight: '700', color: '#334155' },
  aviso: { fontSize: 13, color: '#b45309', marginVertical: 12, lineHeight: 18 },
  hayMas: { fontSize: 11, color: '#d97706', fontWeight: '600', marginBottom: 6 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  btnSec: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#eef1f5',
    backgroundColor: '#ffffff',
  },
  btnSecText: { fontSize: 13, color: '#64748b', fontWeight: '600' },
  btnPri: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#0ea5e9' },
  btnPriText: { fontSize: 13, color: '#ffffff', fontWeight: '700' },
  btnOff: { opacity: 0.45 },
});
