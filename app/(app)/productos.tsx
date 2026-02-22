import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Platform,
  Modal,
  Pressable,
  KeyboardAvoidingView,
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { formatId6 } from '../utils/idFormat';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const PAGE_SIZE = 50;
const MAX_TEXT_LENGTH = 30;

/** Columnas preferidas para Productos Ágora (solo campos permitidos por API) */
const PREFERRED_COLS_AGORA = ['Id', 'IGP', 'Name', 'CostPrice', 'BaseSaleFormatId', 'FamilyId', 'VatId'];

const DEFAULT_COL_WIDTH = 90;
const MAX_TEXT_LENGTH_TABLE = 30;

type Producto = Record<string, unknown>;

/** Obtiene las columnas a partir de los datos devueltos por la API */
function columnasFromProductos(
  productos: Producto[],
  preferred = PREFERRED_COLS_AGORA,
  fallback = ['Id', 'IGP', 'Name', 'CostPrice']
): string[] {
  const keySet = new Set<string>();
  for (const p of productos) {
    if (p && typeof p === 'object') {
      for (const k of Object.keys(p)) keySet.add(k);
    }
  }
  const keys = Array.from(keySet);
  const ordered: string[] = [];
  for (const preferredCol of preferred) {
    const found = keys.find((k) => k.toLowerCase() === preferredCol.toLowerCase());
    if (found) ordered.push(found);
  }
  for (const k of keys.sort()) {
    if (!ordered.includes(k)) ordered.push(k);
  }
  return ordered.length ? ordered : [...fallback];
}

function truncar(val: string, max = MAX_TEXT_LENGTH_TABLE): string {
  if (val.length <= max) return val;
  return val.slice(0, max - 3) + '…';
}

function valorPorColumna(item: Producto, col: string): unknown {
  if (item[col] !== undefined && item[col] !== null) return item[col];
  const key = Object.keys(item).find((k) => k.toLowerCase() === col.toLowerCase());
  return key != null ? item[key] : undefined;
}

