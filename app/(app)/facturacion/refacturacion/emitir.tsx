import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { InputFecha } from '../../../components/InputFecha';
import { estiloCampoFechaCompacto } from '../../../components/RangoFechas';
import { useLocalToast, detectToastType } from '../../../components/Toast';
import { apiFetch, errorMessage } from '../../../utils/api';
import { formatMoneda, esEmpresaSedeGrupoParipe } from '../../../utils/facturacion';
import { INCREMENTO_REFACTURACION_PCT } from '../../../lib/refacturacion';

type EmpresaOpt = { id: string; nombre: string; cif: string };
type SerieOpt = {
  serie?: string;
  codigo?: string;
  id?: string;
  nombre?: string;
  descripcion?: string;
  tipo?: string;
};

type LineaRefact = {
  id_linea: string;
  descripcion: string;
  cantidad: number;
  precio_refacturado_unitario?: number;
  total_linea?: number;
  tipo_iva?: number;
  empresa_destino_id: string;
};

function hoyIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function RefacturacionEmitirScreen() {
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const { isPhone } = useBreakpoint();
  const { show: showToast, ToastView } = useLocalToast();
  const alertMsg = useCallback(
    (t: string, m: string) => showToast(t, m, detectToastType(t, m)),
    [showToast],
  );

  const puedeVer = hasPermiso('refacturacion.ver');
  const puedeGestionar = hasPermiso('refacturacion.gestionar');

  const [empresas, setEmpresas] = useState<EmpresaOpt[]>([]);
  const [series, setSeries] = useState<SerieOpt[]>([]);
  const [destinoId, setDestinoId] = useState('');
  const [emisorId, setEmisorId] = useState('');
  const [serie, setSerie] = useState('');
  const [fecha, setFecha] = useState(hoyIso);
  const [lineas, setLineas] = useState<LineaRefact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingLineas, setLoadingLineas] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [facturaCreadaId, setFacturaCreadaId] = useState<string | null>(null);

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

    apiFetch('/api/facturacion/series')
      .then((r) => r.json())
      .then((d) => {
        const all: SerieOpt[] = d.series ?? d ?? [];
        setSeries(all.filter((s) => String(s.tipo || '').toUpperCase() === 'OUT'));
      })
      .catch(() => setSeries([]));
  }, []);

  const opcionesEmpresa = useMemo(
    () => [
      { id: '', titulo: 'Seleccionar…', icono: 'business' as const },
      ...empresas.map((e) => ({ id: e.id, titulo: e.nombre, icono: 'domain' as const })),
    ],
    [empresas],
  );

  const opcionesSerie = useMemo(
    () => [
      { id: '', titulo: 'Seleccionar serie…', icono: 'format-list-numbered' as const },
      ...series.map((s) => {
        const codigo = String(s.serie || s.codigo || s.id || '');
        const nombre = String(s.descripcion || s.nombre || codigo);
        return {
          id: codigo,
          titulo: nombre === codigo ? codigo : `${codigo} · ${nombre}`,
          icono: 'receipt' as const,
        };
      }),
    ],
    [series],
  );

  const cargarLineas = useCallback((empresaId: string) => {
    if (!empresaId) {
      setLineas([]);
      setSelected(new Set());
      return;
    }
    setLoadingLineas(true);
    const qs = new URLSearchParams({
      estado: 'pendiente',
      empresa_destino_id: empresaId,
    });
    apiFetch(`/api/refacturacion/lineas?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        const list: LineaRefact[] = Array.isArray(d.lineas) ? d.lineas : [];
        setLineas(list);
        setSelected(new Set(list.map((l) => l.id_linea)));
      })
      .catch(() => {
        setLineas([]);
        setSelected(new Set());
      })
      .finally(() => setLoadingLineas(false));
  }, []);

  useEffect(() => {
    cargarLineas(destinoId);
  }, [destinoId, cargarLineas]);

  const emisorIgualDestino = Boolean(emisorId && destinoId && emisorId === destinoId);

  const totalSeleccionado = useMemo(() => {
    let t = 0;
    for (const l of lineas) {
      if (selected.has(l.id_linea)) t += Number(l.total_linea) || 0;
    }
    return t;
  }, [lineas, selected]);

  const toggleLinea = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTodas = () => {
    if (selected.size === lineas.length) setSelected(new Set());
    else setSelected(new Set(lineas.map((l) => l.id_linea)));
  };

  const emitir = async () => {
    if (!puedeGestionar) return;
    if (!destinoId) {
      alertMsg('Validación', 'Selecciona la sociedad destino');
      return;
    }
    if (!emisorId) {
      alertMsg('Validación', 'Selecciona el emisor');
      return;
    }
    if (emisorIgualDestino) {
      alertMsg('Validación', 'El emisor y la sociedad destino no pueden ser la misma empresa');
      return;
    }
    if (!serie) {
      alertMsg('Validación', 'Selecciona una serie OUT');
      return;
    }
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      alertMsg('Validación', 'Indica una fecha válida (dd/mm/aaaa)');
      return;
    }
    const ids = [...selected];
    if (ids.length === 0) {
      alertMsg('Validación', 'Selecciona al menos una línea');
      return;
    }

    setEmitiendo(true);
    setFacturaCreadaId(null);
    try {
      const res = await apiFetch('/api/refacturacion/emitir', {
        method: 'POST',
        body: JSON.stringify({
          emisor_id: emisorId,
          empresa_destino_id: destinoId,
          serie,
          fecha_emision: fecha,
          lineas_ids: ids,
          usuario_id: user?.id_usuario ?? '',
          usuario_nombre: user?.Nombre ?? '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al emitir');
      const id = String(data.factura_id || data.factura?.id_factura || '');
      setFacturaCreadaId(id || null);
      showToast(
        'Borrador creado',
        data.aviso || 'Factura OUT en borrador. Completa la emisión desde Facturación.',
        data.aviso ? 'warning' : 'success',
      );
      cargarLineas(destinoId);
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setEmitiendo(false);
    }
  };

  if (!puedeVer) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>No tienes permiso para ver refacturaciones.</Text>
      </View>
    );
  }

  if (!puedeGestionar) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>Necesitas permiso «Refacturación · Gestionar» para emitir.</Text>
        <TouchableOpacity
          style={styles.btnGhost}
          onPress={() => router.push('/facturacion/refacturacion' as never)}
        >
          <Text style={styles.btnGhostText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      {ToastView}
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.push('/facturacion/refacturacion' as never)}
            style={[styles.backBtn, isPhone && { minHeight: MIN_TOUCH }]}
          >
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Emitir refacturación</Text>
            <Text style={styles.subtitle}>
              Crea un borrador OUT (+{INCREMENTO_REFACTURACION_PCT}% ya aplicado en las líneas). Emisor ≠ destino.
            </Text>
          </View>
        </View>

        <View style={[styles.formCard, { zIndex: 40 }]}>
          <Text style={styles.label}>Sociedad destino (cliente)</Text>
          <SelectorDesplegable
            icono="business"
            tituloLista="Sociedad destino"
            iconoLista="business"
            valorId={destinoId}
            opciones={opcionesEmpresa}
            onSeleccionar={setDestinoId}
          />

          <Text style={styles.label}>Emisor</Text>
          <SelectorDesplegable
            icono="store"
            tituloLista="Emisor"
            iconoLista="store"
            valorId={emisorId}
            opciones={opcionesEmpresa}
            onSeleccionar={setEmisorId}
          />
          {emisorIgualDestino ? (
            <View style={styles.warnBox}>
              <MaterialIcons name="warning" size={16} color="#b45309" />
              <Text style={styles.warnText}>
                El emisor y la sociedad destino no pueden ser la misma empresa
              </Text>
            </View>
          ) : null}

          <View style={styles.row2}>
            <View style={[styles.col, { zIndex: 30 }]}>
              <Text style={styles.label}>Serie OUT</Text>
              <SelectorDesplegable
                icono="format-list-numbered"
                tituloLista="Serie"
                iconoLista="receipt"
                valorId={serie}
                opciones={opcionesSerie}
                onSeleccionar={setSerie}
              />
            </View>
            <View style={styles.col}>
              <Text style={styles.label}>Fecha emisión</Text>
              <InputFecha
                compact
                valueIso={fecha}
                onChangeIso={setFecha}
                style={estiloCampoFechaCompacto}
              />
            </View>
          </View>
        </View>

        <View style={styles.listCard}>
          <View style={styles.listHeader}>
            <Text style={styles.listTitle}>
              Líneas pendientes{destinoId ? ` (${lineas.length})` : ''}
            </Text>
            {lineas.length > 0 ? (
              <TouchableOpacity onPress={toggleTodas}>
                <Text style={styles.link}>
                  {selected.size === lineas.length ? 'Desmarcar todas' : 'Seleccionar todas'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {!destinoId ? (
            <Text style={styles.empty}>Selecciona primero la sociedad destino</Text>
          ) : loadingLineas ? (
            <ActivityIndicator color="#6d28d9" style={{ marginVertical: 20 }} />
          ) : lineas.length === 0 ? (
            <Text style={styles.empty}>No hay líneas pendientes para esta sociedad</Text>
          ) : (
            lineas.map((l) => {
              const on = selected.has(l.id_linea);
              return (
                <TouchableOpacity
                  key={l.id_linea}
                  style={[styles.lineaRow, on && styles.lineaRowOn]}
                  onPress={() => toggleLinea(l.id_linea)}
                  activeOpacity={0.7}
                >
                  <MaterialIcons
                    name={on ? 'check-box' : 'check-box-outline-blank'}
                    size={22}
                    color={on ? '#6d28d9' : '#94a3b8'}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.lineaDesc}>{l.descripcion}</Text>
                    <Text style={styles.lineaMeta}>
                      {l.cantidad} ud × {formatMoneda(l.precio_refacturado_unitario || 0)}
                      {l.tipo_iva != null ? ` · IVA ${l.tipo_iva}%` : ''}
                    </Text>
                  </View>
                  <Text style={styles.lineaTotal}>{formatMoneda(l.total_linea || 0)}</Text>
                </TouchableOpacity>
              );
            })
          )}

          {lineas.length > 0 ? (
            <Text style={styles.totalSel}>
              Seleccionadas: {selected.size} · Total {formatMoneda(totalSeleccionado)}
            </Text>
          ) : null}
        </View>

        <TouchableOpacity
          style={[
            styles.btnEmitir,
            (emitiendo || emisorIgualDestino || selected.size === 0) && styles.btnDisabled,
          ]}
          disabled={emitiendo || emisorIgualDestino || selected.size === 0}
          onPress={() => void emitir()}
        >
          {emitiendo ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <MaterialIcons name="receipt-long" size={18} color="#fff" />
              <Text style={styles.btnEmitirText}>Crear borrador OUT</Text>
            </>
          )}
        </TouchableOpacity>

        {facturaCreadaId ? (
          <TouchableOpacity
            style={styles.linkFactura}
            onPress={() =>
              router.push(
                `/facturacion/factura-detalle?id=${facturaCreadaId}&modo=editar&tipo=OUT` as never,
              )
            }
          >
            <MaterialIcons name="open-in-new" size={18} color="#6d28d9" />
            <Text style={styles.linkFacturaText}>Abrir factura borrador</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  denied: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  backBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 12, color: '#64748b', marginTop: 2 },
  formCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#c4b5fd',
    padding: 14,
    gap: 4,
    position: 'relative',
  },
  label: { fontSize: 12, fontWeight: '600', color: '#64748b', marginTop: 8, marginBottom: 4 },
  row2: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  col: { flex: 1, minWidth: 160 },
  warnBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: 8,
    padding: 8,
    marginTop: 8,
  },
  warnText: { flex: 1, fontSize: 12, color: '#b45309', fontWeight: '500' },
  listCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    gap: 6,
  },
  listHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  listTitle: { fontSize: 14, fontWeight: '700', color: '#334155' },
  link: { fontSize: 12, fontWeight: '600', color: '#6d28d9' },
  empty: { fontSize: 13, color: '#94a3b8', paddingVertical: 16, textAlign: 'center' },
  lineaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  lineaRowOn: { backgroundColor: '#f5f3ff' },
  lineaDesc: { fontSize: 13, fontWeight: '600', color: '#334155' },
  lineaMeta: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  lineaTotal: { fontSize: 13, fontWeight: '700', color: '#334155' },
  totalSel: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '600',
    color: '#5b21b6',
    textAlign: 'right',
  },
  btnEmitir: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#7c3aed',
    paddingVertical: 14,
    borderRadius: 10,
  },
  btnEmitirText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  btnDisabled: { opacity: 0.45 },
  btnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  btnGhostText: { fontWeight: '600', color: '#475569' },
  linkFactura: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#ede9fe',
    borderWidth: 1,
    borderColor: '#c4b5fd',
  },
  linkFacturaText: { fontSize: 14, fontWeight: '700', color: '#6d28d9' },
});
