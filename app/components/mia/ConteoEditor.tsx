/**
 * Líneas del conteo agrupadas por proveedor.
 * La cantidad y el máximo final se editan; quitar y restaurar marcan la fila.
 * En escritorio y tablet es una tabla; en móvil, tarjetas.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { CampoSelector } from './CampoSelector';

export type LineaConteo = {
  productId: string;
  nombre: string;
  proveedorId: string;
  proveedorNombre: string;
  stockReal: number | null;
  maximoFinal: number | null;
  formatoCompra: number | null;
  omitida: boolean;
  aviso: string | null;
  cantidadCalculada: number;
  maximoCalculado: number | null;
  cantidadPedida: number | null;
  costeUnitario?: number | null;
  unit?: string;
  purchaseUnitId?: string;
  proveedorManual?: boolean;
  unidadManual?: boolean;
  unidades?: { id: string; nombre: string }[];
};

export type OpcionProveedor = {
  proveedorId: string;
  proveedorNombre: string;
};

export type BorradorLinea = {
  cantidad: string;
  maximo: string;
  omitida: boolean;
  proveedorId: string;
  proveedorNombre: string;
  purchaseUnitId: string;
  unit: string;
};

export type PedidoProveedor = {
  proveedorId: string;
  proveedorNombre: string;
  estado: string;
  serie?: string | null;
  number?: number | null;
  enviandoDesde?: string | null;
};

const MINUTOS_ATASCO = 10;

type Props = {
  lineas: LineaConteo[];
  borradores: Record<string, BorradorLinea>;
  errores: Record<string, string>;
  pedidos: PedidoProveedor[];
  proveedores?: OpcionProveedor[];
  puedeEditarProveedor: (proveedorId: string) => boolean;
  puedeAprobar: boolean;
  puedeConfirmar: boolean;
  /** El conteo todavía no se ha calculado: Aprobar y Confirmar no se pueden pulsar. */
  aprobarBloqueado?: boolean;
  aprobando: boolean;
  enTarjetas: boolean;
  onCambio: (clave: string, campo: 'cantidad' | 'maximo', valor: string) => void;
  onElegir: (clave: string, campo: 'proveedor' | 'unidad', id: string, nombre: string) => void;
  onQuitar: (clave: string) => void;
  onRestaurar: (clave: string) => void;
  onAprobar: (proveedorId: string, confirmed: boolean) => void;
  onDescargar: (proveedorId: string) => void;
  onComprobar: (proveedorId: string) => void;
  comprobando: boolean;
};

const TEXTO = '#0f172a';
const SECUNDARIO = '#64748b';
const ROJO = '#b91c1c';
const ROSA = '#be185d';
const ROSA_BORDE = '#ec4899';
const BORDE = '#e2e8f0';

const ANCHO = { stock: 80, formato: 80, unidad: 120, maximo: 96, pedir: 96, acciones: 170 };
const ANCHO_HASTA_PEDIR = ANCHO.stock + ANCHO.formato + ANCHO.unidad + ANCHO.maximo;

export function claveLinea(linea: { proveedorId: string; productId: string }) {
  return `${linea.proveedorId}#${linea.productId}`;
}

const ESTADO: Record<string, string> = {
  generado: 'Generado',
  enviando: 'Enviando',
  pedido: 'Pedido',
  confirmado: 'Confirmado',
  mixto: 'Mixto',
};

function numero(texto: string) {
  const t = texto.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

function unidadesDe(texto: string, omitida: boolean) {
  if (omitida) return 0;
  const n = numero(texto);
  return n == null ? 0 : n;
}

function formatoUnidades(n: number) {
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4 }).format(n);
}

/** Manual solo si hay valor escrito y no coincide con el calculado. */
function esManual(valor: string, calculado: string) {
  return valor.trim() !== '' && canon(valor) !== canon(calculado);
}

