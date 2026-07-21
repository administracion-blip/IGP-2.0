/**
 * Agenda de limpiezas: chips Próximas / Realizadas, navegación mes/año
 * y listado ordenado (registros reales).
 */
import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../../utils/api';

export type RegistroAgenda = {
  id_registro: string;
  local_id: string;
  objeto_id?: string | null;
  objeto_nombre?: string | null;
  ubicacion?: string | null;
  tarea_key?: string | null;
  tarea_nombre?: string | null;
  tipo_objeto_id?: string | null;
  fecha_programada: string;
  estado: string;
  realizado_por_nombre?: string | null;
  completado_at?: string | null;
};

export type ChipAgenda = 'proximas' | 'realizadas';

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const ESTADO_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  pendiente: { bg: '#fef3c7', color: '#b45309', label: 'Pendiente' },
  hecha: { bg: '#dcfce7', color: '#15803d', label: 'Hecha' },
  retrasada: { bg: '#fee2e2', color: '#b91c1c', label: 'Retrasada' },
  reprogramada: { bg: '#e0e7ff', color: '#4338ca', label: 'Reprogramada' },
};

/** Días de ventana hacia delante desde el día 1 del mes (≈ mes corto). */
const VENTANA_DIAS = 30;
/** Días atrás para incluir atrasadas al cargar Próximas. */
const VENTANA_ATRASADAS = 120;

