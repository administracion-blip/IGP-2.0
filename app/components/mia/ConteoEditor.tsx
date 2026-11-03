/**
 * Líneas del conteo agrupadas por proveedor.
 * La cantidad y el máximo final se editan; quitar y restaurar marcan la fila.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MIN_TOUCH, SPACING } from '../../constants/layout';
import { SelectorDesplegable } from '../SelectorDesplegable';

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
  puedeEditar: boolean;
  puedeAprobar: boolean;
  puedeConfirmar: boolean;
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

export function ConteoEditor({
  lineas,
  borradores,
  errores,
  pedidos,
  proveedores = [],
  puedeEditar,
  puedeAprobar,
  puedeConfirmar,
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

  const bloques = [...grupos.entries()].map(([proveedorId, filas]) => {
    const pedido = pedidos.find((p) => p.proveedorId === proveedorId);
    let subtotal = 0;
    const celdas = filas.map((linea) => {
      const clave = claveLinea(linea);
      const borrador = borradores[clave] ?? baseVisible(linea);
      const error = errores[clave];
      const unidades = unidadesDe(borrador.cantidad, borrador.omitida);
      subtotal += unidades;
      const manualCantidad = !borrador.omitida && canon(borrador.cantidad) !== canon(String(linea.cantidadCalculada));
      const manualMaximo = canon(borrador.maximo) !== canon(linea.maximoCalculado == null ? '' : String(linea.maximoCalculado));
      const sinProveedor = !linea.proveedorId || linea.proveedorId === 'SIN_PROVEEDOR';
      const sinUnidad = !String(linea.purchaseUnitId || '').trim() || !String(linea.unit || '').trim();
      const proveedorManual = linea.proveedorManual === true || (sinProveedor && borrador.proveedorId !== linea.proveedorId);
      const unidadManual = linea.unidadManual === true || (sinUnidad && borrador.purchaseUnitId !== (linea.purchaseUnitId || ''));
      return (
        <View key={clave} style={[enTarjetas ? styles.tarjeta : styles.fila, (error || borrador.omitida) && styles.filaMarcada, error && styles.filaError]}>
          <View style={enTarjetas ? undefined : styles.identidad}>
            <Text style={[styles.nombre, borrador.omitida && styles.tachada]} numberOfLines={2}>{linea.nombre}</Text>
            <Text style={styles.meta} numberOfLines={2}>
              {linea.stockReal == null ? 'Sin contar' : `Stock ${formatoUnidades(linea.stockReal)}`}
              {linea.formatoCompra != null ? ` · Formato ${formatoUnidades(linea.formatoCompra)}` : ''}
              {linea.aviso ? ` · ${linea.aviso}` : ''}
            </Text>
            <View style={styles.marcas}>
              {borrador.omitida ? <Text style={styles.marca}>Quitada</Text> : null}
              {manualCantidad ? <Text style={styles.marca}>Cantidad manual</Text> : null}
              {manualMaximo ? <Text style={styles.marca}>Máximo manual</Text> : null}
              {proveedorManual ? <Text style={styles.marca}>Proveedor manual</Text> : null}
              {unidadManual ? <Text style={styles.marca}>Unidad manual</Text> : null}
            </View>
            {puedeEditar && sinProveedor ? (
              <Eleccion
                etiqueta="Proveedor"
                valorId={borrador.proveedorId === 'SIN_PROVEEDOR' ? '' : borrador.proveedorId}
                opciones={proveedores.map((p) => ({ id: p.proveedorId, titulo: p.proveedorNombre || p.proveedorId }))}
                placeholder="Elige proveedor"
                onElegir={(id, nombre) => onElegir(clave, 'proveedor', id, nombre)}
              />
            ) : null}
            {puedeEditar && sinUnidad ? (
              <Eleccion
                etiqueta="Unidad"
                valorId={borrador.purchaseUnitId}
                opciones={(linea.unidades || []).map((u) => ({ id: u.id, titulo: u.nombre || u.id }))}
                placeholder="Elige unidad"
                onElegir={(id, nombre) => onElegir(clave, 'unidad', id, nombre)}
              />
            ) : null}
          </View>
          <View style={enTarjetas ? styles.camposTarjeta : styles.campos}>
            <Campo
              etiqueta="Cantidad"
              valor={borrador.cantidad}
              editable={puedeEditar && !borrador.omitida}
              error={!!error}
              onChangeText={(v) => onCambio(clave, 'cantidad', v)}
            />
            <Campo
              etiqueta="Máximo final"
              valor={borrador.maximo}
              editable={puedeEditar}
              error={!!error}
              onChangeText={(v) => onCambio(clave, 'maximo', v)}
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
    });
    total += subtotal;
    const atascado = estaAtascado(pedido, ahora);
    return (
      <View key={proveedorId} style={styles.grupo}>
        <View style={styles.grupoCabecera}>
          <Text style={styles.grupoNombre}>{pedido?.proveedorNombre || filas[0]?.proveedorNombre || proveedorId}</Text>
          <Text style={styles.grupoEstado}>
            {ESTADO[pedido?.estado || 'generado'] || pedido?.estado}
            {atascado ? ' · atascado' : ''}
          </Text>
          <Text style={styles.grupoTotal}>{formatoUnidades(subtotal)} uds</Text>
          <Pressable
            style={styles.accion}
            disabled={aprobando || comprobando}
            onPress={() => onDescargar(proveedorId)}
            accessibilityRole="button"
          >
            <Text style={styles.accionTexto}>Descargar PDF</Text>
          </Pressable>
          {puedeAprobar && atascado ? (
            <Pressable
              style={styles.accion}
              disabled={aprobando || comprobando}
              onPress={() => onComprobar(proveedorId)}
              accessibilityRole="button"
            >
              <Text style={styles.accionTexto}>Comprobar en Ágora</Text>
            </Pressable>
          ) : null}
          {puedeAprobar && (pedido?.estado || 'generado') === 'generado' ? (
            <View style={styles.aprobar}>
              <Pressable
                style={styles.accion}
                disabled={aprobando || comprobando}
                onPress={() => onAprobar(proveedorId, false)}
                accessibilityRole="button"
              >
                <Text style={styles.accionTexto}>Aprobar</Text>
              </Pressable>
              {puedeConfirmar ? (
                <Pressable
                  style={styles.accion}
                  disabled={aprobando || comprobando}
                  onPress={() => onAprobar(proveedorId, true)}
                  accessibilityRole="button"
                >
                  <Text style={styles.accionTexto}>Confirmar</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
        {celdas}
      </View>
    );
  });

  return (
    <View style={styles.lista}>
      {bloques}
      <Text style={styles.total}>Total general {formatoUnidades(total)} uds</Text>
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
  valorId,
  opciones,
  placeholder,
  onElegir,
}: {
  etiqueta: string;
  valorId: string;
  opciones: { id: string; titulo: string }[];
  placeholder: string;
  onElegir: (id: string, nombre: string) => void;
}) {
  if (opciones.length === 0) {
    return (
      <View style={styles.campo}>
        <Text style={styles.etiqueta}>{etiqueta}</Text>
        <TextInput
          value={valorId}
          onChangeText={(v) => onElegir(v.trim(), v.trim())}
          placeholder={placeholder}
          style={styles.input}
          keyboardType="number-pad"
        />
      </View>
    );
  }
  const lista = valorId && !opciones.some((o) => o.id === valorId)
    ? [{ id: valorId, titulo: valorId }, ...opciones]
    : opciones;
  return (
    <View style={styles.selector}>
      <SelectorDesplegable
        label={etiqueta}
        placeholder={placeholder}
        opciones={lista}
        valorId={valorId}
        onSeleccionar={(id) => {
          const op = lista.find((o) => o.id === id);
          onElegir(id, op?.titulo || id);
        }}
        compact
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

function Campo({
  etiqueta,
  valor,
  editable,
  error,
  onChangeText,
}: {
  etiqueta: string;
  valor: string;
  editable: boolean;
  error: boolean;
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
        style={[styles.input, error && styles.inputError, !editable && styles.inputOff]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  lista: { gap: SPACING.md, padding: SPACING.lg },
  grupo: { gap: SPACING.sm },
  grupoCabecera: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' },
  grupoNombre: { color: TEXTO, fontWeight: '700', flexGrow: 1 },
  grupoEstado: { color: SECUNDARIO, fontSize: 13 },
  grupoTotal: { color: TEXTO, fontWeight: '700' },
  fila: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: SPACING.sm,
  },
  tarjeta: {
    gap: SPACING.sm,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: SPACING.md,
  },
  filaMarcada: { backgroundColor: '#fdf2f8' },
  filaError: { borderColor: ROJO, backgroundColor: '#fef2f2' },
  identidad: { flexGrow: 1, flexBasis: 180 },
  nombre: { color: TEXTO, fontWeight: '700' },
  tachada: { textDecorationLine: 'line-through', color: SECUNDARIO },
  meta: { color: SECUNDARIO, fontSize: 12, marginTop: 2 },
  marcas: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  marca: { color: ROSA, fontSize: 12, fontWeight: '700' },
  campos: { flexDirection: 'row', gap: SPACING.sm },
  camposTarjeta: { gap: SPACING.sm },
  campo: { minWidth: 110, flexGrow: 1 },
  selector: { minWidth: 180, flexGrow: 1, zIndex: 20 },
  etiqueta: { color: SECUNDARIO, fontSize: 12, marginBottom: 4 },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    color: TEXTO,
  },
  inputError: { borderColor: ROJO },
  inputOff: { backgroundColor: '#f8fafc', color: SECUNDARIO },
  aprobar: { flexDirection: 'row', gap: SPACING.xs },
  acciones: { flexDirection: 'row', gap: SPACING.xs },
  accion: { minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 8 },
  accionTexto: { color: ROSA, fontWeight: '700' },
  error: { width: '100%', color: ROJO, fontSize: 13 },
  total: { color: TEXTO, fontWeight: '700', fontSize: 16 },
});