export function ConteoEditor({
  lineas,
  borradores,
  errores,
  pedidos,
  proveedores = [],
  puedeEditarProveedor,
  puedeAprobar,
  puedeConfirmar,
  aprobarBloqueado = false,
  aprobando,
  enTarjetas,
  onCambio,
  onElegir,
  onQuitar,
  onRestaurar,
  onAprobar,
  onDescargar,
  onComprobar,
  comprobando,
}: Props) {
  const { isPhone, isTablet } = useBreakpoint();
  const tactil = isPhone || isTablet;
  const toque = tactil ? MIN_TOUCH : 32;
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const reloj = setInterval(() => setAhora(Date.now()), 30_000);
    return () => clearInterval(reloj);
  }, []);
  const grupos = new Map<string, LineaConteo[]>();
  for (const linea of lineas) {
    const lista = grupos.get(linea.proveedorId) || [];
    lista.push(linea);
    grupos.set(linea.proveedorId, lista);
  }
  let total = 0;
  const numGrupos = grupos.size;

  const bloques = [...grupos.entries()].map(([proveedorId, filas], gi) => {
    const pedido = pedidos.find((p) => p.proveedorId === proveedorId);
    const puedeEditar = puedeEditarProveedor(proveedorId);
    let subtotal = 0;
    const celdas = filas.map((linea, i) => {
      const clave = claveLinea(linea);
      const borrador = borradores[clave] ?? baseVisible(linea);
      const error = errores[clave];
      const unidades = unidadesDe(borrador.cantidad, borrador.omitida);
      subtotal += unidades;
      const manualCantidad = !borrador.omitida && esManual(borrador.cantidad, String(linea.cantidadCalculada ?? 0));
      const manualMaximo = esManual(borrador.maximo, linea.maximoCalculado == null ? '' : String(linea.maximoCalculado));
      const sinProveedor = !linea.proveedorId || linea.proveedorId === 'SIN_PROVEEDOR';
      const sinUnidad = !String(linea.purchaseUnitId || '').trim() || !String(linea.unit || '').trim();
      const proveedorManual = linea.proveedorManual === true || (sinProveedor && borrador.proveedorId !== linea.proveedorId);
      const unidadManual = linea.unidadManual === true || (sinUnidad && borrador.purchaseUnitId !== (linea.purchaseUnitId || ''));
      const nombreUnidad = (borrador.unit || linea.unit || '').trim();
      const elecciones = (
        <>
          {puedeEditar && sinProveedor ? (
            <Eleccion
              etiqueta="Proveedor"
              compacto={!enTarjetas}
              valorId={borrador.proveedorId === 'SIN_PROVEEDOR' ? '' : borrador.proveedorId}
              opciones={proveedores.map((p) => ({ id: p.proveedorId, titulo: p.proveedorNombre || p.proveedorId }))}
              placeholder="Elige proveedor"
              onElegir={(id, nombre) => onElegir(clave, 'proveedor', id, nombre)}
            />
          ) : null}
          {puedeEditar && sinUnidad ? (
            <Eleccion
              etiqueta="Unidad"
              compacto={!enTarjetas}
              valorId={borrador.purchaseUnitId}
              opciones={(linea.unidades || []).map((u) => ({ id: u.id, titulo: u.nombre || u.id }))}
              placeholder="Elige unidad"
              onElegir={(id, nombre) => onElegir(clave, 'unidad', id, nombre)}
            />
          ) : null}
        </>
      );

      if (enTarjetas) {
        return (
          <View key={clave} style={[styles.tarjeta, (error || borrador.omitida) && styles.filaMarcada, error && styles.filaError]}>
            <Text style={[styles.nombre, borrador.omitida && styles.tachada]} numberOfLines={2}>{linea.nombre}</Text>
            <Text style={styles.meta} numberOfLines={2}>
              {linea.stockReal == null ? 'Sin contar' : `Stock ${formatoUnidades(linea.stockReal)}`}
              {linea.formatoCompra != null ? ` · Formato ${formatoUnidades(linea.formatoCompra)}` : ''}
              {nombreUnidad ? ` · Unidad ${nombreUnidad}` : ' · Sin unidad'}
              {linea.aviso ? ` · ${linea.aviso}` : ''}
            </Text>
            <View style={styles.marcas}>
              {borrador.omitida ? <Text style={styles.marca}>Quitada</Text> : null}
              {manualCantidad ? <Text style={styles.marca}>Cantidad manual</Text> : null}
              {manualMaximo ? <Text style={styles.marca}>Máximo manual</Text> : null}
              {proveedorManual ? <Text style={styles.marca}>Proveedor manual</Text> : null}
              {unidadManual ? <Text style={styles.marca}>Unidad manual</Text> : null}
            </View>
            {elecciones}
            <View style={styles.camposTarjeta}>
              <Campo
                etiqueta="Máximo final"
                valor={borrador.maximo}
                editable={puedeEditar}
                error={!!error}
                manual={manualMaximo}
                onChangeText={(v) => onCambio(clave, 'maximo', v)}
              />
              <Campo
                etiqueta="Pedir"
                valor={borrador.cantidad}
                editable={puedeEditar && !borrador.omitida}
                error={!!error}
                manual={manualCantidad}
                destacado
                onChangeText={(v) => onCambio(clave, 'cantidad', v)}
              />
            </View>
            {puedeEditar ? (
              <View style={styles.acciones}>
                <Pressable style={styles.accion} onPress={() => onQuitar(clave)} accessibilityRole="button">
                  <Text style={styles.accionTexto}>Quitar</Text>
                </Pressable>
                <Pressable style={styles.accion} onPress={() => onRestaurar(clave)} accessibilityRole="button">
                  <Text style={styles.accionTexto}>Restaurar</Text>
                </Pressable>
              </View>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        );
      }

      const tieneEleccion = puedeEditar && (sinProveedor || sinUnidad);
      return (
        <View key={clave} style={[styles.filaBloque, { zIndex: filas.length - i }, error && styles.filaError]}>
          <View style={styles.fila}>
            <View style={styles.celdaProducto}>
              <Text numberOfLines={tieneEleccion ? 2 : 1}>
                <Text style={[styles.nombreFila, borrador.omitida && styles.tachada]}>{linea.nombre}</Text>
                {manualCantidad || manualMaximo ? <Text style={styles.sufijo}> · manual</Text> : null}
                {proveedorManual ? <Text style={styles.sufijo}> · proveedor manual</Text> : null}
                {unidadManual ? <Text style={styles.sufijo}> · unidad manual</Text> : null}
                {linea.aviso ? <Text style={styles.avisoLinea}> · {linea.aviso}</Text> : null}
              </Text>
              {tieneEleccion ? <View style={styles.elecciones}>{elecciones}</View> : null}
            </View>
            <Text style={[styles.celdaNum, { width: ANCHO.stock }, linea.stockReal == null && styles.textoGris]} numberOfLines={1}>
              {linea.stockReal == null ? 'Sin contar' : formatoUnidades(linea.stockReal)}
            </Text>
            <Text style={[styles.celdaNum, { width: ANCHO.formato }, linea.formatoCompra == null && styles.textoGris]}>
              {linea.formatoCompra != null ? formatoUnidades(linea.formatoCompra) : '—'}
            </Text>
            <Text
              style={[styles.celdaNum, { width: ANCHO.unidad }, !nombreUnidad && styles.textoGris, unidadManual && styles.unidadManual]}
              numberOfLines={1}
            >
              {nombreUnidad || '—'}
            </Text>
            <View style={[styles.celdaInput, { width: ANCHO.maximo }]}>
              <InputCelda
                valor={borrador.maximo}
                editable={puedeEditar}
                error={!!error}
                manual={manualMaximo}
                etiqueta="Máximo final"
                onChangeText={(v) => onCambio(clave, 'maximo', v)}
              />
            </View>
            <View style={[styles.celdaInput, { width: ANCHO.pedir }]}>
              <InputCelda
                valor={borrador.cantidad}
                editable={puedeEditar && !borrador.omitida}
                error={!!error}
                manual={manualCantidad}
                destacado
                etiqueta="Pedir"
                onChangeText={(v) => onCambio(clave, 'cantidad', v)}
              />
            </View>
            <View style={[styles.celdaAcciones, { width: ANCHO.acciones }]}>
              {puedeEditar ? (
                <>
                  <Pressable
                    style={[styles.icono, { minWidth: toque, minHeight: toque }]}
                    onPress={() => onQuitar(clave)}
                    accessibilityRole="button"
                    accessibilityLabel="Quitar"
                  >
                    <MaterialIcons name="close" size={18} color={SECUNDARIO} />
                  </Pressable>
                  <Pressable
                    style={[styles.icono, { minWidth: toque, minHeight: toque }]}
                    onPress={() => onRestaurar(clave)}
                    accessibilityRole="button"
                    accessibilityLabel="Restaurar"
                  >
                    <MaterialIcons name="restore" size={18} color={SECUNDARIO} />
                  </Pressable>
                </>
              ) : null}
            </View>
          </View>
          {error ? <Text style={styles.errorFila}>{error}</Text> : null}
        </View>
      );
    });
    total += subtotal;
    const atascado = estaAtascado(pedido, ahora);
    const estadoTexto = `${ESTADO[pedido?.estado || 'generado'] || pedido?.estado}${atascado ? ' · atascado' : ''}`;
    const nombreProveedor = pedido?.proveedorNombre || filas[0]?.proveedorNombre || proveedorId;
    const enlace = (texto: string, onPress: () => void, bloqueado = false) => (
      <Pressable
        key={texto}
        style={[styles.enlace, { minHeight: enTarjetas ? MIN_TOUCH : toque }]}
        disabled={aprobando || comprobando || bloqueado}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ disabled: aprobando || comprobando || bloqueado }}
      >
        <Text style={[styles.enlaceTexto, bloqueado && styles.enlaceOff]}>{texto}</Text>
      </Pressable>
    );
    const enlaces: ReactNode[] = [enlace(enTarjetas ? 'Descargar PDF' : 'PDF', () => onDescargar(proveedorId))];
    if (puedeAprobar && atascado) enlaces.push(enlace('Comprobar en Ágora', () => onComprobar(proveedorId)));
    if (puedeAprobar && (pedido?.estado || 'generado') === 'generado') {
      enlaces.push(enlace('Aprobar', () => onAprobar(proveedorId, false), aprobarBloqueado));
      if (puedeConfirmar) enlaces.push(enlace('Confirmar', () => onAprobar(proveedorId, true), aprobarBloqueado));
    }

    if (enTarjetas) {
      return (
        <View key={proveedorId} style={styles.grupo}>
          <View style={styles.grupoCabecera}>
            <Text style={styles.grupoNombre}>{nombreProveedor}</Text>
            <Text style={styles.pastilla}>{estadoTexto}</Text>
            <Text style={styles.grupoTotal}>{formatoUnidades(subtotal)} uds</Text>
            {enlaces}
          </View>
          {celdas}
        </View>
      );
    }

    return (
      <View key={proveedorId} style={{ position: 'relative', zIndex: numGrupos - gi }}>
        <View style={styles.filaGrupo}>
          <View style={[styles.celdaProducto, styles.grupoIdentidad]}>
            <Text style={styles.grupoNombre} numberOfLines={1}>{nombreProveedor}</Text>
            <Text style={styles.pastilla}>{estadoTexto}</Text>
          </View>
          <View style={{ width: ANCHO_HASTA_PEDIR + SPACING.sm * 3 }} />
          <Text style={[styles.celdaNum, styles.negrita, { width: ANCHO.pedir }]}>{formatoUnidades(subtotal)}</Text>
          <View style={[styles.celdaAcciones, styles.enlaces, { width: ANCHO.acciones }]}>{enlaces}</View>
        </View>
        {celdas}
      </View>
    );
  });

  if (enTarjetas) {
    return (
      <View style={styles.lista}>
        {bloques}
        <Text style={styles.total}>Total general {formatoUnidades(total)} uds</Text>
      </View>
    );
  }

  return (
    <View style={styles.tabla}>
      <View style={styles.cabecera}>
        <Text style={[styles.th, styles.celdaProducto]}>Producto</Text>
        <Text style={[styles.th, styles.thNum, { width: ANCHO.stock }]}>Stock</Text>
        <Text style={[styles.th, styles.thNum, { width: ANCHO.formato }]}>Formato</Text>
        <Text style={[styles.th, styles.thNum, { width: ANCHO.unidad }]}>Unidad</Text>
        <Text style={[styles.th, styles.thNum, { width: ANCHO.maximo }]}>Máx. final</Text>
        <Text style={[styles.th, styles.thNum, { width: ANCHO.pedir }]}>Pedir</Text>
        <View style={{ width: ANCHO.acciones }} />
      </View>
      {bloques}
      <View style={styles.filaTotal}>
        <Text style={[styles.celdaProducto, styles.negrita]}>Total general</Text>
        <View style={{ width: ANCHO_HASTA_PEDIR + SPACING.sm * 3 }} />
        <Text style={[styles.celdaNum, styles.negrita, { width: ANCHO.pedir }]}>{formatoUnidades(total)}</Text>
        <View style={{ width: ANCHO.acciones }} />
      </View>
    </View>
  );
}

