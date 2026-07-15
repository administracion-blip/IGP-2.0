import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from './InputFecha';
import { SelectorDesplegableMulti } from './SelectorDesplegableMulti';
import { apiFetch } from '../utils/api';
import { valorEnLocal } from '../utils/valorEnLocal';
import {
  avisoDuracionLarga,
  etiquetaDestinatario,
  etiquetaTipoIncentivo,
} from '../lib/incentivosProducto';
import type {
  Campana,
  CampanaFormValues,
  DestinatarioCampana,
  EstadoCampana,
  TipoIncentivo,
} from '../types/incentivosProducto';

type AgoraProduct = {
  Id?: string | number;
  Name?: string;
  CostPrice?: number;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
  campana?: Campana | null;
  puedeGestionar: boolean;
};

const EMPTY_FORM: CampanaFormValues = {
  nombre: '',
  locales: [],
  productos: [],
  fechaInicio: '',
  fechaFin: '',
  baselineInicio: '',
  baselineFin: '',
  tipoIncentivo: 'eur_por_unidad',
  valorIncentivo: '',
  destinatario: 'equipo',
  notas: '',
};

function campanaAForm(c: Campana): CampanaFormValues {
  return {
    nombre: c.nombre || '',
    locales: [...(c.locales || [])],
    productos: [...(c.productos || [])],
    fechaInicio: c.fechaInicio || '',
    fechaFin: c.fechaFin || '',
    baselineInicio: c.baselineInicio || '',
    baselineFin: c.baselineFin || '',
    tipoIncentivo: c.tipoIncentivo || 'eur_por_unidad',
    valorIncentivo: c.valorIncentivo != null ? String(c.valorIncentivo) : '',
    destinatario: c.destinatario || 'equipo',
    notas: c.notas || '',
    estado: c.estado,
  };
}

