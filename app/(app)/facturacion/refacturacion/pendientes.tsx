import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../../../components/TablaBasica';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { useLocalToast, detectToastType } from '../../../components/Toast';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { useAuth } from '../../../contexts/AuthContext';
import { apiFetch, errorMessage } from '../../../utils/api';
import { formatMoneda, esEmpresaSedeGrupoParipe } from '../../../utils/facturacion';
import { formatFecha } from '../../../utils/formatFecha';
import {
  INCREMENTO_REFACTURACION_PCT,
  recalcularLineaPreview,
} from '../../../lib/refacturacion';

type EmpresaOpt = { id: string; nombre: string; cif: string };

type LineaRefact = {
  id_linea: string;
  empresa_destino_id: string;
  empresa_destino_nombre?: string;
  empresa_destino_cif?: string;
  descripcion: string;
  cantidad: number;
  precio_base_unitario: number;
  precio_refacturado_unitario?: number;
  tipo_iva: number;
  descuento?: number;
  base_linea?: number;
  iva_linea?: number;
  total_linea?: number;
  estado?: string;
  proveedor_origen?: string;
  fecha_documento?: string;
  doc_origen_nombre?: string;
  creado_en?: string;
};

const COLUMNAS = [
  'Sociedad',
  'Descripción',
  'Cant.',
  'Base ud.',
  `+${INCREMENTO_REFACTURACION_PCT}%`,
  'IVA %',
  'Total',
  'Proveedor',
  'Doc.',
];