function estaAtascado(pedido: PedidoProveedor | undefined, ahora: number) {
  if ((pedido?.estado || '') !== 'enviando') return false;
  const desde = Date.parse(pedido?.enviandoDesde || '');
  if (!Number.isFinite(desde)) return true;
  return ahora - desde >= MINUTOS_ATASCO * 60 * 1000;
}

function baseVisible(linea: LineaConteo): BorradorLinea {
  return {
    cantidad: linea.cantidadPedida == null ? '' : String(linea.cantidadPedida),
    maximo: linea.maximoFinal == null ? '' : String(linea.maximoFinal),
    omitida: linea.omitida,
    proveedorId: linea.proveedorId || 'SIN_PROVEEDOR',
    proveedorNombre: linea.proveedorNombre || '',
    purchaseUnitId: linea.purchaseUnitId || '',
    unit: linea.unit || '',
  };
}

function Eleccion({
  etiqueta,
  compacto,
  valorId,
  opciones,
  placeholder,
  onElegir,
}: {
  etiqueta: string;
  compacto: boolean;
  valorId: string;
  opciones: { id: string; titulo: string }[];
  placeholder: string;
  onElegir: (id: string, nombre: string) => void;
}) {
  const alto = compacto ? 32 : MIN_TOUCH;
  if (opciones.length === 0) {
    return (
      <View style={compacto ? styles.eleccionCompacta : styles.campo}>
        {compacto ? null : <Text style={styles.etiqueta}>{etiqueta}</Text>}
        <TextInput
          value={valorId}
          onChangeText={(v) => onElegir(v.trim(), v.trim())}
          placeholder={placeholder}
          accessibilityLabel={etiqueta}
          style={[styles.input, { minHeight: alto, height: alto }]}
          keyboardType="number-pad"
        />
      </View>
    );
  }
  const lista = valorId && !opciones.some((o) => o.id === valorId)
    ? [{ id: valorId, titulo: valorId }, ...opciones]
    : opciones;
  return (
    <View style={compacto ? styles.eleccionCompacta : styles.selector}>
      <CampoSelector
        etiqueta={compacto ? undefined : etiqueta}
        alto={alto}
        radio={compacto ? 6 : 10}
        placeholder={placeholder}
        opciones={lista}
        valorId={valorId}
        onSeleccionar={(id) => {
          const op = lista.find((o) => o.id === id);
          onElegir(id, op?.titulo || id);
        }}
      />
    </View>
  );
}

