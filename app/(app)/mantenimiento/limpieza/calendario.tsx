import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useMantenimientoLocales, valorEnLocal } from '../LocalesContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { LimpiezaAgenda, type RegistroAgenda } from '../../../components/limpieza/LimpiezaAgenda';
import { apiFetch } from '../../../utils/api';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../../constants/theme';

type Vista = 'agenda' | 'mes' | 'semana' | 'dia';
type Registro = {
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
type Objeto = { id_objeto: string; nombre: string; ubicacion?: string };

const TODOS = '__all__';
const DIAS_SEMANA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const ESTADO_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  pendiente: { bg: statusColors.warning.bg, color: statusColors.warning.text, label: 'Pendiente' },
  hecha: { bg: statusColors.success.bg, color: statusColors.success.text, label: 'Hecha' },
  retrasada: { bg: statusColors.danger.bg, color: statusColors.danger.text, label: 'Retrasada' },
  reprogramada: { bg: '#e0e7ff', color: '#4338ca', label: 'Reprogramada' },
};
const ESTADOS_FILTRO: { id: string; label: string }[] = [
  { id: '', label: 'Todos' },
  { id: 'pendiente', label: 'Pendientes' },
  { id: 'hecha', label: 'Hechas' },
  { id: 'retrasada', label: 'Retrasadas' },
];

function pad2(n: number) { return String(n).padStart(2, '0'); }
function toIso(d: Date) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function hoyIso() { return toIso(new Date()); }
function fromIso(iso: string) { return new Date(`${iso}T00:00:00`); }
function fechaCorta(iso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
/** Lunes de la semana que contiene d. */
function inicioSemanaLunes(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow));
  return x;
}

