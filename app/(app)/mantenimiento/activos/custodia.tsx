import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';
import { colors, inputCursorProps, radius, shadowCard, statusColors, typography } from '../../../constants/theme';
import { apiFetch, errorMessage } from '../../../utils/api';
import { fotoGeneralUrl, tallaDeActivo } from '../../../lib/activos';
import type { ActivoListado, ArticuloCustodia, CustodiaEmpleado } from '../../../types/activos';

type Vista = 'trabajador' | 'articulo';

export default function ActivosCustodiaScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackPanels, shouldStackToolbar } = useBreakpoint();

  const puedeVer = hasPermiso('activos.ver');

  const [vista, setVista] = useState<Vista>('trabajador');
  const [q, setQ] = useState('');

  const [trabajadores, setTrabajadores] = useState<CustodiaEmpleado[]>([]);
  const [articulos, setArticulos] = useState<ArticuloCustodia[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selTrabajador, setSelTrabajador] = useState<string | null>(null);
  const [selArticulo, setSelArticulo] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!puedeVer) return;
    setLoading(true);
    setError(null);
    try {
      const path = vista === 'articulo' ? '/api/activos/custodia?agrupar=articulo' : '/api/activos/custodia';
      const res = await apiFetch(path);
      const data = (await res.json().catch(() => ({}))) as {
        custodias?: CustodiaEmpleado[];
        articulos?: ArticuloCustodia[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'No se pudo cargar la custodia');
      if (vista === 'articulo') setArticulos(Array.isArray(data.articulos) ? data.articulos : []);
      else setTrabajadores(Array.isArray(data.custodias) ? data.custodias : []);
    } catch (e) {
      if (vista === 'articulo') setArticulos([]);
      else setTrabajadores([]);
      setError(errorMessage(e, 'No se pudo cargar la custodia'));
    } finally {
      setLoading(false);
    }
  }, [puedeVer, vista]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const trabajadoresFiltrados = useMemo(() => {
    const texto = q.trim().toLowerCase();
    const lista = [...trabajadores].sort((a, b) =>
      String(a.employee_nombre || '').localeCompare(String(b.employee_nombre || ''), 'es'),
    );
    if (!texto) return lista;
    return lista.filter((t) => String(t.employee_nombre || '').toLowerCase().includes(texto));
  }, [trabajadores, q]);

  const articulosFiltrados = useMemo(() => {
    const texto = q.trim().toLowerCase();
    const lista = [...articulos].sort((a, b) =>
      `${a.marca || ''} ${a.nombre_modelo || ''}`.localeCompare(`${b.marca || ''} ${b.nombre_modelo || ''}`, 'es'),
    );
    if (!texto) return lista;
    return lista.filter((a) => `${a.marca || ''} ${a.nombre_modelo || ''}`.toLowerCase().includes(texto));
  }, [articulos, q]);

  const trabajadorSel = useMemo(
    () => trabajadores.find((t) => String(t.employee_id) === selTrabajador) || null,
    [trabajadores, selTrabajador],
  );
  const articuloSel = useMemo(
    () => articulos.find((a) => a.modelo_id === selArticulo) || null,
    [articulos, selArticulo],
  );

  const cambiarVista = (siguiente: Vista) => {
    if (siguiente === vista) return;
    setVista(siguiente);
    setQ('');
    setSelTrabajador(null);
    setSelArticulo(null);
  };

  const haySeleccion = vista === 'trabajador' ? trabajadorSel != null : articuloSel != null;
  const mostrarLista = !shouldStackPanels || !haySeleccion;
  const mostrarDetalle = !shouldStackPanels || haySeleccion;

  const limpiarSeleccion = () => {
    setSelTrabajador(null);
    setSelArticulo(null);
  };

  if (!puedeVer) {
    return (
      <View style={styles.container}>
        <Text style={styles.vacio}>No tienes permiso para ver la custodia de activos.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => router.push('/mantenimiento/activos' as never)}
          style={styles.iconBtn}
          accessibilityLabel="Volver"
        >
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>Custodia</Text>
          <Text style={styles.subtitle}>Qué tiene cada trabajador y quién tiene cada prenda.</Text>
        </View>
      </View>

      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStack]}>
        <View style={styles.chips}>
          <Chip label="Por trabajador" activo={vista === 'trabajador'} onPress={() => cambiarVista('trabajador')} />
          <Chip label="Por artículo" activo={vista === 'articulo'} onPress={() => cambiarVista('articulo')} />
        </View>
        <TextInput
          style={styles.busqueda}
          value={q}
          onChangeText={setQ}
          placeholder={vista === 'trabajador' ? 'Buscar trabajador…' : 'Buscar marca o modelo…'}
          placeholderTextColor={colors.textMuted}
          {...inputCursorProps}
        />
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
      ) : (
        <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
          {mostrarLista ? (
            <ScrollView
              style={[styles.lista, shouldStackPanels && styles.listaFull]}
              contentContainerStyle={styles.listaContent}
            >
              {vista === 'trabajador' ? (
                trabajadoresFiltrados.length === 0 ? (
                  <Text style={styles.vacio}>
                    {q.trim() ? 'Ningún trabajador coincide.' : 'Nadie tiene prendas entregadas ahora mismo.'}
                  </Text>
                ) : (
                  trabajadoresFiltrados.map((t) => (
                    <TouchableOpacity
                      key={String(t.employee_id)}
                      style={[styles.fila, selTrabajador === String(t.employee_id) && styles.filaSel]}
                      onPress={() => setSelTrabajador(String(t.employee_id))}
                      accessibilityLabel={`Ver prendas de ${t.employee_nombre}`}
                    >
                      <View style={styles.avatar}>
                        <MaterialIcons name="person" size={22} color={colors.accentPressed} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.filaTitulo} numberOfLines={1}>
                          {t.employee_nombre || String(t.employee_id)}
                        </Text>
                        <Text style={styles.filaMeta}>
                          {t.cantidad === 1 ? '1 prenda' : `${t.cantidad} prendas`}
                        </Text>
                      </View>
                      <MaterialIcons name="chevron-right" size={22} color={colors.textMuted} />
                    </TouchableOpacity>
                  ))
                )
              ) : articulosFiltrados.length === 0 ? (
                <Text style={styles.vacio}>
                  {q.trim() ? 'Ningún artículo coincide.' : 'No hay artículos entregados ahora mismo.'}
                </Text>
              ) : (
                articulosFiltrados.map((a) => (
                  <TouchableOpacity
                    key={a.modelo_id}
                    style={[styles.fila, selArticulo === a.modelo_id && styles.filaSel]}
                    onPress={() => setSelArticulo(a.modelo_id)}
                    accessibilityLabel={`Ver quién tiene ${a.marca} ${a.nombre_modelo}`}
                  >
                    {a.foto_url ? (
                      <Image source={{ uri: a.foto_url }} style={styles.thumb} />
                    ) : (
                      <View style={[styles.thumb, styles.thumbVacio]}>
                        <MaterialIcons name="image" size={20} color={colors.textMuted} />
                      </View>
                    )}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.filaTitulo} numberOfLines={2}>
                        {[a.marca, a.nombre_modelo].filter(Boolean).join(' ') || 'Sin modelo'}
                      </Text>
                      <Text style={styles.filaMeta}>
                        {a.cantidad === 1 ? '1 unidad repartida' : `${a.cantidad} unidades repartidas`}
                      </Text>
                    </View>
                    <MaterialIcons name="chevron-right" size={22} color={colors.textMuted} />
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          ) : null}

          {mostrarDetalle ? (
            <View style={[styles.detalle, !shouldStackPanels && shadowCard(), shouldStackPanels && styles.detalleFull]}>
              {shouldStackPanels ? (
                <TouchableOpacity style={styles.volverLista} onPress={limpiarSeleccion}>
                  <MaterialIcons name="arrow-back" size={18} color={colors.accentPressed} />
                  <Text style={styles.volverListaTxt}>Volver a la lista</Text>
                </TouchableOpacity>
              ) : null}
              {vista === 'trabajador' ? (
                <DetalleTrabajador trabajador={trabajadorSel} />
              ) : (
                <DetalleArticulo articulo={articuloSel} />
              )}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

function DetalleTrabajador({ trabajador }: { trabajador: CustodiaEmpleado | null }) {
  if (!trabajador) {
    return (
      <View style={styles.detalleVacio}>
        <MaterialIcons name="assignment-ind" size={36} color={colors.textMuted} />
        <Text style={styles.detalleVacioTxt}>Elige un trabajador para ver lo que tiene.</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.detalleBody}>
      <Text style={styles.detalleTitulo}>{trabajador.employee_nombre || String(trabajador.employee_id)}</Text>
      <Text style={styles.detalleSub}>
        {trabajador.cantidad === 1 ? '1 prenda en su poder' : `${trabajador.cantidad} prendas en su poder`}
      </Text>
      {(trabajador.activos || []).length === 0 ? (
        <Text style={styles.vacio}>No hay prendas registradas.</Text>
      ) : (
        (trabajador.activos || []).map((a) => <FilaActivoCustodia key={a.asset_id} activo={a} />)
      )}
    </ScrollView>
  );
}

function FilaActivoCustodia({ activo }: { activo: ActivoListado }) {
  const thumb = fotoGeneralUrl(activo);
  const talla = tallaDeActivo(activo);
  const origen = activo.local_nombre || activo.id_local;
  const factura = activo.local_imputado_nombre || activo.local_imputado_id || origen;
  return (
    <View style={styles.tarjeta}>
      {thumb ? (
        <Image source={{ uri: thumb }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbVacio]}>
          <MaterialIcons name="image" size={20} color={colors.textMuted} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.tarjetaTitulo}>{activo.etiqueta_legible}</Text>
        <Text style={styles.tarjetaMeta} numberOfLines={1}>
          {[activo.marca, activo.nombre_modelo].filter(Boolean).join(' ') || 'Sin modelo'}
          {talla ? ` · ${talla}` : ''}
          {activo.granularidad === 'lote' && activo.cantidad != null ? ` · ${activo.cantidad} ud.` : ''}
        </Text>
        <View style={styles.pills}>
          <Pill icono="storefront" texto={`Sale de ${origen}`} />
          <Pill icono="receipt-long" texto={`Se factura a ${factura}`} destacado />
        </View>
      </View>
    </View>
  );
}

function DetalleArticulo({ articulo }: { articulo: ArticuloCustodia | null }) {
  if (!articulo) {
    return (
      <View style={styles.detalleVacio}>
        <MaterialIcons name="inventory-2" size={36} color={colors.textMuted} />
        <Text style={styles.detalleVacioTxt}>Elige un artículo para ver quién lo tiene.</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.detalleBody}>
      <View style={styles.detalleCabecera}>
        {articulo.foto_url ? (
          <Image source={{ uri: articulo.foto_url }} style={styles.fotoGrande} />
        ) : (
          <View style={[styles.fotoGrande, styles.thumbVacio]}>
            <MaterialIcons name="image" size={26} color={colors.textMuted} />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.detalleTitulo}>
            {[articulo.marca, articulo.nombre_modelo].filter(Boolean).join(' ') || 'Sin modelo'}
          </Text>
          <Text style={styles.detalleSub}>
            {articulo.cantidad === 1 ? '1 unidad repartida' : `${articulo.cantidad} unidades repartidas`}
          </Text>
        </View>
      </View>
      {(articulo.custodios || []).length === 0 ? (
        <Text style={styles.vacio}>Nadie tiene unidades de este artículo.</Text>
      ) : (
        (articulo.custodios || []).map((c, i) => (
          <View key={`${c.employee_id}-${c.talla || ''}-${i}`} style={styles.tarjeta}>
            <View style={styles.avatar}>
              <MaterialIcons name="person" size={22} color={colors.accentPressed} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.tarjetaTitulo} numberOfLines={1}>
                {c.employee_nombre || String(c.employee_id)}
              </Text>
              <Text style={styles.tarjetaMeta}>
                {c.cantidad === 1 ? '1 unidad' : `${c.cantidad} unidades`}
                {c.talla ? ` · Talla ${c.talla}` : ''}
              </Text>
              <View style={styles.pills}>
                {c.id_local || c.local_nombre ? (
                  <Pill icono="storefront" texto={`Sale de ${c.local_nombre || c.id_local}`} />
                ) : null}
                {c.local_imputado_id || c.local_imputado_nombre ? (
                  <Pill
                    icono="receipt-long"
                    texto={`Se factura a ${c.local_imputado_nombre || c.local_imputado_id}`}
                    destacado
                  />
                ) : null}
              </View>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function Pill({
  icono,
  texto,
  destacado,
}: {
  icono: React.ComponentProps<typeof MaterialIcons>['name'];
  texto: string;
  destacado?: boolean;
}) {
  return (
    <View style={[styles.pill, destacado && styles.pillDestacado]}>
      <MaterialIcons name={icono} size={13} color={destacado ? colors.accentPressed : colors.textSecondary} />
      <Text style={[styles.pillTxt, destacado && styles.pillTxtDestacado]} numberOfLines={1}>
        {texto}
      </Text>
    </View>
  );
}

function Chip({ label, activo, onPress }: { label: string; activo: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, activo && styles.chipActivo]} onPress={onPress}>
      <Text style={[styles.chipTxt, activo && styles.chipTxtActivo]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  iconBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.titulo, color: '#0f172a' },
  subtitle: { ...typography.cuerpo, color: colors.textSecondary, marginTop: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  toolbarStack: { flexDirection: 'column', alignItems: 'stretch' },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActivo: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  chipTxt: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  chipTxtActivo: { color: colors.accentPressed, fontWeight: '700' },
  busqueda: {
    flex: 1,
    minWidth: 180,
    height: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.bgSubtle,
  },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  error: { color: statusColors.danger.text, textAlign: 'center' },
  retry: { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: colors.accentMuted, borderRadius: radius.md },
  retryTxt: { color: colors.accentPressed, fontWeight: '600' },
  vacio: { padding: 16, color: colors.textMuted, fontSize: 14 },
  split: { flex: 1, flexDirection: 'row', gap: 10, minHeight: 0 },
  splitStack: { flexDirection: 'column' },
  lista: { flex: 0.38, minWidth: 280 },
  listaFull: { flex: 1, minWidth: 0 },
  listaContent: { paddingBottom: 16, gap: 6 },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    minHeight: MIN_TOUCH + 12,
    backgroundColor: colors.bgSubtle,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filaSel: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  filaTitulo: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  filaMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: colors.border },
  thumbVacio: { alignItems: 'center', justifyContent: 'center' },
  detalle: {
    flex: 0.62,
    minWidth: 0,
    backgroundColor: colors.bgSubtle,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  detalleFull: { flex: 1 },
  detalleBody: { padding: 14, gap: 8 },
  detalleCabecera: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 },
  fotoGrande: { width: 64, height: 64, borderRadius: radius.md, backgroundColor: colors.border },
  detalleTitulo: { ...typography.subtitulo, color: '#0f172a' },
  detalleSub: { fontSize: 13, color: colors.textSecondary, marginBottom: 6 },
  detalleVacio: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  detalleVacioTxt: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  volverLista: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
  },
  volverListaTxt: { fontSize: 13, fontWeight: '700', color: colors.accentPressed },
  tarjeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tarjetaTitulo: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  tarjetaMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.bgSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: '100%',
  },
  pillDestacado: { backgroundColor: colors.accentMuted, borderColor: colors.accentMuted },
  pillTxt: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
  pillTxtDestacado: { color: colors.accentPressed },
});
