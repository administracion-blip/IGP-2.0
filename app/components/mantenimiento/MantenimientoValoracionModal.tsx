import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { formatearDuracionTrabajo, segundosAHorasInput } from '../../lib/mantenimientoIncidenciaUi';
import { IMPORTE_HORA_DEFECTO, PRECIO_KM_DEFECTO } from '../../hooks/useTarifasMantenimiento';

export type TipoLineaValoracion = 'material' | 'mano_obra' | 'desplazamiento';

export type LineaValoracionInput = {
  articulo: string;
  cantidad: number;
  precio: number;
  tipo_iva: number;
  tipo: TipoLineaValoracion;
};

type Props = {
  visible: boolean;
  titulo?: string;
  guardando?: boolean;
  error?: string | null;
  /** Segundos cronometrados en la reparación: precargan las horas de mano de obra. */
  trabajoSegundos?: number;
  /** €/hora de mano de obra (ajustes de mantenimiento); `null` mientras se cargan. */
  precioHora?: number | null;
  /** €/km de desplazamiento (ajustes de mantenimiento); `null` mientras se cargan. */
  precioKm?: number | null;
  /**
   * Km de ida desde la sede central hasta el local (ficha del local). Cadena
   * vacía si el local no los tiene informados; `null` si aún no se sabe.
   */
  kmDesplazamiento?: string | null;
  onClose: () => void;
  onGuardar: (lineas: LineaValoracionInput[]) => void | Promise<void>;
};

type LineaState = {
  key: string;
  articulo: string;
  cantidad: string;
  precio: string;
  tipo_iva: string;
};

/** Línea única y no borrable (mano de obra, desplazamiento). */
type LineaFijaState = {
  cantidad: string;
  precio: string;
  tipo_iva: string;
};

const IVA_DEFECTO = '21';

const ARTICULO_MANO_OBRA = 'Mano de obra';
const ARTICULO_DESPLAZAMIENTO = 'Desplazamiento';

function nuevoKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function lineaVacia(): LineaState {
  return { key: nuevoKey(), articulo: '', cantidad: '1', precio: '', tipo_iva: IVA_DEFECTO };
}

function numAInput(n: number): string {
  return String(n).replace('.', ',');
}

/** Precio de una línea fija; en blanco mientras la tarifa no se conoce. */
function precioAInput(precio: number | null): string {
  return precio == null ? '' : numAInput(precio);
}

/** Km del local en el formato del formulario (coma decimal); '' si no se saben. */
function kmAInput(km: string | null): string {
  return (km ?? '').trim().replace('.', ',');
}

function lineaFijaVacia(precioDefecto: number | null): LineaFijaState {
  return { cantidad: '', precio: precioAInput(precioDefecto), tipo_iva: IVA_DEFECTO };
}

