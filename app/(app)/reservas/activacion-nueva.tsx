import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
  Linking,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useProductosCache } from '../../contexts/ProductosCache';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch } from '../../utils/api';
import { valorEnLocal } from '../../utils/valorEnLocal';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { SelectorDesplegableMulti } from '../../components/SelectorDesplegableMulti';
import type { Activacion, ActivacionAdjunto, EstadoActivacion } from '../../types/activaciones';

type EmpresaApi = {
  id_empresa?: string;
  Nombre?: string;
  Cif?: string;
};

export default function ActivacionNuevaScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = typeof params.id === 'string' ? params.id : '';
  const { hasPermiso, user } = useAuth();
  const { shouldStackPanels } = useBreakpoint();
  const puedeGestionar = hasPermiso('activaciones.gestionar');
  const {
    productosIgp: productosIgpCache,
    loading: loadingProductos,
    lastFetch: productosLastFetch,
    recargar: recargarProductos,
  } = useProductosCache();
  const productosIgp = productosIgpCache as Record<string, unknown>[];

  const [loading, setLoading] = useState(!!editId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estadoActual, setEstadoActual] = useState<EstadoActivacion>('borrador');

  const [empresas, setEmpresas] = useState<EmpresaApi[]>([]);
  const [idEmpresa, setIdEmpresa] = useState('');
  const [empresaNombre, setEmpresaNombre] = useState('');
  const [empresaCif, setEmpresaCif] = useState('');
  const [promotorNombre, setPromotorNombre] = useState('');
  const [promotorTelefono, setPromotorTelefono] = useState('');

  const [codigo, setCodigo] = useState('');
  const [marca, setMarca] = useState('');
  const [productoIds, setProductoIds] = useState<string[]>([]);
  const [productoLegacy, setProductoLegacy] = useState('');
  const [tipoActivacion, setTipoActivacion] = useState('');

  const [vigenciaInicio, setVigenciaInicio] = useState('');
  const [vigenciaFin, setVigenciaFin] = useState('');
  const [duracionHoras, setDuracionHoras] = useState('');
  const [ocasion, setOcasion] = useState('');
  const [targetDescripcion, setTargetDescripcion] = useState('');

  const [mecanica, setMecanica] = useState('');
  const [equipoDescripcion, setEquipoDescripcion] = useState('');
  const [materiales, setMateriales] = useState<string[]>([]);
  const [nuevoMaterial, setNuevoMaterial] = useState('');
  const [pagoObservaciones, setPagoObservaciones] = useState('');
  const [adjuntos, setAdjuntos] = useState<ActivacionAdjunto[]>([]);
  const [subiendoAdjunto, setSubiendoAdjunto] = useState(false);

  useEffect(() => {
    if (!editId) return;
    apiFetch(`/api/activaciones/${editId}/adjuntos`)
      .then((r) => r.json())
      .then((d) => setAdjuntos(Array.isArray(d.adjuntos) ? d.adjuntos : []))
      .catch(() => setAdjuntos([]));
  }, [editId]);

  const subirAdjunto = () => {
    if (!editId) return;
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setSubiendoAdjunto(true);
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('usuario_nombre', user?.Nombre ?? '');
        const r = await apiFetch(`/api/activaciones/${editId}/adjuntos`, { method: 'POST', body: formData });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Error al subir');
        const r2 = await apiFetch(`/api/activaciones/${editId}/adjuntos`);
        const d2 = await r2.json();
        setAdjuntos(Array.isArray(d2.adjuntos) ? d2.adjuntos : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al subir adjunto');
      } finally {
        setSubiendoAdjunto(false);
      }
    };
    input.click();
  };

  const eliminarAdjunto = async (adjId: string) => {
    if (!editId) return;
    if (Platform.OS === 'web' && !window.confirm('¿Eliminar este adjunto?')) return;
    try {
      const r = await apiFetch(`/api/activaciones/${editId}/adjuntos/${adjId}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json();
        throw new Error(d.error || 'No se pudo eliminar');
      }
      setAdjuntos((prev) => prev.filter((a) => a.id !== adjId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar adjunto');
    }
  };

  useEffect(() => {
    if (!productosLastFetch) void recargarProductos();
  }, [productosLastFetch, recargarProductos]);

  const opcionesProducto = useMemo(
    () =>
      productosIgp
        .map((prod, idx) => {
          const idProd = String(valorEnLocal(prod, 'Id') ?? '').trim();
          const nombre = String(
            valorEnLocal(prod, 'Name') ?? valorEnLocal(prod, 'Nombre') ?? idProd,
          ).trim();
          return {
            id: idProd || `p-${idx}`,
            titulo: nombre || idProd || '—',
            subtitulo: idProd ? `ID ${idProd}` : undefined,
            icono: 'inventory-2' as const,
          };
        })
        .filter((o) => o.id && !o.id.startsWith('p-'))
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    [productosIgp],
  );

  const productoTexto = useMemo(() => {
    const nombres = productoIds
      .map((id) => opcionesProducto.find((o) => o.id === id)?.titulo ?? '')
      .filter(Boolean);
    return nombres.join(', ');
  }, [productoIds, opcionesProducto]);

  useEffect(() => {
    apiFetch('/api/empresas')
      .then((r) => r.json())
      .then((d) => setEmpresas(Array.isArray(d.empresas) ? d.empresas : []))
      .catch(() => setEmpresas([]));
  }, []);

  useEffect(() => {
    if (productoIds.length > 0 || !productoLegacy.trim() || opcionesProducto.length === 0) return;
    const names = productoLegacy.split(',').map((s) => s.trim()).filter(Boolean);
    const resolved = names.flatMap((name) => {
      const prod = productosIgp.find((p) => {
        const n = String(valorEnLocal(p, 'Name') ?? valorEnLocal(p, 'Nombre') ?? '')
          .trim()
          .toLowerCase();
        return n === name.toLowerCase();
      });
      const id = prod ? String(valorEnLocal(prod, 'Id') ?? '').trim() : '';
      return id ? [id] : [];
    });
    if (resolved.length > 0) setProductoIds(resolved);
  }, [productoLegacy, productoIds.length, opcionesProducto.length, productosIgp]);

  const cargarFicha = useCallback(async () => {
    if (!editId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/activaciones/${editId}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo cargar la activación');
      const a = d.activacion as Activacion;
      setEstadoActual(a.estado ?? 'borrador');
      setIdEmpresa(a.id_empresa ?? '');
      setEmpresaNombre(a.empresa_nombre ?? '');
      setEmpresaCif(a.empresa_cif ?? '');
      setPromotorNombre(a.promotor_nombre ?? '');
      setPromotorTelefono(a.promotor_telefono ?? '');
      setCodigo(a.codigo ?? '');
      setMarca(a.marca ?? '');
      setProductoIds(Array.isArray(a.productos_ids) ? a.productos_ids.filter(Boolean) : []);
      setProductoLegacy(a.producto ?? '');
      setTipoActivacion(a.tipo_activacion ?? '');
      setVigenciaInicio(a.vigencia_inicio ?? '');
      setVigenciaFin(a.vigencia_fin ?? '');
      setDuracionHoras(a.duracion_horas ? String(a.duracion_horas) : '');
      setOcasion(a.ocasion ?? '');
      setTargetDescripcion(a.target_descripcion ?? '');
      setMecanica(a.mecanica ?? '');
      setEquipoDescripcion(a.equipo_descripcion ?? '');
      setMateriales(Array.isArray(a.materiales) ? a.materiales : []);
      setPagoObservaciones(a.pago_observaciones ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, [editId]);

  useEffect(() => {
    cargarFicha();
  }, [cargarFicha]);

  const opcionesEmpresa = useMemo(
    () =>
      empresas
        .map((e) => ({
          id: String(e.id_empresa ?? e.Nombre ?? ''),
          titulo: String(e.Nombre ?? '—'),
          subtitulo: String(e.Cif ?? '').trim() || undefined,
        }))
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    [empresas],
  );

  const valorEmpresaId = useMemo(() => {
    if (idEmpresa && opcionesEmpresa.some((o) => o.id === idEmpresa)) return idEmpresa;
    const n = empresaNombre.trim().toLowerCase();
    return opcionesEmpresa.find((o) => o.titulo.trim().toLowerCase() === n)?.id ?? null;
  }, [idEmpresa, empresaNombre, opcionesEmpresa]);

  const seleccionarEmpresa = useCallback(
    (id: string) => {
      const e = empresas.find((x) => String(x.id_empresa ?? x.Nombre ?? '') === id);
      if (!e) return;
      setIdEmpresa(String(e.id_empresa ?? ''));
      setEmpresaNombre(String(e.Nombre ?? ''));
      setEmpresaCif(String(e.Cif ?? '').trim());
    },
    [empresas],
  );

  const agregarMaterial = () => {
    const m = nuevoMaterial.trim();
    if (!m) return;
    setMateriales((prev) => [...prev, m]);
    setNuevoMaterial('');
  };

  const guardar = useCallback(
    async (estado: EstadoActivacion) => {
      setError(null);
      if (!codigo.trim()) return setError('El código es obligatorio.');
      if (!marca.trim()) return setError('La marca es obligatoria.');
      if (productoIds.length === 0) return setError('Selecciona al menos un producto.');
      if (estado === 'activa') {
        if (!idEmpresa && !empresaNombre.trim()) return setError('Selecciona la empresa para activar la campaña.');
        if (!vigenciaInicio || !vigenciaFin) return setError('Indica la vigencia (inicio y fin) para activar la campaña.');
      }

      const payload = {
        codigo: codigo.trim(),
        marca: marca.trim(),
        producto: productoTexto,
        productos_ids: productoIds,
        tipo_activacion: tipoActivacion.trim(),
        vigencia_inicio: vigenciaInicio,
        vigencia_fin: vigenciaFin,
        duracion_horas: parseFloat(duracionHoras.replace(',', '.')) || 0,
        ocasion: ocasion.trim(),
        target_descripcion: targetDescripcion.trim(),
        mecanica: mecanica.trim(),
        equipo_descripcion: equipoDescripcion.trim(),
        materiales,
        pago_observaciones: pagoObservaciones.trim(),
        id_empresa: idEmpresa,
        empresa_nombre: empresaNombre.trim(),
        empresa_cif: empresaCif.trim(),
        promotor_nombre: promotorNombre.trim(),
        promotor_telefono: promotorTelefono.trim(),
        estado,
      };

      setSaving(true);
      try {
        const r = await apiFetch(editId ? `/api/activaciones/${editId}` : '/api/activaciones', {
          method: editId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
        const id = d.activacion?.id_activacion ?? editId;
        router.replace(`/reservas/activacion-detalle?id=${id}` as never);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error de red');
      } finally {
        setSaving(false);
      }
    },
    [
      codigo, marca, productoIds, productoTexto, tipoActivacion, vigenciaInicio, vigenciaFin, duracionHoras,
      ocasion, targetDescripcion, mecanica, equipoDescripcion, materiales, pagoObservaciones,
      idEmpresa, empresaNombre, empresaCif, promotorNombre, promotorTelefono, editId, router,
    ],
  );

  if (!puedeGestionar) {
    return (
      <View style={styles.centerBox}>
        <MaterialIcons name="lock-outline" size={36} color="#94a3b8" />
        <Text style={styles.emptyText}>No tienes permiso para gestionar activaciones.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.formWrap}>
            <View style={styles.headerRow}>
              <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                <MaterialIcons name="arrow-back" size={22} color="#334155" />
              </TouchableOpacity>
              <Text style={styles.title}>{editId ? 'Editar activación' : 'Nueva activación'}</Text>
            </View>

          <Text style={styles.secTitle}>Empresa y promotor</Text>
          <Text style={styles.label}>Empresa (marca)</Text>
          <SelectorDesplegable
            icono="business"
            tituloLista="Empresa"
            iconoLista="business"
            placeholder="Selecciona la empresa…"
            opciones={opcionesEmpresa}
            valorId={valorEmpresaId}
            onSeleccionar={seleccionarEmpresa}
            buscador
            buscadorPlaceholder="Buscar por nombre o CIF…"
          />
          {empresaCif ? <Text style={styles.cifAux}>CIF: {empresaCif}</Text> : null}

          <View style={[styles.row2, shouldStackPanels && styles.rowStack]}>
            <View style={[styles.colPromotor, shouldStackPanels && styles.colStackFull]}>
              <Text style={styles.label}>Nombre del promotor</Text>
              <TextInput
                style={styles.input}
                value={promotorNombre}
                onChangeText={setPromotorNombre}
                placeholder="Persona de contacto de la marca"
                placeholderTextColor="#94a3b8"
              />
            </View>
            <View style={[styles.colTelefono, shouldStackPanels && styles.colStackFull]}>
              <Text style={styles.label}>Teléfono del promotor</Text>
              <TextInput
                style={styles.input}
                value={promotorTelefono}
                onChangeText={setPromotorTelefono}
                keyboardType="phone-pad"
                placeholder="+34 612 345 678"
                placeholderTextColor="#94a3b8"
              />
            </View>
          </View>

          <Text style={styles.secTitle}>Identificación</Text>
          <Text style={styles.label}>Código *</Text>
          <TextInput
            style={[styles.input, styles.inputCodigo]}
            value={codigo}
            onChangeText={setCodigo}
            autoCapitalize="characters"
            placeholder="LARIOSPOMELO_RULETA_26HD"
            placeholderTextColor="#94a3b8"
          />
          <Text style={styles.label}>Marca *</Text>
          <TextInput
            style={[styles.input, styles.inputMedio]}
            value={marca}
            onChangeText={setMarca}
            placeholder="Larios"
            placeholderTextColor="#94a3b8"
          />
          <Text style={styles.label}>Producto(s) *</Text>
          <SelectorDesplegableMulti
            placeholder="Buscar producto IGP…"
            icono="inventory-2"
            tituloLista="Productos IGP"
            iconoLista="inventory-2"
            loading={loadingProductos}
            buscador
            buscadorPlaceholder="Buscar por nombre o ID…"
            valorIds={productoIds}
            opciones={opcionesProducto}
            onChange={setProductoIds}
            vacioTexto="No hay productos IGP en el catálogo."
          />
          {productoIds.length > 0 ? (
            <View style={styles.productosChips}>
              {productoIds.map((id) => {
                const titulo = opcionesProducto.find((o) => o.id === id)?.titulo ?? id;
                return (
                  <View key={id} style={styles.materialChip}>
                    <Text style={styles.materialText} numberOfLines={1}>{titulo}</Text>
                    <TouchableOpacity
                      onPress={() => setProductoIds((prev) => prev.filter((x) => x !== id))}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    >
                      <MaterialIcons name="close" size={14} color="#64748b" />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          ) : null}
          <Text style={styles.label}>Tipo de activación</Text>
          <TextInput
            style={[styles.input, styles.inputMedio]}
            value={tipoActivacion}
            onChangeText={setTipoActivacion}
            placeholder="Ruleta, Degustación, Showcooking…"
            placeholderTextColor="#94a3b8"
          />

          <Text style={styles.secTitle}>Vigencia y sesión</Text>
          <View style={styles.row2}>
            <View style={styles.col}>
              <Text style={styles.label}>Fecha inicio</Text>
              <InputFecha valueIso={vigenciaInicio} onChangeIso={setVigenciaInicio} style={styles.input} />
            </View>
            <View style={styles.col}>
              <Text style={styles.label}>Fecha fin</Text>
              <InputFecha valueIso={vigenciaFin} onChangeIso={setVigenciaFin} style={styles.input} />
            </View>
          </View>
          <View style={[styles.row2, shouldStackPanels && styles.rowStack]}>
            <View style={[styles.colDuracion, shouldStackPanels && styles.colStackFull]}>
              <Text style={styles.label}>Duración por sesión (horas)</Text>
              <TextInput
                style={styles.input}
                value={duracionHoras}
                onChangeText={setDuracionHoras}
                keyboardType="decimal-pad"
                placeholder="2"
                placeholderTextColor="#94a3b8"
              />
            </View>
            <View style={styles.col}>
              <Text style={styles.label}>Ocasión</Text>
              <TextInput style={styles.input} value={ocasion} onChangeText={setOcasion} placeholder="Tardeo largo / 1ª copa" placeholderTextColor="#94a3b8" />
            </View>
          </View>
          <Text style={styles.label}>Target de consumidor</Text>
          <TextInput
            style={[styles.input, styles.inputMedio]}
            value={targetDescripcion}
            onChangeText={setTargetDescripcion}
            placeholder="+35 años"
            placeholderTextColor="#94a3b8"
          />

          <Text style={styles.secTitle}>Mecánica</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={mecanica}
            onChangeText={setMecanica}
            multiline
            placeholder="Descripción de cómo funciona la activación…"
            placeholderTextColor="#94a3b8"
          />

          <Text style={styles.secTitle}>Equipo</Text>
          <TextInput
            style={[styles.input, styles.inputMedio]}
            value={equipoDescripcion}
            onChangeText={setEquipoDescripcion}
            placeholder="Azafato + Azafato + Coordinador"
            placeholderTextColor="#94a3b8"
          />

          <Text style={styles.secTitle}>Materiales</Text>
          <View style={styles.materialesWrap}>
            {materiales.map((m, idx) => (
              <View key={`${m}-${idx}`} style={styles.materialChip}>
                <Text style={styles.materialText}>{m}</Text>
                <TouchableOpacity
                  onPress={() => setMateriales((prev) => prev.filter((_, i) => i !== idx))}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <MaterialIcons name="close" size={14} color="#64748b" />
                </TouchableOpacity>
              </View>
            ))}
          </View>
          <View style={styles.addMaterialRow}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={nuevoMaterial}
              onChangeText={setNuevoMaterial}
              placeholder="Ruleta x2, Totebags…"
              placeholderTextColor="#94a3b8"
              onSubmitEditing={agregarMaterial}
            />
            <TouchableOpacity style={styles.addMaterialBtn} onPress={agregarMaterial}>
              <MaterialIcons name="add" size={18} color="#fff" />
              <Text style={styles.addMaterialBtnText}>Añadir material</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.secTitle}>Observaciones de pago</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={pagoObservaciones}
            onChangeText={setPagoObservaciones}
            multiline
            placeholder="El PDV debe guardar todos los tickets para liquidación…"
            placeholderTextColor="#94a3b8"
          />

          <Text style={styles.secTitle}>Documentos e imágenes</Text>
          {!editId ? (
            <Text style={styles.adjHint}>Guarda la activación para poder adjuntar archivos.</Text>
          ) : (
            <>
              {adjuntos.map((adj) => (
                <View key={adj.id} style={styles.adjRow}>
                  <MaterialIcons name="attach-file" size={18} color="#0ea5e9" />
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    onPress={() => adj.url && Linking.openURL(adj.url).catch(() => {})}
                  >
                    <Text style={styles.adjNombre} numberOfLines={1}>{adj.nombre}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => eliminarAdjunto(adj.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <MaterialIcons name="delete-outline" size={18} color="#dc2626" />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity
                style={[styles.addMaterialBtn, subiendoAdjunto && styles.btnDisabled]}
                onPress={subirAdjunto}
                disabled={subiendoAdjunto}
              >
                {subiendoAdjunto ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <MaterialIcons name="cloud-upload" size={18} color="#fff" />
                )}
                <Text style={styles.addMaterialBtnText}>
                  {Platform.OS === 'web' ? 'Subir archivo o imagen' : 'Subida disponible en web'}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {error ? (
            <View style={styles.errorBanner}>
              <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.footerRow}>
            <TouchableOpacity
              style={[styles.btnSecundario, saving && styles.btnDisabled]}
              onPress={() => guardar('borrador')}
              disabled={saving}
            >
              <MaterialIcons name="save" size={16} color="#334155" />
              <Text style={styles.btnSecundarioText}>Guardar como borrador</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btnPrimario, saving && styles.btnDisabled]}
              onPress={() => guardar('activa')}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialIcons name="check-circle" size={16} color="#fff" />
              )}
              <Text style={styles.btnPrimarioText}>
                {estadoActual === 'activa' ? 'Guardar' : 'Activar'}
              </Text>
            </TouchableOpacity>
          </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, backgroundColor: '#f8fafc' },
  scrollContent: { paddingBottom: 32, alignItems: 'center' },
  formWrap: { width: '100%', maxWidth: 680 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  secTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: 18,
    marginBottom: 8,
  },
  label: { fontSize: 12, fontWeight: '600', color: '#0f172a', marginBottom: 4 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    color: '#0f172a',
    marginBottom: 10,
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  cifAux: { fontSize: 12, color: '#64748b', marginTop: 4, marginBottom: 10 },
  row2: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  rowStack: { flexDirection: 'column' },
  col: { flex: 1, minWidth: 0 },
  colPromotor: { flex: 1, minWidth: 0, maxWidth: 360 },
  colTelefono: { width: 200, maxWidth: 220, flexShrink: 0 },
  colDuracion: { width: 120, maxWidth: 140, flexShrink: 0 },
  colStackFull: { width: '100%', maxWidth: '100%' },
  inputCodigo: { maxWidth: 480, alignSelf: 'flex-start' },
  inputMedio: { maxWidth: 420, alignSelf: 'flex-start' },
  productosChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  adjHint: { fontSize: 12, color: '#64748b', fontStyle: 'italic', marginBottom: 8 },
  adjRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  adjNombre: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },
  materialesWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  materialChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  materialText: { fontSize: 12, color: '#334155' },
  addMaterialRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  addMaterialBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  addMaterialBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    padding: 10,
    marginTop: 14,
  },
  errorText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  footerRow: { flexDirection: 'row', gap: 10, marginTop: 18, flexWrap: 'wrap' },
  btnSecundario: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  btnSecundarioText: { fontSize: 13, fontWeight: '600', color: '#334155' },
  btnPrimario: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#16a34a',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  btnPrimarioText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  btnDisabled: { opacity: 0.6 },
});
