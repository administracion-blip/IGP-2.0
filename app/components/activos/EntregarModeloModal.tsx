import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  Image,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { type OpcionDesplegable } from '../SelectorDesplegable';
import { StepperUnidades } from './StepperUnidades';
import { useMantenimientoLocales, valorEnLocal } from '../../(app)/mantenimiento/LocalesContext';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, radius, statusColors, typography } from '../../constants/theme';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatId6 } from '../../utils/idFormat';
import { useCestaActivos } from '../../lib/activosCesta';
import type { LineaStockModelo, ModeloActivo, StockModelo } from '../../types/activos';

type Props = {
  visible: boolean;
  modelo: ModeloActivo | null;
  onClose: () => void;
  /** Se llama tras añadir líneas a la cesta (p. ej. para abrir el carrito). */
  onAnadido?: (unidades: number) => void;
};

type Seleccion = { cantidad: number };

function descripcionLinea(l: LineaStockModelo): string {
  const partes: string[] = [];
  if (l.talla) partes.push(String(l.talla));
  if (l.numero_serie) partes.push(`Nº ${l.numero_serie}`);
  if (!partes.length) partes.push(l.etiqueta_legible);
  partes.push(l.disponibles === 1 ? '1 disponible' : `${l.disponibles} disponibles`);
  return partes.join(' · ');
}