function canon(texto: string) {
  const t = texto.trim().replace(',', '.');
  if (!t) return '';
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : t;
}

function InputCelda({
  valor,
  editable,
  error,
  manual,
  destacado = false,
  etiqueta,
  onChangeText,
}: {
  valor: string;
  editable: boolean;
  error: boolean;
  manual: boolean;
  destacado?: boolean;
  etiqueta: string;
  onChangeText: (v: string) => void;
}) {
  return (
    <TextInput
      value={valor}
      editable={editable}
      onChangeText={onChangeText}
      keyboardType="decimal-pad"
      accessibilityLabel={etiqueta}
      style={[
        styles.inputCelda,
        !editable && styles.inputOff,
        manual && styles.inputManual,
        destacado && styles.inputDestacado,
        error && styles.inputError,
      ]}
    />
  );
}

function Campo({
  etiqueta,
  valor,
  editable,
  error,
  manual,
  destacado = false,
  onChangeText,
}: {
  etiqueta: string;
  valor: string;
  editable: boolean;
  error: boolean;
  manual: boolean;
  destacado?: boolean;
  onChangeText: (v: string) => void;
}) {
  return (
    <View style={styles.campo}>
      <Text style={styles.etiqueta}>{etiqueta}</Text>
      <TextInput
        value={valor}
        editable={editable}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        style={[
          styles.input,
          !editable && styles.inputOff,
          manual && styles.inputManual,
          destacado && styles.inputDestacado,
          error && styles.inputError,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tabla: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: BORDE,
    borderRadius: 10,
    overflow: 'visible',
    position: 'relative',
    zIndex: 0,
  },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: BORDE,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  th: { color: SECUNDARIO, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
  thNum: { textAlign: 'right' },
  filaGrupo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: 12,
    minHeight: 40,
    paddingVertical: 4,
    backgroundColor: '#fdf2f8',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  grupoIdentidad: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  filaBloque: { position: 'relative', borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: 12,
    minHeight: 40,
    paddingVertical: 4,
  },
  filaTotal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: 12,
    minHeight: 40,
  },
  celdaProducto: { flex: 1, minWidth: 0 },
  celdaNum: { color: TEXTO, fontSize: 13, textAlign: 'right' },
  celdaInput: { alignItems: 'flex-end' },
  celdaAcciones: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: SPACING.sm },
  enlaces: { flexWrap: 'wrap', columnGap: SPACING.sm },
  negrita: { color: TEXTO, fontWeight: '700' },
  textoGris: { color: SECUNDARIO },
  nombreFila: { color: TEXTO, fontSize: 13 },
  sufijo: { color: SECUNDARIO, fontSize: 12 },
  avisoLinea: { color: SECUNDARIO, fontSize: 11 },
  elecciones: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, marginTop: 4 },
  eleccionCompacta: { width: 220, maxWidth: '100%' },
  inputCelda: {
    width: 80,
    height: 32,
    borderWidth: 1,
    borderColor: BORDE,
    borderRadius: 6,
    paddingHorizontal: 8,
    backgroundColor: '#fff',
    color: TEXTO,
    fontSize: 13,
    textAlign: 'right',
  },
  inputManual: { backgroundColor: '#fefce8', borderColor: '#facc15' },
  inputDestacado: { borderColor: ROSA_BORDE, borderWidth: 2 },
  unidadManual: { color: '#a16207' },
  icono: { alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  enlace: { justifyContent: 'center' },
  enlaceTexto: { color: ROSA, fontWeight: '700', fontSize: 12 },
  enlaceOff: { color: '#94a3b8' },
  pastilla: {
    color: SECUNDARIO,
    backgroundColor: BORDE,
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  errorFila: { color: ROJO, fontSize: 12, paddingHorizontal: 12, paddingBottom: 6 },

  lista: { gap: SPACING.md },
  grupo: { gap: SPACING.sm },
  grupoCabecera: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' },
  grupoNombre: { color: TEXTO, fontWeight: '700', flexShrink: 1 },
  grupoTotal: { color: TEXTO, fontWeight: '700' },
  tarjeta: {
    gap: SPACING.sm,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: BORDE,
    borderRadius: 12,
    padding: SPACING.md,
  },
  filaMarcada: { backgroundColor: '#fdf2f8' },
  filaError: { borderColor: ROJO, backgroundColor: '#fef2f2' },
  nombre: { color: TEXTO, fontWeight: '700' },
  tachada: { textDecorationLine: 'line-through', color: SECUNDARIO },
  meta: { color: SECUNDARIO, fontSize: 12 },
  marcas: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  marca: { color: ROSA, fontSize: 12, fontWeight: '700' },
  camposTarjeta: { gap: SPACING.sm },
  campo: { minWidth: 110, flexGrow: 1 },
  selector: { minWidth: 180, flexGrow: 1, zIndex: 20 },
  etiqueta: { color: SECUNDARIO, fontSize: 12, marginBottom: 4 },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: BORDE,
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    color: TEXTO,
  },
  inputError: { borderColor: ROJO },
  inputOff: { backgroundColor: '#f8fafc', color: SECUNDARIO },
  acciones: { flexDirection: 'row', gap: SPACING.xs },
  accion: { minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 8 },
  accionTexto: { color: ROSA, fontWeight: '700' },
  error: { width: '100%', color: ROJO, fontSize: 13 },
  total: { color: TEXTO, fontWeight: '700', fontSize: 16 },
});