export function CampanaFormModal({ visible, onClose, onSaved, campana, puedeGestionar }: Props) {
  const esEdicion = !!campana?.campanaId;
  const inmutable = esEdicion && campana?.estado === 'Activa';

  const [form, setForm] = useState<CampanaFormValues>(EMPTY_FORM);
  const [locales, setLocales] = useState<Record<string, unknown>[]>([]);
  const [productosAgora, setProductosAgora] = useState<AgoraProduct[]>([]);
  const [loadingMaestros, setLoadingMaestros] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [productoIdsSel, setProductoIdsSel] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;
    setForm(campana ? campanaAForm(campana) : EMPTY_FORM);
    setProductoIdsSel(campana?.productos?.map((p) => p.productId) ?? []);
    setError(null);
    setAvisos([]);
  }, [visible, campana]);

  useEffect(() => {
    if (!visible) return;
    setLoadingMaestros(true);
    Promise.all([
      apiFetch('/api/locales').then((r) => r.json()),
      apiFetch('/api/agora/products').then((r) => r.json()),
    ])
      .then(([locData, prodData]) => {
        setLocales(locData.locales || []);
        setProductosAgora(prodData.productos || []);
      })
      .catch(() => {
        setLocales([]);
        setProductosAgora([]);
      })
      .finally(() => setLoadingMaestros(false));
  }, [visible]);

  const opcionesLocales = useMemo(
    () =>
      locales.map((l) => {
        const id = String(
          valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'Id_Locales') ?? '',
        ).trim();
        const nombre = String(valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id).trim();
        return { id, titulo: nombre || id, subtitulo: id ? `#${id}` : undefined };
      }).filter((o) => o.id),
    [locales],
  );

  const opcionesProductos = useMemo(
    () =>
      productosAgora
        .map((p) => {
          const id = String(p.Id ?? '').trim();
          const nombre = String(p.Name ?? id).trim();
          const coste = p.CostPrice;
          const sinCoste = coste == null || coste === 0;
          return {
            id,
            titulo: nombre,
            subtitulo: sinCoste ? 'Sin coste en almacén' : `Coste ${Number(coste).toFixed(2)} €`,
          };
        })
        .filter((o) => o.id),
    [productosAgora],
  );

  const productosMap = useMemo(() => {
    const m = new Map<string, AgoraProduct>();
    for (const p of productosAgora) {
      const id = String(p.Id ?? '').trim();
      if (id) m.set(id, p);
    }
    return m;
  }, [productosAgora]);

  const onProductosChange = useCallback((ids: string[]) => {
    setProductoIdsSel(ids);
    const productos = ids.map((id) => {
      const p = productosMap.get(id);
      return {
        productId: id,
        productName: String(p?.Name ?? id),
      };
    });
    setForm((f) => ({ ...f, productos }));
  }, [productosMap]);

  const guardar = async () => {
    if (!puedeGestionar) return;
    setError(null);
    setAvisos([]);
    const valor = parseFloat(String(form.valorIncentivo).replace(',', '.'));
    if (!form.nombre.trim()) {
      setError('Indica un nombre para la campaña');
      return;
    }
    if (form.locales.length === 0) {
      setError('Selecciona al menos un local');
      return;
    }
    if (form.productos.length === 0) {
      setError('Selecciona al menos un producto');
      return;
    }
    if (!form.fechaInicio || !form.fechaFin) {
      setError('Indica fechas de inicio y fin');
      return;
    }
    if (!(valor > 0)) {
      setError('El valor del incentivo debe ser mayor que 0');
      return;
    }

    const body: Record<string, unknown> = {
      nombre: form.nombre.trim(),
      locales: form.locales,
      productos: form.productos,
      fechaInicio: form.fechaInicio,
      fechaFin: form.fechaFin,
      tipoIncentivo: form.tipoIncentivo,
      valorIncentivo: valor,
      destinatario: form.destinatario,
      notas: form.notas.trim(),
    };
    if (form.baselineInicio && form.baselineFin) {
      body.baselineInicio = form.baselineInicio;
      body.baselineFin = form.baselineFin;
    }
    if (esEdicion && form.estado) body.estado = form.estado;

    setGuardando(true);
    try {
      const url = esEdicion
        ? `/api/campanas/${campana!.campanaId}`
        : '/api/campanas';
      const res = await apiFetch(url, {
        method: esEdicion ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        setAvisos(data.warnings);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  };

  const duracionLarga = avisoDuracionLarga(form.fechaInicio, form.fechaFin);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.panel} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.titulo}>
              {esEdicion ? 'Editar campaña' : 'Nueva campaña de incentivo'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <MaterialIcons name="close" size={24} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            {inmutable ? (
              <View style={styles.avisoBox}>
                <MaterialIcons name="info-outline" size={18} color="#d97706" />
                <Text style={styles.avisoText}>
                  Campaña activa: no se pueden cambiar productos, locales, fechas ni incentivo.
                </Text>
              </View>
            ) : null}

            <Text style={styles.label}>Nombre</Text>
            <TextInput
              style={styles.input}
              value={form.nombre}
              onChangeText={(t) => setForm((f) => ({ ...f, nombre: t }))}
              placeholder="Ej. Vino selección otoño"
              editable={puedeGestionar}
            />

            <SelectorDesplegableMulti
              label="Locales"
              opciones={opcionesLocales}
              valorIds={form.locales}
              onChange={(ids) => setForm((f) => ({ ...f, locales: ids }))}
              loading={loadingMaestros}
              disabled={!puedeGestionar || inmutable}
              buscador
              buscadorPlaceholder="Buscar local…"
            />

            <SelectorDesplegableMulti
              label="Productos"
              opciones={opcionesProductos}
              valorIds={productoIdsSel}
              onChange={onProductosChange}
              loading={loadingMaestros}
              disabled={!puedeGestionar || inmutable}
              buscador
              buscadorPlaceholder="Buscar producto…"
            />

            <View style={styles.filaFechas}>
              <View style={styles.fechaCol}>
                <Text style={styles.label}>Inicio campaña</Text>
                <InputFecha
                  valueIso={form.fechaInicio}
                  onChangeIso={(iso) => setForm((f) => ({ ...f, fechaInicio: iso }))}
                  editable={puedeGestionar && !inmutable}
                />
              </View>
              <View style={styles.fechaCol}>
                <Text style={styles.label}>Fin campaña</Text>
                <InputFecha
                  valueIso={form.fechaFin}
                  onChangeIso={(iso) => setForm((f) => ({ ...f, fechaFin: iso }))}
                  editable={puedeGestionar && !inmutable}
                />
              </View>
            </View>

            {duracionLarga ? (
              <Text style={styles.avisoInline}>
                La duración supera 8 semanas. Revisa que el periodo sea el adecuado.
              </Text>
            ) : null}

            <Text style={styles.notaFechas}>
              Las fechas de campaña son días naturales; las unidades vienen de la jornada de negocio de Ágora (business-day).
            </Text>

            {!inmutable ? (
              <View style={styles.filaFechas}>
                <View style={styles.fechaCol}>
                  <Text style={styles.label}>Baseline desde</Text>
                  <InputFecha
                    valueIso={form.baselineInicio}
                    onChangeIso={(iso) => setForm((f) => ({ ...f, baselineInicio: iso }))}
                    editable={puedeGestionar}
                  />
                </View>
                <View style={styles.fechaCol}>
                  <Text style={styles.label}>Baseline hasta</Text>
                  <InputFecha
                    valueIso={form.baselineFin}
                    onChangeIso={(iso) => setForm((f) => ({ ...f, baselineFin: iso }))}
                    editable={puedeGestionar}
                  />
                </View>
              </View>
            ) : null}

            <Text style={styles.label}>Tipo de incentivo</Text>
            <View style={styles.chipsRow}>
              {(['eur_por_unidad', 'pct_margen'] as TipoIncentivo[]).map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.chip, form.tipoIncentivo === t && styles.chipActivo]}
                  onPress={() => !inmutable && setForm((f) => ({ ...f, tipoIncentivo: t }))}
                  disabled={inmutable}
                >
                  <Text style={[styles.chipText, form.tipoIncentivo === t && styles.chipTextActivo]}>
                    {etiquetaTipoIncentivo(t)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>
              {form.tipoIncentivo === 'eur_por_unidad' ? 'Euros por unidad' : 'Fracción del margen (0,10 = 10%)'}
            </Text>
            <TextInput
              style={styles.input}
              value={form.valorIncentivo}
              onChangeText={(t) => setForm((f) => ({ ...f, valorIncentivo: t }))}
              keyboardType="decimal-pad"
              editable={puedeGestionar && !inmutable}
            />

            <Text style={styles.label}>Destinatario</Text>
            <View style={styles.chipsRow}>
              {(['equipo', 'individual'] as DestinatarioCampana[]).map((d) => (
                <TouchableOpacity
                  key={d}
                  style={[styles.chip, form.destinatario === d && styles.chipActivo]}
                  onPress={() => !inmutable && setForm((f) => ({ ...f, destinatario: d }))}
                  disabled={inmutable}
                >
                  <Text style={[styles.chipText, form.destinatario === d && styles.chipTextActivo]}>
                    {etiquetaDestinatario(d)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {esEdicion ? (
              <>
                <Text style={styles.label}>Estado</Text>
                <View style={styles.chipsRow}>
                  {(['Borrador', 'Activa', 'Finalizada', 'Archivada'] as EstadoCampana[]).map((e) => (
                    <TouchableOpacity
                      key={e}
                      style={[styles.chip, form.estado === e && styles.chipActivo]}
                      onPress={() => setForm((f) => ({ ...f, estado: e }))}
                    >
                      <Text style={[styles.chipText, form.estado === e && styles.chipTextActivo]}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}

            <Text style={styles.label}>Notas</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={form.notas}
              onChangeText={(t) => setForm((f) => ({ ...f, notas: t }))}
              multiline
              numberOfLines={3}
              editable={puedeGestionar}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {avisos.map((a) => (
              <Text key={a} style={styles.avisoInline}>{a}</Text>
            ))}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity style={styles.btnSec} onPress={onClose}>
              <Text style={styles.btnSecText}>Cancelar</Text>
            </TouchableOpacity>
            {puedeGestionar ? (
              <TouchableOpacity style={styles.btnPri} onPress={guardar} disabled={guardando}>
                {guardando ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.btnPriText}>{esEdicion ? 'Guardar' : 'Crear'}</Text>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: Platform.OS === 'web' ? 24 : 12,
  },
  panel: {
    backgroundColor: '#fff',
    borderRadius: 12,
    maxHeight: '92%',
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  titulo: { fontSize: 18, fontWeight: '700', color: '#334155', flex: 1 },
  scroll: { padding: 16, maxHeight: 520 },
  label: { fontSize: 13, fontWeight: '600', color: '#475569', marginBottom: 6, marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#334155',
    backgroundColor: '#fff',
  },
  textArea: { minHeight: 72, textAlignVertical: 'top' },
  filaFechas: { flexDirection: 'row', gap: 12 },
  fechaCol: { flex: 1 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipText: { fontSize: 13, color: '#64748b' },
  chipTextActivo: { color: '#0369a1', fontWeight: '600' },
  notaFechas: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginTop: 8 },
  avisoBox: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#fffbeb',
    padding: 10,
    borderRadius: 8,
    marginBottom: 8,
    alignItems: 'flex-start',
  },
  avisoText: { flex: 1, fontSize: 13, color: '#92400e' },
  avisoInline: { fontSize: 12, color: '#d97706', marginTop: 6 },
  error: { fontSize: 13, color: '#dc2626', marginTop: 10 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  btnSec: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  btnSecText: { color: '#475569', fontWeight: '600' },
  btnPri: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
    minWidth: 100,
    alignItems: 'center',
  },
  btnPriText: { color: '#fff', fontWeight: '700' },
});