function pad2(n: number) {
  return String(n).padStart(2, '0');
}
function toIso(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function hoyIsoAgenda() {
  return toIso(new Date());
}
function fechaCorta(iso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function fechaHoraCorta(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type Props = {
  /** Local concreto, o vacío / undefined = todos los locales del usuario. */
  localId?: string;
  /** Nombre de local por id (solo si hay multi-local). */
  nombreLocal?: (localId: string) => string;
  chip?: ChipAgenda;
  onChipChange?: (chip: ChipAgenda) => void;
  onPressRegistro?: (r: RegistroAgenda) => void;
  /** Si se pasa, muestra botón borrar en cada fila (según permiso del padre). */
  onBorrarRegistro?: (r: RegistroAgenda) => void;
  /** Refresco externo (p. ej. tras borrar). */
  refreshToken?: number;
};

export function LimpiezaAgenda({
  localId,
  nombreLocal,
  chip: chipControlado,
  onChipChange,
  onPressRegistro,
  onBorrarRegistro,
  refreshToken = 0,
}: Props) {
  const [chipInterno, setChipInterno] = useState<ChipAgenda>('proximas');
  const chip = chipControlado ?? chipInterno;
  const setChip = (c: ChipAgenda) => {
    if (onChipChange) onChipChange(c);
    else setChipInterno(c);
  };

  const [anio, setAnio] = useState(() => new Date().getFullYear());
  const [mes, setMes] = useState(() => new Date().getMonth()); // 0-11
  const [registros, setRegistros] = useState<RegistroAgenda[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rango = useMemo(() => {
    const inicioMes = new Date(anio, mes, 1);
    const desdeMes = toIso(inicioMes);
    const hastaVentana = new Date(anio, mes, 1);
    hastaVentana.setDate(hastaVentana.getDate() + (VENTANA_DIAS - 1));
    const finMes = new Date(anio, mes + 1, 0);
    // Ventana = min(inicio+29, fin de mes) → ~mes / 30 días
    const hasta = toIso(hastaVentana < finMes ? hastaVentana : finMes);
    const hoy = hoyIsoAgenda();
    // Para Próximas: incluir atrasadas anteriores al mes
    const desdeProximas = (() => {
      const atras = new Date(hoy);
      atras.setDate(atras.getDate() - VENTANA_ATRASADAS);
      const desdeAtras = toIso(atras);
      return desdeAtras < desdeMes ? desdeAtras : desdeMes;
    })();
    return { desdeMes, hasta, desdeProximas, hoy };
  }, [anio, mes]);

  const cargar = useCallback(() => {
    setLoading(true);
    setError(null);
    // Rango amplio: atrasadas + mes (y hechas programadas antes pero realizadas en el periodo).
    const params = new URLSearchParams({
      fecha_desde: rango.desdeProximas,
      fecha_hasta: rango.hasta,
    });
    if (localId) params.set('local_id', localId);
    apiFetch(`/api/limpieza/registros/calendario?${params.toString()}`)
      .then((res) => res.json())
      .then((data: { registros?: RegistroAgenda[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          setRegistros([]);
          return;
        }
        setRegistros(Array.isArray(data.registros) ? data.registros : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [localId, rango.desdeProximas, rango.hasta]);

  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar, refreshToken]),
  );

  const navegarMes = (dir: -1 | 1) => {
    const d = new Date(anio, mes + dir, 1);
    setAnio(d.getFullYear());
    setMes(d.getMonth());
  };

  const irHoy = () => {
    const n = new Date();
    setAnio(n.getFullYear());
    setMes(n.getMonth());
  };

  const listado = useMemo(() => {
    const hoy = rango.hoy;
    if (chip === 'proximas') {
      const pend = registros.filter((r) => r.estado !== 'hecha');
      // Dentro de la ventana del mes + atrasadas (fecha < hoy)
      const enVentana = pend.filter((r) => {
        const f = r.fecha_programada;
        if (f < hoy) return true; // atrasada
        return f >= rango.desdeMes && f <= rango.hasta;
      });
      return [...enVentana].sort((a, b) => {
        // Más próxima arriba: fecha ASC (atrasadas antiguas primero, luego hoy, luego futuro)
        const cmp = a.fecha_programada.localeCompare(b.fecha_programada);
        if (cmp !== 0) return cmp;
        return String(a.objeto_nombre || '').localeCompare(String(b.objeto_nombre || ''), 'es');
      });
    }
    // Realizadas: en el mes/ventana según fecha de realización (más reciente arriba)
    const hechas = registros.filter((r) => {
      if (r.estado !== 'hecha') return false;
      const realizada = (r.completado_at || '').slice(0, 10);
      const f = realizada || r.fecha_programada;
      return f >= rango.desdeMes && f <= rango.hasta;
    });
    return [...hechas].sort((a, b) => {
      const ca = a.completado_at || '';
      const cb = b.completado_at || '';
      if (ca && cb) {
        const cmp = cb.localeCompare(ca); // DESC — más reciente arriba
        if (cmp !== 0) return cmp;
      } else if (ca) return -1;
      else if (cb) return 1;
      return b.fecha_programada.localeCompare(a.fecha_programada);
    });
  }, [chip, registros, rango]);

  const conteoProximas = useMemo(() => {
    const hoy = rango.hoy;
    return registros.filter((r) => {
      if (r.estado === 'hecha') return false;
      const f = r.fecha_programada;
      if (f < hoy) return true;
      return f >= rango.desdeMes && f <= rango.hasta;
    }).length;
  }, [registros, rango]);

  const conteoRealizadas = useMemo(
    () => registros.filter((r) => {
      if (r.estado !== 'hecha') return false;
      const realizada = (r.completado_at || '').slice(0, 10);
      const f = realizada || r.fecha_programada;
      return f >= rango.desdeMes && f <= rango.hasta;
    }).length,
    [registros, rango],
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.chipsRow}>
        <TouchableOpacity
          style={[styles.chip, chip === 'proximas' && styles.chipActive]}
          onPress={() => setChip('proximas')}
          activeOpacity={0.75}
        >
          <MaterialIcons name="upcoming" size={16} color={chip === 'proximas' ? '#0369a1' : '#64748b'} />
          <Text style={[styles.chipText, chip === 'proximas' && styles.chipTextActive]}>Próximas</Text>
          <View style={[styles.chipCount, chip === 'proximas' && styles.chipCountActive]}>
            <Text style={[styles.chipCountText, chip === 'proximas' && styles.chipCountTextActive]}>{conteoProximas}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.chip, chip === 'realizadas' && styles.chipActive]}
          onPress={() => setChip('realizadas')}
          activeOpacity={0.75}
        >
          <MaterialIcons name="task-alt" size={16} color={chip === 'realizadas' ? '#0369a1' : '#64748b'} />
          <Text style={[styles.chipText, chip === 'realizadas' && styles.chipTextActive]}>Realizadas</Text>
          <View style={[styles.chipCount, chip === 'realizadas' && styles.chipCountActive]}>
            <Text style={[styles.chipCountText, chip === 'realizadas' && styles.chipCountTextActive]}>{conteoRealizadas}</Text>
          </View>
        </TouchableOpacity>
      </View>

      <View style={styles.navRow}>
        <TouchableOpacity onPress={() => navegarMes(-1)} style={styles.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="chevron-left" size={26} color="#334155" />
        </TouchableOpacity>
        <TouchableOpacity onPress={irHoy} style={styles.navTitleBtn} activeOpacity={0.7}>
          <Text style={styles.navTitle}>{MESES[mes]} {anio}</Text>
          <Text style={styles.navSub}>Ventana {VENTANA_DIAS} días · toca para ir al mes actual</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navegarMes(1)} style={styles.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="chevron-right" size={26} color="#334155" />
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color="#0ea5e9" /></View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {listado.length === 0 ? (
            <Text style={styles.vacio}>
              {chip === 'proximas'
                ? 'No hay limpiezas próximas ni atrasadas en este periodo.'
                : 'No hay limpiezas realizadas en este periodo.'}
            </Text>
          ) : listado.map((r) => {
            const atrasada = chip === 'proximas' && (r.estado === 'retrasada' || (r.estado !== 'hecha' && r.fecha_programada < rango.hoy));
            const est = atrasada
              ? ESTADO_STYLE.retrasada
              : (ESTADO_STYLE[r.estado] ?? ESTADO_STYLE.pendiente);
            const titulo = r.objeto_nombre ?? r.tipo_objeto_id ?? 'Limpieza';
            return (
              <TouchableOpacity
                key={r.id_registro}
                style={[styles.card, atrasada && styles.cardAtrasada]}
                onPress={() => onPressRegistro?.(r)}
                activeOpacity={onPressRegistro ? 0.8 : 1}
                disabled={!onPressRegistro}
              >
                {atrasada ? (
                  <MaterialIcons name="warning-amber" size={20} color="#b91c1c" style={{ marginRight: 4 }} />
                ) : null}
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>
                    {titulo}{r.tarea_nombre ? ` — ${r.tarea_nombre}` : ''}
                  </Text>
                  <Text style={styles.cardMeta}>
                    {nombreLocal && !localId ? `${nombreLocal(r.local_id)} · ` : ''}
                    {r.ubicacion ? `${r.ubicacion} · ` : ''}
                    {chip === 'proximas'
                      ? (atrasada ? `Debía ${fechaCorta(r.fecha_programada)}` : fechaCorta(r.fecha_programada))
                      : (r.completado_at
                        ? `Realizada ${fechaHoraCorta(r.completado_at)}`
                        : `Programada ${fechaCorta(r.fecha_programada)}`)}
                    {chip === 'realizadas' && r.realizado_por_nombre ? ` · ${r.realizado_por_nombre}` : ''}
                  </Text>
                </View>
                <View style={[styles.badge, { backgroundColor: est.bg }]}>
                  <Text style={[styles.badgeText, { color: est.color }]}>
                    {atrasada ? 'Retrasada' : est.label}
                  </Text>
                </View>
                {onBorrarRegistro ? (
                  <TouchableOpacity
                    onPress={() => onBorrarRegistro(r)}
                    style={styles.iconBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <MaterialIcons name="delete-outline" size={20} color="#dc2626" />
                  </TouchableOpacity>
                ) : onPressRegistro ? (
                  <MaterialIcons name="chevron-right" size={22} color="#94a3b8" />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 0 },
  chipsRow: { flexDirection: 'row', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  chipActive: { borderColor: '#7dd3fc', backgroundColor: '#e0f2fe' },
  chipText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  chipTextActive: { color: '#0369a1' },
  chipCount: {
    minWidth: 20,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(15,23,42,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipCountActive: { backgroundColor: '#0369a1' },
  chipCountText: { fontSize: 10, fontWeight: '700', color: '#475569' },
  chipCountTextActive: { color: '#fff' },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  navBtn: { padding: 4 },
  navTitleBtn: { alignItems: 'center', flex: 1 },
  navTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  navSub: { fontSize: 10, color: '#94a3b8', marginTop: 2 },
  errorText: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  center: { paddingVertical: 40, alignItems: 'center' },
  list: { gap: 8, paddingBottom: 24 },
  vacio: { fontSize: 13, color: '#94a3b8', paddingVertical: 16, textAlign: 'center', lineHeight: 19 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    minHeight: 56,
  },
  cardAtrasada: { borderColor: '#fca5a5', backgroundColor: '#fef2f2' },
  cardTitle: { fontSize: 14, fontWeight: '600', color: '#334155' },
  cardMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  badge: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 999 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  iconBtn: { padding: 4 },
});
