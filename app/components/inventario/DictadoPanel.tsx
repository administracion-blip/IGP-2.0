/**
 * Panel del dictado por voz del conteo: pantallas «Dictando», «En pausa» y «Resumen».
 * Modal a pantalla completa en móvil/tablet vertical; ventana ancha en tablet horizontal y escritorio.
 * Solo muestra lo contado: nunca stock teórico.
 */
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  Modal,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import {
  useDictado,
  type CambiosLinea,
  type LineaDictado,
  type ModoLinea,
  type RechazoDictado,
} from '../../hooks/useDictado';
import { MAX_TROZO_MS } from '../../lib/dictado/grabadora';
import { guardarModoVoz, leerModoVoz, type ModoVoz } from '../../lib/dictado/voz';
import { descargarExcelConteo } from '../../lib/inventarioExcel';
import { apiFetch } from '../../utils/api';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { BotonPeligro } from '../ui/BotonPeligro';
import {
  colors,
  statusColors,
  fontFamily,
  fontSizes,
  inputCursorProps,
  inputCursorStyle,
  radius,
  MIN_TOUCH,
  SPACING,
} from '../../constants/theme';

type Props = {
  inventarioId: string;
  onCerrar: () => void;
  /** Tras aplicar o deshacer líneas: la pantalla recarga el conteo. */
  onAplicado: () => void;
  /** Quien tiene inventario.gestionar y el conteo ya está contado. */
  puedeDescargar?: boolean;
};

const MOTIVOS: Record<string, string> = {
  ambiguo: 'Hay varios productos parecidos',
  marca_ambigua: 'Hay varios de esa marca; elige cuál',
  propuesto_ia: 'Sugerencia, confirma antes de aplicar',
  aproximado: 'Nombre parecido, comprueba',
  ya_contado: 'Ya estaba contado',
  redondeo: 'Se redondea la botella abierta',
  falta_formato: 'Falta saber cuántas unidades trae la caja',
  variante_no_dicha: 'No se ha dicho la variante (tamaño, sabor…)',
  semilla_no_anclada: 'Nombre poco claro, comprueba el producto',
  generico: 'Nombre demasiado general',
  repetido_en_dictado: 'Ese producto ya sale en otra línea del dictado',
  sumado: 'Sumado a lo que ya habías dictado',
  sin_coincidencia: 'No se encuentra el producto',
  no_en_plantilla: 'No está en la plantilla',
  sin_producto: 'Falta el producto',
  fraccion_redondeada: 'La fracción se ha llevado a la botella más cercana',
  numero_ambiguo: 'Número dudoso, comprueba la cantidad',
  nombre_ambiguo: 'No está claro si el número es parte del nombre',
  revisar_texto: 'Revisa lo que se ha entendido',
  autocorreccion: 'Corregido al dictar',
  total_negativo: 'El total quedaría negativo',
  sin_cantidad: 'Falta la cantidad',
  cantidad_fuera_de_rango: 'Cantidad fuera de rango',
  requiere_confirmacion: 'Falta confirmar',
  sin_modo: 'Falta indicar si suma o reemplaza',
  descartada: 'La línea está descartada',
  deshecha: 'La línea está deshecha',
  estado_no_valido: 'La línea no se puede aplicar en su estado',
  no_en_conteo: 'El producto no está en el conteo',
  producto_no_encontrado: 'Producto no encontrado',
  producto_no_anadible: 'No se puede añadir este producto al conteo',
  agora_no_disponible: 'Ágora no responde; vuelve a intentarlo',
  estado_inventario: 'El conteo ya no admite cambios',
  conflicto: 'Ha cambiado a la vez; vuelve a intentarlo',
  no_valida: 'La línea no es válida',
  no_encontrada: 'Línea no encontrada',
  error_interno: 'Error al aplicar; vuelve a intentarlo',
};

const MODOS: Record<ModoLinea, string> = { sumar: 'Suma', reemplazar: 'Reemplaza', borrar: 'Borra' };

function textoMotivo(motivo: string, linea: LineaDictado): string {
  if (motivo === 'calculo') {
    const expr = linea.orden?.calculo?.expresion;
    return expr ? `Calculado: ${expr}` : 'Cantidad calculada';
  }
  return MOTIVOS[motivo] ?? 'Revisa esta línea';
}

function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  const s = String(Math.abs(r)).replace('.', ',');
  return r < 0 ? `−${s}` : s;
}

function totalDe(c: { stockReal: number | null; botellasAbiertas: number } | null | undefined): number | null {
  if (!c || c.stockReal == null) return null;
  return Math.round((c.stockReal + (c.botellasAbiertas || 0)) * 10000) / 10000;
}

function parseNumero(raw: string, { negativo = false } = {}): number | null {
  const s = raw.trim().replace(',', '.').replace('−', '-');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (!negativo && n < 0) return null;
  return n;
}

function textoCantidad(l: LineaDictado): string {
  if (l.modo === 'borrar') return 'Sin contar';
  if (!l.cantidad) return 'Sin cantidad';
  return num(l.cantidad.total);
}

function textoPrevisto(l: LineaDictado): string | null {
  if (l.estado === 'aplicada' && l.aplicado) {
    const t = totalDe(l.aplicado);
    return `Queda ${t == null ? 'sin contar' : num(t)}`;
  }
  if (l.estado === 'descartada' || l.estado === 'deshecha' || !l.previsto) return null;
  const queda = l.previsto.total == null ? 'sin contar' : num(l.previsto.total);
  if (l.conteoActual) {
    const actual = totalDe(l.conteoActual);
    return `${actual == null ? 'Sin contar' : `Contado ${num(actual)}`} → queda ${queda}`;
  }
  return `Queda ${queda}`;
}

/** Motivos informativos: no son avisos ni piden confirmar. */
const MOTIVOS_INFO = new Set(['sumado']);

function textoTotal(c: { stockReal: number | null; botellasAbiertas: number } | null | undefined): string {
  const t = totalDe(c);
  return t == null ? 'sin contar' : num(t);
}

/** «antes 3 → ahora 5» de una línea 'sumado' (tras recargar, con anterior/aplicado). */
function textoSumado(l: LineaDictado): string | null {
  if (l.sumado) return `antes ${textoTotal(l.sumado.antes)} → ahora ${textoTotal(l.sumado.ahora)}`;
  if (l.anterior && l.aplicado) return `antes ${textoTotal(l.anterior)} → ahora ${textoTotal(l.aplicado)}`;
  return null;
}

/**
 * Chip «Sumado» solo si la línea se aplicó sola: sin rechazo, sin editar, sin pasar por confirmar
 * y, si llegó `sumado`, con el mismo total que se guardó.
 */
function sumadoAutomatico(l: LineaDictado, rechazo: RechazoDictado | undefined, editada: boolean, aMano: boolean): boolean {
  if (l.estado !== 'aplicada' || !l.motivos.includes('sumado')) return false;
  if (rechazo || editada || aMano || l.confirmar) return false;
  if (l.sumado && l.aplicado && totalDe(l.sumado.ahora) !== totalDe(l.aplicado)) return false;
  return true;
}

