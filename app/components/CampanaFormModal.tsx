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
  colorEstadoCampana,
  etiquetaDestinatario,
  etiquetaTipoIncentivo,
  normalizarValorIncentivo,
  parseValorIncentivoInput,
  valorIncentivoParaFormulario,
} from '../lib/incentivosProducto';
import { DIAS_AUTO_ARCHIVAR, estadoEfectivoCampana, etiquetaEstadoAutomatico } from '../lib/campanaEstado';
import type {
  Campana,
  CampanaFormValues,
  DestinatarioCampana,
  ProductoCampana,
  TipoIncentivo,
} from '../types/incentivosProducto';

type AgoraProduct = {
  Id?: string | number;
  Name?: string;
  CostPrice?: number;
  FamilyId?: string | number;
  FamilyName?: string;
};

type FilaPreviewIncentivo = {
  productId: string;
  productName: string;
  precioCompra: number | null;
  incentivo: number | null;
  /** Override €/ud del producto, si existe. */
  valorOverride?: number;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onSaved: (info?: { campanaId?: string; creada?: boolean }) => void;
  campana?: Campana | null;
  /** Si true, abre como alta nueva con datos de `campana` (todos editables). */
  duplicar?: boolean;
  puedeGestionar: boolean;
};

const EMPTY_FORM: CampanaFormValues = {
  nombre: '',
  locales: [],
  productos: [],
  fechaInicio: '',
  fechaFin: '',
  tipoIncentivo: 'pct_coste',
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
    tipoIncentivo: c.tipoIncentivo || 'eur_por_unidad',
    valorIncentivo: c.valorIncentivo != null
      ? valorIncentivoParaFormulario(c.tipoIncentivo || 'pct_coste', c.valorIncentivo)
      : '',
    destinatario: c.destinatario || 'equipo',
    notas: c.notas || '',
  };
}

/** Plantilla para duplicar: copia reglas, limpia fechas y marca el nombre. */
function campanaAPlantillaDuplicado(c: Campana): CampanaFormValues {
  const base = campanaAForm(c);
  const nombreBase = (base.nombre || 'Campaña').replace(/\s*\(copia\)\s*$/i, '').trim();
  return {
    ...base,
    nombre: `${nombreBase} (copia)`,
    fechaInicio: '',
    fechaFin: '',
  };
}

function productoFamilyId(p: AgoraProduct): string {
  return String(p.FamilyId ?? '').trim();
}