export default function ProductosScreen() {
  const router = useRouter();
  const [productosAgora, setProductosAgora] = useState<Producto[]>([]);
  const [loadingAgora, setLoadingAgora] = useState(false);
  const [syncingAgora, setSyncingAgora] = useState(false);
  const [errorAgora, setErrorAgora] = useState<string | null>(null);
  const [filtroAgora, setFiltroAgora] = useState('');
  const [pageIndexAgora, setPageIndexAgora] = useState(0);
  const [modalEditarVisible, setModalEditarVisible] = useState(false);
  const [productoEditando, setProductoEditando] = useState<Producto | null>(null);
  const [formName, setFormName] = useState('');
  const [formCostPrice, setFormCostPrice] = useState('');
  const [formBaseSaleFormatId, setFormBaseSaleFormatId] = useState('');
  const [formFamilyId, setFormFamilyId] = useState('');
  const [formVatId, setFormVatId] = useState('');
  const [formIGP, setFormIGP] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [errorEditar, setErrorEditar] = useState<string | null>(null);

  const refetchProductosAgora = useCallback(() => {
    setLoadingAgora(true);
    setErrorAgora(null);
    fetch(`${API_URL}/api/agora/products`)
      .then((res) => res.json())
      .then((data: { productos?: Producto[]; error?: string }) => {
        if (data.error) {
          setErrorAgora(data.error);
          setProductosAgora([]);
        } else {
          setErrorAgora(null);
          const list = Array.isArray(data.productos) ? data.productos : [];
          setProductosAgora(
            [...list].sort((a, b) => {
              const idA = valorPorColumna(a, 'Id') ?? valorPorColumna(a, 'id');
              const idB = valorPorColumna(b, 'Id') ?? valorPorColumna(b, 'id');
              const na = typeof idA === 'number' ? idA : parseInt(String(idA ?? 0).replace(/^0+/, ''), 10) || 0;
              const nb = typeof idB === 'number' ? idB : parseInt(String(idB ?? 0).replace(/^0+/, ''), 10) || 0;
              return na - nb;
            })
          );
        }
      })
      .catch((e) => {
        setErrorAgora(e.message || 'Error de conexión');
        setProductosAgora([]);
      })
      .finally(() => setLoadingAgora(false));
  }, []);

  const toggleAgoraProductIGP = useCallback(
    async (producto: Producto) => {
      const id = valorPorColumna(producto, 'Id') ?? valorPorColumna(producto, 'id') ?? valorPorColumna(producto, 'Code');
      if (id == null) return;
      const idStr = String(id);
      const actual = valorPorColumna(producto, 'IGP');
      const nuevoVal = actual === true || actual === 'true' ? false : true;
      try {
        const res = await fetch(`${API_URL}/api/agora/products/${encodeURIComponent(idStr)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ IGP: nuevoVal }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          setProductosAgora((prev) =>
            prev.map((p) => {
              const pid = valorPorColumna(p, 'Id') ?? valorPorColumna(p, 'id') ?? valorPorColumna(p, 'Code');
              if (pid != null && String(pid) === idStr) return { ...p, IGP: nuevoVal };
              return p;
            })
          );
        }
      } catch {
        setErrorAgora('Error al actualizar IGP');
      }
    },
    []
  );

  const abrirModalEditar = useCallback((producto: Producto) => {
    setProductoEditando(producto);
    setFormName(String(valorPorColumna(producto, 'Name') ?? ''));
    setFormCostPrice(String(valorPorColumna(producto, 'CostPrice') ?? ''));
    setFormBaseSaleFormatId(String(valorPorColumna(producto, 'BaseSaleFormatId') ?? ''));
    setFormFamilyId(String(valorPorColumna(producto, 'FamilyId') ?? ''));
    setFormVatId(String(valorPorColumna(producto, 'VatId') ?? ''));
    setFormIGP(valorPorColumna(producto, 'IGP') === true || valorPorColumna(producto, 'IGP') === 'true');
    setErrorEditar(null);
    setModalEditarVisible(true);
  }, []);

  const cerrarModalEditar = useCallback(() => {
    if (!guardando) {
      setModalEditarVisible(false);
      setProductoEditando(null);
      setErrorEditar(null);
    }
  }, [guardando]);

  const guardarEdicion = useCallback(async () => {
    if (!productoEditando) return;
    const id = valorPorColumna(productoEditando, 'Id') ?? valorPorColumna(productoEditando, 'id');
    if (id == null) return;
    setGuardando(true);
    setErrorEditar(null);
    try {
      const costPriceNum = parseFloat(String(formCostPrice).replace(',', '.'));
      const body: Record<string, unknown> = {
        Name: formName.trim(),
        CostPrice: Number.isNaN(costPriceNum) ? 0 : costPriceNum,
        BaseSaleFormatId: formBaseSaleFormatId.trim() || null,
        FamilyId: formFamilyId.trim() || null,
        VatId: formVatId.trim() || null,
        IGP: formIGP,
      };
      const res = await fetch(`${API_URL}/api/agora/products/${encodeURIComponent(String(id))}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setProductosAgora((prev) =>
          prev.map((p) => {
            const pid = valorPorColumna(p, 'Id') ?? valorPorColumna(p, 'id');
            if (pid != null && String(pid) === String(id)) {
              return {
                ...p,
                Name: body.Name,
                CostPrice: body.CostPrice,
                BaseSaleFormatId: body.BaseSaleFormatId,
                FamilyId: body.FamilyId,
                VatId: body.VatId,
                IGP: body.IGP,
              };
            }
            return p;
          })
        );
        cerrarModalEditar();
      } else {
        setErrorEditar(data.error || 'Error al guardar');
      }
    } catch (e) {
      setErrorEditar(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }, [productoEditando, formName, formCostPrice, formBaseSaleFormatId, formFamilyId, formVatId, formIGP, cerrarModalEditar]);

  const syncProductosAgora = useCallback(() => {
    setSyncingAgora(true);
    setErrorAgora(null);
    fetch(`${API_URL}/api/agora/products/sync?force=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((res) => res.json())
      .then((data: { ok?: boolean; added?: number; updated?: number; unchanged?: number; fetched?: number; error?: string }) => {
        if (data.error) {
          setErrorAgora(data.error);
        } else if (data.ok) {
          if ((data.added ?? 0) > 0 || (data.updated ?? 0) > 0) {
            refetchProductosAgora();
          }
        }
      })
      .catch((e) => setErrorAgora(e.message || 'Error al sincronizar'))
      .finally(() => setSyncingAgora(false));
  }, [refetchProductosAgora]);

  /** Columnas para Productos Ágora */
  const columnasAgora = useMemo(
    () =>
      productosAgora.length > 0
        ? columnasFromProductos(productosAgora, PREFERRED_COLS_AGORA, ['Id', 'IGP', 'Name', 'CostPrice'])
        : ['Id', 'IGP', 'Name', 'CostPrice'],
    [productosAgora]
  );

  const valorCeldaAgora = useCallback((item: Producto, col: string) => {
    const raw = valorPorColumna(item, col);
    if (raw === undefined || raw === null) return '—';
    if (Array.isArray(raw)) return raw.length ? String(raw.join(', ')) : '—';
    if (typeof raw === 'object') return JSON.stringify(raw).slice(0, MAX_TEXT_LENGTH_TABLE);
    if (col === 'Price' || col === 'CostPrice') {
      const n = parseFloat(String(raw));
      if (!Number.isNaN(n)) return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    }
    const str = String(raw);
    if (col === 'Id' || col === 'id') return formatId6(str);
    return str;
  }, []);

  const productosAgoraFiltrados = useMemo(() => {
    const q = filtroAgora.trim().toLowerCase();
    if (!q) return productosAgora;
    return productosAgora.filter((p) =>
      columnasAgora.some((col) => {
        const val = valorCeldaAgora(p, col);
        return val !== '—' && val.toLowerCase().includes(q);
      })
    );
  }, [productosAgora, filtroAgora, columnasAgora, valorCeldaAgora]);

  const totalFiltradosAgora = productosAgoraFiltrados.length;
  const totalPagesAgora = Math.max(1, Math.ceil(totalFiltradosAgora / PAGE_SIZE));
  const pageIndexClampedAgora = Math.min(Math.max(0, pageIndexAgora), totalPagesAgora - 1);

  const productosAgoraPagina = useMemo(() => {
    const start = pageIndexClampedAgora * PAGE_SIZE;
    return productosAgoraFiltrados.slice(start, start + PAGE_SIZE);
  }, [productosAgoraFiltrados, pageIndexClampedAgora]);

  useEffect(() => {
    setPageIndexAgora((prev) => (prev >= totalPagesAgora ? Math.max(0, totalPagesAgora - 1) : prev));
  }, [totalPagesAgora]);

  useEffect(() => {
    setPageIndexAgora(0);
  }, [filtroAgora]);

  const goPrevPageAgora = () => setPageIndexAgora((p) => Math.max(0, p - 1));
  const goNextPageAgora = () => setPageIndexAgora((p) => Math.min(totalPagesAgora - 1, p + 1));

  useEffect(() => {
    refetchProductosAgora();
  }, [refetchProductosAgora]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Productos Ágora</Text>
      </View>

      {
        <View style={styles.agoraContent}>
          <View style={styles.agoraToolbar}>
            <TouchableOpacity
              style={styles.reloadBtn}
              onPress={refetchProductosAgora}
              disabled={loadingAgora}
              accessibilityLabel="Recargar"
            >
              {loadingAgora ? (
                <ActivityIndicator size="small" color="#0ea5e9" />
              ) : (
                <MaterialIcons name="refresh" size={22} color="#0ea5e9" />
              )}
              <Text style={styles.reloadBtnText}>Recargar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.reloadBtn}
              onPress={syncProductosAgora}
              disabled={syncingAgora}
              accessibilityLabel="Sincronizar desde Ágora"
            >
              {syncingAgora ? (
                <ActivityIndicator size="small" color="#0ea5e9" />
              ) : (
                <MaterialIcons name="sync" size={22} color="#0ea5e9" />
              )}
              <Text style={styles.reloadBtnText}>Sincronizar</Text>
            </TouchableOpacity>
            <View style={styles.searchWrap}>
              <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
              <TextInput
                style={styles.searchInput}
                value={filtroAgora}
                onChangeText={setFiltroAgora}
                placeholder="Buscar en la tabla…"
                placeholderTextColor="#94a3b8"
              />
            </View>
          </View>
          {loadingAgora && productosAgora.length === 0 ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#0ea5e9" />
              <Text style={styles.loadingText}>Cargando productos Ágora…</Text>
            </View>
          ) : errorAgora && productosAgora.length === 0 ? (
            <View style={styles.center}>
              <MaterialIcons name="error-outline" size={48} color="#f87171" />
              <Text style={styles.errorText}>{errorAgora}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={refetchProductosAgora}>
                <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
                <Text style={styles.retryBtnText}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={styles.subtitle}>
                {productosAgoraFiltrados.length} registro{productosAgoraFiltrados.length !== 1 ? 's' : ''}
                {totalPagesAgora > 1 && ` · Página ${pageIndexClampedAgora + 1} de ${totalPagesAgora}`}
              </Text>
              <ScrollView horizontal style={styles.scroll} contentContainerStyle={[styles.scrollContent, { flexGrow: 1 }]}>
                <View style={[styles.table, styles.tableAgora, { minWidth: columnasAgora.reduce((w, c) => w + (c === 'IGP' ? 56 : c === 'Name' ? 180 : DEFAULT_COL_WIDTH), 0) + 44 }]}>
                  <View style={styles.rowHeaderAgora}>
                    {columnasAgora.map((col) => (
                      <View key={col} style={[styles.cellHeaderAgora, { width: col === 'IGP' ? 56 : col === 'Name' ? 180 : DEFAULT_COL_WIDTH }]}>
                        <Text style={styles.cellHeaderTextAgora} numberOfLines={1} ellipsizeMode="tail">{col}</Text>
                      </View>
                    ))}
                    <View style={[styles.cellHeaderAgora, { width: 44 }]}>
                      <Text style={styles.cellHeaderTextAgora}>—</Text>
                    </View>
                  </View>
                  <ScrollView style={styles.agoraBodyScroll} nestedScrollEnabled>
                  {productosAgoraPagina.map((p, idx) => {
                    const rowId = valorPorColumna(p, 'Id') ?? valorPorColumna(p, 'id');
                    return (
                    <View
                      key={rowId != null ? String(rowId) : `page-${pageIndexClampedAgora}-${idx}`}
                      style={styles.rowAgora}
                    >
                      {columnasAgora.map((col) => {
                        const isMoneda = col === 'CostPrice';
                        const isIGP = col === 'IGP';
                        const colWidth = isIGP ? 56 : col === 'Name' ? 180 : DEFAULT_COL_WIDTH;
                        const igpVal = isIGP && (valorPorColumna(p, 'IGP') === true || valorPorColumna(p, 'IGP') === 'true');
                        if (isIGP) {
                          return (
                            <TouchableOpacity
                              key={col}
                              style={[styles.cellAgora, styles.cellIGP, { width: colWidth }]}
                              onPress={() => toggleAgoraProductIGP(p)}
                              activeOpacity={0.7}
                            >
                              <MaterialIcons
                                name={igpVal ? 'check-box' : 'check-box-outline-blank'}
                                size={18}
                                color={igpVal ? '#0ea5e9' : '#94a3b8'}
                              />
                            </TouchableOpacity>
                          );
                        }
                        return (
                          <View
                            key={col}
                            style={[
                              styles.cellAgora,
                              { width: colWidth },
                              isMoneda && styles.cellRight,
                            ]}
                          >
                            <Text style={[styles.cellTextAgora, isMoneda && styles.cellTextRight]} numberOfLines={1} ellipsizeMode="tail">
                              {truncar(valorCeldaAgora(p, col))}
                            </Text>
                          </View>
                        );
                      })}
                      <TouchableOpacity
                        style={[styles.cellAgora, styles.cellEditarAgora, { width: 44 }]}
                        onPress={() => abrirModalEditar(p)}
                        accessibilityLabel="Editar"
                      >
                        <MaterialIcons name="edit" size={16} color="#0ea5e9" />
                      </TouchableOpacity>
                    </View>
                  );
                  })}
                  </ScrollView>
                </View>
              </ScrollView>
              {totalPagesAgora > 1 && (
                <View style={styles.paginacionAgora}>
                  <TouchableOpacity
                    style={[styles.pagBtn, pageIndexClampedAgora === 0 && styles.pagBtnDisabled]}
                    onPress={goPrevPageAgora}
                    disabled={pageIndexClampedAgora === 0}
                  >
                    <MaterialIcons name="chevron-left" size={20} color={pageIndexClampedAgora === 0 ? '#94a3b8' : '#0ea5e9'} />
                    <Text style={[styles.pagBtnText, pageIndexClampedAgora === 0 && styles.pagBtnTextDisabled]}>Anterior</Text>
                  </TouchableOpacity>
                  <Text style={styles.pagInfo}>
                    {pageIndexClampedAgora * PAGE_SIZE + 1}-{Math.min((pageIndexClampedAgora + 1) * PAGE_SIZE, totalFiltradosAgora)} de {totalFiltradosAgora}
                  </Text>
                  <TouchableOpacity
                    style={[styles.pagBtn, pageIndexClampedAgora >= totalPagesAgora - 1 && styles.pagBtnDisabled]}
                    onPress={goNextPageAgora}
                    disabled={pageIndexClampedAgora >= totalPagesAgora - 1}
                  >
                    <Text style={[styles.pagBtnText, pageIndexClampedAgora >= totalPagesAgora - 1 && styles.pagBtnTextDisabled]}>Siguiente</Text>
                    <MaterialIcons name="chevron-right" size={20} color={pageIndexClampedAgora >= totalPagesAgora - 1 ? '#94a3b8' : '#0ea5e9'} />
                  </TouchableOpacity>
                </View>
              )}
              {productosAgoraFiltrados.length === 0 && (
                <Text style={styles.emptyText}>
                  {filtroAgora.trim()
                    ? 'Ningún resultado con el filtro'
                    : 'No hay productos. Pulsa Sincronizar para cargar desde Ágora a DynamoDB.'}
                </Text>
              )}
            </>
          )}
        </View>
      }

      <Modal visible={modalEditarVisible} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={cerrarModalEditar}>
          <KeyboardAvoidingView style={styles.modalCenter} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={styles.modalCardTouch} onPress={(e) => e.stopPropagation()}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Editar producto</Text>
                  <TouchableOpacity onPress={cerrarModalEditar} style={styles.modalClose} disabled={guardando}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                  <View style={styles.modalBodyRow}>
                    {productoEditando && (
                      <View style={styles.modalIdSide}>
                        <Text style={styles.modalIdLabel}>Id</Text>
                        <Text style={styles.modalIdValue}>{formatId6(String(valorPorColumna(productoEditando, 'Id') ?? ''))}</Text>
                      </View>
                    )}
                    <View style={styles.modalBody}>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>Name</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formName}
                          onChangeText={setFormName}
                          placeholder="Nombre del producto"
                          placeholderTextColor="#94a3b8"
                          editable={!guardando}
                        />
                      </View>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>CostPrice (€)</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formCostPrice}
                          onChangeText={setFormCostPrice}
                          placeholder="0.00"
                          placeholderTextColor="#94a3b8"
                          keyboardType="decimal-pad"
                          editable={!guardando}
                        />
                      </View>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>BaseSaleFormatId</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formBaseSaleFormatId}
                          onChangeText={setFormBaseSaleFormatId}
                          placeholder="Opcional"
                          placeholderTextColor="#94a3b8"
                          editable={!guardando}
                        />
                      </View>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>FamilyId</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formFamilyId}
                          onChangeText={setFormFamilyId}
                          placeholder="Opcional"
                          placeholderTextColor="#94a3b8"
                          editable={!guardando}
                        />
                      </View>
                      <View style={styles.formGroup}>
                        <Text style={styles.formLabel}>VatId</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formVatId}
                          onChangeText={setFormVatId}
                          placeholder="Opcional"
                          placeholderTextColor="#94a3b8"
                          editable={!guardando}
                        />
                      </View>
                      <View style={[styles.formGroup, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                        <Text style={styles.formLabel}>IGP</Text>
                        <Switch
                          value={formIGP}
                          onValueChange={setFormIGP}
                          disabled={guardando}
                          trackColor={{ false: '#e2e8f0', true: '#0ea5e9' }}
                          thumbColor="#fff"
                        />
                      </View>
                    </View>
                  </View>
                </ScrollView>
                {errorEditar ? <Text style={styles.modalError}>{errorEditar}</Text> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalFooterBtn} onPress={cerrarModalEditar} disabled={guardando}>
                    <Text style={styles.reloadBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalFooterBtn, { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' }]}
                    onPress={guardarEdicion}
                    disabled={guardando}
                  >
                    {guardando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={[styles.reloadBtnText, { color: '#fff' }]}>Guardar</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155', flex: 1 },
  agoraContent: { flex: 1 },
  agoraToolbar: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  reloadBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#f1f5f9', borderRadius: 8 },
  reloadBtnText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f1f5f9', borderRadius: 8, paddingHorizontal: 10 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 13, color: '#334155' },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  table: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  tableAgora: { flex: 1 },
  rowHeader: { flexDirection: 'row', backgroundColor: '#f1f5f9', borderBottomWidth: 2, borderBottomColor: '#e2e8f0' },
  cellHeader: { paddingVertical: 10, paddingHorizontal: 10 },
  cellHeaderText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0' },
  cell: { paddingVertical: 8, paddingHorizontal: 10 },
  cellIGP: { alignItems: 'center', justifyContent: 'center' },
  cellText: { fontSize: 12, color: '#334155' },
  rowHeaderAgora: { flexDirection: 'row', backgroundColor: '#f1f5f9', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  cellHeaderAgora: { paddingVertical: 5, paddingHorizontal: 6 },
  cellHeaderTextAgora: { fontSize: 9, fontWeight: '600', color: '#334155' },
  agoraBodyScroll: { flex: 1, minHeight: 200 },
  rowAgora: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0' },
  cellAgora: { paddingVertical: 4, paddingHorizontal: 6 },
  cellTextAgora: { fontSize: 10, color: '#334155' },
  cellEditarAgora: { alignItems: 'center', justifyContent: 'center' },
  cellRight: { alignItems: 'flex-end' },
  cellTextRight: { textAlign: 'right' },
  subtitle: { fontSize: 12, color: '#64748b', marginBottom: 6 },
  emptyText: { fontSize: 12, color: '#94a3b8', textAlign: 'center', marginTop: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, padding: 8, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  retryBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  paginacionAgora: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 12, paddingVertical: 8 },
  pagBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#f1f5f9', borderRadius: 8 },
  pagBtnDisabled: { opacity: 0.6 },
  pagBtnText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },
  pagBtnTextDisabled: { color: '#94a3b8' },
  pagInfo: { fontSize: 12, color: '#64748b' },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', width: '100%', padding: 20 },
  modalContentWrap: { width: '100%', maxWidth: 420, padding: 24, alignItems: 'center' },
  modalCardTouch: { width: '100%' },
  modalCard: { width: '100%', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderRadius: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBodyRow: { flexDirection: 'row' },
  modalIdSide: { width: 56, paddingVertical: 12, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0', alignItems: 'center', justifyContent: 'flex-start' },
  modalIdLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', marginBottom: 2 },
  modalIdValue: { fontSize: 14, fontWeight: '600', color: '#334155' },
  modalBody: { flex: 1, maxHeight: 400, paddingHorizontal: 16, paddingVertical: 12 },
  formGroup: { marginBottom: 8 },
  formLabel: { fontSize: 10, fontWeight: '500', color: '#475569', marginBottom: 2 },
  formInput: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, fontSize: 13, color: '#334155' },
  modalError: { fontSize: 11, color: '#f87171', paddingHorizontal: 20, paddingVertical: 4 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  modalFooterBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  importHelpText: { fontSize: 12, color: '#475569', marginBottom: 16, lineHeight: 18 },
  importButtonsRow: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  importOptionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  importOptionLabel: { fontSize: 12, color: '#334155', fontWeight: '500' },
  importSuccessText: { fontSize: 11, color: '#22c55e', paddingHorizontal: 20, paddingVertical: 4 },
});