export default function RefacturacionPendientesScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { show: showToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();
  const alertMsg = useCallback(
    (t: string, m: string) => showToast(t, m, detectToastType(t, m)),
    [showToast],
  );

  const puedeVer = hasPermiso('refacturacion.ver');
  const puedeGestionar = hasPermiso('refacturacion.gestionar');

  const [empresas, setEmpresas] = useState<EmpresaOpt[]>([]);
  const [lineas, setLineas] = useState<LineaRefact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState('');
  const [filtroSociedad, setFiltroSociedad] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editLinea, setEditLinea] = useState<LineaRefact | null>(null);
  const [formDesc, setFormDesc] = useState('');
  const [formCant, setFormCant] = useState('1');
  const [formPrecio, setFormPrecio] = useState('0');
  const [formIva, setFormIva] = useState('21');
  const [formDto, setFormDto] = useState('0');
  const [formSociedad, setFormSociedad] = useState('');

  const [reasignarOpen, setReasignarOpen] = useState(false);
  const [reasignarLinea, setReasignarLinea] = useState<LineaRefact | null>(null);
  const [nuevaSociedad, setNuevaSociedad] = useState('');

  useEffect(() => {
    apiFetch('/api/empresas')
      .then((r) => r.json())
      .then((d) => {
        const raw: unknown[] = d.empresas ?? d ?? [];
        const list: EmpresaOpt[] = raw
          .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
          .filter((e) => esEmpresaSedeGrupoParipe(e as { Sede?: string; sede?: string }))
          .map((e) => ({
            id: e.id_empresa != null ? String(e.id_empresa) : '',
            nombre: String(e.Nombre ?? e.nombre ?? '').trim(),
            cif: String(e.Cif ?? e.cif ?? '').trim(),
          }))
          .filter((x) => x.id)
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        setEmpresas(list);
      })
      .catch(() => setEmpresas([]));
  }, []);

  const fetchLineas = useCallback(() => {
    if (!puedeVer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ estado: 'pendiente' });
    if (filtroSociedad) qs.set('empresa_destino_id', filtroSociedad);
    apiFetch(`/api/refacturacion/lineas?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setLineas(Array.isArray(d.lineas) ? d.lineas : []);
        setSelectedRowIndex(null);
      })
      .catch((e) => setError((e as Error).message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [filtroSociedad, puedeVer]);

  useFocusEffect(
    useCallback(() => {
      fetchLineas();
    }, [fetchLineas]),
  );

  const filtradas = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return lineas;
    return lineas.filter((l) =>
      [
        l.empresa_destino_nombre,
        l.descripcion,
        l.proveedor_origen,
        l.doc_origen_nombre,
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [filtro, lineas]);

  const empresaById = useMemo(() => {
    const m = new Map<string, EmpresaOpt>();
    for (const e of empresas) m.set(e.id, e);
    return m;
  }, [empresas]);

  const opcionesSociedad = useMemo(
    () => [
      { id: '', titulo: 'Todas las sociedades', icono: 'layers' as const },
      ...empresas.map((e) => ({ id: e.id, titulo: e.nombre, icono: 'domain' as const })),
    ],
    [empresas],
  );

  const opcionesSociedadEdit = useMemo(
    () => empresas.map((e) => ({ id: e.id, titulo: e.nombre, icono: 'domain' as const })),
    [empresas],
  );

  const getValorCelda = (item: LineaRefact, col: string) => {
    switch (col) {
      case 'Sociedad':
        return item.empresa_destino_nombre || item.empresa_destino_id || '';
      case 'Descripción':
        return item.descripcion || '';
      case 'Cant.':
        return String(item.cantidad ?? '');
      case 'Base ud.':
        return formatMoneda(item.precio_base_unitario || 0);
      case `+${INCREMENTO_REFACTURACION_PCT}%`:
        return formatMoneda(item.precio_refacturado_unitario || 0);
      case 'IVA %':
        return String(item.tipo_iva ?? '');
      case 'Total':
        return formatMoneda(item.total_linea || 0);
      case 'Proveedor':
        return item.proveedor_origen || '';
      case 'Doc.':
        return item.doc_origen_nombre || '';
      default:
        return '';
    }
  };

  const abrirEditar = (item: LineaRefact) => {
    if (!puedeGestionar) return;
    setEditLinea(item);
    setFormDesc(item.descripcion || '');
    setFormCant(String(item.cantidad ?? 1));
    setFormPrecio(String(item.precio_base_unitario ?? 0));
    setFormIva(String(item.tipo_iva ?? 21));
    setFormDto(String(item.descuento ?? 0));
    setFormSociedad(item.empresa_destino_id || '');
    setEditOpen(true);
  };

  const guardarEdicion = async () => {
    if (!editLinea) return;
    if (!formDesc.trim()) {
      alertMsg('Validación', 'La descripción es obligatoria');
      return;
    }
    setGuardando(true);
    try {
      const body: Record<string, unknown> = {
        empresa_destino_id: editLinea.empresa_destino_id,
        descripcion: formDesc.trim(),
        cantidad: Number(formCant) || 0,
        precio_base_unitario: Number(formPrecio) || 0,
        tipo_iva: Number(formIva) || 0,
        descuento: Number(formDto) || 0,
      };
      if (formSociedad && formSociedad !== editLinea.empresa_destino_id) {
        body.empresa_destino_id_nueva = formSociedad;
        const emp = empresaById.get(formSociedad);
        body.empresa_destino_nombre = emp?.nombre || '';
        body.empresa_destino_cif = emp?.cif || '';
      }
      const res = await apiFetch(`/api/refacturacion/lineas/${editLinea.id_linea}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      showToast('Actualizado', 'Línea actualizada', 'success');
      setEditOpen(false);
      setEditLinea(null);
      fetchLineas();
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setGuardando(false);
    }
  };

  const abrirReasignar = (item: LineaRefact) => {
    if (!puedeGestionar) return;
    setReasignarLinea(item);
    setNuevaSociedad('');
    setReasignarOpen(true);
  };

  const confirmarReasignar = async () => {
    if (!reasignarLinea || !nuevaSociedad) {
      alertMsg('Validación', 'Selecciona la nueva sociedad');
      return;
    }
    if (nuevaSociedad === reasignarLinea.empresa_destino_id) {
      alertMsg('Info', 'Es la misma sociedad');
      return;
    }
    setGuardando(true);
    try {
      const emp = empresaById.get(nuevaSociedad);
      const res = await apiFetch(`/api/refacturacion/lineas/${reasignarLinea.id_linea}`, {
        method: 'PATCH',
        body: JSON.stringify({
          empresa_destino_id: reasignarLinea.empresa_destino_id,
          empresa_destino_id_nueva: nuevaSociedad,
          empresa_destino_nombre: emp?.nombre || '',
          empresa_destino_cif: emp?.cif || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al reasignar');
      showToast('Reasignada', 'Sociedad actualizada', 'success');
      setReasignarOpen(false);
      setReasignarLinea(null);
      fetchLineas();
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setGuardando(false);
    }
  };

  const descartarLinea = async (item: LineaRefact) => {
    if (!puedeGestionar) return;
    const ok = await confirmar(
      'Descartar línea',
      `¿Descartar «${item.descripcion}»?`,
      { confirmarLabel: 'Descartar', cancelarLabel: 'Cancelar', variant: 'danger' },
    );
    if (!ok) return;
    setGuardando(true);
    try {
      const res = await apiFetch(`/api/refacturacion/lineas/${item.id_linea}`, {
        method: 'PATCH',
        body: JSON.stringify({
          empresa_destino_id: item.empresa_destino_id,
          estado: 'descartada',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al descartar');
      showToast('Descartada', 'Línea descartada', 'success');
      fetchLineas();
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setGuardando(false);
    }
  };

  const borrarLinea = async (item: LineaRefact) => {
    if (!puedeGestionar) return;
    const ok = await confirmar(
      'Borrar línea',
      `¿Eliminar permanentemente «${item.descripcion}»?`,
      { confirmarLabel: 'Borrar', cancelarLabel: 'Cancelar', variant: 'danger' },
    );
    if (!ok) return;
    setGuardando(true);
    try {
      const qs = new URLSearchParams({
        empresa_destino_id: item.empresa_destino_id,
      });
      const res = await apiFetch(
        `/api/refacturacion/lineas/${item.id_linea}?${qs.toString()}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Error al borrar');
      showToast('Borrada', 'Línea eliminada', 'success');
      fetchLineas();
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setGuardando(false);
    }
  };

  const selected = selectedRowIndex != null ? filtradas[selectedRowIndex] : null;
  const previewEdit = recalcularLineaPreview({
    cantidad: formCant,
    precio_base_unitario: formPrecio,
    tipo_iva: formIva,
    descuento_pct: formDto,
  });

  if (!puedeVer) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>No tienes permiso para ver refacturaciones.</Text>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      {ToastView}
      {ConfirmarView}
      <TablaBasica
        title="Líneas pendientes"
        onBack={() => router.push('/facturacion/refacturacion' as never)}
        columnas={COLUMNAS}
        datos={filtradas}
        getValorCelda={getValorCelda}
        loading={loading}
        error={error}
        onRetry={fetchLineas}
        filtroBusqueda={filtro}
        onFiltroChange={setFiltro}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        onCrear={() => router.push('/facturacion/refacturacion/escanear' as never)}
        onEditar={(item) => abrirEditar(item)}
        onBorrar={(item) => void borrarLinea(item)}
        guardando={guardando}
        hideToolbarActions={!puedeGestionar}
        toolbarCrearLabel="Escanear"
        emptyMessage="No hay líneas pendientes"
        columnasMoneda={['Base ud.', `+${INCREMENTO_REFACTURACION_PCT}%`, 'Total']}
        extraToolbarLeft={(
          <SelectorDesplegable
            style={styles.filtroSociedad}
            icono="business"
            tituloLista="Sociedad"
            iconoLista="business"
            placeholder="Todas"
            valorId={filtroSociedad}
            opciones={opcionesSociedad}
            onSeleccionar={setFiltroSociedad}
          />
        )}
        extraToolbarRight={puedeGestionar && selected ? (
          <View style={styles.extraBtns}>
            <TouchableOpacity
              style={styles.extraBtn}
              onPress={() => abrirReasignar(selected)}
            >
              <MaterialIcons name="swap-horiz" size={16} color="#6d28d9" />
              <Text style={styles.extraBtnText}>Reasignar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.extraBtn}
              onPress={() => void descartarLinea(selected)}
            >
              <MaterialIcons name="block" size={16} color="#b45309" />
              <Text style={[styles.extraBtnText, { color: '#b45309' }]}>Descartar</Text>
            </TouchableOpacity>
          </View>
        ) : undefined}
      />

      {/* Modal editar */}
      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Editar línea</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              <Text style={styles.label}>Descripción</Text>
              <TextInput style={styles.input} value={formDesc} onChangeText={setFormDesc} />
              <View style={styles.formRow}>
                <View style={styles.formCol}>
                  <Text style={styles.label}>Cantidad</Text>
                  <TextInput style={styles.input} value={formCant} onChangeText={setFormCant} keyboardType="decimal-pad" />
                </View>
                <View style={styles.formCol}>
                  <Text style={styles.label}>Precio base</Text>
                  <TextInput style={styles.input} value={formPrecio} onChangeText={setFormPrecio} keyboardType="decimal-pad" />
                </View>
              </View>
              <View style={styles.formRow}>
                <View style={styles.formCol}>
                  <Text style={styles.label}>IVA %</Text>
                  <TextInput style={styles.input} value={formIva} onChangeText={setFormIva} keyboardType="decimal-pad" />
                </View>
                <View style={styles.formCol}>
                  <Text style={styles.label}>Dto %</Text>
                  <TextInput style={styles.input} value={formDto} onChangeText={setFormDto} keyboardType="decimal-pad" />
                </View>
              </View>
              <Text style={styles.label}>Sociedad destino</Text>
              <SelectorDesplegable
                style={{ marginBottom: 8 }}
                icono="business"
                tituloLista="Sociedad"
                iconoLista="business"
                valorId={formSociedad}
                opciones={opcionesSociedadEdit}
                onSeleccionar={setFormSociedad}
              />
              <Text style={styles.preview}>
                Preview +{INCREMENTO_REFACTURACION_PCT}%: {formatMoneda(previewEdit.precio_refacturado_unitario)}
                {' · '}Total {formatMoneda(previewEdit.total_linea)}
              </Text>
              {editLinea?.creado_en ? (
                <Text style={styles.meta}>Creada: {formatFecha(editLinea.creado_en)}</Text>
              ) : null}
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.btnGhost} onPress={() => setEditOpen(false)}>
                <Text style={styles.btnGhostText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSave, guardando && { opacity: 0.5 }]}
                disabled={guardando}
                onPress={() => void guardarEdicion()}
              >
                {guardando ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnSaveText}>Guardar</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal reasignar */}
      <Modal visible={reasignarOpen} transparent animationType="fade" onRequestClose={() => setReasignarOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Reasignar sociedad</Text>
            <Text style={styles.meta}>
              Actual: {reasignarLinea?.empresa_destino_nombre || reasignarLinea?.empresa_destino_id}
            </Text>
            <Text style={styles.label}>Nueva sociedad</Text>
            <SelectorDesplegable
              icono="business"
              tituloLista="Nueva sociedad"
              iconoLista="business"
              valorId={nuevaSociedad}
              opciones={opcionesSociedadEdit}
              onSeleccionar={setNuevaSociedad}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.btnGhost} onPress={() => setReasignarOpen(false)}>
                <Text style={styles.btnGhostText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSave, guardando && { opacity: 0.5 }]}
                disabled={guardando}
                onPress={() => void confirmarReasignar()}
              >
                {guardando ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnSaveText}>Reasignar</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f8fafc' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  denied: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  filtroSociedad: { minWidth: 180, maxWidth: 260 },
  extraBtns: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  extraBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#ede9fe',
    borderWidth: 1,
    borderColor: '#c4b5fd',
  },
  extraBtnText: { fontSize: 12, fontWeight: '600', color: '#6d28d9' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '600', color: '#64748b', marginTop: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#fff',
  },
  formRow: { flexDirection: 'row', gap: 8 },
  formCol: { flex: 1 },
  preview: { fontSize: 12, color: '#6d28d9', marginTop: 8, fontWeight: '500' },
  meta: { fontSize: 12, color: '#94a3b8', marginBottom: 4 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  btnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  btnGhostText: { fontWeight: '600', color: '#475569' },
  btnSave: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#7c3aed',
    minWidth: 100,
    alignItems: 'center',
  },
  btnSaveText: { color: '#fff', fontWeight: '600' },
});