/** Suma cuyo «actual → queda» calculado al interpretar puede estar desfasado. */
function sumaDesfasada(l: LineaDictado, rechazo: RechazoDictado | undefined): boolean {
  return l.modo === 'sumar' && (l.motivos.includes('ya_contado') || Boolean(rechazo));
}

function yaContadoLinea(l: LineaDictado, rechazo?: RechazoDictado): boolean {
  return Boolean(l.conteoActual?.contado)
    || l.motivos.includes('ya_contado')
    || l.motivos.includes('repetido_en_dictado')
    || rechazo?.motivo === 'ya_contado';
}

/** Se puede confirmar sin tocar nada: con producto, modo y cantidad (salvo borrar). Sin producto, no. */
function confirmable(l: LineaDictado): boolean {
  if (!l.productId) return false;
  return l.modo != null && (l.modo === 'borrar' || l.cantidad != null);
}

/** «¿Es otro producto?» solo si el candidato se parece a lo dicho. */
function candidatoParecido(texto: string, c: { nombre: string; puntuacion?: number }): boolean {
  const norm = (s: string) => s
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const dichos = norm(texto).split(' ').filter((t) => t.length >= 3 || /^\d+$/.test(t));
  const nombre = norm(c.nombre).split(' ').filter(Boolean);
  const coincide = dichos.some((t) => nombre.some((n) => n === t || (t.length >= 3 && (n.startsWith(t) || t.startsWith(n)))));
  return coincide || (c.puntuacion ?? 0) >= 0.6;
}

function evaluarExpresion(expr: string): number | null {
  const limpio = expr.replace(/\s+/g, '');
  if (!limpio || !/^[\d,.×+−-]+$/.test(limpio)) return null;
  let total = 0;
  for (const termino of limpio.split(/(?=[+−-])/)) {
    let signo = 1;
    let s = termino;
    if (s.startsWith('+')) s = s.slice(1);
    else if (s.startsWith('−') || s.startsWith('-')) {
      signo = -1;
      s = s.slice(1);
    }
    let producto = 1;
    for (const f of s.split('×')) {
      const n = Number(f.replace(',', '.'));
      if (!f || !Number.isFinite(n)) return null;
      producto *= n;
    }
    total += signo * producto;
  }
  return Math.round(total * 10000) / 10000;
}

/**
 * Total con el formato: sustituye el «?» de la expresión del cálculo («12×?+5») por las unidades.
 * null si no es seguro (no se sabe si es caja o pack, o es una resta): entonces se pide el total.
 */
function totalConFormato(l: LineaDictado, caja: number | null, pack: number | null): number | null {
  const expr = l.orden?.calculo?.expresion;
  if (!expr || !expr.includes('?')) return null;
  const texto = l.texto.toLocaleLowerCase('es');
  if (/\b(quita|quitar|resta|restar|menos)\b/.test(texto)) return null;
  const usaPack = /\bpacks?\b/.test(texto);
  const usaCaja = /\b(cajas?|bandejas?)\b/.test(texto);
  if (usaPack === usaCaja) return null;
  const m = usaPack ? pack : caja;
  if (!m || m <= 0) return null;
  const total = evaluarExpresion(expr.split('?').join(String(m)));
  return total != null && total >= 0 ? total : null;
}

function necesitaFormato(l: LineaDictado): boolean {
  return Boolean(l.faltaFormato || l.motivos.includes('falta_formato')) && l.cantidad == null && l.modo !== 'borrar';
}

function esEditable(l: LineaDictado): boolean {
  return l.estado === 'pendiente' || l.estado === 'confirmada';
}

/** Nombre del producto o, si no hay, el texto dictado entre comillas. */
function textoResumenLinea(l: LineaDictado): string {
  const nombre = l.productoNombre?.trim();
  if (nombre) return nombre;
  const texto = l.texto?.trim();
  return texto ? `«${texto}»` : 'Sin nombre';
}

function estaEditada(l: LineaDictado, editadas: Set<number>): boolean {
  if (editadas.has(l.n)) return true;
  const tipo = l.orden?.tipo;
  return (tipo === 'corregir' || tipo === 'reemplazar')
    && (l.motivos.includes('ya_contado') || Boolean(l.conteoActual?.contado));
}

