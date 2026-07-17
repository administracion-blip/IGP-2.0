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
  useWindowDimensions,
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
  FamilyId?: string | number;
  FamilyName?: string;
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

function productoFamilyId(p: AgoraProduct): string {
  return String(p.FamilyId ?? '').trim();
}

export function CampanaFormModal({ visible, onClose, onSaved, campana, puedeGestionar }: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const formWide = windowWidth >= 900;

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
  const [familiaIdsSel, setFamiliaIdsSel] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;
    setForm(campana ? campanaAForm(campana) : EMPTY_FORM);
    setProductoIdsSel(campana?.productos?.map((p) => p.productId) ?? []);
    setFamiliaIdsSel([]);
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

  const opcionesFamilias = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of productosAgora) {
      const id = productoFamilyId(p);
      if (!id) continue;
      const name = String(p.FamilyName ?? id).trim();
      if (!map.has(id)) map.set(id, name || id);
    }
    return [...map.entries()]
      .map(([id, titulo]) => ({ id, titulo }))
      .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'));
  }, [productosAgora]);

  const productosVisibles = useMemo(() => {
    if (familiaIdsSel.length === 0) return productosAgora;
    const set = new Set(familiaIdsSel);
    return productosAgora.filter((p) => set.has(productoFamilyId(p)));
  }, [productosAgora, familiaIdsSel]);

  const opcionesProductos = useMemo(
    () =>
      productosVisibles
        .map((p) => {
          const id = String(p.Id ?? '').trim();
          const nombre = String(p.Name ?? id).trim();
          const familia = String(p.FamilyName ?? '').trim();
          const coste = p.CostPrice;
          const sinCoste = coste == null || coste === 0;
          const costeTxt = sinCoste ? 'Sin coste en almacén' : `Coste ${Number(coste).toFixed(2)} €`;
          return {
            id,
            titulo: nombre,
            subtitulo: familia ? `${familia} · ${costeTxt}` : costeTxt,
          };
        })
        .filter((o) => o.id),
    [productosVisibles],
  );

  const productosMap = useMemo(() => {
    const m = new Map<string, AgoraProduct>();
    for (const p of productosAgora) {
      const id = String(p.Id ?? '').trim();
      if (id) m.set(id, p);
    }
    return m;
  }, [productosAgora]);

  const aplicarProductosIds = useCallback(
    (ids: string[]) => {
      setProductoIdsSel(ids);
      const productos = ids.map((id) => {
        const p = productosMap.get(id);
        return {
          productId: id,
          productName: String(p?.Name ?? id),
        };
      });
      setForm((f) => ({ ...f, productos }));
    },
    [productosMap],
  );

  const onProductosChange = useCallback(
    (ids: string[]) => {
      aplicarProductosIds(ids);
    },
    [aplicarProductosIds],
  );

  const onFamiliasChange = useCallback(
    (ids: string[]) => {
      setFamiliaIdsSel(ids);
      if (ids.length === 0) return;
      const visibleSet = new Set(
        productosAgora
          .filter((p) => ids.includes(productoFamilyId(p)))
          .map((p) => String(p.Id ?? '').trim())
          .filter(Boolean),
      );
      const pruned = productoIdsSel.filter((id) => visibleSet.has(id));
      if (pruned.length !== productoIdsSel.length) {
        aplicarProductosIds(pruned);
      }
    },
    [productosAgora, productoIdsSel, aplicarProductosIds],
  );

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

  const bloqueFechas = (
    <>
      <View style={styles.filaFechas}>
        <View style={styles.fechaCol}>
          <Text style={styles.label}>Inicio campaña</Text>
          <InputFecha
            valueIso={form.fechaInicio}
            onChangeIso={(iso) => setForm((f) => ({ ...f, fechaInicio: iso }))}
            placeholder="dd/mm/aaaa"
            compact
            style={styles.inputFecha}
            editable={puedeGestionar && !inmutable}
          />
        </View>
        <View style={styles.fechaCol}>
          <Text style={styles.label}>Fin campaña</Text>
          <InputFecha
            valueIso={form.fechaFin}
            onChangeIso={(iso) => setForm((f) => ({ ...f, fechaFin: iso }))}
            placeholder="dd/mm/aaaa"
            compact
            style={styles.inputFecha}
            editable={puedeGestionar && !inmutable}
          />
        </View>
      </View>

      {!inmutable ? (
        <View style={styles.filaFechas}>
          <View style={styles.fechaCol}>
            <Text style={styles.label}>Baseline desde</Text>
            <InputFecha
              valueIso={form.baselineInicio}
              onChangeIso={(iso) => setForm((f) => ({ ...f, baselineInicio: iso }))}
              placeholder="dd/mm/aaaa"
              compact
              style={styles.inputFecha}
              editable={puedeGestionar}
            />
          </View>
          <View style={styles.fechaCol}>
            <Text style={styles.label}>Baseline hasta</Text>
            <InputFecha
              valueIso={form.baselineFin}
              onChangeIso={(iso) => setForm((f) => ({ ...f, baselineFin: iso }))}
              placeholder="dd/mm/aaaa"
              compact
              style={styles.inputFecha}
              editable={puedeGestionar}
            />
          </View>
        </View>
      ) : null}

      {duracionLarga ? (
        <Text style={styles.avisoInline}>
          La duración supera 8 semanas. Revisa que el periodo sea el adecuado.
        </Text>
      ) : null}

      <Text style={styles.notaFechas}>
        Las fechas de campaña son días naturales; las unidades vienen de la jornada de negocio de Ágora (business-day).
      </Text>
    </>
  );

  const bloqueIncentivo = (
    <>
      <View style={styles.filaIncentivo}>
        <View style={styles.incentivoTipoCol}>
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
        </View>
        <View style={styles.incentivoValorCol}>
          <Text style={styles.label}>
            {form.tipoIncentivo === 'eur_por_unidad' ? '€ / ud.' : 'Fracción margen'}
          </Text>
          <TextInput
            style={[styles.input, styles.inputValor]}
            value={form.valorIncentivo}
            onChangeText={(t) => setForm((f) => ({ ...f, valorIncentivo: t }))}
            keyboardType="decimal-pad"
            placeholder={form.tipoIncentivo === 'eur_por_unidad' ? '0,00' : '0,10'}
            editable={puedeGestionar && !inmutable}
          />
        </View>
      </View>

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
        numberOfLines={formWide ? 4 : 3}
        editable={puedeGestionar}
      />
    </>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[styles.panel, formWide && styles.panelWide]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.header}>
            <Text style={styles.titulo}>
              {esEdicion ? 'Editar campaña' : 'Nueva campaña de incentivo'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <MaterialIcons name="close" size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={[styles.scroll, formWide && styles.scrollWide]}
            contentContainerStyle={formWide ? styles.scrollContentWide : undefined}
            keyboardShouldPersistTaps="handled"
          >
            {inmutable ? (
              <View style={styles.avisoBox}>
                <MaterialIcons name="info-outline" size={16} color="#d97706" />
                <Text style={styles.avisoText}>
                  Campaña activa: no se pueden cambiar productos, locales, fechas ni incentivo.
                </Text>
              </View>
            ) : null}

            <View style={formWide ? styles.formRow : undefined}>
              <View style={formWide ? styles.formCol : undefined}>
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
                  compact
                  style={styles.fieldGap}
                />

                <SelectorDesplegableMulti
                  label="Familias"
                  opciones={opcionesFamilias}
                  valorIds={familiaIdsSel}
                  onChange={onFamiliasChange}
                  loading={loadingMaestros}
                  disabled={!puedeGestionar || inmutable}
                  buscador
                  buscadorPlaceholder="Buscar familia…"
                  placeholder="Todas las familias"
                  compact
                  style={styles.fieldGap}
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
                  compact
                  style={styles.fieldGap}
                />
              </View>

              <View style={formWide ? styles.formCol : undefined}>
                {bloqueFechas}
                {bloqueIncentivo}
              </View>
            </View>

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
  panelWide: {
    maxWidth: 960,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  titulo: { fontSize: 15, fontWeight: '700', color: '#334155', flex: 1 },
  scroll: { padding: 12, maxHeight: 480 },
  scrollWide: { maxHeight: 520 },
  scrollContentWide: { paddingBottom: 4 },
  formRow: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'flex-start',
  },
  formCol: {
    flex: 1,
    minWidth: 0,
  },
  fieldGap: { marginTop: 6 },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 4,
    marginTop: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 12,
    color: '#334155',
    backgroundColor: '#fff',
    minHeight: 32,
  },
  inputFecha: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    backgroundColor: '#fff',
    fontSize: 12,
    minHeight: 32,
  },
  textArea: { minHeight: 52, textAlignVertical: 'top', paddingVertical: 6 },
  filaFechas: { flexDirection: 'row', gap: 8, marginTop: 2 },
  fechaCol: { flex: 1, minWidth: 0 },
  filaIncentivo: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    flexWrap: 'wrap',
  },
  incentivoTipoCol: { flex: 1, minWidth: 160 },
  incentivoValorCol: { width: 96, flexShrink: 0 },
  inputValor: { textAlign: 'right' as const },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 2 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipText: { fontSize: 11, color: '#64748b' },
  chipTextActivo: { color: '#0369a1', fontWeight: '600' },
  notaFechas: { fontSize: 10, color: '#94a3b8', fontStyle: 'italic', marginTop: 4 },
  avisoBox: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#fffbeb',
    padding: 8,
    borderRadius: 6,
    marginBottom: 6,
    alignItems: 'flex-start',
  },
  avisoText: { flex: 1, fontSize: 11, color: '#92400e' },
  avisoInline: { fontSize: 10, color: '#d97706', marginTop: 4 },
  error: { fontSize: 11, color: '#dc2626', marginTop: 6 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  btnSec: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#f1f5f9',
  },
  btnSecText: { color: '#475569', fontWeight: '600', fontSize: 12 },
  btnPri: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: '#0ea5e9',
    minWidth: 88,
    alignItems: 'center',
  },
  btnPriText: { color: '#fff', fontWeight: '700', fontSize: 12 },
});
