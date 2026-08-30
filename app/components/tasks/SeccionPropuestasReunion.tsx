/**
 * Cola de validación de propuestas IA en la ficha de reunión (Fase 2F).
 * La IA propone; solo se crean tareas/acuerdos al aceptar aquí.
 * Sin cita literal no se muestra el ítem.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { SeccionFicha, type VarianteSeccionFicha } from './SeccionFicha';
import { BadgeTasks } from './BadgesTasks';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { InputFecha } from '../InputFecha';
import { estiloCampoFechaCompacto } from '../RangoFechas';
import { estilosFormTasks as form } from './estilosTasks';
import {
  ETIQUETA_ESTADO_PROPUESTA,
  ETIQUETA_TIPO_PROPUESTA,
  TONO_ESTADO_PROPUESTA,
  TONO_TIPO_PROPUESTA,
} from '../../lib/tasksUi';
import type { NombresUsuarios } from '../../hooks/useNombresUsuarios';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatFecha } from '../../utils/formatFecha';
import type {
  DecisionPropuesta,
  EstadoPropuesta,
  PropuestaReunion,
  TipoPropuesta,
} from '../../types/tasks';

type EdicionLocal = {
  titulo: string;
  descripcion: string;
  responsable_id: string;
  fecha_limite: string;
};

function tieneCita(p: PropuestaReunion): boolean {
  return !!(p.cita ?? '').trim();
}

function edicionDesde(p: PropuestaReunion): EdicionLocal {
  return {
    titulo: (p.titulo ?? '').trim(),
    descripcion: (p.descripcion ?? '').trim(),
    responsable_id: (p.responsable_sugerido_id ?? '').trim(),
    fecha_limite: (p.fecha_limite_sugerida ?? '').trim(),
  };
}

function decisionAceptar(p: PropuestaReunion, ed?: EdicionLocal | null): DecisionPropuesta {
  if (!ed) {
    return { id_propuesta: p.id_propuesta, accion: 'aceptar' };
  }
  return {
    id_propuesta: p.id_propuesta,
    accion: 'aceptar',
    titulo: ed.titulo.trim(),
    descripcion: ed.descripcion.trim() || undefined,
    responsable_id: ed.responsable_id.trim() || null,
    fecha_limite: ed.fecha_limite.trim() || null,
  };
}

export function SeccionPropuestasReunion({
  idReunion,
  puedeEditar,
  usuarios,
  onResuelto,
  variante = 'normal',
}: {
  idReunion: string;
  variante?: VarianteSeccionFicha;
  puedeEditar: boolean;
  usuarios: NombresUsuarios;
  /** Tras aceptar/rechazar: refrescar acuerdos, tareas y ficha. */
  onResuelto: () => void;
}) {
  const { isCompact } = useBreakpoint();
  const [propuestas, setPropuestas] = useState<PropuestaReunion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolviendoId, setResolviendoId] = useState<string | null>(null);
  const [msgLocal, setMsgLocal] = useState<string | null>(null);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [edicion, setEdicion] = useState<EdicionLocal | null>(null);
  const [errorEdicion, setErrorEdicion] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!idReunion) return;
    setCargando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/reuniones/${encodeURIComponent(idReunion)}/propuestas`);
      const data = (await res.json().catch(() => ({}))) as {
        propuestas?: PropuestaReunion[];
        items?: PropuestaReunion[];
        error?: string;
      };
      if (!res.ok) {
        setError(data.error || 'No se pudieron cargar las propuestas');
        return;
      }
      const lista = Array.isArray(data.propuestas)
        ? data.propuestas
        : Array.isArray(data.items)
          ? data.items
          : [];
      setPropuestas(lista.filter(tieneCita));
    } catch (e) {
      console.error('[reuniones] fallo al listar propuestas', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setCargando(false);
    }
  }, [idReunion]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const pendientes = useMemo(
    () => propuestas.filter((p) => p.propuesta_estado === 'pendiente'),
    [propuestas],
  );
  const resueltas = useMemo(
    () => propuestas.filter((p) => p.propuesta_estado !== 'pendiente'),
    [propuestas],
  );

  const opcionesResponsable = useMemo<OpcionDesplegable[]>(() => {
    const lista: OpcionDesplegable[] = [{ id: '', titulo: '(sin responsable)' }, ...usuarios.opciones];
    const actual = edicion?.responsable_id;
    if (actual && !lista.some((o) => o.id === actual)) {
      lista.push({
        id: actual,
        titulo: usuarios.nombrePorId(actual),
        icono: 'person',
      });
    }
    return lista;
  }, [usuarios, edicion?.responsable_id]);

  function abrirEdicion(p: PropuestaReunion) {
    setEditandoId(p.id_propuesta);
    setEdicion(edicionDesde(p));
    setErrorEdicion(null);
    setErrorId(null);
  }

  function cerrarEdicion() {
    setEditandoId(null);
    setEdicion(null);
    setErrorEdicion(null);
    setErrorId(null);
  }

  async function resolver(decisiones: DecisionPropuesta[]) {
    if (!puedeEditar || decisiones.length === 0) return;
    const id = decisiones[0].id_propuesta;
    setResolviendoId(id);
    setMsgLocal(null);
    setErrorEdicion(null);
    setErrorId(null);
    try {
      const res = await apiFetch(
        `/api/reuniones/${encodeURIComponent(idReunion)}/propuestas/resolver`,
        { method: 'POST', body: JSON.stringify({ decisiones }) },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        resueltas?: Array<{ accion?: string; propuesta_estado?: string; omitida?: boolean }>;
        error?: string;
        mensaje?: string;
      };
      if (!res.ok) {
        setErrorId(id);
        setErrorEdicion(data.error || data.mensaje || 'No se pudo resolver la propuesta');
        return;
      }
      const n = data.resueltas?.length ?? 0;
      const accion = decisiones[0].accion;
      setMsgLocal(
        accion === 'rechazar'
          ? n > 0
            ? 'Propuesta rechazada.'
            : 'No se aplicó ningún cambio.'
          : n > 0
            ? 'Propuesta aceptada.'
            : 'No se aplicó ningún cambio.',
      );
      cerrarEdicion();
      await cargar();
      onResuelto();
    } catch (e) {
      console.error('[reuniones] fallo al resolver propuestas', e);
      setErrorId(id);
      setErrorEdicion(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setResolviendoId(null);
    }
  }

  async function aceptar(p: PropuestaReunion, conEdicion: boolean) {
    if (conEdicion && edicion) {
      const titulo = edicion.titulo.trim();
      if (!titulo) {
        setErrorId(p.id_propuesta);
        setErrorEdicion('El título es obligatorio');
        return;
      }
      if (p.tipo === 'tarea' && !edicion.responsable_id.trim()) {
        setErrorId(p.id_propuesta);
        setErrorEdicion('Las tareas necesitan un responsable');
        return;
      }
      if (edicion.fecha_limite && !/^\d{4}-\d{2}-\d{2}$/.test(edicion.fecha_limite)) {
        setErrorId(p.id_propuesta);
        setErrorEdicion('Indica una fecha válida (dd/mm/aaaa)');
        return;
      }
      await resolver([decisionAceptar(p, edicion)]);
      return;
    }
    if (p.tipo === 'tarea' && !(p.responsable_sugerido_id ?? '').trim()) {
      abrirEdicion(p);
      setErrorId(p.id_propuesta);
      setErrorEdicion('Indica un responsable antes de aceptar la tarea');
      return;
    }
    await resolver([decisionAceptar(p)]);
  }

  function nombreResponsable(p: PropuestaReunion): string {
    if ((p.responsable_sugerido_nombre ?? '').trim()) {
      return (p.responsable_sugerido_nombre as string).trim();
    }
    return usuarios.nombrePorId(p.responsable_sugerido_id);
  }

  const vacioTotal = !cargando && !error && pendientes.length === 0 && resueltas.length === 0;

  return (
    <SeccionFicha
      titulo="Propuestas de la IA"
      icono="auto-awesome"
      variante={variante}
      contador={pendientes.length > 0 ? pendientes.length : undefined}
      cargando={cargando}
      error={error}
      onReintentar={() => void cargar()}
      vacio={
        vacioTotal
          ? 'No hay propuestas de la IA. Aparecerán cuando se genere el acta a partir del audio.'
          : undefined
      }
    >
      {vacioTotal ? null : (
        <>
          {msgLocal ? (
            <View style={styles.bannerOk}>
              <MaterialIcons name="check-circle-outline" size={16} color="#15803d" />
              <Text style={styles.bannerOkTexto}>{msgLocal}</Text>
              <TouchableOpacity onPress={() => setMsgLocal(null)}>
                <MaterialIcons name="close" size={16} color="#15803d" />
              </TouchableOpacity>
            </View>
          ) : null}

          {pendientes.length > 0 ? (
            <View style={styles.lista}>
              {pendientes.map((p) => {
                const enEdicion = editandoId === p.id_propuesta;
                const ocupado = resolviendoId === p.id_propuesta;
                return (
                  <View key={p.id_propuesta} style={styles.tarjeta}>
                    <View style={styles.cabecera}>
                      <BadgeTipo tipo={p.tipo} />
                      <BadgeEstado estado={p.propuesta_estado} />
                    </View>
                    <Text style={styles.titulo}>{p.titulo || 'Sin título'}</Text>
                    {(p.descripcion ?? '').trim() ? (
                      <Text style={styles.descripcion}>{p.descripcion}</Text>
                    ) : null}
                    <View style={styles.citaBox}>
                      <MaterialIcons name="format-quote" size={14} color="#b45309" />
                      <Text style={styles.citaTexto}>{p.cita}</Text>
                    </View>
                    <Text style={styles.meta}>
                      {nombreResponsable(p)}
                      {p.fecha_limite_sugerida ? ` · ${formatFecha(p.fecha_limite_sugerida)}` : ''}
                    </Text>

                    {enEdicion && edicion ? (
                      <View style={styles.editor}>
                        <View style={form.group}>
                          <Text style={form.label}>Título</Text>
                          <TextInput
                            style={form.input}
                            value={edicion.titulo}
                            onChangeText={(t) =>
                              setEdicion((prev) => (prev ? { ...prev, titulo: t } : prev))
                            }
                            placeholder="Título de la propuesta"
                            placeholderTextColor="#94a3b8"
                          />
                        </View>
                        <View style={form.group}>
                          <Text style={form.label}>Descripción</Text>
                          <TextInput
                            style={[form.input, form.inputMultilinea]}
                            value={edicion.descripcion}
                            onChangeText={(t) =>
                              setEdicion((prev) => (prev ? { ...prev, descripcion: t } : prev))
                            }
                            placeholder="Opcional"
                            placeholderTextColor="#94a3b8"
                            multiline
                          />
                        </View>
                        <View style={form.group}>
                          <Text style={form.label}>Responsable</Text>
                          <SelectorDesplegable
                            sinIconoTrigger
                            tituloLista="Responsable"
                            valorId={edicion.responsable_id}
                            opciones={opcionesResponsable}
                            loading={usuarios.cargando}
                            onSeleccionar={(id) =>
                              setEdicion((prev) => (prev ? { ...prev, responsable_id: id } : prev))
                            }
                          />
                        </View>
                        <View style={form.group}>
                          <Text style={form.label}>Fecha límite</Text>
                          <InputFecha
                            compact
                            valueIso={edicion.fecha_limite}
                            onChangeIso={(iso) =>
                              setEdicion((prev) => (prev ? { ...prev, fecha_limite: iso } : prev))
                            }
                            style={estiloCampoFechaCompacto}
                          />
                        </View>
                        {errorEdicion && errorId === p.id_propuesta ? (
                          <Text style={styles.errorLocal}>{errorEdicion}</Text>
                        ) : null}
                        <View style={styles.acciones}>
                          <TouchableOpacity
                            style={[styles.btnSec, isCompact && styles.btnTactil]}
                            onPress={cerrarEdicion}
                            disabled={ocupado}
                          >
                            <Text style={styles.btnSecTexto}>Cancelar</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.btnOk, isCompact && styles.btnTactil]}
                            onPress={() => void aceptar(p, true)}
                            disabled={ocupado}
                          >
                            {ocupado ? (
                              <ActivityIndicator size="small" color="#ffffff" />
                            ) : (
                              <>
                                <MaterialIcons name="check" size={16} color="#ffffff" />
                                <Text style={styles.btnOkTexto}>Aceptar editada</Text>
                              </>
                            )}
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : puedeEditar ? (
                      <View style={styles.acciones}>
                        <TouchableOpacity
                          style={[styles.btnSec, isCompact && styles.btnTactil]}
                          onPress={() => abrirEdicion(p)}
                          disabled={!!resolviendoId}
                        >
                          <MaterialIcons name="edit" size={14} color="#475569" />
                          <Text style={styles.btnSecTexto}>Editar</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.btnNo, isCompact && styles.btnTactil]}
                          onPress={() =>
                            void resolver([{ id_propuesta: p.id_propuesta, accion: 'rechazar' }])
                          }
                          disabled={!!resolviendoId}
                        >
                          {ocupado ? (
                            <ActivityIndicator size="small" color="#b91c1c" />
                          ) : (
                            <>
                              <MaterialIcons name="close" size={16} color="#b91c1c" />
                              <Text style={styles.btnNoTexto}>Rechazar</Text>
                            </>
                          )}
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.btnOk, isCompact && styles.btnTactil]}
                          onPress={() => void aceptar(p, false)}
                          disabled={!!resolviendoId}
                        >
                          {ocupado ? (
                            <ActivityIndicator size="small" color="#ffffff" />
                          ) : (
                            <>
                              <MaterialIcons name="check" size={16} color="#ffffff" />
                              <Text style={styles.btnOkTexto}>Aceptar</Text>
                            </>
                          )}
                        </TouchableOpacity>
                      </View>
                    ) : null}
                    {!enEdicion && errorEdicion && errorId === p.id_propuesta ? (
                      <Text style={styles.errorLocal}>{errorEdicion}</Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : resueltas.length > 0 ? (
            <Text style={styles.sinPendientes}>No quedan propuestas pendientes de validar.</Text>
          ) : null}

          {resueltas.length > 0 ? (
            <View style={styles.resueltas}>
              <Text style={styles.resueltasTitulo}>Ya resueltas ({resueltas.length})</Text>
              {resueltas.map((p) => (
                <View key={p.id_propuesta} style={styles.tarjetaResuelta}>
                  <View style={styles.cabecera}>
                    <BadgeTipo tipo={p.tipo} />
                    <BadgeEstado estado={p.propuesta_estado} />
                  </View>
                  <Text style={styles.tituloResuelto} numberOfLines={2}>
                    {p.titulo || 'Sin título'}
                  </Text>
                  <Text style={styles.citaResuelta} numberOfLines={2}>
                    «{(p.cita ?? '').trim()}»
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}
    </SeccionFicha>
  );
}

function BadgeTipo({ tipo }: { tipo: TipoPropuesta }) {
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_TIPO_PROPUESTA[tipo] ?? tipo}
      tono={TONO_TIPO_PROPUESTA[tipo] ?? { bg: '#e2e8f0', fg: '#64748b' }}
      icono={tipo === 'tarea' ? 'task-alt' : 'assignment-turned-in'}
    />
  );
}

function BadgeEstado({ estado }: { estado: EstadoPropuesta }) {
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_ESTADO_PROPUESTA[estado] ?? estado}
      tono={TONO_ESTADO_PROPUESTA[estado] ?? { bg: '#e2e8f0', fg: '#64748b' }}
    />
  );
}

const styles = StyleSheet.create({
  lista: { gap: 10 },
  tarjeta: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    backgroundColor: '#f8fafc',
    gap: 8,
  },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  titulo: { fontSize: 14, fontWeight: '700', color: '#0f172a', lineHeight: 20 },
  descripcion: { fontSize: 13, color: '#475569', lineHeight: 18 },
  citaBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  citaTexto: { flex: 1, fontSize: 12, color: '#92400e', lineHeight: 17, fontStyle: 'italic' },
  meta: { fontSize: 11, color: '#64748b' },
  editor: { gap: 10, marginTop: 4 },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  btnTactil: { minHeight: MIN_TOUCH },
  btnSec: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  btnSecTexto: { fontSize: 12, fontWeight: '600', color: '#475569' },
  btnOk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#16a34a',
  },
  btnOkTexto: { fontSize: 12, fontWeight: '700', color: '#ffffff' },
  btnNo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  btnNoTexto: { fontSize: 12, fontWeight: '700', color: '#b91c1c' },
  errorLocal: { fontSize: 12, color: '#ef4444' },
  bannerOk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#dcfce7',
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  bannerOkTexto: { flex: 1, fontSize: 12, color: '#166534' },
  sinPendientes: { fontSize: 12, color: '#64748b', lineHeight: 18 },
  resueltas: { gap: 8, marginTop: 4 },
  resueltasTitulo: { fontSize: 12, fontWeight: '700', color: '#64748b' },
  tarjetaResuelta: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    backgroundColor: '#ffffff',
    gap: 4,
    opacity: 0.9,
  },
  tituloResuelto: { fontSize: 13, fontWeight: '600', color: '#334155' },
  citaResuelta: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic' },
});