export default function CalendarioLimpiezaScreen() {
  const router = useRouter();
  const { locales, loading: loadingLocales } = useMantenimientoLocales();
  const { hasPermiso } = useAuth();
  const { isPhone } = useBreakpoint();
  const puedeAgregar = hasPermiso('limpieza.programar');
  const puedeBorrar = hasPermiso('limpieza.borrar');

  const [vista, setVista] = useState<Vista>('agenda');
  const [ancla, setAncla] = useState<Date>(() => new Date());
  const [localId, setLocalId] = useState(TODOS);
  const [estado, setEstado] = useState('');
  const [registros, setRegistros] = useState<Registro[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [diaModal, setDiaModal] = useState<string | null>(null);
  const [objetos, setObjetos] = useState<Objeto[]>([]);
  const [addObjetoId, setAddObjetoId] = useState('');
  const [addFecha, setAddFecha] = useState('');
  const [addModal, setAddModal] = useState(false);
  const [accion, setAccion] = useState(false);
  const [agendaRefresh, setAgendaRefresh] = useState(0);

  const localesOpciones = useMemo(
    () => [
      { id: TODOS, titulo: 'Todos mis locales', icono: 'apps' as const },
      ...locales.map((l) => ({
        id: valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'id_locales') ?? '',
        titulo: valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? '',
        icono: 'store' as const,
      })).filter((o) => o.id),
    ],
    [locales],
  );

  // Rango [desde, hasta] visible según la vista (no aplica a agenda).
  const rango = useMemo(() => {
    if (vista === 'agenda') return { desde: '', hasta: '' };
    if (vista === 'dia') { const iso = toIso(ancla); return { desde: iso, hasta: iso }; }
    if (vista === 'semana') {
      const ini = inicioSemanaLunes(ancla);
      return { desde: toIso(ini), hasta: toIso(addDays(ini, 6)) };
    }
    // mes: rejilla completa (6 semanas desde el lunes anterior al día 1).
    const first = new Date(ancla.getFullYear(), ancla.getMonth(), 1);
    const gridStart = inicioSemanaLunes(first);
    return { desde: toIso(gridStart), hasta: toIso(addDays(gridStart, 41)) };
  }, [vista, ancla]);

  const cargar = useCallback(() => {
    if (vista === 'agenda') return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ fecha_desde: rango.desde, fecha_hasta: rango.hasta });
    if (localId !== TODOS) params.set('local_id', localId);
    if (estado) params.set('estado', estado);
    apiFetch(`/api/limpieza/registros/calendario?${params.toString()}`)
      .then((res) => res.json())
      .then((data: { registros?: Registro[]; error?: string }) => {
        if (data.error) { setError(data.error); setRegistros([]); return; }
        setRegistros(Array.isArray(data.registros) ? data.registros : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [vista, rango.desde, rango.hasta, localId, estado]);

  useFocusEffect(useCallback(() => { cargar(); }, [cargar]));

  // Objetos del local (para "agregar"); solo si hay un local concreto.
  useEffect(() => {
    if (localId === TODOS) { setObjetos([]); return; }
    apiFetch(`/api/limpieza/objetos?local_id=${encodeURIComponent(localId)}&solo_activos=1`)
      .then((res) => res.json())
      .then((data: { objetos?: Objeto[] }) => setObjetos(Array.isArray(data.objetos) ? data.objetos : []))
      .catch(() => setObjetos([]));
  }, [localId]);

  const porFecha = useMemo(() => {
    const m = new Map<string, Registro[]>();
    for (const r of registros) {
      const k = String(r.fecha_programada || '').slice(0, 10);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  }, [registros]);

  const localNombre = useCallback((id: string) => {
    const l = locales.find((x) => (valorEnLocal(x, 'id_Locales') ?? valorEnLocal(x, 'id_locales')) === id);
    return l ? (valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id) : id;
  }, [locales]);

  const navegar = (dir: -1 | 1) => {
    setAncla((prev) => {
      if (vista === 'dia') return addDays(prev, dir);
      if (vista === 'semana') return addDays(prev, dir * 7);
      return new Date(prev.getFullYear(), prev.getMonth() + dir, 1);
    });
  };

  const tituloRango = useMemo(() => {
    if (vista === 'dia') return fechaCorta(toIso(ancla));
    if (vista === 'semana') {
      const ini = inicioSemanaLunes(ancla);
      return `${fechaCorta(toIso(ini))} – ${fechaCorta(toIso(addDays(ini, 6)))}`;
    }
    return `${MESES[ancla.getMonth()]} ${ancla.getFullYear()}`;
  }, [vista, ancla]);

  const abrirDia = (iso: string) => { setDiaModal(iso); };
  const abrirAgregar = (iso: string) => {
    setAddFecha(iso);
    setAddObjetoId(objetos[0]?.id_objeto ?? '');
    setAddModal(true);
  };

  const crearRegistro = async () => {
    if (localId === TODOS || !addObjetoId || !addFecha) return;
    setAccion(true);
    setError(null);
    try {
      const res = await apiFetch('/api/limpieza/registros', {
        method: 'POST',
        body: JSON.stringify({ local_id: localId, objeto_id: addObjetoId, fecha_programada: addFecha }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al crear'); return; }
      setAddModal(false);
      setAgendaRefresh((t) => t + 1);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setAccion(false);
    }
  };

  const borrarRegistro = async (r: Registro | RegistroAgenda) => {
    setAccion(true);
    setError(null);
    try {
      const res = await apiFetch('/api/limpieza/registros', {
        method: 'DELETE',
        body: JSON.stringify({
          items: [{
            local_id: r.local_id,
            fecha_programada: r.fecha_programada,
            objeto_id: r.objeto_id ?? undefined,
            tarea_key: r.tarea_key ?? undefined,
            tipo_objeto_id: r.tipo_objeto_id ?? undefined,
          }],
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al borrar'); return; }
      setAgendaRefresh((t) => t + 1);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setAccion(false);
    }
  };

  // ─── Rejilla del mes ───
  const celdasMes = useMemo(() => {
    if (vista !== 'mes') return [];
    const gridStart = inicioSemanaLunes(new Date(ancla.getFullYear(), ancla.getMonth(), 1));
    const cells: { iso: string; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      cells.push({ iso: toIso(d), inMonth: d.getMonth() === ancla.getMonth() });
    }
    return cells;
  }, [vista, ancla]);

  const semanaDias = useMemo(() => {
    if (vista !== 'semana') return [];
    const ini = inicioSemanaLunes(ancla);
    return Array.from({ length: 7 }, (_, i) => toIso(addDays(ini, i)));
  }, [vista, ancla]);

  const diaRegistros = diaModal ? (porFecha.get(diaModal) ?? []) : [];

  const resumenDia = (iso: string) => {
    const list = porFecha.get(iso) ?? [];
    const pend = list.filter((r) => r.estado === 'pendiente' || r.estado === 'retrasada').length;
    const hechas = list.filter((r) => r.estado === 'hecha').length;
    return { total: list.length, pend, hechas };
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Calendario de limpiezas</Text>
      </View>

      {loadingLocales ? (
        <View style={styles.center}><ActivityIndicator size="small" color={colors.accent} /></View>
      ) : (
        <>
          <View style={[styles.filtros, isPhone && styles.filtrosStacked]}>
            <SelectorDesplegable
              style={isPhone ? undefined : { flex: 1 }}
              placeholder="Local"
              icono="store"
              tituloLista="Local"
              valorId={localId}
              opciones={localesOpciones}
              onSeleccionar={setLocalId}
            />
            <View style={styles.vistaToggle}>
              {([
                { id: 'agenda' as Vista, label: 'Agenda' },
                { id: 'mes' as Vista, label: 'Mes' },
                { id: 'semana' as Vista, label: 'Semana' },
                { id: 'dia' as Vista, label: 'Día' },
              ]).map((v) => (
                <TouchableOpacity key={v.id} style={[styles.vistaBtn, vista === v.id && styles.vistaBtnActive]} onPress={() => setVista(v.id)}>
                  <Text style={[styles.vistaBtnText, vista === v.id && styles.vistaBtnTextActive]}>{v.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {vista === 'agenda' ? (
            <LimpiezaAgenda
              localId={localId === TODOS ? undefined : localId}
              nombreLocal={localNombre}
              onBorrarRegistro={puedeBorrar ? (r) => { if (!accion) borrarRegistro(r); } : undefined}
              onPressRegistro={(r) => abrirDia(r.fecha_programada)}
              refreshToken={agendaRefresh}
            />
          ) : (
          <>
          <View style={styles.estadoChips}>
            {ESTADOS_FILTRO.map((e) => (
              <TouchableOpacity key={e.id || 'all'} style={[styles.chip, estado === e.id && styles.chipActive]} onPress={() => setEstado(e.id)}>
                <Text style={[styles.chipText, estado === e.id && styles.chipTextActive]}>{e.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.navRow}>
            <TouchableOpacity onPress={() => navegar(-1)} style={styles.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialIcons name="chevron-left" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setAncla(new Date())}>
              <Text style={styles.navTitle}>{tituloRango}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => navegar(1)} style={styles.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialIcons name="chevron-right" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /></View>
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
              {vista === 'mes' ? (
                <>
                  <View style={styles.weekHeader}>
                    {DIAS_SEMANA.map((d) => (
                      <Text key={d} style={styles.weekHeaderText}>{d}</Text>
                    ))}
                  </View>
                  <View style={styles.mesGrid}>
                    {celdasMes.map((c) => {
                      const { total, pend, hechas } = resumenDia(c.iso);
                      const esHoy = c.iso === hoyIso();
                      return (
                        <TouchableOpacity
                          key={c.iso}
                          style={[styles.mesCell, !c.inMonth && styles.mesCellOut, esHoy && styles.mesCellHoy]}
                          onPress={() => abrirDia(c.iso)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.mesCellDay, !c.inMonth && styles.mesCellDayOut]}>{Number(c.iso.slice(8, 10))}</Text>
                          {total > 0 ? (
                            <View style={styles.mesCellBadges}>
                              {pend > 0 ? <View style={[styles.dot, { backgroundColor: '#f59e0b' }]} /> : null}
                              {hechas > 0 ? <View style={[styles.dot, { backgroundColor: colors.success }]} /> : null}
                              <Text style={styles.mesCellCount}>{total}</Text>
                            </View>
                          ) : null}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              ) : vista === 'semana' ? (
                <View style={styles.semanaWrap}>
                  {semanaDias.map((iso) => {
                    const list = porFecha.get(iso) ?? [];
                    const esHoy = iso === hoyIso();
                    return (
                      <View key={iso} style={[styles.semanaCol, esHoy && styles.semanaColHoy]}>
                        <TouchableOpacity onPress={() => abrirDia(iso)} style={styles.semanaColHead}>
                          <Text style={styles.semanaColHeadText}>{DIAS_SEMANA[(fromIso(iso).getDay() + 6) % 7]} {Number(iso.slice(8, 10))}</Text>
                          {puedeAgregar && localId !== TODOS ? (
                            <TouchableOpacity onPress={() => abrirAgregar(iso)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                              <MaterialIcons name="add" size={16} color={colors.accent} />
                            </TouchableOpacity>
                          ) : null}
                        </TouchableOpacity>
                        {list.length === 0 ? <Text style={styles.semanaVacio}>—</Text> : list.map((r) => {
                          const est = ESTADO_STYLE[r.estado] ?? ESTADO_STYLE.pendiente;
                          return (
                            <View key={r.id_registro} style={[styles.semanaItem, { borderLeftColor: est.color }]}>
                              <Text style={styles.semanaItemText} numberOfLines={2}>{r.objeto_nombre ?? r.tipo_objeto_id}</Text>
                            </View>
                          );
                        })}
                      </View>
                    );
                  })}
                </View>
              ) : (
                <View style={styles.diaWrap}>
                  {puedeAgregar && localId !== TODOS ? (
                    <TouchableOpacity style={styles.addDiaBtn} onPress={() => abrirAgregar(toIso(ancla))}>
                      <MaterialIcons name="add" size={18} color={colors.surface} />
                      <Text style={styles.addDiaBtnText}>Añadir limpieza este día</Text>
                    </TouchableOpacity>
                  ) : null}
                  {(porFecha.get(toIso(ancla)) ?? []).length === 0 ? (
                    <Text style={styles.vacio}>No hay limpiezas registradas este día.</Text>
                  ) : (porFecha.get(toIso(ancla)) ?? []).map((r) => {
                    const est = ESTADO_STYLE[r.estado] ?? ESTADO_STYLE.pendiente;
                    return (
                      <View key={r.id_registro} style={styles.diaItem}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.diaItemTitle}>{r.objeto_nombre ?? r.tipo_objeto_id}{r.tarea_nombre ? ` — ${r.tarea_nombre}` : ''}</Text>
                          <Text style={styles.diaItemMeta}>
                            {localId === TODOS ? `${localNombre(r.local_id)} · ` : ''}{r.ubicacion ? `${r.ubicacion}` : ''}
                          </Text>
                        </View>
                        <View style={[styles.badge, { backgroundColor: est.bg }]}>
                          <Text style={[styles.badgeText, { color: est.color }]}>{est.label}</Text>
                        </View>
                        {puedeBorrar ? (
                          <TouchableOpacity onPress={() => borrarRegistro(r)} disabled={accion} style={styles.iconBtn}>
                            <MaterialIcons name="delete-outline" size={20} color={colors.danger} />
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              )}
            </ScrollView>
          )}
          </>
          )}
        </>
      )}

      {/* Detalle de un día (desde mes/semana) */}
      <Modal visible={!!diaModal} transparent animationType="slide" onRequestClose={() => setDiaModal(null)}>
        <View style={[styles.overlay, !isPhone && styles.overlayCentered]}>
          <View style={[styles.modalCard, !isPhone && styles.modalCardCentered]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{diaModal ? fechaCorta(diaModal) : ''}</Text>
              <TouchableOpacity onPress={() => setDiaModal(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <MaterialIcons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll}>
              {puedeAgregar && localId !== TODOS && diaModal ? (
                <TouchableOpacity style={styles.addDiaBtn} onPress={() => { const iso = diaModal; setDiaModal(null); abrirAgregar(iso); }}>
                  <MaterialIcons name="add" size={18} color={colors.surface} />
                  <Text style={styles.addDiaBtnText}>Añadir limpieza este día</Text>
                </TouchableOpacity>
              ) : null}
              {diaRegistros.length === 0 ? (
                <Text style={styles.vacio}>No hay limpiezas registradas este día.</Text>
              ) : diaRegistros.map((r) => {
                const est = ESTADO_STYLE[r.estado] ?? ESTADO_STYLE.pendiente;
                return (
                  <View key={r.id_registro} style={styles.diaItem}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.diaItemTitle}>{r.objeto_nombre ?? r.tipo_objeto_id}{r.tarea_nombre ? ` — ${r.tarea_nombre}` : ''}</Text>
                      <Text style={styles.diaItemMeta}>
                        {localId === TODOS ? `${localNombre(r.local_id)} · ` : ''}{r.ubicacion ? `${r.ubicacion}` : ''}
                      </Text>
                    </View>
                    <View style={[styles.badge, { backgroundColor: est.bg }]}>
                      <Text style={[styles.badgeText, { color: est.color }]}>{est.label}</Text>
                    </View>
                    {puedeBorrar ? (
                      <TouchableOpacity onPress={() => borrarRegistro(r)} disabled={accion} style={styles.iconBtn}>
                        <MaterialIcons name="delete-outline" size={20} color={colors.danger} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Añadir registro puntual */}
      <Modal visible={addModal} transparent animationType="fade" onRequestClose={() => setAddModal(false)}>
        <View style={[styles.overlay, styles.overlayCentered]}>
          <View style={[styles.modalCard, styles.modalCardCentered]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Añadir limpieza · {addFecha ? fechaCorta(addFecha) : ''}</Text>
              <TouchableOpacity onPress={() => setAddModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <MaterialIcons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={styles.modalScroll}>
              <Text style={styles.label}>Objeto</Text>
              <SelectorDesplegable
                placeholder="Selecciona objeto"
                icono="kitchen"
                tituloLista="Objeto del local"
                buscador
                buscadorPlaceholder="Buscar objeto…"
                valorId={addObjetoId}
                opciones={objetos.map((o) => ({ id: o.id_objeto, titulo: o.ubicacion ? `${o.nombre} · ${o.ubicacion}` : o.nombre, icono: 'kitchen' as const }))}
                onSeleccionar={setAddObjetoId}
              />
              {objetos.length === 0 ? (
                <Text style={styles.ayuda}>Este local no tiene objetos. Créalos en «Tipos y objetos».</Text>
              ) : null}
              <TouchableOpacity
                style={[styles.saveBtn, (!addObjetoId || accion) && styles.saveBtnDisabled]}
                onPress={crearRegistro}
                disabled={!addObjetoId || accion}
              >
                {accion ? <ActivityIndicator size="small" color={colors.surface} /> : <Text style={styles.saveBtnText}>Crear limpieza</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: SPACING.md },
  backBtn: { padding: SPACING.xs },
  title: { flex: 1, fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  center: { paddingVertical: 40, alignItems: 'center' },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, marginBottom: SPACING.sm },
  filtros: { flexDirection: 'row', gap: SPACING.sm, marginBottom: 10, alignItems: 'center' },
  filtrosStacked: { flexDirection: 'column', alignItems: 'stretch' },
  vistaToggle: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: 'hidden' },
  vistaBtn: { paddingVertical: SPACING.sm, paddingHorizontal: 14, backgroundColor: colors.bg },
  vistaBtnActive: { backgroundColor: colors.accentMuted },
  vistaBtnText: { fontSize: fontSizes[13], color: colors.textMuted, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  vistaBtnTextActive: { color: statusColors.info.text },
  estadoChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  chip: { paddingVertical: 6, paddingHorizontal: SPACING.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipActive: { borderColor: '#7dd3fc', backgroundColor: colors.accentMuted },
  chipText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  chipTextActive: { color: statusColors.info.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  navBtn: { padding: SPACING.xs },
  navTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  weekHeader: { flexDirection: 'row' },
  weekHeaderText: { flex: 1, textAlign: 'center', fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, paddingVertical: SPACING.xs },
  mesGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  mesCell: { width: `${100 / 7}%`, aspectRatio: 1, borderWidth: 0.5, borderColor: colors.border, padding: SPACING.xs, backgroundColor: colors.surface },
  mesCellOut: { backgroundColor: colors.bg },
  mesCellHoy: { backgroundColor: '#eff6ff', borderColor: '#93c5fd' },
  mesCellDay: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  mesCellDayOut: { color: colors.borderStrong },
  mesCellBadges: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: SPACING.xs, flexWrap: 'wrap' },
  // Círculo 7×7; radius.sm es 6.
  dot: { width: 7, height: 7, borderRadius: 4 },
  mesCellCount: { fontSize: fontSizes.badge, color: colors.textMuted, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontVariant: ['tabular-nums'] },
  semanaWrap: { gap: SPACING.sm },
  semanaCol: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: SPACING.sm, backgroundColor: colors.surface },
  semanaColHoy: { borderColor: '#93c5fd', backgroundColor: '#eff6ff' },
  semanaColHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  semanaColHeadText: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  semanaVacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.borderStrong },
  // 4 px; radius.sm es 6.
  semanaItem: { borderLeftWidth: 3, paddingLeft: SPACING.sm, paddingVertical: SPACING.xs, marginBottom: SPACING.xs, backgroundColor: colors.bg, borderRadius: 4 },
  semanaItemText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary },
  diaWrap: { gap: SPACING.sm },
  diaItem: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: SPACING.md },
  diaItemTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  diaItemMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },
  badge: { paddingVertical: SPACING.xs, paddingHorizontal: 10, borderRadius: radius.pill },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  iconBtn: { padding: SPACING.xs },
  vacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, paddingVertical: SPACING.md, textAlign: 'center' },
  addDiaBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 10, marginBottom: 10 },
  addDiaBtnText: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[13] },
  // Más oscuro que colors.overlay.
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  overlayCentered: { justifyContent: 'center', alignItems: 'center', padding: 20 },
  // 18 px: entre radius.xl (16) y el siguiente salto.
  modalCard: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '85%', overflow: 'hidden' },
  modalCardCentered: { width: '100%', maxWidth: 520, borderRadius: radius.xl },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: SPACING.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, flex: 1 },
  modalScroll: { padding: SPACING.lg },
  label: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: 6, marginTop: SPACING.xs },
  ayuda: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: SPACING.sm },
  saveBtn: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: SPACING.md, alignItems: 'center', marginTop: 20 },
  saveBtnDisabled: { backgroundColor: colors.textMuted },
  saveBtnText: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[14] },
});