export function EntregarModeloModal({ visible, modelo, onClose, onAnadido }: Props) {
  const { shouldStackPanels } = useBreakpoint();
  const { locales } = useMantenimientoLocales();
  const { anadir } = useCestaActivos();

  const [lineas, setLineas] = useState<LineaStockModelo[]>([]);
  const [seleccion, setSeleccion] = useState<Record<string, Seleccion>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const opcionesLocal: OpcionDesplegable[] = useMemo(
    () =>
      locales
        .map((l) => {
          const id = formatId6(valorEnLocal(l, 'id_Locales'));
          const nombre = String(valorEnLocal(l, 'nombre') || valorEnLocal(l, 'Nombre') || '').trim();
          return { id, titulo: nombre || id };
        })
        .filter((o) => o.id && o.id !== '000000'),
    [locales],
  );

  const nombreLocal = useCallback(
    (id: string) => opcionesLocal.find((o) => o.id === formatId6(id))?.titulo || id,
    [opcionesLocal],
  );

  const cargar = useCallback(async () => {
    if (!modelo) return;
    setLoading(true);
    setError(null);
    setAviso(null);
    try {
      const res = await apiFetch(`/api/activos/modelos/${encodeURIComponent(modelo.modelo_id)}/stock`);
      const data = (await res.json().catch(() => ({}))) as StockModelo & { error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar el stock del modelo');
      const disponibles = (data.lineas || []).filter((l) => (l.disponibles || 0) > 0);
      setLineas(disponibles);
      setSeleccion(
        Object.fromEntries(
          disponibles.map((l) => [
            l.asset_id,
            { cantidad: 0 } as Seleccion,
          ]),
        ),
      );
    } catch (e) {
      setLineas([]);
      setSeleccion({});
      setError(errorMessage(e, 'No se pudo cargar el stock del modelo'));
    } finally {
      setLoading(false);
    }
  }, [modelo]);

  useEffect(() => {
    if (!visible) return;
    void cargar();
  }, [visible, cargar]);

  const grupos = useMemo(() => {
    const mapa = new Map<string, { id_local: string; local_nombre: string; lineas: LineaStockModelo[] }>();
    for (const l of lineas) {
      const id = formatId6(l.id_local);
      const nombre = (l.local_nombre || nombreLocal(id) || id).trim() || id;
      if (!mapa.has(id)) mapa.set(id, { id_local: id, local_nombre: nombre, lineas: [] });
      mapa.get(id)!.lineas.push(l);
    }
    return [...mapa.values()].sort((a, b) => a.local_nombre.localeCompare(b.local_nombre, 'es'));
  }, [lineas, nombreLocal]);

  const totalSeleccionado = useMemo(
    () => Object.values(seleccion).reduce((s, v) => s + (v.cantidad || 0), 0),
    [seleccion],
  );

  const cambiarCantidad = (assetId: string, n: number, max: number) => {
    setAviso(null);
    setSeleccion((prev) => ({
      ...prev,
      [assetId]: {
        cantidad: Math.max(0, Math.min(n, max)),
      },
    }));
  };

  const anadirACesta = () => {
    const elegidas = lineas.filter((l) => (seleccion[l.asset_id]?.cantidad || 0) > 0);
    if (!elegidas.length) {
      setAviso('Elige al menos una unidad antes de añadir a la cesta.');
      return;
    }
    let unidades = 0;
    for (const l of elegidas) {
      const sel = seleccion[l.asset_id];
      anadir({
        asset_id: l.asset_id,
        etiqueta_legible: l.etiqueta_legible,
        marca: modelo?.marca,
        nombre_modelo: modelo?.nombre,
        id_local: formatId6(l.id_local),
        local_nombre: l.local_nombre || nombreLocal(l.id_local),
        local_imputado_id: '',
        granularidad: l.granularidad,
        cantidad: sel.cantidad,
        max: l.disponibles,
        talla: l.talla || undefined,
        numero_serie: l.numero_serie ?? null,
        foto_url: modelo?.foto_url ?? null,
      });
      unidades += sel.cantidad;
    }
    onAnadido?.(unidades);
    onClose();
  };

  const titulo = [modelo?.marca, modelo?.nombre].filter(Boolean).join(' ') || 'Modelo';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.fondo} onPress={onClose}>
        <Pressable style={[styles.caja, shouldStackPanels && styles.cajaFull]} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            {modelo?.foto_url ? (
              <Image source={{ uri: modelo.foto_url }} style={styles.foto} />
            ) : (
              <View style={[styles.foto, styles.fotoVacia]}>
                <MaterialIcons name="image" size={20} color={colors.textMuted} />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.titulo} numberOfLines={2}>
                Entregar {titulo}
              </Text>
              <Text style={styles.sub}>
                Elige cuántas unidades salen de cada almacén. El local a facturar se indica en la cesta.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.close} accessibilityLabel="Cerrar">
              <MaterialIcons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.centro}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : error ? (
            <View style={styles.centro}>
              <Text style={styles.error}>{error}</Text>
              <TouchableOpacity style={styles.retry} onPress={() => void cargar()}>
                <Text style={styles.retryTxt}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : lineas.length === 0 ? (
            <View style={styles.centro}>
              <MaterialIcons name="inventory-2" size={32} color={colors.textMuted} />
              <Text style={styles.vacio}>No hay unidades en almacén de este modelo</Text>
            </View>
          ) : (
            <ScrollView style={styles.lista} contentContainerStyle={styles.listaContent} keyboardShouldPersistTaps="handled">
              {grupos.map((g) => (
                <View key={g.id_local} style={styles.grupo}>
                  <Text style={styles.grupoTitulo}>{g.local_nombre}</Text>
                  {g.lineas.map((l) => {
                    const sel = seleccion[l.asset_id] || { cantidad: 0 };
                    const esUnidad = l.granularidad === 'unidad';
                    const max = esUnidad ? 1 : l.disponibles;
                    return (
                      <View key={l.asset_id} style={styles.fila}>
                        <View style={styles.filaTop}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.filaTitulo} numberOfLines={2}>
                              {descripcionLinea(l)}
                            </Text>
                            <Text style={styles.filaMeta} numberOfLines={1}>
                              {l.etiqueta_legible}
                            </Text>
                          </View>
                          {esUnidad ? (
                            <TouchableOpacity
                              style={styles.check}
                              onPress={() => cambiarCantidad(l.asset_id, sel.cantidad > 0 ? 0 : 1, max)}
                              accessibilityLabel={sel.cantidad > 0 ? 'Quitar de la selección' : 'Añadir a la selección'}
                            >
                              <MaterialIcons
                                name={sel.cantidad > 0 ? 'check-box' : 'check-box-outline-blank'}
                                size={24}
                                color={sel.cantidad > 0 ? colors.accent : colors.textMuted}
                              />
                            </TouchableOpacity>
                          ) : (
                            <StepperUnidades
                              valor={sel.cantidad}
                              max={max}
                              onChange={(n) => cambiarCantidad(l.asset_id, n, max)}
                            />
                          )}
                        </View>
                      </View>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          )}

          {aviso ? <Text style={styles.error}>{aviso}</Text> : null}

          <View style={styles.acciones}>
            <TouchableOpacity style={styles.cancel} onPress={onClose}>
              <Text style={styles.cancelTxt}>Cerrar</Text>
            </TouchableOpacity>
            {lineas.length > 0 ? (
              <TouchableOpacity style={styles.cta} onPress={anadirACesta}>
                <MaterialIcons name="add-shopping-cart" size={18} color="#fff" />
                <Text style={styles.ctaTxt}>
                  {totalSeleccionado > 0 ? `Añadir a la cesta (${totalSeleccionado})` : 'Añadir a la cesta'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fondo: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)', justifyContent: 'center', padding: 16 },
  caja: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 16,
    maxHeight: '88%',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
    flexShrink: 1,
  },
  cajaFull: { maxWidth: '100%', maxHeight: '100%', height: '100%', borderRadius: 0, flex: 1 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  foto: { width: 48, height: 48, borderRadius: 8, backgroundColor: colors.bgSubtle },
  fotoVacia: { alignItems: 'center', justifyContent: 'center' },
  titulo: { ...typography.subtitulo, color: '#0f172a' },
  sub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  close: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  centro: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 32 },
  vacio: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  lista: { flexGrow: 1, flexShrink: 1, minHeight: 80, marginBottom: 8 },
  listaContent: { flexGrow: 0, paddingBottom: 8 },
  grupo: { marginBottom: 14 },
  grupoTitulo: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 6 },
  fila: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
    padding: 10,
    gap: 8,
    marginBottom: 8,
  },
  filaTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filaTitulo: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  filaMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  check: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  error: { color: statusColors.danger.text, fontSize: 13, marginBottom: 8 },
  retry: { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: colors.accentMuted, borderRadius: radius.md },
  retryTxt: { color: colors.accentPressed, fontWeight: '600' },
  acciones: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  cancel: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelTxt: { fontWeight: '700', color: colors.textSecondary },
  cta: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  ctaTxt: { color: '#fff', fontWeight: '700' },
});
