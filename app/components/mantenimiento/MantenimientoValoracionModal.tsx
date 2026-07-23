import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { apiFetch } from '../../utils/api';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { SelectorDesplegable } from '../SelectorDesplegable';

export type LineaValoracionInput = {
  id_producto?: string;
  articulo: string;
  cantidad: number;
  precio: number;
  tipo_iva: number;
};

type Props = {
  visible: boolean;
  titulo?: string;
  guardando?: boolean;
  error?: string | null;
  onClose: () => void;
  onGuardar: (lineas: LineaValoracionInput[]) => void | Promise<void>;
};

type Producto = Record<string, unknown>;

type LineaState = {
  key: string;
  id_producto?: string;
  articulo: string;
  cantidad: string;
  precio: string;
  tipo_iva: string;
};

const IVA_DEFECTO = '21';

function nuevoKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function lineaVacia(): LineaState {
  return { key: nuevoKey(), articulo: '', cantidad: '1', precio: '', tipo_iva: IVA_DEFECTO };
}

function toNum(v: string): number {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function fmt(n: number): string {
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function nombreProducto(p: Producto): string {
  return (p.Nombre ?? p.nombre ?? p.Name ?? '').toString().trim();
}

function idProducto(p: Producto): string {
  return (p.id_producto ?? p.Id ?? '').toString().trim();
}

function precioProducto(p: Producto): string {
  const raw = p.precio ?? p.Precio ?? p.Price ?? '';
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

function ivaProducto(p: Producto): string {
  const raw = p.iva ?? p.Iva ?? p.IVA ?? p.VatPercent ?? '';
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? String(n) : IVA_DEFECTO;
}

export function MantenimientoValoracionModal({
  visible,
  titulo,
  guardando,
  error,
  onClose,
  onGuardar,
}: Props) {
  const { isCompact } = useBreakpoint();
  const [productos, setProductos] = useState<Producto[]>([]);
  const [cargandoProd, setCargandoProd] = useState(false);
  const [lineas, setLineas] = useState<LineaState[]>([lineaVacia()]);
  const [errorLocal, setErrorLocal] = useState<string | null>(null);

  // Alta rápida de producto
  const [nuevoVisible, setNuevoVisible] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoPrecio, setNuevoPrecio] = useState('');
  const [nuevoIva, setNuevoIva] = useState(IVA_DEFECTO);
  const [guardandoNuevo, setGuardandoNuevo] = useState(false);
  const [lineaDestino, setLineaDestino] = useState<string | null>(null);

  const cargarProductos = useCallback(() => {
    setCargandoProd(true);
    apiFetch('/api/productos')
      .then((r) => r.json())
      .then((d: { productos?: Producto[] }) => setProductos(d.productos ?? []))
      .catch(() => setProductos([]))
      .finally(() => setCargandoProd(false));
  }, []);

  useEffect(() => {
    if (visible) {
      setLineas([lineaVacia()]);
      setErrorLocal(null);
      cargarProductos();
    }
  }, [visible, cargarProductos]);

  const opcionesProductos = useMemo(
    () =>
      productos
        .map((p) => {
          const id = idProducto(p);
          const nombre = nombreProducto(p);
          const precio = precioProducto(p);
          return {
            id: id || nombre,
            titulo: nombre || '(sin nombre)',
            subtitulo: precio ? `${fmt(Number(precio))} € · IVA ${ivaProducto(p)}%` : undefined,
          };
        })
        .filter((o) => o.titulo && o.titulo !== '(sin nombre)')
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es', { sensitivity: 'base' })),
    [productos],
  );

  const totales = useMemo(() => {
    let base = 0;
    let iva = 0;
    for (const l of lineas) {
      const cant = toNum(l.cantidad);
      const precio = toNum(l.precio);
      const tipo = l.tipo_iva === '' ? 21 : toNum(l.tipo_iva);
      if (cant <= 0 || !l.articulo.trim()) continue;
      const bLinea = cant * precio;
      base += bLinea;
      iva += (bLinea * tipo) / 100;
    }
    return { base, iva, total: base + iva };
  }, [lineas]);

  const updateLinea = useCallback((key: string, patch: Partial<LineaState>) => {
    setLineas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }, []);

  const seleccionarProducto = useCallback(
    (key: string, prodId: string) => {
      const p = productos.find((x) => idProducto(x) === prodId || nombreProducto(x) === prodId);
      if (!p) return;
      updateLinea(key, {
        id_producto: idProducto(p) || undefined,
        articulo: nombreProducto(p),
        precio: precioProducto(p) || '',
        tipo_iva: ivaProducto(p),
      });
    },
    [productos, updateLinea],
  );

  const addLinea = useCallback(() => setLineas((prev) => [...prev, lineaVacia()]), []);
  const removeLinea = useCallback(
    (key: string) => setLineas((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.key !== key))),
    [],
  );

  const abrirNuevoProducto = useCallback((key: string) => {
    setLineaDestino(key);
    setNuevoNombre('');
    setNuevoPrecio('');
    setNuevoIva(IVA_DEFECTO);
    setNuevoVisible(true);
  }, []);

  const guardarNuevoProducto = useCallback(async () => {
    const nombre = nuevoNombre.trim();
    if (!nombre) {
      setErrorLocal('El nombre del producto es obligatorio');
      return;
    }
    setGuardandoNuevo(true);
    setErrorLocal(null);
    try {
      const res = await apiFetch('/api/productos', {
        method: 'POST',
        body: JSON.stringify({ Nombre: nombre, precio: toNum(nuevoPrecio), iva: nuevoIva === '' ? 21 : toNum(nuevoIva) }),
      });
      const data = (await res.json()) as { producto?: Producto; error?: string };
      if (!res.ok || !data.producto) {
        setErrorLocal(data.error ?? 'No se pudo crear el producto');
        return;
      }
      setProductos((prev) => [...prev, data.producto as Producto]);
      const nuevoId = idProducto(data.producto);
      if (lineaDestino) {
        updateLinea(lineaDestino, {
          id_producto: nuevoId || undefined,
          articulo: nombre,
          precio: precioProducto(data.producto) || (nuevoPrecio ? String(toNum(nuevoPrecio)) : ''),
          tipo_iva: nuevoIva === '' ? IVA_DEFECTO : nuevoIva,
        });
      }
      setNuevoVisible(false);
      setLineaDestino(null);
    } catch (e) {
      setErrorLocal(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardandoNuevo(false);
    }
  }, [nuevoNombre, nuevoPrecio, nuevoIva, lineaDestino, updateLinea]);

  const handleGuardar = useCallback(() => {
    const validas: LineaValoracionInput[] = [];
    for (const l of lineas) {
      const articulo = l.articulo.trim();
      const cantidad = toNum(l.cantidad);
      const precio = toNum(l.precio);
      const tipo = l.tipo_iva === '' ? 21 : toNum(l.tipo_iva);
      if (!articulo || cantidad <= 0 || precio < 0) continue;
      validas.push({ id_producto: l.id_producto, articulo, cantidad, precio, tipo_iva: tipo });
    }
    if (validas.length === 0) {
      setErrorLocal('Añade al menos una línea con artículo, cantidad y precio');
      return;
    }
    setErrorLocal(null);
    void onGuardar(validas);
  }, [lineas, onGuardar]);

  if (!visible) return null;

  const errorMostrar = errorLocal ?? error ?? null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.card, isCompact && styles.cardCompact]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>Valoración de la reparación</Text>
              {titulo ? (
                <Text style={styles.title} numberOfLines={2}>
                  {titulo}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Cerrar">
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionLabel}>Conceptos a cobrar</Text>

            {lineas.map((l, idx) => {
              const cant = toNum(l.cantidad);
              const precio = toNum(l.precio);
              const tipo = l.tipo_iva === '' ? 21 : toNum(l.tipo_iva);
              const totalLinea = cant > 0 ? cant * precio * (1 + tipo / 100) : 0;
              return (
                <View key={l.key} style={styles.lineaCard}>
                  <View style={styles.lineaTopRow}>
                    <Text style={styles.lineaNum}>#{idx + 1}</Text>
                    <View style={styles.lineaSelectorWrap}>
                      <SelectorDesplegable
                        placeholder="Selecciona artículo…"
                        icono="inventory-2"
                        opciones={opcionesProductos}
                        valorId={l.id_producto ?? (l.articulo ? l.articulo : null)}
                        onSeleccionar={(id) => seleccionarProducto(l.key, id)}
                        tituloLista="Artículos"
                        iconoLista="inventory-2"
                        loading={cargandoProd}
                        buscador
                        buscadorPlaceholder="Buscar artículo…"
                        compact
                      />
                    </View>
                    <TouchableOpacity
                      onPress={() => abrirNuevoProducto(l.key)}
                      style={styles.nuevoProdBtn}
                      accessibilityLabel="Crear nuevo artículo"
                    >
                      <MaterialIcons name="add" size={16} color="#0ea5e9" />
                    </TouchableOpacity>
                    {lineas.length > 1 ? (
                      <TouchableOpacity
                        onPress={() => removeLinea(l.key)}
                        style={styles.delBtn}
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
                        style={styles.input}
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
                        style={styles.input}
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
                        style={styles.input}
                        value={l.tipo_iva}
                        onChangeText={(v) => updateLinea(l.key, { tipo_iva: v })}
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

            <TouchableOpacity style={styles.addLineBtn} onPress={addLinea}>
              <MaterialIcons name="add" size={18} color="#0ea5e9" />
              <Text style={styles.addLineTxt}>Añadir línea</Text>
            </TouchableOpacity>

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

      {/* Alta rápida de producto */}
      {nuevoVisible ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setNuevoVisible(false)}>
          <View style={styles.overlay}>
            <View style={styles.nuevoCard}>
              <View style={styles.header}>
                <Text style={styles.title}>Nuevo artículo</Text>
                <TouchableOpacity onPress={() => setNuevoVisible(false)} style={styles.closeBtn} accessibilityLabel="Cerrar">
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.nuevoBody}>
                <View>
                  <Text style={styles.campoLabel}>Nombre</Text>
                  <TextInput
                    style={styles.input}
                    value={nuevoNombre}
                    onChangeText={setNuevoNombre}
                    placeholder="Nombre del artículo"
                    placeholderTextColor="#cbd5e1"
                    autoFocus={Platform.OS === 'web'}
                  />
                </View>
                <View style={styles.nuevoFieldsRow}>
                  <View style={styles.campo}>
                    <Text style={styles.campoLabel}>Precio (sin IVA)</Text>
                    <TextInput
                      style={styles.input}
                      value={nuevoPrecio}
                      onChangeText={setNuevoPrecio}
                      keyboardType="decimal-pad"
                      placeholder="0,00"
                      placeholderTextColor="#cbd5e1"
                    />
                  </View>
                  <View style={styles.campoSm}>
                    <Text style={styles.campoLabel}>IVA %</Text>
                    <TextInput
                      style={styles.input}
                      value={nuevoIva}
                      onChangeText={setNuevoIva}
                      keyboardType="decimal-pad"
                      placeholder="21"
                      placeholderTextColor="#cbd5e1"
                    />
                  </View>
                </View>
              </View>
              <View style={styles.footer}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setNuevoVisible(false)} disabled={guardandoNuevo}>
                  <Text style={styles.cancelBtnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.guardarBtn} onPress={() => void guardarNuevoProducto()} disabled={guardandoNuevo}>
                  {guardandoNuevo ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <MaterialIcons name="check" size={18} color="#fff" />
                      <Text style={styles.guardarBtnText}>Crear</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
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
  closeBtn: { padding: 4 },
  scroll: { flexGrow: 0 },
  scrollContent: { padding: 16, gap: 10 },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: '#64748b' },
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
  lineaSelectorWrap: { flex: 1, minWidth: 0 },
  nuevoProdBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  delBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  nuevoCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  nuevoBody: { padding: 16, gap: 12 },
  nuevoFieldsRow: { flexDirection: 'row', gap: 10 },
});