function toNum(v: string): number {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Mismo redondeo que `round2` del backend, para que los totales no difieran en céntimos. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** El backend descarta el IVA negativo y aplica 21: aquí igual. */
function ivaLinea(v: string): number {
  if (v === '') return 21;
  const n = toNum(v);
  return n >= 0 ? n : 21;
}

/** El IVA nunca es negativo: se impide teclear el signo. */
function sanitizarIva(v: string): string {
  return v.replace(/-/g, '');
}

/** Base, IVA y total de una línea con el redondeo por línea del backend. */
function importesLinea(cantidad: number, precio: number, tipoIva: number) {
  if (cantidad <= 0) return { base: 0, iva: 0, total: 0 };
  const base = round2(cantidad * precio);
  const iva = round2((base * tipoIva) / 100);
  return { base, iva, total: round2(base + iva) };
}

/** Convierte una línea fija en línea a enviar; `null` si está vacía (bloque opcional). */
function lineaFijaAInput(
  estado: LineaFijaState,
  articulo: string,
  tipo: TipoLineaValoracion,
): LineaValoracionInput | null {
  const cantidad = toNum(estado.cantidad);
  if (cantidad <= 0) return null;
  return { articulo, cantidad, precio: toNum(estado.precio), tipo_iva: ivaLinea(estado.tipo_iva), tipo };
}

/**
 * Si el bloque fijo tiene cantidad pero el precio no es válido, es un error de
 * captura: mejor avisar que guardar (o descartar) una línea a 0 €.
 */
function errorLineaFija(
  estado: LineaFijaState,
  bloque: string,
  campoPrecio: string,
  campoCantidad: string,
): string | null {
  if (toNum(estado.cantidad) <= 0) return null;
  if (toNum(estado.precio) > 0) return null;
  return `Indica el ${campoPrecio} en el bloque «${bloque}» (mayor que 0) o deja ${campoCantidad} en blanco`;
}

/**
 * Mismo criterio que `errorLineaFija` para las líneas de material: una línea a
 * medias se avisa en vez de descartarse en silencio, porque al teclear el
 * concepto a mano es fácil dejarse uno de los dos datos y perder el importe.
 * Se ignora sin ruido la línea intacta (sin concepto y sin precio), que es la
 * que el formulario ofrece de partida.
 */
function errorLineaMaterial(linea: LineaState, numero: number): string | null {
  const articulo = linea.articulo.trim();
  const cantidad = toNum(linea.cantidad);
  const precio = toNum(linea.precio);
  if (!articulo && precio <= 0) return null;
  if (!articulo) return `Indica el concepto de la línea #${numero} o deja su precio en blanco`;
  if (cantidad <= 0) return `Indica la cantidad de la línea #${numero} (mayor que 0)`;
  if (precio <= 0) return `Indica el precio de la línea #${numero} (mayor que 0) o borra la línea`;
  return null;
}

function fmt(n: number): string {
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function MantenimientoValoracionModal({
  visible,
  titulo,
  guardando,
  error,
  trabajoSegundos = 0,
  precioHora = IMPORTE_HORA_DEFECTO,
  precioKm = PRECIO_KM_DEFECTO,
  kmDesplazamiento = '',
  onClose,
  onGuardar,
}: Props) {
  const { isCompact, shouldStackPanels } = useBreakpoint();
  // Formulario largo: en móvil/tablet vertical se muestra a pantalla completa.
  const pantallaCompleta = shouldStackPanels;
  const [lineas, setLineas] = useState<LineaState[]>([lineaVacia()]);
  const [manoObra, setManoObra] = useState<LineaFijaState>(() => lineaFijaVacia(precioHora));
  const [desplazamiento, setDesplazamiento] = useState<LineaFijaState>(() => lineaFijaVacia(precioKm));
  const [errorLocal, setErrorLocal] = useState<string | null>(null);
  // Campos precargados que el usuario ya ha editado: dejan de seguir al origen.
  const tocadoRef = useRef({ precioHora: false, precioKm: false, km: false });

  // El formulario solo se reinicia al abrirse: un cambio de props con el modal
  // ya abierto no puede borrar las líneas que el usuario esté tecleando.
  const visibleAnteriorRef = useRef(false);
  useEffect(() => {
    const acabaDeAbrirse = visible && !visibleAnteriorRef.current;
    visibleAnteriorRef.current = visible;
    if (acabaDeAbrirse) {
      tocadoRef.current = { precioHora: false, precioKm: false, km: false };
      setLineas([lineaVacia()]);
      setManoObra({
        ...lineaFijaVacia(precioHora),
        cantidad: segundosAHorasInput(trabajoSegundos),
      });
      setDesplazamiento({
        ...lineaFijaVacia(precioKm),
        // Sin km en la ficha del local se deja en blanco: no se inventa distancia.
        cantidad: kmAInput(kmDesplazamiento),
      });
      setErrorLocal(null);
    }
  }, [visible, trabajoSegundos, precioHora, precioKm, kmDesplazamiento]);

  // Las tarifas y los km del local pueden llegar después de abrirse el modal:
  // mientras el usuario no haya tocado el campo, manda el valor configurado. Sin
  // esto una carga lenta acabaría facturando a la tarifa por defecto.
  useEffect(() => {
    if (tocadoRef.current.precioHora) return;
    setManoObra((prev) => ({ ...prev, precio: precioAInput(precioHora) }));
  }, [precioHora]);

  useEffect(() => {
    if (tocadoRef.current.precioKm) return;
    setDesplazamiento((prev) => ({ ...prev, precio: precioAInput(precioKm) }));
  }, [precioKm]);

  useEffect(() => {
    if (tocadoRef.current.km || kmDesplazamiento == null) return;
    setDesplazamiento((prev) => ({ ...prev, cantidad: kmAInput(kmDesplazamiento) }));
  }, [kmDesplazamiento]);

  /** Líneas que se enviarán al backend: materiales, luego mano de obra, luego desplazamiento. */
  const lineasValidas = useMemo<LineaValoracionInput[]>(() => {
    const out: LineaValoracionInput[] = [];
    for (const l of lineas) {
      const articulo = l.articulo.trim();
      const cantidad = toNum(l.cantidad);
      const precio = toNum(l.precio);
      if (!articulo || cantidad <= 0 || precio < 0) continue;
      out.push({
        articulo,
        cantidad,
        precio,
        tipo_iva: ivaLinea(l.tipo_iva),
        tipo: 'material',
      });
    }
    const lineaManoObra = lineaFijaAInput(manoObra, ARTICULO_MANO_OBRA, 'mano_obra');
    if (lineaManoObra) out.push(lineaManoObra);
    const lineaDesplazamiento = lineaFijaAInput(desplazamiento, ARTICULO_DESPLAZAMIENTO, 'desplazamiento');
    if (lineaDesplazamiento) out.push(lineaDesplazamiento);
    return out;
  }, [lineas, manoObra, desplazamiento]);

  const totales = useMemo(() => {
    let base = 0;
    let iva = 0;
    for (const l of lineasValidas) {
      const importes = importesLinea(l.cantidad, l.precio, l.tipo_iva);
      base += importes.base;
      iva += importes.iva;
    }
    const baseTotal = round2(base);
    const ivaTotal = round2(iva);
    return { base: baseTotal, iva: ivaTotal, total: round2(baseTotal + ivaTotal) };
  }, [lineasValidas]);

  const updateLinea = useCallback((key: string, patch: Partial<LineaState>) => {
    setLineas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }, []);

  const addLinea = useCallback(() => setLineas((prev) => [...prev, lineaVacia()]), []);
  const removeLinea = useCallback(
    (key: string) => setLineas((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.key !== key))),
    [],
  );

  const handleGuardar = useCallback(() => {
    const errorMaterial = lineas
      .map((l, idx) => errorLineaMaterial(l, idx + 1))
      .find((e): e is string => e !== null);
    if (errorMaterial) {
      setErrorLocal(errorMaterial);
      return;
    }
    const errorFija =
      errorLineaFija(manoObra, ARTICULO_MANO_OBRA, 'precio por hora', 'las horas') ??
      errorLineaFija(desplazamiento, ARTICULO_DESPLAZAMIENTO, 'precio por kilómetro', 'los kilómetros');
    if (errorFija) {
      setErrorLocal(errorFija);
      return;
    }
    if (lineasValidas.length === 0) {
      setErrorLocal('Añade al menos una línea con concepto, cantidad y precio');
      return;
    }
    setErrorLocal(null);
    void onGuardar(lineasValidas);
  }, [lineas, lineasValidas, manoObra, desplazamiento, onGuardar]);

  if (!visible) return null;

  const errorMostrar = errorLocal ?? error ?? null;

  const renderLineaFija = (cfg: {
    descripcion: string;
    icono: React.ComponentProps<typeof MaterialIcons>['name'];
    labelCantidad: string;
    labelPrecio: string;
    estado: LineaFijaState;
    nota?: string;
    /** Nota secundaria (explicación), en gris y con icono informativo. */
    notaSuave?: boolean;
    onChange: (patch: Partial<LineaFijaState>) => void;
  }) => {
    const cant = toNum(cfg.estado.cantidad);
    const precio = toNum(cfg.estado.precio);
    const tipo = ivaLinea(cfg.estado.tipo_iva);
    const totalLinea = importesLinea(cant, precio, tipo).total;
    return (
      <View style={styles.lineaCard}>
        <View style={styles.lineaTopRow}>
          <MaterialIcons name={cfg.icono} size={18} color="#94a3b8" />
          <Text style={styles.lineaFijaTitulo}>{cfg.descripcion}</Text>
        </View>
        <View style={styles.lineaFieldsRow}>
          <View style={styles.campo}>
            <Text style={styles.campoLabel}>{cfg.labelCantidad}</Text>
            <TextInput
              style={[styles.input, isCompact && styles.inputCompact]}
              value={cfg.estado.cantidad}
              onChangeText={(v) => cfg.onChange({ cantidad: v })}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor="#cbd5e1"
            />
          </View>
          <View style={styles.campo}>
            <Text style={styles.campoLabel}>{cfg.labelPrecio}</Text>
            <TextInput
              style={[styles.input, isCompact && styles.inputCompact]}
              value={cfg.estado.precio}
              onChangeText={(v) => cfg.onChange({ precio: v })}
              keyboardType="decimal-pad"
              placeholder="0,00"
              placeholderTextColor="#cbd5e1"
            />
          </View>
          <View style={styles.campoSm}>
            <Text style={styles.campoLabel}>IVA %</Text>
            <TextInput
              style={[styles.input, isCompact && styles.inputCompact]}
              value={cfg.estado.tipo_iva}
              onChangeText={(v) => cfg.onChange({ tipo_iva: sanitizarIva(v) })}
              keyboardType="decimal-pad"
              placeholder="21"
              placeholderTextColor="#cbd5e1"
            />
          </View>
          <View style={styles.campoTotal}>
            <Text style={styles.campoLabel}>Total</Text>
            <Text style={styles.totalLineaText}>{fmt(totalLinea)} €</Text>
          </View>
        </View>
        {cfg.nota ? (
          <View style={[styles.notaRow, cfg.notaSuave && styles.notaRowSuave]}>
            <MaterialIcons
              name={cfg.notaSuave ? 'info-outline' : 'timer'}
              size={13}
              color={cfg.notaSuave ? '#94a3b8' : '#0f766e'}
            />
            <Text style={[styles.notaText, cfg.notaSuave && styles.notaTextSuave]}>{cfg.nota}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, pantallaCompleta && styles.overlayFullScreen]}>
        <View
          style={[
            styles.card,
            isCompact && styles.cardCompact,
            pantallaCompleta && styles.cardFullScreen,
          ]}
        >
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>Valoración de la reparación</Text>
              {titulo ? (
                <Text style={styles.title} numberOfLines={2}>
                  {titulo}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.closeBtn, isCompact && styles.btnIconCompact]}
              accessibilityLabel="Cerrar"
            >
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={[styles.scroll, pantallaCompleta && styles.scrollFullScreen]}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.sectionLabel}>Conceptos / materiales</Text>

            {lineas.map((l, idx) => {
              const cant = toNum(l.cantidad);
              const precio = toNum(l.precio);
              const tipo = ivaLinea(l.tipo_iva);
              const totalLinea = importesLinea(cant, precio, tipo).total;
              return (
                <View key={l.key} style={styles.lineaCard}>
                  <View style={styles.lineaTopRow}>
                    <Text style={styles.lineaNum}>#{idx + 1}</Text>
                    <View style={styles.lineaConceptoWrap}>
                      <Text style={styles.campoLabel}>Concepto</Text>
                      <TextInput
                        style={[styles.input, isCompact && styles.inputCompact]}
                        value={l.articulo}
                        onChangeText={(v) => updateLinea(l.key, { articulo: v })}
                        placeholder="Descripción del material o concepto"
                        placeholderTextColor="#cbd5e1"
                      />
                    </View>
                    {lineas.length > 1 ? (
                      <TouchableOpacity
                        onPress={() => removeLinea(l.key)}
                        style={[styles.delBtn, isCompact && styles.btnIconCompact]}
                        accessibilityLabel="Eliminar línea"
                      >
                        <MaterialIcons name="delete-outline" size={18} color="#94a3b8" />
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  <View style={styles.lineaFieldsRow}>
                    <View style={styles.campo}>
                      <Text style={styles.campoLabel}>Cantidad</Text>
                      <TextInput
                        style={[styles.input, isCompact && styles.inputCompact]}
                        value={l.cantidad}
                        onChangeText={(v) => updateLinea(l.key, { cantidad: v })}
                        keyboardType="decimal-pad"
                        placeholder="0"
                        placeholderTextColor="#cbd5e1"
                      />
                    </View>
                    <View style={styles.campo}>
                      <Text style={styles.campoLabel}>Precio (sin IVA)</Text>
                      <TextInput
                        style={[styles.input, isCompact && styles.inputCompact]}
                        value={l.precio}
                        onChangeText={(v) => updateLinea(l.key, { precio: v })}
                        keyboardType="decimal-pad"
                        placeholder="0,00"
                        placeholderTextColor="#cbd5e1"
                      />
                    </View>
                    <View style={styles.campoSm}>
                      <Text style={styles.campoLabel}>IVA %</Text>
                      <TextInput
                        style={[styles.input, isCompact && styles.inputCompact]}
                        value={l.tipo_iva}
                        onChangeText={(v) => updateLinea(l.key, { tipo_iva: sanitizarIva(v) })}
                        keyboardType="decimal-pad"
                        placeholder="21"
                        placeholderTextColor="#cbd5e1"
                      />
                    </View>
                    <View style={styles.campoTotal}>
                      <Text style={styles.campoLabel}>Total</Text>
                      <Text style={styles.totalLineaText}>{fmt(totalLinea)} €</Text>
                    </View>
                  </View>
                </View>
              );
            })}

            <TouchableOpacity
              style={[styles.addLineBtn, isCompact && styles.addLineBtnCompact]}
              onPress={addLinea}
            >
              <MaterialIcons name="add" size={18} color="#0ea5e9" />
              <Text style={styles.addLineTxt}>Añadir línea</Text>
            </TouchableOpacity>

            <Text style={[styles.sectionLabel, styles.sectionLabelSpaced]}>Mano de obra</Text>
            {renderLineaFija({
              descripcion: ARTICULO_MANO_OBRA,
              icono: 'handyman',
              labelCantidad: 'Horas',
              labelPrecio: '€/hora (sin IVA)',
              estado: manoObra,
              nota:
                trabajoSegundos > 0
                  ? `Cronometrado: ${formatearDuracionTrabajo(trabajoSegundos)}`
                  : undefined,
              onChange: (patch) => {
                if (patch.precio !== undefined) tocadoRef.current.precioHora = true;
                setManoObra((prev) => ({ ...prev, ...patch }));
              },
            })}

            <Text style={[styles.sectionLabel, styles.sectionLabelSpaced]}>Desplazamiento</Text>
            {renderLineaFija({
              descripcion: ARTICULO_DESPLAZAMIENTO,
              icono: 'directions-car',
              labelCantidad: 'Km',
              labelPrecio: '€/km (sin IVA)',
              estado: desplazamiento,
              nota:
                'Indica los kilómetros del trayecto completo. Si ese día hay más partes en este local, el viaje se reparte entre todos y a este se le imputará menos.',
              notaSuave: true,
              onChange: (patch) => {
                if (patch.precio !== undefined) tocadoRef.current.precioKm = true;
                if (patch.cantidad !== undefined) tocadoRef.current.km = true;
                setDesplazamiento((prev) => ({ ...prev, ...patch }));
              },
            })}

            <View style={styles.totalesBox}>
              <View style={styles.totalRow}>
                <Text style={styles.totalRowLabel}>Total sin IVA</Text>
                <Text style={styles.totalRowValue}>{fmt(totales.base)} €</Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={styles.totalRowLabel}>IVA</Text>
                <Text style={styles.totalRowValue}>{fmt(totales.iva)} €</Text>
              </View>
              <View style={[styles.totalRow, styles.totalRowFinal]}>
                <Text style={styles.totalRowLabelFinal}>Total (IVA incl.)</Text>
                <Text style={styles.totalRowValueFinal}>{fmt(totales.total)} €</Text>
              </View>
              {toNum(desplazamiento.cantidad) > 0 ? (
                <Text style={styles.totalNota}>
                  Antes de repartir el desplazamiento: el importe final de este parte puede ser menor.
                </Text>
              ) : null}
            </View>

            {errorMostrar ? (
              <View style={styles.errorBox}>
                <MaterialIcons name="error-outline" size={16} color="#dc2626" />
                <Text style={styles.errorText}>{errorMostrar}</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={guardando}>
              <Text style={styles.cancelBtnText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.guardarBtn} onPress={handleGuardar} disabled={guardando}>
              {guardando ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <MaterialIcons name="check" size={18} color="#fff" />
                  <Text style={styles.guardarBtnText}>Guardar valoración</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  overlayFullScreen: { padding: 0 },
  card: {
    width: '100%',
    maxWidth: 640,
    maxHeight: '90%',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  cardCompact: { maxWidth: '100%', maxHeight: '94%' },
  cardFullScreen: { maxWidth: '100%', height: '100%', maxHeight: '100%', borderRadius: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerText: { flex: 1, minWidth: 0, gap: 4 },
  eyebrow: { fontSize: 11, fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 },
  title: { fontSize: 16, fontWeight: '700', color: '#334155', flex: 1 },
  closeBtn: { padding: 4, alignItems: 'center', justifyContent: 'center' },
  // Debe poder encogerse dentro de `card` (maxHeight + overflow hidden) o el pie
  // con Cancelar/Guardar quedaría fuera de la tarjeta.
  scroll: { flexGrow: 0, flexShrink: 1 },
  // A pantalla completa el scroll ocupa el hueco libre para que el pie quede abajo.
  scrollFullScreen: { flexGrow: 1 },
  scrollContent: { padding: 16, gap: 10 },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: '#64748b' },
  sectionLabelSpaced: { marginTop: 6 },
  lineaCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
    gap: 10,
    backgroundColor: '#f8fafc',
  },
  lineaTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lineaNum: { fontSize: 12, fontWeight: '700', color: '#94a3b8', width: 24 },
  lineaFijaTitulo: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600', color: '#334155' },
  lineaConceptoWrap: { flex: 1, minWidth: 0, gap: 3 },
  delBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnIconCompact: { width: MIN_TOUCH, height: MIN_TOUCH },
  lineaFieldsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' },
  campo: { flex: 1, minWidth: 88, gap: 3 },
  campoSm: { width: 64, gap: 3 },
  campoTotal: { minWidth: 90, gap: 3, alignItems: 'flex-end' },
  campoLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 },
  input: {
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#1e293b',
    backgroundColor: '#fff',
    ...(Platform.OS === 'web' && ({ outlineStyle: 'none' } as object)),
  },
  inputCompact: { minHeight: MIN_TOUCH },
  notaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: -4 },
  notaRowSuave: { alignItems: 'flex-start' },
  notaText: { fontSize: 11, fontWeight: '600', color: '#0f766e' },
  notaTextSuave: { flex: 1, minWidth: 0, fontWeight: '500', color: '#64748b' },
  totalLineaText: { fontSize: 14, fontWeight: '700', color: '#0f766e', paddingVertical: 8 },
  addLineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 10,
    borderStyle: 'dashed',
  },
  addLineBtnCompact: { minHeight: MIN_TOUCH },
  addLineTxt: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  totalesBox: {
    marginTop: 4,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    gap: 6,
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalRowLabel: { fontSize: 13, color: '#64748b' },
  totalRowValue: { fontSize: 13, fontWeight: '600', color: '#334155' },
  totalRowFinal: { borderTopWidth: 1, borderTopColor: '#cbd5e1', paddingTop: 6, marginTop: 2 },
  totalNota: { fontSize: 11, color: '#64748b' },
  totalRowLabelFinal: { fontSize: 14, fontWeight: '700', color: '#334155' },
  totalRowValueFinal: { fontSize: 16, fontWeight: '800', color: '#0f766e' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    padding: 10,
  },
  errorText: { flex: 1, fontSize: 12, color: '#dc2626' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  cancelBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
  },
  cancelBtnText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  guardarBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#16a34a',
  },
  guardarBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