function reloj(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function horaCorta(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ─── Tarjeta de línea ───

type PropsTarjeta = {
  linea: LineaDictado;
  rechazo: RechazoDictado | undefined;
  nueva: boolean;
  editada: boolean;
  /** Confirmada por el usuario o rechazada alguna vez en esta sesión del panel. */
  aMano: boolean;
  ocupada: boolean;
  apilar: boolean;
  catalogo: OpcionDesplegable[] | null;
  cargandoCatalogo: boolean;
  onPedirCatalogo: () => void;
  onConfirmar: (l: LineaDictado) => void;
  onBorrar: (l: LineaDictado) => void;
  onEditar: (l: LineaDictado, cambios: CambiosLinea) => void;
  onFormato: (
    l: LineaDictado,
    args: { unidadesCaja: number | null; unidadesPack: number | null; guardar: boolean; total: number },
  ) => void;
};

function TarjetaLinea({
  linea,
  rechazo,
  nueva,
  editada,
  aMano,
  ocupada,
  apilar,
  catalogo,
  cargandoCatalogo,
  onPedirCatalogo,
  onConfirmar,
  onBorrar,
  onEditar,
  onFormato,
}: PropsTarjeta) {
  const [cantidadTexto, setCantidadTexto] = useState(linea.cantidad ? num(linea.cantidad.total) : '');
  const [buscando, setBuscando] = useState(false);
  const [cajaTexto, setCajaTexto] = useState('');
  const [packTexto, setPackTexto] = useState('');
  const [totalManual, setTotalManual] = useState('');
  const [guardarFormato, setGuardarFormato] = useState(true);

  useEffect(() => {
    setCantidadTexto(linea.cantidad ? num(linea.cantidad.total) : '');
  }, [linea.cantidad]);

  const editable = esEditable(linea);
  const autoaplicable = linea.estado === 'pendiente' && !linea.confirmar && !rechazo;
  const previsto = textoPrevisto(linea);
  const motivos = (editable ? linea.motivos : linea.motivos.filter((m) => m === 'calculo'))
    .filter((m) => !MOTIVOS_INFO.has(m));
  const esSumado = sumadoAutomatico(linea, rechazo, editada, aMano);
  const sumadoTexto = esSumado ? textoSumado(linea) : null;
  const pideConfirmar = linea.estado === 'pendiente' && (linea.confirmar || Boolean(rechazo));
  const ayudaConfirmar = pideConfirmar
    ? (linea.modo === 'sumar' && yaContadoLinea(linea, rechazo) ? 'Toca Confirmar para sumar' : 'Toca Confirmar para aplicar')
    : null;
  const candidatos = (linea.candidatos ?? []).filter(
    (c) => c.productId !== linea.productId && candidatoParecido(linea.texto, c),
  );
  const faltaFormato = editable && necesitaFormato(linea);
  const caja = parseNumero(cajaTexto);
  const pack = parseNumero(packTexto);
  const calculado = faltaFormato ? totalConFormato(linea, caja, pack) : null;
  const manual = parseNumero(totalManual);
  const totalFormato = calculado ?? manual;
  const nombre = linea.productoNombre || linea.productId || 'Sin producto';
  const sumar = linea.modo === 'sumar';
  const cantidadNueva = parseNumero(cantidadTexto, { negativo: sumar });
  const puedeConfirmar = Boolean(linea.productId) && (linea.modo === 'borrar' || linea.cantidad != null) && !ocupada;

  let estadoTexto = 'Pendiente de confirmar';
  let estadoColor: { bg: string; text: string } = statusColors.warning;
  if (linea.estado === 'aplicada') {
    estadoTexto = 'Aplicada';
    estadoColor = statusColors.success;
  } else if (linea.estado === 'descartada') {
    estadoTexto = 'Descartada';
    estadoColor = statusColors.neutral;
  } else if (linea.estado === 'deshecha') {
    estadoTexto = 'Deshecha';
    estadoColor = statusColors.neutral;
  } else if (autoaplicable) {
    estadoTexto = ocupada ? 'Aplicando…' : 'Lista para aplicar';
    estadoColor = statusColors.info;
  }

  return (
    <View style={[styles.tarjeta, nueva && styles.tarjetaNueva, !editable && linea.estado !== 'aplicada' && styles.tarjetaApagada]}>
      <View style={styles.tarjetaCab}>
        <View style={styles.etiquetas}>
          {nueva ? (
            <View style={[styles.chip, { backgroundColor: colors.accent }]}>
              <Text style={[styles.chipTexto, { color: colors.surface }]}>Nuevo</Text>
            </View>
          ) : null}
          {editada ? (
            <View style={[styles.chip, { backgroundColor: statusColors.info.bg }]}>
              <Text style={[styles.chipTexto, { color: statusColors.info.text }]}>Editado</Text>
            </View>
          ) : null}
          {esSumado ? (
            <View style={[styles.chip, { backgroundColor: statusColors.success.bg }]}>
              <Text style={[styles.chipTexto, { color: statusColors.success.text }]}>Sumado</Text>
            </View>
          ) : null}
          <View style={[styles.chip, { backgroundColor: estadoColor.bg }]}>
            <Text style={[styles.chipTexto, { color: estadoColor.text }]}>{estadoTexto}</Text>
          </View>
          {linea.modo ? (
            <View style={[styles.chip, { backgroundColor: statusColors.neutral.bg }]}>
              <Text style={[styles.chipTexto, { color: colors.textPrimary }]}>{MODOS[linea.modo]}</Text>
            </View>
          ) : null}
        </View>
        {ocupada || linea.estado === 'aplicada' ? (
          <View style={styles.cabAcciones}>
            {ocupada ? <ActivityIndicator color={colors.accent} /> : null}
            {linea.estado === 'aplicada' ? (
              <BotonPeligro
                disabled={ocupada}
                accessibilityLabel="Borrar esta línea"
                onPress={() => onBorrar(linea)}
              />
            ) : null}
          </View>
        ) : null}
      </View>

      <Text style={styles.textoDictado}>{`«${linea.texto}»`}</Text>
      <View style={styles.productoFila}>
        {linea.productId ? (
          <View style={styles.badgeId}>
            <Text style={styles.badgeIdTexto}>{linea.productId}</Text>
          </View>
        ) : null}
        <Text style={[styles.producto, !linea.productId && styles.sinProducto]} numberOfLines={2}>
          {linea.productId ? nombre : 'Sin producto'}
        </Text>
        <Text style={styles.cantidad}>{textoCantidad(linea)}</Text>
      </View>
      {previsto ? <Text style={styles.previsto}>{previsto}</Text> : null}
      {esSumado ? (
        <Text style={styles.sumado}>
          {sumadoTexto ? `${MOTIVOS.sumado}: ${sumadoTexto}` : MOTIVOS.sumado}
        </Text>
      ) : null}
      {ayudaConfirmar && editable ? <Text style={styles.ayuda}>{ayudaConfirmar}</Text> : null}

      {motivos.length > 0 ? (
        <View style={styles.motivos}>
          {motivos.map((m) => (
            <View key={m} style={styles.motivo}>
              <Text style={styles.motivoTexto}>{textoMotivo(m, linea)}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {rechazo && editable ? (
        <Text style={styles.rechazo}>
          {`No se ha aplicado: ${MOTIVOS[rechazo.motivo] ?? 'revisa la línea'}${rechazo.mensaje ? ` (${rechazo.mensaje})` : ''}`}
        </Text>
      ) : null}

      {editable ? (
        <View style={styles.acciones}>
          {candidatos.length > 0 ? (
            <View>
              <Text style={styles.etiqueta}>¿Es otro producto?</Text>
              <View style={styles.opciones}>
                {candidatos.map((c) => (
                  <Pressable
                    key={c.productId}
                    style={styles.botella}
                    disabled={ocupada}
                    onPress={() => onEditar(linea, { productId: c.productId })}
                    accessibilityRole="button"
                    accessibilityLabel={`Elegir ${c.nombre}`}
                  >
                    <Text style={styles.botellaTexto} numberOfLines={1}>{c.nombre}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {buscando ? (
            <SelectorDesplegable
              label="Producto"
              placeholder="Elige un producto"
              icono="search"
              opciones={catalogo ?? []}
              valorId={linea.productId}
              onSeleccionar={(id) => {
                setBuscando(false);
                onEditar(linea, { productId: id });
              }}
              tituloLista="Producto"
              buscador
              buscadorPlaceholder="Buscar producto"
              minCharsBusqueda={2}
              limiteResultados={40}
              loading={cargandoCatalogo}
              vacioTexto="No hay productos"
            />
          ) : (
            <Pressable
              style={styles.botonAnadir}
              disabled={ocupada}
              onPress={() => {
                onPedirCatalogo();
                setBuscando(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Buscar el producto a mano"
            >
              <MaterialIcons name="search" size={20} color={colors.accent} />
              <Text style={styles.botonAnadirTexto}>{linea.productId ? 'Cambiar producto' : 'Elegir producto'}</Text>
            </Pressable>
          )}

          {faltaFormato ? (
            <View style={styles.formato}>
              {linea.productId ? (
                <>
                  <Text style={styles.formatoTitulo}>{`¿Cuántas unidades trae una caja de ${nombre}?`}</Text>
                  {linea.orden?.calculo?.expresion ? (
                    <Text style={styles.previsto}>{`Dictado: ${linea.orden.calculo.expresion}`}</Text>
                  ) : null}
                  <View style={[styles.fila, apilar && styles.filaApilada]}>
                    <TextInput
                      value={cajaTexto}
                      onChangeText={setCajaTexto}
                      keyboardType="number-pad"
                      placeholder="Unidades por caja"
                      placeholderTextColor={colors.textMuted}
                      style={[styles.input, styles.inputFlex]}
                      accessibilityLabel="Unidades por caja"
                      {...inputCursorProps}
                    />
                    <TextInput
                      value={packTexto}
                      onChangeText={setPackTexto}
                      keyboardType="number-pad"
                      placeholder="Unidades por pack (opcional)"
                      placeholderTextColor={colors.textMuted}
                      style={[styles.input, styles.inputFlex]}
                      accessibilityLabel="Unidades por pack"
                      {...inputCursorProps}
                    />
                  </View>
                  {calculado != null ? (
                    <Text style={styles.previsto}>{`Total: ${num(calculado)}`}</Text>
                  ) : (
                    <TextInput
                      value={totalManual}
                      onChangeText={setTotalManual}
                      keyboardType="decimal-pad"
                      placeholder="Cantidad total"
                      placeholderTextColor={colors.textMuted}
                      style={[styles.input]}
                      accessibilityLabel="Cantidad total"
                      {...inputCursorProps}
                    />
                  )}
                  <Pressable
                    style={styles.check}
                    onPress={() => setGuardarFormato((v) => !v)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: guardarFormato }}
                  >
                    <MaterialIcons
                      name={guardarFormato ? 'check-box' : 'check-box-outline-blank'}
                      size={22}
                      color={guardarFormato ? colors.accent : colors.textMuted}
                    />
                    <Text style={styles.checkTexto}>Guardar para la próxima vez</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.botonFoto, (totalFormato == null || ocupada) && styles.botonOff]}
                    disabled={totalFormato == null || ocupada}
                    onPress={() => {
                      if (totalFormato == null) return;
                      onFormato(linea, { unidadesCaja: caja, unidadesPack: pack, guardar: guardarFormato, total: totalFormato });
                    }}
                    accessibilityRole="button"
                  >
                    <MaterialIcons name="calculate" size={18} color={colors.surface} />
                    <Text style={styles.botonFotoTexto}>Usar esta cantidad</Text>
                  </Pressable>
                </>
              ) : (
                <Text style={styles.formatoTitulo}>Elige primero el producto para saber cuántas unidades trae la caja.</Text>
              )}
            </View>
          ) : null}

          <View style={[styles.fila, apilar && styles.filaApilada]}>
            <View style={styles.opciones}>
              {(['sumar', 'reemplazar'] as const).map((m) => {
                const activa = linea.modo === m;
                return (
                  <Pressable
                    key={m}
                    style={[styles.botella, activa && styles.botellaActiva]}
                    disabled={ocupada || activa}
                    onPress={() => onEditar(linea, { modo: m })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: activa }}
                  >
                    <Text style={[styles.botellaTexto, activa && styles.botellaTextoActiva]}>{MODOS[m]}</Text>
                  </Pressable>
                );
              })}
            </View>
            {linea.modo !== 'borrar' ? (
              <View style={styles.cantidadFila}>
                <TextInput
                  value={cantidadTexto}
                  onChangeText={setCantidadTexto}
                  keyboardType="decimal-pad"
                  placeholder="Cantidad"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, styles.inputCantidad]}
                  accessibilityLabel={`Cantidad de ${nombre}`}
                  {...inputCursorProps}
                />
                <Pressable
                  style={[styles.botonAnadir, styles.botonCompacto, (cantidadNueva == null || ocupada) && styles.botonOff]}
                  disabled={cantidadNueva == null || ocupada || cantidadNueva === linea.cantidad?.total}
                  onPress={() => {
                    if (cantidadNueva != null) onEditar(linea, { cantidad: cantidadNueva });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cambiar la cantidad"
                >
                  <Text style={styles.botonAnadirTexto}>Cambiar</Text>
                </Pressable>
              </View>
            ) : null}
          </View>

          <View style={[styles.fila, apilar && styles.filaApilada]}>
            <Pressable
              style={[styles.boton, styles.flex, !puedeConfirmar && styles.botonOff]}
              disabled={!puedeConfirmar}
              onPress={() => onConfirmar(linea)}
              accessibilityRole="button"
            >
              <Text style={styles.botonTexto}>{autoaplicable ? 'Aplicar' : 'Confirmar'}</Text>
            </Pressable>
            <BotonPeligro
              disabled={ocupada}
              accessibilityLabel="Borrar esta línea"
              onPress={() => onBorrar(linea)}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ─── Panel ───

export function DictadoPanel({ inventarioId, onCerrar, onAplicado, puedeDescargar = false }: Props) {
  const { isPhone, isPortrait, shouldStackPanels, shouldStackToolbar } = useBreakpoint();
  const insets = useSafeAreaInsets();
  const { confirmar, ConfirmarView } = useConfirmar();
  const dictado = useDictado(inventarioId, { onAplicado });
  const [ahora, setAhora] = useState(() => Date.now());
  const [catalogo, setCatalogo] = useState<OpcionDesplegable[] | null>(null);
  const [cargandoCatalogo, setCargandoCatalogo] = useState(false);
  const [cerrando, setCerrando] = useState(false);
  const [terminando, setTerminando] = useState(false);
  const [enRed, setEnRed] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const [descargandoExcel, setDescargandoExcel] = useState(false);
  const [errorExcel, setErrorExcel] = useState<string | null>(null);

  const pantallaCompleta = isPhone || (shouldStackPanels && isPortrait);
  const { fase, cola } = dictado;

  useEffect(() => {
    if (fase !== 'dictando') return undefined;
    const t = setInterval(() => setAhora(Date.now()), 500);
    return () => clearInterval(t);
  }, [fase]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const on = () => setEnRed(true);
    const off = () => setEnRed(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const pedirCatalogo = useCallback(async () => {
    if (catalogo || cargandoCatalogo) return;
    setCargandoCatalogo(true);
    try {
      const res = await apiFetch('/api/inventarios/productos');
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const lista = res.ok && Array.isArray(body.productos) ? body.productos : [];
      setCatalogo(
        lista
          .map((p) => {
            const fila = p as { productId?: unknown; nombre?: unknown; familiaNombre?: unknown };
            const id = String(fila.productId ?? '').trim();
            return {
              id,
              titulo: String(fila.nombre || id),
              subtitulo: String(fila.familiaNombre || '').trim() || undefined,
              badge: id,
            };
          })
          .filter((p) => p.id),
      );
    } catch {
      setCatalogo([]);
    } finally {
      setCargandoCatalogo(false);
    }
  }, [catalogo, cargandoCatalogo]);

  const lineasVisibles = useMemo(
    () => [...dictado.lineas]
      .filter((l) => l.estado !== 'descartada' && l.estado !== 'deshecha')
      .sort((a, b) => b.n - a.n),
    [dictado.lineas],
  );
  const resumenGrupos = useMemo(() => {
    const lineas = dictado.lineas;
    return [
      { titulo: 'Aplicadas', lineas: lineas.filter((l) => l.estado === 'aplicada') },
      { titulo: 'Pendientes', lineas: lineas.filter((l) => l.estado === 'pendiente' || l.estado === 'confirmada') },
      { titulo: 'Descartadas', lineas: lineas.filter((l) => l.estado === 'descartada') },
      { titulo: 'Deshechas', lineas: lineas.filter((l) => l.estado === 'deshecha') },
    ];
  }, [dictado.lineas]);
  const aplicadas = dictado.lineas.filter((l) => l.estado === 'aplicada').length;
  const porConfirmar = dictado.lineas.filter((l) => esEditable(l) && (l.confirmar || dictado.rechazos[l.n])).length;
  /** Pendientes de confirmar (sin las de trozos descartados): las que se pueden confirmar ya y las que no. */
  const { confirmables, sinCompletar } = useMemo(() => {
    const pendientes = dictado.lineas.filter(
      (l) => esEditable(l) && (l.confirmar || dictado.rechazos[l.n]) && !dictado.esDescartada(l),
    );
    return {
      confirmables: pendientes.filter(confirmable).sort((a, b) => a.n - b.n),
      sinCompletar: pendientes.filter((l) => !confirmable(l)).length,
    };
  }, [dictado.lineas, dictado.rechazos, dictado.esDescartada]);
  const [confirmandoTodas, setConfirmandoTodas] = useState(false);
  const [modoVoz, setModoVoz] = useState<ModoVoz>(() => leerModoVoz());
  const [resultadoTodas, setResultadoTodas] = useState<string | null>(null);
  /** Líneas que no se aplicaron solas: el hook borra el rechazo al aplicarlas, así que se recuerdan aquí. */
  const [aMano, setAMano] = useState<Set<number>>(() => new Set());

  const marcarAMano = useCallback((ns: number[]) => {
    setAMano((prev) => {
      if (ns.every((n) => prev.has(n))) return prev;
      const s = new Set(prev);
      ns.forEach((n) => s.add(n));
      return s;
    });
  }, []);

  useEffect(() => {
    const ns = dictado.lineas
      .filter((l) => l.estado === 'confirmada' || dictado.rechazos[l.n])
      .map((l) => l.n);
    if (ns.length > 0) marcarAMano(ns);
  }, [dictado.lineas, dictado.rechazos, marcarAMano]);

  async function confirmarTodas() {
    if (confirmandoTodas) return;
    const lista = confirmables.filter((l) => !dictado.ocupadas.has(l.n));
    const n = lista.length;
    if (n === 0) return;
    const MAX = 10;
    const filas = lista.slice(0, MAX).map((l) => {
      const producto = l.productoNombre || l.productId || 'Sin producto';
      if (sumaDesfasada(l, dictado.rechazos[l.n])) {
        const c = l.cantidad?.total;
        const dictada = c == null ? '' : `${c < 0 ? '' : '+'}${num(c)}, `;
        return `${producto}: ${dictada}se sumará a lo contado ahora`;
      }
      const actual = l.conteoActual?.contado ? textoTotal(l.conteoActual) : 'sin contar';
      const queda = l.previsto
        ? (l.previsto.total == null ? 'sin contar' : num(l.previsto.total))
        : `${l.modo ? MODOS[l.modo].toLowerCase() : ''} ${textoCantidad(l)}`.trim();
      return `${producto}: ${actual} → ${queda}`;
    });
    if (n > MAX) filas.push(`…y ${n - MAX} más`);
    if (sinCompletar > 0) {
      filas.push('', `Quedan ${sinCompletar} sin producto o sin cantidad: revísalas una a una.`);
    }
    const ok = await confirmar(`Confirmar ${n} ${n === 1 ? 'línea' : 'líneas'}`, filas.join('\n'), {
      confirmarLabel: 'Confirmar y aplicar',
    });
    if (!ok) return;
    setResultadoTodas(null);
    setConfirmandoTodas(true);
    marcarAMano(lista.map((l) => l.n));
    try {
      const r = await dictado.confirmarTodas(lista.map((l) => l.n));
      if (r.aplicadas < r.total) setResultadoTodas(`Se han aplicado ${r.aplicadas} de ${r.total}.`);
    } finally {
      setConfirmandoTodas(false);
    }
  }

  /**
   * La X: pausa (o, si se está esperando al terminar, deja de esperar) y cierra sin descartar audio.
   * Si queda audio sin enviar, avisa antes: se enviará al volver a abrir el dictado.
   * En el resumen ya no queda audio pendiente: cierra sin ese aviso.
   */
  async function cerrar() {
    if (cerrando) return;
    if (fase === 'terminada') {
      onCerrar();
      return;
    }
    setCerrando(true);
    let salir = true;
    try {
      if (fase === 'esperando') dictado.abandonarTerminar();
      if (fase === 'dictando' || fase === 'esperando') await dictado.pausar();
      const n = dictado.sinEnviarAhora();
      if (n > 0) {
        salir = await confirmar(
          'Audio sin enviar',
          `${n === 1 ? 'Queda 1 trozo de audio sin enviar. Se enviará' : `Quedan ${n} trozos de audio sin enviar. Se enviarán`} al volver a abrir el dictado. ¿Cerrar igualmente?`,
          { confirmarLabel: 'Cerrar', cancelarLabel: 'Seguir aquí' },
        );
      }
    } finally {
      setCerrando(false);
    }
    if (salir) onCerrar();
  }

  async function bajarExcel() {
    if (descargandoExcel) return;
    setDescargandoExcel(true);
    setErrorExcel(null);
    try {
      const r = await descargarExcelConteo(inventarioId, confirmar);
      if (r.resultado === 'error') setErrorExcel(r.error || 'No se ha podido generar el Excel');
    } finally {
      setDescargandoExcel(false);
    }
  }

  async function terminar() {
    if (terminando) return;
    setTerminando(true);
    try {
      const ok = await dictado.terminar(async (n) => {
        const texto = n === 1 ? 'Queda 1 trozo sin enviar' : `Quedan ${n} trozos sin enviar`;
        const esperar = await confirmar(
          'Audio sin enviar',
          `${texto}. ¿Esperar a que se envíen o descartarlos?`,
          { confirmarLabel: 'Esperar', cancelarLabel: 'Descartar' },
        );
        if (esperar) return 'esperar';
        const descartar = await confirmar(
          'Descartar audio',
          `Se perderá lo dictado en ${n === 1 ? 'ese trozo' : `esos ${n} trozos`}. Si uno se está enviando, se esperará a que termine y se descartarán sus líneas.`,
          { variant: 'danger', confirmarLabel: 'Descartar', cancelarLabel: 'Volver' },
        );
        return descartar ? 'descartar' : 'cancelar';
      });
      // La fase queda en «terminada»: el resumen sigue en este modal.
      if (ok) return;
    } finally {
      setTerminando(false);
    }
  }

  async function descartarErrores() {
    const n = cola.errores;
    const ok = await confirmar(
      'Descartar audio',
      `Se perderá lo dictado en ${n === 1 ? 'el trozo que no se ha podido enviar' : `los ${n} trozos que no se han podido enviar`}.`,
      { variant: 'danger', confirmarLabel: 'Descartar' },
    );
    if (ok) await dictado.descartarErrores();
  }

  async function borrarLinea(l: LineaDictado) {
    const ok = await confirmar('Borrar línea', '¿Borrar esta línea?', {
      variant: 'danger',
      confirmarLabel: 'Borrar',
    });
    if (!ok) return;
    await dictado.borrarLinea(l.n);
  }

  async function deshacer() {
    const u = dictado.ultimaDeshacible;
    if (!u) return;
    if (u.estado === 'aplicada') {
      const anterior = u.anterior ? totalDe(u.anterior) : undefined;
      const valor = anterior === undefined ? 'como estaba antes de dictarlo' : anterior == null ? 'sin contar' : num(anterior);
      const ok = await confirmar(
        'Deshacer último',
        `«${u.texto}»: ${u.productoNombre || u.productId || 'el producto'} vuelve a ${valor}.`,
        { confirmarLabel: 'Deshacer' },
      );
      if (!ok) return;
    }
    await dictado.deshacerUltimo();
  }

  async function confirmarLinea(l: LineaDictado) {
    const rechazo = dictado.rechazos[l.n];
    const yaContado = Boolean(l.conteoActual?.contado) || l.motivos.includes('ya_contado') || rechazo?.motivo === 'ya_contado';
    if (yaContado) {
      const actual = l.conteoActual?.contado ? totalDe(l.conteoActual) : null;
      const queda = l.previsto ? (l.previsto.total == null ? 'sin contar' : num(l.previsto.total)) : null;
      const partes = [
        `${l.productoNombre || 'Este producto'} ya estaba contado${actual != null ? ` (contado ${num(actual)})` : ''}.`,
      ];
      if (queda) partes.push(`Con este cambio queda ${queda}.`);
      const ok = await confirmar('Producto ya contado', partes.join(' '), { confirmarLabel: 'Aplicar cambio' });
      if (!ok) return;
    }
    marcarAMano([l.n]);
    await dictado.confirmarLinea(l.n);
  }

  function formato(
    l: LineaDictado,
    args: { unidadesCaja: number | null; unidadesPack: number | null; guardar: boolean; total: number },
  ) {
    if (!l.productId) return;
    const guardar = args.guardar && args.unidadesCaja != null && Number.isInteger(args.unidadesCaja) && args.unidadesCaja > 0;
    void dictado.guardarFormato(l.n, {
      productId: l.productId,
      unidadesCaja: args.unidadesCaja ?? 0,
      unidadesPack: args.unidadesPack != null && Number.isInteger(args.unidadesPack) && args.unidadesPack > 0
        ? args.unidadesPack
        : null,
      guardar,
      total: args.total,
    });
  }

  const inicioTrozo = dictado.leerInicioTrozo();
  const tiempoTrozo = fase === 'dictando' && inicioTrozo ? Math.min(MAX_TROZO_MS, ahora - inicioTrozo) : 0;
  const sinEnviar = cola.pendientes + cola.enviando;

  let estadoCola: { icono: ComponentProps<typeof MaterialIcons>['name']; texto: string; color: string };
  if (cola.sinSesion) {
    estadoCola = {
      icono: 'lock-outline',
      texto: 'La sesión ha caducado: vuelve a entrar para enviar el audio. No se ha perdido.',
      color: colors.danger,
    };
  } else if (cola.errores > 0) {
    estadoCola = { icono: 'error-outline', texto: `Error${cola.mensajeError ? `: ${cola.mensajeError}` : ''}`, color: colors.danger };
  } else if (sinEnviar > 0) {
    estadoCola = {
      icono: 'cloud-upload',
      texto: `${sinEnviar} ${sinEnviar === 1 ? 'pendiente' : 'pendientes'}${enRed ? (cola.enviando > 0 ? ' · enviando…' : '') : ' · sin cobertura, se reenviarán solos'}`,
      color: colors.warning,
    };
  } else {
    estadoCola = { icono: 'cloud-done', texto: 'Guardado', color: colors.success };
  }

  const contenido = (
    <View
      style={[
        styles.panel,
        pantallaCompleta && { paddingTop: insets.top + SPACING.md, paddingBottom: insets.bottom + SPACING.md },
      ]}
    >
      <View style={styles.cabecera}>
        <View style={styles.cabeceraTexto}>
          <Text style={styles.titulo}>{fase === 'terminada' ? 'Resumen' : 'Dictado'}</Text>
          <Text style={styles.subtitulo}>
            {fase === 'terminada'
              ? `${dictado.lineas.length} ${dictado.lineas.length === 1 ? 'línea' : 'líneas'} en este dictado`
              : `${dictado.lineas.length} ${dictado.lineas.length === 1 ? 'línea' : 'líneas'} · ${aplicadas} aplicadas${porConfirmar > 0 ? ` · ${porConfirmar} por confirmar` : ''}`}
          </Text>
        </View>
        <Pressable
          style={styles.iconoBtn}
          onPress={() => void cerrar()}
          disabled={cerrando}
          accessibilityRole="button"
          accessibilityLabel="Cerrar el dictado"
        >
          <MaterialIcons name="close" size={22} color={colors.textStrong} />
        </Pressable>
      </View>

      {!dictado.disponible ? <Text style={styles.aviso}>El dictado solo está disponible en la web</Text> : null}

      {fase === 'terminada' ? null : fase === 'cargando' ? (
        <View style={styles.banner}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.bannerTexto}>Preparando el micrófono…</Text>
        </View>
      ) : fase === 'dictando' ? (
        <View style={[styles.banner, styles.bannerDictando]}>
          <View style={styles.puntoGrabando} />
          <Text style={[styles.bannerTexto, { color: statusColors.danger.text }]}>Dictando</Text>
          <Text style={styles.bannerTiempo}>{`${reloj(tiempoTrozo)} / ${reloj(MAX_TROZO_MS)}`}</Text>
        </View>
      ) : fase === 'esperando' ? (
        <View style={[styles.banner, styles.bannerPausa]}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={[styles.bannerTexto, styles.flex]}>Enviando los trozos pendientes…</Text>
          <Pressable style={styles.bannerAccion} onPress={dictado.cancelarEspera} accessibilityRole="button">
            <Text style={styles.botonAnadirTexto}>Dejar de esperar</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[styles.banner, styles.bannerPausa]}>
          <MaterialIcons name="pause" size={20} color={colors.textSecondary} />
          <Text style={styles.bannerTexto}>En pausa</Text>
        </View>
      )}

      {fase === 'terminada' ? null : (
      <View style={[styles.barra, shouldStackToolbar && styles.filaApilada]}>
        {([
          ['silencio', 'volume-off', 'Silenciar'],
          ['pitido', 'notifications', 'Pitido'],
          ['hablada', 'record-voice-over', 'Voz'],
        ] as const).map(([id, icono, etiqueta]) => (
          <Pressable
            key={id}
            style={[styles.botonAnadir, modoVoz === id && styles.vozActiva]}
            onPress={() => { guardarModoVoz(id); setModoVoz(id); }}
            accessibilityRole="button"
            accessibilityState={{ selected: modoVoz === id }}
            accessibilityLabel={etiqueta === 'Silenciar' ? 'Silenciar la voz del dictado' : etiqueta === 'Pitido' ? 'Avisar los aciertos con un pitido' : 'Confirmar en voz alta'}
          >
            <MaterialIcons name={icono} size={18} color={modoVoz === id ? colors.accent : colors.textSecondary} />
            <Text style={styles.botonAnadirTexto}>{etiqueta}</Text>
          </Pressable>
        ))}
      </View>
      )}

      {fase === 'terminada' ? null : (
      <View style={[styles.barra, shouldStackToolbar && styles.filaApilada]}>
        {fase === 'dictando' ? (
          <Pressable
            style={[styles.botonFoto, styles.flex]}
            onPress={() => void dictado.pausar()}
            accessibilityRole="button"
          >
            <MaterialIcons name="pause" size={18} color={colors.surface} />
            <Text style={styles.botonFotoTexto}>Pausar</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.botonFoto, styles.flex, (!dictado.disponible || fase === 'cargando' || fase === 'esperando') && styles.botonOff]}
            disabled={!dictado.disponible || fase === 'cargando' || fase === 'esperando'}
            onPress={() => void dictado.reanudar()}
            accessibilityRole="button"
          >
            <MaterialIcons name="mic" size={18} color={colors.surface} />
            <Text style={styles.botonFotoTexto}>Reanudar</Text>
          </Pressable>
        )}
        <Pressable
          style={[styles.botonAnadir, styles.flex, !dictado.ultimaDeshacible && styles.botonOff]}
          disabled={!dictado.ultimaDeshacible || dictado.ocupadas.has(dictado.ultimaDeshacible.n)}
          onPress={() => void deshacer()}
          accessibilityRole="button"
        >
          <MaterialIcons name="undo" size={20} color={colors.accent} />
          <Text style={styles.botonAnadirTexto}>Deshacer último</Text>
        </Pressable>
        <Pressable
          style={[styles.botonBorrar, styles.flex, (terminando || cerrando) && styles.botonOff]}
          disabled={terminando || cerrando || fase === 'esperando'}
          onPress={() => void terminar()}
          accessibilityRole="button"
        >
          <MaterialIcons name="stop" size={18} color={colors.danger} />
          <Text style={styles.botonBorrarTexto}>Terminar</Text>
        </Pressable>
      </View>
      )}

      <View style={styles.cola}>
        <MaterialIcons name={estadoCola.icono} size={18} color={estadoCola.color} />
        <Text style={[styles.colaTexto, { color: estadoCola.color }]} numberOfLines={2}>{estadoCola.texto}</Text>
        {cola.errores > 0 && !cola.sinSesion ? (
          <>
            <Pressable style={styles.bannerAccion} onPress={dictado.reintentarCola} accessibilityRole="button">
              <Text style={styles.botonAnadirTexto}>Reintentar</Text>
            </Pressable>
            <Pressable style={styles.bannerAccion} onPress={() => void descartarErrores()} accessibilityRole="button">
              <Text style={styles.botonBorrarTexto}>Descartar</Text>
            </Pressable>
          </>
        ) : null}
      </View>
      {dictado.descartando > 0 ? (
        <View style={[styles.banner, styles.bannerPausa]}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={[styles.bannerTexto, styles.flex]}>
            {`Descartando: enviando ${dictado.descartando} ${dictado.descartando === 1 ? 'trozo' : 'trozos'}…`}
          </Text>
        </View>
      ) : null}
      {cola.trozos.length > 0 ? (
        <View style={styles.trozos}>
          {cola.trozos.map((t) => (
            <Text key={t.idEnvio} style={[styles.trozo, t.estado === 'error' && { color: colors.danger }]}>
              {`${horaCorta(t.creadoEn)} · ${t.estado === 'enviando' ? 'enviando' : t.estado === 'error' ? 'error' : 'pendiente'}`}
            </Text>
          ))}
        </View>
      ) : null}
      {!cola.persistente ? (
        <Text style={styles.avisoDiscreto}>
          Este navegador no guarda el audio: no cierres la pestaña hasta que se envíe.
        </Text>
      ) : null}
      {cola.sinUsuario > 0 ? (
        <Text style={styles.error}>
          {`${cola.sinUsuario === 1 ? 'Un trozo se ha grabado' : `${cola.sinUsuario} trozos se han grabado`} sin sesión: se guarda${cola.sinUsuario === 1 ? '' : 'n'} en este navegador pero no se enviará${cola.sinUsuario === 1 ? '' : 'n'} (se borra${cola.sinUsuario === 1 ? '' : 'n'} a los 7 días). Vuelve a entrar y dicta de nuevo esa parte.`}
        </Text>
      ) : null}
      {dictado.error ? <Text style={styles.error}>{dictado.error}</Text> : null}
      {dictado.aviso ? <Text style={styles.aviso}>{dictado.aviso}</Text> : null}

      {fase === 'terminada' ? (
        <>
          <ScrollView style={styles.flex} contentContainerStyle={styles.lista} keyboardShouldPersistTaps="handled">
            {resumenGrupos.map((grupo) => (
              <View key={grupo.titulo} style={styles.tarjeta}>
                <View style={styles.tarjetaCab}>
                  <Text style={styles.producto}>{grupo.titulo}</Text>
                  <Text style={styles.cantidad}>{grupo.lineas.length}</Text>
                </View>
                {grupo.lineas.map((l) => (
                  <Text key={l.n} style={styles.resumenLinea}>{textoResumenLinea(l)}</Text>
                ))}
              </View>
            ))}
          </ScrollView>
          {errorExcel ? <Text style={styles.error}>{errorExcel}</Text> : null}
          {puedeDescargar ? (
            <Pressable
              style={[styles.boton, descargandoExcel && styles.botonOff]}
              disabled={descargandoExcel}
              onPress={() => void bajarExcel()}
              accessibilityRole="button"
              accessibilityLabel="Descargar Excel"
            >
              {descargandoExcel ? (
                <ActivityIndicator color={colors.surface} />
              ) : (
                <Text style={styles.botonTexto}>Descargar Excel</Text>
              )}
            </Pressable>
          ) : null}
          <Pressable
            style={styles.boton}
            onPress={onCerrar}
            accessibilityRole="button"
            accessibilityLabel="Cerrar el resumen"
          >
            <Text style={styles.botonTexto}>Cerrar</Text>
          </Pressable>
        </>
      ) : (
        <>
          {confirmables.length >= 2 || confirmandoTodas ? (
            <Pressable
              style={[styles.botonAnadir, styles.botonTodas, confirmandoTodas && styles.botonOff]}
              disabled={confirmandoTodas}
              onPress={() => void confirmarTodas()}
              accessibilityRole="button"
            >
              {confirmandoTodas ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <MaterialIcons name="done-all" size={20} color={colors.accent} />
              )}
              <Text style={styles.botonAnadirTexto}>{`Confirmar todas (${confirmables.length})`}</Text>
            </Pressable>
          ) : null}
          {resultadoTodas ? <Text style={styles.avisoDiscreto}>{resultadoTodas}</Text> : null}

          <ScrollView style={styles.flex} contentContainerStyle={styles.lista} keyboardShouldPersistTaps="handled">
            {lineasVisibles.length === 0 && fase !== 'cargando' ? (
              <Text style={styles.vacio}>
                {'Di el producto y la cantidad, por ejemplo «Larios 3 y media» o «Coca-Cola 2 cajas de 24».'}
              </Text>
            ) : null}
            {lineasVisibles.map((l) => (
              <TarjetaLinea
                key={l.n}
                linea={l}
                rechazo={dictado.rechazos[l.n]}
                nueva={dictado.nuevas.has(l.n)}
                editada={estaEditada(l, dictado.editadas)}
                aMano={aMano.has(l.n)}
                ocupada={dictado.ocupadas.has(l.n)}
                apilar={shouldStackToolbar}
                catalogo={catalogo}
                cargandoCatalogo={cargandoCatalogo}
                onPedirCatalogo={() => void pedirCatalogo()}
                onConfirmar={(x) => void confirmarLinea(x)}
                onBorrar={(x) => void borrarLinea(x)}
                onEditar={(x, cambios) => void dictado.editarLinea(x.n, cambios)}
                onFormato={formato}
              />
            ))}
          </ScrollView>
        </>
      )}
    </View>
  );

  return (
    <Modal
      visible
      animationType={pantallaCompleta ? 'slide' : 'fade'}
      transparent={!pantallaCompleta}
      statusBarTranslucent
      onRequestClose={() => void cerrar()}
    >
      {pantallaCompleta ? (
        contenido
      ) : (
        <View style={styles.fondo}>
          <View style={styles.ventana}>{contenido}</View>
        </View>
      )}
      {ConfirmarView}
    </Modal>
  );
}

const styles = StyleSheet.create({
  fondo: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  ventana: {
    width: 760,
    height: '92%',
    maxWidth: '100%',
    maxHeight: '100%',
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  panel: { flex: 1, backgroundColor: colors.bg, padding: SPACING.lg },
  flex: { flex: 1 },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginBottom: SPACING.sm },
  cabeceraTexto: { flex: 1 },
  titulo: { fontFamily: fontFamily.bold, fontSize: fontSizes[20], color: colors.textStrong },
  subtitulo: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textSecondary, marginTop: 4 },
  iconoBtn: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  banner: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bannerDictando: { backgroundColor: statusColors.danger.bg, borderColor: statusColors.danger.bg },
  bannerPausa: { backgroundColor: statusColors.neutral.bg, borderColor: colors.borderStrong },
  bannerTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textSecondary },
  bannerTiempo: {
    marginLeft: 'auto',
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[14],
    color: statusColors.danger.text,
    ...(Platform.OS === 'web' ? ({ fontVariantNumeric: 'tabular-nums' } as object) : {}),
  },
  bannerAccion: { minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: SPACING.sm },
  puntoGrabando: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.danger },
  barra: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.xs },
  vozActiva: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  cola: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, minHeight: 32 },
  colaTexto: { flex: 1, fontFamily: fontFamily.medium, fontSize: fontSizes[13] },
  trozos: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.xs },
  trozo: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textSecondary },
  avisoDiscreto: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textSecondary, marginBottom: SPACING.xs },
  lista: { gap: SPACING.sm, paddingBottom: SPACING.md, paddingTop: SPACING.xs },
  vacio: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textSecondary,
    textAlign: 'center',
    paddingVertical: SPACING.xl,
  },
  tarjeta: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  tarjetaNueva: { borderColor: colors.accent, borderWidth: 2, backgroundColor: colors.accentMuted },
  tarjetaApagada: { opacity: 0.6 },
  tarjetaCab: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  cabAcciones: { flexDirection: 'row', alignItems: 'center' },
  etiquetas: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  chip: { borderRadius: radius.pill, paddingHorizontal: SPACING.sm, paddingVertical: 2 },
  chipTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[12] },
  textoDictado: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textSecondary, fontStyle: 'italic' },
  productoFila: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, minWidth: 0 },
  badgeId: {
    flexShrink: 0,
    backgroundColor: statusColors.info.bg,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeIdTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[12], color: statusColors.info.text },
  producto: { flex: 1, fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textStrong },
  resumenLinea: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary },
  sinProducto: { color: colors.warning },
  cantidad: { fontFamily: fontFamily.bold, fontSize: fontSizes[18], color: colors.textStrong },
  previsto: { fontFamily: fontFamily.medium, fontSize: fontSizes[13], color: colors.textPrimary },
  motivos: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  motivo: { borderRadius: radius.md, backgroundColor: statusColors.warning.bg, paddingHorizontal: SPACING.sm, paddingVertical: 4 },
  motivoTexto: { fontFamily: fontFamily.medium, fontSize: fontSizes[12], color: statusColors.warning.text },
  rechazo: { fontFamily: fontFamily.medium, fontSize: fontSizes[13], color: colors.danger },
  sumado: { fontFamily: fontFamily.medium, fontSize: fontSizes[13], color: statusColors.success.text },
  ayuda: { fontFamily: fontFamily.semibold, fontSize: fontSizes[13], color: colors.accentPressed },
  acciones: { gap: SPACING.xs, marginTop: SPACING.xs },
  etiqueta: { fontFamily: fontFamily.semibold, fontSize: fontSizes[13], color: colors.textSecondary, marginBottom: 4 },
  opciones: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  fila: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm },
  filaApilada: { flexDirection: 'column', alignItems: 'stretch' },
  cantidadFila: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexGrow: 1 },
  formato: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: statusColors.warning.bg,
    padding: SPACING.sm,
    gap: SPACING.xs,
  },
  formatoTitulo: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: statusColors.warning.text },
  check: { minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  checkTexto: { fontFamily: fontFamily.medium, fontSize: fontSizes[14], color: colors.textStrong },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: SPACING.md,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[16],
    color: colors.textStrong,
    backgroundColor: colors.surface,
    ...(Platform.OS === 'web' ? (inputCursorStyle as object) : {}),
  },
  inputFlex: { flex: 1, minWidth: 160 },
  inputCantidad: { width: 110 },
  // Mismos valores que los botones de la pantalla de conteo (inventario.tsx).
  botonFoto: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flexShrink: 0,
  },
  botonFotoTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.surface },
  boton: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  botonOff: { opacity: 0.5 },
  botonTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.surface },
  botonAnadir: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.lg,
  },
  botonCompacto: { paddingHorizontal: SPACING.md },
  botonTodas: { marginBottom: SPACING.xs },
  botonAnadirTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.accentPressed },
  botonBorrar: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.lg,
  },
  botonBorrarTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.danger },
  botella: {
    minWidth: 72,
    maxWidth: 260,
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  botellaActiva: { backgroundColor: colors.accent, borderColor: colors.accent },
  botellaTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textPrimary },
  botellaTextoActiva: { color: colors.surface },
  aviso: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.warning, marginBottom: SPACING.xs },
  error: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.danger, marginBottom: SPACING.xs },
});
