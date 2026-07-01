import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Platform,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { InputFecha } from '../../components/InputFecha';
import { useComprasProveedorCache } from '../../contexts/ComprasProveedorCache';
import { apiFetch } from '../../utils/api';
import { formatMoneda } from '../../utils/formatMoneda';
import {
  CompraLinea,
  albaranKey,
  albaranLabel,
  fechaLineaISO,
  idNorm,
  styles,
  TOOLBAR_ICON_SIZE,
  ComprasToolbarIconBtn,
} from './comprasProveedorShared';

/** Normaliza CIF/NIF para comparar (solo A–Z0–9, mayúsculas). Equivalente al de backend. */
function normalizeCif(val: unknown): string {
  return String(val ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function normNombre(val: unknown): string {
  return String(val ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatFechaCorta(iso: string): string {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

type Almacen = Record<string, string | number | undefined>;
type Empresa = Record<string, string | number | undefined>;

/** Periodos rápidos (chips). Calculan un rango ISO sobre la fecha de albarán. */
type PeriodoChip = { id: string; label: string };
const PERIODOS: PeriodoChip[] = [
  { id: 'mes', label: 'Este mes' },
  { id: 'mes_ant', label: 'Mes anterior' },
  { id: 'trimestre', label: 'Trimestre' },
  { id: 'anio', label: 'Este año' },
];

function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function rangoPeriodo(id: string): { desde: string; hasta: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  if (id === 'mes') {
    return { desde: isoLocal(new Date(y, m, 1)), hasta: isoLocal(new Date(y, m + 1, 0)) };
  }
  if (id === 'mes_ant') {
    return { desde: isoLocal(new Date(y, m - 1, 1)), hasta: isoLocal(new Date(y, m, 0)) };
  }
  if (id === 'trimestre') {
    const qStart = Math.floor(m / 3) * 3;
    return { desde: isoLocal(new Date(y, qStart, 1)), hasta: isoLocal(new Date(y, qStart + 3, 0)) };
  }
  // anio
  return { desde: isoLocal(new Date(y, 0, 1)), hasta: isoLocal(new Date(y, 11, 31)) };
}

type NodoAlbaran = { key: string; label: string; fechaIso: string; lineas: CompraLinea[]; total: number };
type NodoProveedor = { id: string; nombre: string; total: number; albaranes: NodoAlbaran[] };
type NodoEmpresa = { key: string; nombre: string; esEmpresa: boolean; total: number; proveedores: NodoProveedor[] };

export default function ComprasProveedorResumenScreen() {
  const router = useRouter();
  const { compras: items, loading, recargar } = useComprasProveedorCache();

  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [maestrosLoading, setMaestrosLoading] = useState(true);

  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [periodoActivo, setPeriodoActivo] = useState<string | null>(null);

  const [empresasAbiertas, setEmpresasAbiertas] = useState<Set<string>>(new Set());
  const [proveedoresAbiertos, setProveedoresAbiertos] = useState<Set<string>>(new Set());
  const [albaranModal, setAlbaranModal] = useState<NodoAlbaran | null>(null);

  useEffect(() => {
    recargar();
  }, [recargar]);

  useEffect(() => {
    let activo = true;
    setMaestrosLoading(true);
    Promise.all([
      apiFetch('/api/almacenes').then((r) => r.json()).catch(() => ({ almacenes: [] })),
      apiFetch('/api/empresas').then((r) => r.json()).catch(() => ({ empresas: [] })),
    ])
      .then(([alm, emp]) => {
        if (!activo) return;
        setAlmacenes(Array.isArray(alm?.almacenes) ? alm.almacenes : Array.isArray(alm) ? alm : []);
        setEmpresas(Array.isArray(emp?.empresas) ? emp.empresas : Array.isArray(emp) ? emp : []);
      })
      .finally(() => {
        if (activo) setMaestrosLoading(false);
      });
    return () => {
      activo = false;
    };
  }, []);

  /** Mapa WarehouseId/WarehouseName → nombre de empresa (vía Cif del almacén). */
  const resolverEmpresa = useMemo(() => {
    const empresaPorCif = new Map<string, string>();
    empresas.forEach((e) => {
      const cif = normalizeCif(e.Cif ?? e.cif);
      const nombre = String(e.Nombre ?? e.nombre ?? '').trim();
      if (cif && nombre && !empresaPorCif.has(cif)) empresaPorCif.set(cif, nombre);
    });
    const cifPorAlmacenId = new Map<string, string>();
    const cifPorAlmacenNombre = new Map<string, string>();
    almacenes.forEach((a) => {
      const cif = normalizeCif(a.Cif ?? a.cif);
      if (!cif) return;
      const id = idNorm(a.Id != null ? String(a.Id) : undefined);
      if (id !== '__sin_id__') cifPorAlmacenId.set(id, cif);
      const nom = normNombre(a.Nombre ?? a.nombre);
      if (nom) cifPorAlmacenNombre.set(nom, cif);
    });
    return (linea: CompraLinea): { key: string; nombre: string; esEmpresa: boolean } => {
      const wid = idNorm(linea.WarehouseId);
      const wname = String(linea.WarehouseName ?? '').trim();
      const cif = cifPorAlmacenId.get(wid) || cifPorAlmacenNombre.get(normNombre(wname)) || '';
      const empresaNombre = cif ? empresaPorCif.get(cif) : undefined;
      if (empresaNombre) return { key: `emp:${cif}`, nombre: empresaNombre, esEmpresa: true };
      return { key: `wh:${wid}|${wname}`, nombre: wname || 'Sin empresa asociada', esEmpresa: false };
    };
  }, [almacenes, empresas]);

  const filtrados = useMemo(() => {
    const isoDesde = /^\d{4}-\d{2}-\d{2}$/.test(fechaDesde.trim()) ? fechaDesde.trim() : null;
    const isoHasta = /^\d{4}-\d{2}-\d{2}$/.test(fechaHasta.trim()) ? fechaHasta.trim() : null;
    return items.filter((it) => {
      const f = fechaLineaISO(it);
      if (isoDesde && (f === '' || f < isoDesde)) return false;
      if (isoHasta && (f === '' || f > isoHasta)) return false;
      return true;
    });
  }, [items, fechaDesde, fechaHasta]);

  /** Árbol empresa → proveedor → albarán (albaranes ordenados por fecha ascendente). */
  const arbol = useMemo<{ empresas: NodoEmpresa[]; total: number }>(() => {
    const empMap = new Map<string, NodoEmpresa>();
    let totalGlobal = 0;

    filtrados.forEach((it) => {
      const emp = resolverEmpresa(it);
      const provId = idNorm(it.SupplierId);
      const provNombre = String(it.SupplierName ?? it.SupplierId ?? '—').trim() || '—';
      const albKey = albaranKey(it);
      const importe = Number(it.TotalAmount);
      const sumImporte = Number.isNaN(importe) ? 0 : importe;
      totalGlobal += sumImporte;

      let nodoEmp = empMap.get(emp.key);
      if (!nodoEmp) {
        nodoEmp = { key: emp.key, nombre: emp.nombre, esEmpresa: emp.esEmpresa, total: 0, proveedores: [] };
        empMap.set(emp.key, nodoEmp);
      }
      nodoEmp.total += sumImporte;

      let nodoProv = nodoEmp.proveedores.find((p) => p.id === provId);
      if (!nodoProv) {
        nodoProv = { id: provId, nombre: provNombre, total: 0, albaranes: [] };
        nodoEmp.proveedores.push(nodoProv);
      }
      nodoProv.total += sumImporte;

      let nodoAlb = nodoProv.albaranes.find((a) => a.key === albKey);
      if (!nodoAlb) {
        nodoAlb = { key: albKey, label: albaranLabel(it), fechaIso: fechaLineaISO(it), lineas: [], total: 0 };
        nodoProv.albaranes.push(nodoAlb);
      }
      nodoAlb.lineas.push(it);
      nodoAlb.total += sumImporte;
    });

    const empresasArr = Array.from(empMap.values());
    empresasArr.forEach((e) => {
      e.proveedores.sort((a, b) => b.total - a.total);
      e.proveedores.forEach((p) => {
        p.albaranes.sort((a, b) => a.fechaIso.localeCompare(b.fechaIso));
      });
    });
    empresasArr.sort((a, b) => b.total - a.total);
    return { empresas: empresasArr, total: totalGlobal };
  }, [filtrados, resolverEmpresa]);

  const aplicarPeriodo = useCallback((id: string) => {
    if (periodoActivo === id) {
      setPeriodoActivo(null);
      setFechaDesde('');
      setFechaHasta('');
      return;
    }
    const r = rangoPeriodo(id);
    setPeriodoActivo(id);
    setFechaDesde(r.desde);
    setFechaHasta(r.hasta);
  }, [periodoActivo]);

  const limpiar = useCallback(() => {
    setPeriodoActivo(null);
    setFechaDesde('');
    setFechaHasta('');
  }, []);

  const toggleEmpresa = useCallback((key: string) => {
    setEmpresasAbiertas((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleProveedor = useCallback((key: string) => {
    setProveedoresAbiertos((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const exportarExcel = useCallback(() => {
    if (filtrados.length === 0) return;
    const headers = ['Fecha', 'Empresa', 'Proveedor', 'Albarán', 'Producto', 'Cantidad', 'Unidad', 'Precio', 'IVA %', 'Total'];
    const rows: (string | number)[][] = [];
    arbol.empresas.forEach((emp) => {
      emp.proveedores.forEach((prov) => {
        prov.albaranes.forEach((alb) => {
          alb.lineas.forEach((l) => {
            rows.push([
              formatFechaCorta(fechaLineaISO(l)),
              emp.nombre,
              prov.nombre,
              alb.label,
              String(l.ProductName ?? l.ProductId ?? ''),
              Number(l.Quantity) || 0,
              String(l.PurchaseUnitName ?? ''),
              Number(l.Price) || 0,
              Number(l.VatRate) ? Number(l.VatRate) * 100 : 0,
              Number(l.TotalAmount) || 0,
            ]);
          });
        });
      });
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Resumen compras');
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `compras_resumen_empresa_${stamp}.xlsx`;
    if (Platform.OS === 'web') {
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() =>
          Sharing.shareAsync(fileUri, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: fname,
          }),
        )
        .catch(() => {});
    }
  }, [arbol, filtrados.length]);

  const cargando = (loading && items.length === 0) || maestrosLoading;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Resumen por empresa y proveedor</Text>
          <Text style={styles.headerSubtitle}>
            Importes de compra agrupados por empresa (almacén) → proveedor → albarán
          </Text>
        </View>
        <ComprasToolbarIconBtn
          tooltip="Exportar detalle a Excel"
          onPress={exportarExcel}
          disabled={filtrados.length === 0}
          accessibilityLabel="Exportar Excel"
          variant="outline"
        >
          <MaterialIcons name="table-chart" size={TOOLBAR_ICON_SIZE} color={filtrados.length === 0 ? '#cbd5e1' : '#0ea5e9'} />
        </ComprasToolbarIconBtn>
      </View>

      {/* Filtros */}
      <View style={local.filtros}>
        <View style={local.chipsRow}>
          {PERIODOS.map((p) => {
            const activo = periodoActivo === p.id;
            return (
              <TouchableOpacity
                key={p.id}
                style={[local.chip, activo && local.chipActivo]}
                onPress={() => aplicarPeriodo(p.id)}
                activeOpacity={0.7}
              >
                <Text style={[local.chipText, activo && local.chipTextActivo]}>{p.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={local.fechasRow}>
          <View style={local.fechaField}>
            <Text style={local.fechaLabel}>Desde</Text>
            <InputFecha
              valueIso={fechaDesde}
              onChangeIso={(v) => { setFechaDesde(v); setPeriodoActivo(null); }}
              placeholder="dd/mm/aaaa"
              style={local.fechaInput}
            />
          </View>
          <View style={local.fechaField}>
            <Text style={local.fechaLabel}>Hasta</Text>
            <InputFecha
              valueIso={fechaHasta}
              onChangeIso={(v) => { setFechaHasta(v); setPeriodoActivo(null); }}
              placeholder="dd/mm/aaaa"
              style={local.fechaInput}
            />
          </View>
          {(fechaDesde || fechaHasta) ? (
            <TouchableOpacity style={local.limpiarBtn} onPress={limpiar}>
              <MaterialIcons name="filter-list-off" size={16} color="#dc2626" />
              <Text style={local.limpiarText}>Limpiar</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* Banner total */}
      <View style={local.totalBanner}>
        <MaterialIcons name="functions" size={16} color="#0369a1" />
        <Text style={local.totalBannerText}>
          Total compras: <Text style={local.totalBannerStrong}>{formatMoneda(arbol.total)}</Text>
          {arbol.empresas.length > 0 ? `  ·  ${arbol.empresas.length} ${arbol.empresas.length === 1 ? 'empresa' : 'empresas'}` : ''}
        </Text>
      </View>

      {/* Árbol */}
      {cargando ? (
        <View style={local.emptyWrap}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={local.emptyText}>Cargando datos…</Text>
        </View>
      ) : arbol.empresas.length === 0 ? (
        <View style={local.emptyWrap}>
          <MaterialIcons name="inbox" size={48} color="#cbd5e1" />
          <Text style={local.emptyText}>No hay compras en el periodo seleccionado.</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {arbol.empresas.map((emp) => {
            const empAbierta = empresasAbiertas.has(emp.key);
            return (
              <View key={emp.key} style={local.empBlock}>
                <TouchableOpacity style={local.empHeader} onPress={() => toggleEmpresa(emp.key)} activeOpacity={0.7}>
                  <MaterialIcons name={empAbierta ? 'expand-more' : 'chevron-right'} size={22} color="#0f172a" />
                  <MaterialIcons name={emp.esEmpresa ? 'business' : 'warehouse'} size={18} color={emp.esEmpresa ? '#0369a1' : '#b45309'} />
                  <Text style={local.empNombre} numberOfLines={1}>{emp.nombre}</Text>
                  <Text style={local.empTotal}>{formatMoneda(emp.total)}</Text>
                </TouchableOpacity>

                {empAbierta ? emp.proveedores.map((prov) => {
                  const provKey = `${emp.key}|${prov.id}`;
                  const provAbierto = proveedoresAbiertos.has(provKey);
                  return (
                    <View key={provKey}>
                      <TouchableOpacity style={local.provHeader} onPress={() => toggleProveedor(provKey)} activeOpacity={0.7}>
                        <MaterialIcons name={provAbierto ? 'expand-more' : 'chevron-right'} size={20} color="#475569" />
                        <Text style={local.provNombre} numberOfLines={1}>{prov.nombre}</Text>
                        <Text style={local.provTotal}>{formatMoneda(prov.total)}</Text>
                      </TouchableOpacity>

                      {provAbierto ? prov.albaranes.map((alb) => (
                        <TouchableOpacity
                          key={alb.key}
                          style={local.albRow}
                          onPress={() => setAlbaranModal(alb)}
                          activeOpacity={0.6}
                        >
                          <Text style={local.albFecha}>{formatFechaCorta(alb.fechaIso)}</Text>
                          <MaterialIcons name="receipt" size={15} color="#94a3b8" />
                          <Text style={local.albLabel} numberOfLines={1}>Albarán {alb.label}</Text>
                          <Text style={local.albLineas}>{alb.lineas.length} líns.</Text>
                          <Text style={local.albTotal}>{formatMoneda(alb.total)}</Text>
                          <MaterialIcons name="chevron-right" size={16} color="#cbd5e1" />
                        </TouchableOpacity>
                      )) : null}
                    </View>
                  );
                }) : null}
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Modal detalle albarán */}
      <Modal visible={albaranModal !== null} transparent animationType="fade" onRequestClose={() => setAlbaranModal(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setAlbaranModal(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={local.modalWrap}>
            <View style={local.modalCard}>
              {albaranModal ? (() => {
                const first = albaranModal.lineas[0];
                return (
                  <>
                    <View style={local.modalHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={local.modalTitle}>Albarán {albaranModal.label} · {formatFechaCorta(albaranModal.fechaIso)}</Text>
                        <Text style={local.modalSubtitle} numberOfLines={1}>
                          {String(first?.SupplierName ?? '—')} · {String(first?.WarehouseName ?? '—')}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={() => setAlbaranModal(null)} hitSlop={8}>
                        <MaterialIcons name="close" size={22} color="#64748b" />
                      </TouchableOpacity>
                    </View>

                    <ScrollView style={{ maxHeight: 360 }} horizontal>
                      <View>
                        <View style={local.modalThRow}>
                          <Text style={[local.modalTh, { width: 200 }]}>Producto</Text>
                          <Text style={[local.modalTh, { width: 70, textAlign: 'right' }]}>Cant.</Text>
                          <Text style={[local.modalTh, { width: 70 }]}>Unidad</Text>
                          <Text style={[local.modalTh, { width: 90, textAlign: 'right' }]}>Precio</Text>
                          <Text style={[local.modalTh, { width: 60, textAlign: 'right' }]}>IVA</Text>
                          <Text style={[local.modalTh, { width: 100, textAlign: 'right' }]}>Total</Text>
                        </View>
                        <ScrollView style={{ maxHeight: 320 }}>
                          {albaranModal.lineas.map((l, i) => (
                            <View key={`${l.PK}-${l.SK}`} style={[local.modalTr, i % 2 === 1 && local.modalTrAlt]}>
                              <Text style={[local.modalTd, { width: 200 }]} numberOfLines={2}>{String(l.ProductName ?? l.ProductId ?? '—')}</Text>
                              <Text style={[local.modalTd, { width: 70, textAlign: 'right' }]}>{Number(l.Quantity) || 0}</Text>
                              <Text style={[local.modalTd, { width: 70 }]} numberOfLines={1}>{String(l.PurchaseUnitName ?? '')}</Text>
                              <Text style={[local.modalTd, { width: 90, textAlign: 'right' }]}>{formatMoneda(l.Price)}</Text>
                              <Text style={[local.modalTd, { width: 60, textAlign: 'right' }]}>{Number(l.VatRate) ? `${(Number(l.VatRate) * 100).toFixed(0)}%` : '—'}</Text>
                              <Text style={[local.modalTd, { width: 100, textAlign: 'right' }]}>{formatMoneda(l.TotalAmount)}</Text>
                            </View>
                          ))}
                        </ScrollView>
                      </View>
                    </ScrollView>

                    <View style={local.modalFooter}>
                      <Text style={local.modalFooterMeta} numberOfLines={1}>
                        Nº doc.: {String(first?.SupplierDocumentNumber ?? '—')}   ·   {first?.Confirmed ? 'Confirmado ✓' : 'Sin confirmar'}   ·   {first?.Invoiced ? 'Facturado ✓' : 'No facturado'}
                      </Text>
                      <Text style={local.modalFooterTotal}>Total: {formatMoneda(albaranModal.total)}</Text>
                    </View>
                  </>
                );
              })() : null}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const local = StyleSheet.create({
  filtros: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  chipText: { fontSize: 12, color: '#475569', fontWeight: '500' },
  chipTextActivo: { color: '#0369a1', fontWeight: '700' },
  fechasRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' },
  fechaField: { gap: 2 },
  fechaLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  fechaInput: { minWidth: 130, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  limpiarBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10 },
  limpiarText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },

  totalBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8,
  },
  totalBannerText: { fontSize: 13, color: '#1e3a8a' },
  totalBannerStrong: { fontWeight: '700', color: '#0369a1' },

  empBlock: { marginHorizontal: 12, marginTop: 8, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, overflow: 'hidden', backgroundColor: '#fff' },
  empHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 12, backgroundColor: '#f8fafc' },
  empNombre: { flex: 1, fontSize: 15, fontWeight: '700', color: '#0f172a' },
  empTotal: { fontSize: 15, fontWeight: '700', color: '#0369a1' },

  provHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 24, paddingRight: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#f1f5f9' },
  provNombre: { flex: 1, fontSize: 14, fontWeight: '600', color: '#334155' },
  provTotal: { fontSize: 14, fontWeight: '600', color: '#475569' },

  albRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 44, paddingRight: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#f8fafc', backgroundColor: '#fff' },
  albFecha: { fontSize: 12, color: '#64748b', width: 78 },
  albLabel: { flex: 1, fontSize: 13, color: '#334155' },
  albLineas: { fontSize: 11, color: '#94a3b8' },
  albTotal: { fontSize: 13, fontWeight: '600', color: '#0f172a', minWidth: 90, textAlign: 'right' },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40 },
  emptyText: { fontSize: 14, color: '#94a3b8' },

  modalWrap: { width: '100%', maxWidth: 640, maxHeight: '88%' },
  modalCard: { width: '100%', backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#e2e8f0' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  modalSubtitle: { fontSize: 12, color: '#64748b', marginTop: 2 },
  modalThRow: { flexDirection: 'row', backgroundColor: '#f8fafc', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTh: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  modalTr: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' },
  modalTrAlt: { backgroundColor: '#f8fafc' },
  modalTd: { fontSize: 12, color: '#334155' },
  modalFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0', backgroundColor: '#f8fafc', flexWrap: 'wrap' },
  modalFooterMeta: { fontSize: 12, color: '#64748b', flex: 1 },
  modalFooterTotal: { fontSize: 14, fontWeight: '700', color: '#0369a1' },
});