export function CampanaFormModal({
  visible,
  onClose,
  onSaved,
  campana,
  duplicar = false,
  puedeGestionar,
}: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const formWide = windowWidth >= 900;

  const esDuplicar = Boolean(duplicar && campana?.campanaId);
  const esEdicion = Boolean(campana?.campanaId) && !esDuplicar;
  const estadoCampana = esEdicion && campana ? estadoEfectivoCampana(campana) : null;
  const inmutable = esEdicion && estadoCampana === 'Activa';

  const [form, setForm] = useState<CampanaFormValues>(EMPTY_FORM);
  const [locales, setLocales] = useState<Record<string, unknown>[]>([]);
  const [productosAgora, setProductosAgora] = useState<AgoraProduct[]>([]);
  const [loadingMaestros, setLoadingMaestros] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [productoIdsSel, setProductoIdsSel] = useState<string[]>([]);
  const [familiaIdsSel, setFamiliaIdsSel] = useState<string[]>([]);
  const [previewIncentivoOpen, setPreviewIncentivoOpen] = useState(false);
  /** Borradores de texto del preview €/ud por producto (UX al teclear coma/punto). */
  const [previewDrafts, setPreviewDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!visible) return;
    if (esDuplicar && campana) {
      setForm(campanaAPlantillaDuplicado(campana));
      setProductoIdsSel(campana.productos?.map((p) => p.productId) ?? []);
    } else if (campana && !esDuplicar) {
      setForm(campanaAForm(campana));
      setProductoIdsSel(campana.productos?.map((p) => p.productId) ?? []);
    } else {
      setForm(EMPTY_FORM);
      setProductoIdsSel([]);
    }
    setFamiliaIdsSel([]);
    setError(null);
    setAvisos([]);
    setPreviewIncentivoOpen(false);
    setPreviewDrafts({});
  }, [visible, campana, esDuplicar]);

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
            subtitulo: familia
              ? `ID ${id} · ${familia} · ${costeTxt}`
              : `ID ${id} · ${costeTxt}`,
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

  const resumenProductosSel = useMemo(
    () =>
      form.productos
        .map((p) => String(p.productName || p.productId).trim())
        .filter(Boolean)
        .join(', '),
    [form.productos],
  );

  const filasPreviewIncentivo = useMemo((): FilaPreviewIncentivo[] => {
    const valorRaw = parseValorIncentivoInput(form.valorIncentivo);
    const valor = normalizarValorIncentivo(form.tipoIncentivo, valorRaw);
    return form.productos.map((p) => {
      const prod = productosMap.get(p.productId);
      const coste = Number(prod?.CostPrice);
      const precioCompra = Number.isFinite(coste) && coste > 0 ? coste : null;
      const override =
        p.valorIncentivo != null && Number.isFinite(p.valorIncentivo)
          ? p.valorIncentivo
          : undefined;
      let incentivo: number | null = null;
      if (form.tipoIncentivo === 'eur_por_unidad') {
        const efectivo =
          override != null && override > 0 ? override : valor > 0 ? valor : 0;
        incentivo = efectivo > 0 ? Math.round(efectivo * 100) / 100 : null;
      } else if (valor > 0 && form.tipoIncentivo === 'pct_coste' && precioCompra != null) {
        incentivo = Math.round(precioCompra * valor * 100) / 100;
      }
      return {
        productId: p.productId,
        productName: String(p.productName || p.productId),
        precioCompra,
        incentivo,
        valorOverride: override,
      };
    });
  }, [form.valorIncentivo, form.tipoIncentivo, form.productos, productosMap]);

  const valorGlobalEurUd = useMemo(() => {
    const n = normalizarValorIncentivo(
      'eur_por_unidad',
      parseValorIncentivoInput(form.valorIncentivo),
    );
    return n > 0 ? n : 0;
  }, [form.valorIncentivo]);

  const textoInputPreviewProducto = useCallback(
    (productId: string, override?: number) => {
      if (previewDrafts[productId] !== undefined) return previewDrafts[productId];
      if (override != null && Number.isFinite(override)) {
        return String(override).replace('.', ',');
      }
      return valorGlobalEurUd > 0
        ? String(valorGlobalEurUd).replace('.', ',')
        : '';
    },
    [previewDrafts, valorGlobalEurUd],
  );

  const onChangePreviewValorProducto = useCallback(
    (productId: string, text: string) => {
      setPreviewDrafts((d) => ({ ...d, [productId]: text }));
      const trimmed = text.trim();
      setForm((f) => ({
        ...f,
        productos: f.productos.map((p) => {
          if (p.productId !== productId) return p;
          if (!trimmed) {
            if (p.valorIncentivo === undefined) return p;
            const { valorIncentivo: _omit, ...rest } = p;
            return rest;
          }
          const n = parseValorIncentivoInput(text);
          if (!(n > 0)) {
            if (p.valorIncentivo === undefined) return p;
            const { valorIncentivo: _omit, ...rest } = p;
            return rest;
          }
          return { ...p, valorIncentivo: Math.round(n * 100) / 100 };
        }),
      }));
    },
    [],
  );

  const aplicarProductosIds = useCallback(
    (ids: string[]) => {
      setProductoIdsSel(ids);
      setForm((f) => {
        const prevById = new Map(f.productos.map((p) => [p.productId, p]));
        const productos: ProductoCampana[] = ids.map((id) => {
          const p = productosMap.get(id);
          const prev = prevById.get(id);
          const next: ProductoCampana = {
            productId: id,
            productName: String(p?.Name ?? prev?.productName ?? id),
          };
          if (prev?.valorIncentivo != null && Number.isFinite(prev.valorIncentivo)) {
            next.valorIncentivo = prev.valorIncentivo;
          }
          if (prev?.margenUnitario != null) {
            next.margenUnitario = prev.margenUnitario;
          }
          return next;
        });
        return { ...f, productos };
      });
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
    const valorRaw = parseValorIncentivoInput(form.valorIncentivo);
    const valor = normalizarValorIncentivo(form.tipoIncentivo, valorRaw);
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
      onSaved({
        campanaId: esEdicion
          ? String(campana?.campanaId || data.campanaId || '')
          : String(data.campanaId || ''),
        creada: !esEdicion,
      });
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

  const formatEuroUd = (n: number) =>
    `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

  const bloqueIncentivo = (
    <>
      <View style={styles.filaIncentivo}>
        <View style={styles.incentivoTipoCol}>
          <Text style={styles.label}>Tipo de incentivo</Text>
          <View style={styles.chipsRow}>
            {(['eur_por_unidad', 'pct_coste'] as TipoIncentivo[]).map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.chip, form.tipoIncentivo === t && styles.chipActivo]}
                onPress={() => {
                  if (inmutable) return;
                  setForm((f) => {
                    if (t === f.tipoIncentivo) return f;
                    if (t === 'eur_por_unidad') {
                      return { ...f, tipoIncentivo: t };
                    }
                    const productos = f.productos.map((p) => {
                      if (p.valorIncentivo === undefined) return p;
                      const { valorIncentivo: _omit, ...rest } = p;
                      return rest;
                    });
                    return { ...f, tipoIncentivo: t, productos };
                  });
                  setPreviewDrafts({});
                }}
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
            {form.tipoIncentivo === 'eur_por_unidad' ? '€ / ud.' : '% (escribe 10 para 10 %)'}
          </Text>
          <View style={styles.valorConPreview}>
            <TouchableOpacity
              style={styles.previewEyeBtn}
              onPress={() =>
                setPreviewIncentivoOpen((v) => {
                  if (v) setPreviewDrafts({});
                  return !v;
                })
              }
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Vista previa del incentivo por producto"
            >
              <MaterialIcons
                name="visibility"
                size={18}
                color={previewIncentivoOpen ? '#0ea5e9' : '#64748b'}
              />
            </TouchableOpacity>
            <TextInput
              style={[styles.input, styles.inputValor]}
              value={form.valorIncentivo}
              onChangeText={(t) => setForm((f) => ({ ...f, valorIncentivo: t }))}
              keyboardType="decimal-pad"
              placeholder={form.tipoIncentivo === 'eur_por_unidad' ? '0,80' : '10'}
              editable={puedeGestionar && !inmutable}
            />
            {previewIncentivoOpen ? (
              <Modal
                visible
                transparent
                animationType="fade"
                onRequestClose={() => {
                  setPreviewIncentivoOpen(false);
                  setPreviewDrafts({});
                }}
              >
                <Pressable style={styles.previewModalOverlay} onPress={() => {
                  setPreviewIncentivoOpen(false);
                  setPreviewDrafts({});
                }}>
                  <Pressable style={styles.previewPanel} onPress={(e) => e.stopPropagation()}>
                    <View style={styles.previewHeader}>
                      <Text style={styles.previewTitulo}>Incentivo por producto</Text>
                      <TouchableOpacity
                        onPress={() => {
                          setPreviewIncentivoOpen(false);
                          setPreviewDrafts({});
                        }}
                        hitSlop={10}
                        accessibilityLabel="Cerrar vista previa"
                      >
                        <MaterialIcons name="close" size={18} color="#64748b" />
                      </TouchableOpacity>
                    </View>
                    {filasPreviewIncentivo.length === 0 ? (
                      <Text style={styles.previewVacio}>Selecciona productos para ver la previsualización.</Text>
                    ) : (
                      <ScrollView style={styles.previewTableScroll} nestedScrollEnabled>
                        <View style={styles.previewTableHead}>
                          <Text style={[styles.previewTh, styles.previewColProducto]}>Producto</Text>
                          <Text style={[styles.previewTh, styles.previewColNum]}>Pr. compra</Text>
                          <Text style={[styles.previewTh, styles.previewColNum]}>
                            {form.tipoIncentivo === 'eur_por_unidad' ? '€ / ud.' : 'Incentivo'}
                          </Text>
                        </View>
                        {filasPreviewIncentivo.map((fila) => (
                          <View key={fila.productId} style={styles.previewTableRow}>
                            <Text style={[styles.previewTd, styles.previewColProducto]} numberOfLines={2}>
                              {fila.productName}
                            </Text>
                            <Text style={[styles.previewTd, styles.previewColNum]}>
                              {fila.precioCompra != null ? formatEuroUd(fila.precioCompra) : '—'}
                            </Text>
                            {form.tipoIncentivo === 'eur_por_unidad' ? (
                              <View style={styles.previewColInput}>
                                <TextInput
                                  style={styles.previewInput}
                                  value={textoInputPreviewProducto(fila.productId, fila.valorOverride)}
                                  onChangeText={(t) => onChangePreviewValorProducto(fila.productId, t)}
                                  onBlur={() => {
                                    setPreviewDrafts((d) => {
                                      if (d[fila.productId] === undefined) return d;
                                      const { [fila.productId]: _omit, ...rest } = d;
                                      return rest;
                                    });
                                  }}
                                  keyboardType="decimal-pad"
                                  placeholder={
                                    valorGlobalEurUd > 0
                                      ? String(valorGlobalEurUd).replace('.', ',')
                                      : '0,00'
                                  }
                                  editable={!inmutable && puedeGestionar}
                                  selectTextOnFocus
                                />
                              </View>
                            ) : (
                              <Text style={[styles.previewTd, styles.previewColNum, styles.previewIncentivo]}>
                                {fila.incentivo != null ? `${formatEuroUd(fila.incentivo)}/ud` : '—'}
                              </Text>
                            )}
                          </View>
                        ))}
                      </ScrollView>
                    )}
                  </Pressable>
                </Pressable>
              </Modal>
            ) : null}
          </View>
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

      {esEdicion && estadoCampana ? (
        <View style={styles.estadoAutoBox}>
          <View style={[
            styles.estadoAutoBadge,
            { backgroundColor: colorEstadoCampana(estadoCampana) + '18', borderColor: colorEstadoCampana(estadoCampana) },
          ]}>
            <Text style={[styles.estadoAutoBadgeText, { color: colorEstadoCampana(estadoCampana) }]}>
              {estadoCampana}
            </Text>
          </View>
          <Text style={styles.estadoAutoHint}>
            {etiquetaEstadoAutomatico(estadoCampana)}
            {estadoCampana !== 'Archivada'
              ? ` · Archivo automático ${DIAS_AUTO_ARCHIVAR} días tras fin de periodo.`
              : ''}
          </Text>
        </View>
      ) : (
        <Text style={styles.estadoAutoHintNueva}>
          El estado se calcula solo: programada → activa (en fechas) → finalizada → archivada ({DIAS_AUTO_ARCHIVAR} días).
        </Text>
      )}

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
              {esDuplicar
                ? 'Duplicar campaña'
                : esEdicion
                  ? 'Editar campaña'
                  : 'Nueva campaña de incentivo'}
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
            {esDuplicar ? (
              <View style={[styles.avisoBox, styles.avisoBoxInfo]}>
                <MaterialIcons name="content-copy" size={16} color="#0ea5e9" />
                <Text style={[styles.avisoText, styles.avisoTextInfo]}>
                  Copia de «{campana?.nombre}». Revisa las fechas; el resto es editable.
                </Text>
              </View>
            ) : null}
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
                {resumenProductosSel ? (
                  <Text style={styles.resumenProductos}>{resumenProductosSel}</Text>
                ) : null}
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
                  <Text style={styles.btnPriText}>
                    {esEdicion ? 'Guardar' : esDuplicar ? 'Crear copia' : 'Crear'}
                  </Text>
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
  resumenProductos: {
    fontSize: 10,
    color: '#64748b',
    fontStyle: 'italic',
    marginTop: 4,
    lineHeight: 14,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 4,
    marginTop: 6,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
    marginTop: 6,
  },
  labelInline: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748b',
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
  incentivoValorCol: { width: 128, flexShrink: 0 },
  valorConPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  previewEyeBtn: {
    padding: 4,
    borderRadius: 6,
    minWidth: 28,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputValor: { flex: 1, textAlign: 'right' as const, minWidth: 64 },
  previewModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  previewPanel: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    width: '100%',
    maxWidth: 440,
    maxHeight: 360,
    padding: 12,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 12px 32px rgba(0,0,0,0.18)' }
      : {
          elevation: 12,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.16,
          shadowRadius: 12,
        }),
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
  },
  previewTitulo: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    flex: 1,
  },
  previewVacio: { fontSize: 12, color: '#94a3b8', lineHeight: 16 },
  previewTableScroll: { maxHeight: 280 },
  previewTableHead: {
    flexDirection: 'row',
    gap: 6,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    marginBottom: 4,
  },
  previewTableRow: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  previewTh: { fontSize: 10, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  previewTd: { fontSize: 11, color: '#334155' },
  previewColProducto: { flex: 1, minWidth: 0 },
  previewColNum: { width: 78, textAlign: 'right' as const },
  previewColInput: {
    width: 78,
    justifyContent: 'center',
  },
  previewInput: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: '700',
    color: '#166534',
    backgroundColor: '#fff',
    textAlign: 'right' as const,
    minHeight: 28,
  },
  previewIncentivo: { fontWeight: '700', color: '#166534' },
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
  estadoAutoBox: { gap: 6, marginBottom: 8 },
  estadoAutoBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  estadoAutoBadgeText: { fontSize: 11, fontWeight: '700' },
  estadoAutoHint: { fontSize: 10, color: '#64748b', lineHeight: 14 },
  estadoAutoHintNueva: { fontSize: 10, color: '#64748b', lineHeight: 14, marginBottom: 8, fontStyle: 'italic' },
  avisoBox: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#fffbeb',
    padding: 8,
    borderRadius: 6,
    marginBottom: 6,
    alignItems: 'flex-start',
  },
  avisoBoxInfo: {
    backgroundColor: '#f0f9ff',
  },
  avisoText: { flex: 1, fontSize: 11, color: '#92400e' },
  avisoTextInfo: { color: '#0369a1' },
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
