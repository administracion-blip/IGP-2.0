/**
 * Alta y edición de un proyecto.
 *
 * El presupuesto solo aparece con `proyectos.presupuesto_ver`: sin ese permiso
 * el backend no lo devuelve al leer y responde `403` al intentar asignarlo, así
 * que enseñar el campo solo serviría para provocar el error. En edición se manda
 * únicamente lo que cambió, y un campo vaciado significa «borra este campo».
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch, errorMessage } from '../../utils/api';
import { InputFecha } from '../InputFecha';
import { estiloCampoFechaCompacto } from '../RangoFechas';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { ETIQUETA_ESTADO_PROYECTO, ETIQUETA_PRIORIDAD } from '../../lib/tasksUi';
import {
  ESTADOS_PROYECTO,
  PRIORIDADES,
  type EstadoProyecto,
  type Prioridad,
  type Proyecto,
} from '../../types/tasks';
import { estilosFormTasks as form, estilosModalTasks as modal } from './estilosTasks';
import type { NombresUsuarios } from '../../hooks/useNombresUsuarios';
import type { MaestroDepartamentos } from '../../hooks/useDepartamentos';

const SIN_VALOR = '';

type FormProyecto = {
  nombre: string;
  descripcion: string;
  estado: EstadoProyecto;
  prioridad: Prioridad;
  departamento_id: string;
  responsable_id: string;
  fecha_inicio: string;
  fecha_fin_prevista: string;
  fecha_cierre: string;
  presupuesto_asignado: string;
};

const INICIAL: FormProyecto = {
  nombre: '',
  descripcion: '',
  estado: 'borrador',
  prioridad: 'media',
  departamento_id: '',
  responsable_id: '',
  fecha_inicio: '',
  fecha_fin_prevista: '',
  fecha_cierre: '',
  presupuesto_asignado: '',
};

function textoImporte(valor?: number | null): string {
  return valor == null || !Number.isFinite(valor) ? '' : String(valor);
}

export function ModalFormularioProyecto({
  visible,
  modo,
  proyecto,
  puedeVerPresupuesto,
  usuarios,
  departamentos,
  onCerrar,
  onGuardado,
}: {
  visible: boolean;
  modo: 'crear' | 'editar';
  proyecto?: Proyecto | null;
  puedeVerPresupuesto: boolean;
  usuarios: NombresUsuarios;
  departamentos: MaestroDepartamentos;
  onCerrar: () => void;
  onGuardado: (proyecto: Proyecto) => void;
}) {
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const [datos, setDatos] = useState<FormProyecto>(INICIAL);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    if (modo === 'editar' && proyecto) {
      setDatos({
        nombre: proyecto.nombre ?? '',
        descripcion: proyecto.descripcion ?? '',
        estado: proyecto.estado ?? 'borrador',
        prioridad: proyecto.prioridad ?? 'media',
        departamento_id: proyecto.departamento_id ?? '',
        responsable_id: proyecto.responsable_id ?? '',
        fecha_inicio: proyecto.fecha_inicio ?? '',
        fecha_fin_prevista: proyecto.fecha_fin_prevista ?? '',
        fecha_cierre: proyecto.fecha_cierre ?? '',
        presupuesto_asignado: textoImporte(proyecto.presupuesto_asignado),
      });
    } else {
      setDatos(INICIAL);
    }
  }, [visible, modo, proyecto]);

  const opcionesDepartamento = useMemo<OpcionDesplegable[]>(
    () => [{ id: SIN_VALOR, titulo: '(sin departamento)' }, ...departamentos.opciones],
    [departamentos.opciones],
  );

  const opcionesResponsable = useMemo<OpcionDesplegable[]>(() => {
    const lista: OpcionDesplegable[] = [
      { id: SIN_VALOR, titulo: modo === 'crear' ? '(yo)' : '(sin responsable)' },
      ...usuarios.opciones,
    ];
    const actual = datos.responsable_id.trim();
    if (actual && !lista.some((o) => o.id === actual)) {
      lista.push({ id: actual, titulo: usuarios.nombrePorId(actual), icono: 'person' });
    }
    return lista;
  }, [usuarios, datos.responsable_id, modo]);

  function importeValido(): { ok: true; valor: number | null } | { ok: false } {
    const bruto = datos.presupuesto_asignado.trim().replace(',', '.');
    if (bruto === '') return { ok: true, valor: null };
    const n = Number(bruto);
    return Number.isFinite(n) && n >= 0 ? { ok: true, valor: n } : { ok: false };
  }

  async function guardar() {
    const nombre = datos.nombre.trim().replace(/\s+/g, ' ');
    if (!nombre) {
      setError('El nombre del proyecto es obligatorio');
      return;
    }
    for (const iso of [datos.fecha_inicio, datos.fecha_fin_prevista, datos.fecha_cierre]) {
      if (iso && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        setError('Indica una fecha válida (dd/mm/aaaa)');
        return;
      }
    }
    if (
      datos.fecha_inicio &&
      datos.fecha_fin_prevista &&
      datos.fecha_fin_prevista < datos.fecha_inicio
    ) {
      setError('El fin previsto no puede ser anterior al inicio');
      return;
    }
    const importe = importeValido();
    if (!importe.ok) {
      setError('El presupuesto debe ser un número igual o mayor que cero');
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      const esEdicion = modo === 'editar' && proyecto != null;
      const cuerpo: Record<string, unknown> = {};

      if (esEdicion) {
        const antes = proyecto as Proyecto;
        if (nombre !== (antes.nombre ?? '')) cuerpo.nombre = nombre;
        if (datos.descripcion.trim() !== (antes.descripcion ?? '')) {
          cuerpo.descripcion = datos.descripcion.trim();
        }
        if (datos.estado !== antes.estado) cuerpo.estado = datos.estado;
        if (datos.prioridad !== (antes.prioridad ?? 'media')) cuerpo.prioridad = datos.prioridad;
        if (datos.departamento_id !== (antes.departamento_id ?? '')) {
          cuerpo.departamento_id = datos.departamento_id;
        }
        if (datos.responsable_id !== (antes.responsable_id ?? '')) {
          cuerpo.responsable_id = datos.responsable_id;
        }
        if (datos.fecha_inicio !== (antes.fecha_inicio ?? '')) cuerpo.fecha_inicio = datos.fecha_inicio;
        if (datos.fecha_fin_prevista !== (antes.fecha_fin_prevista ?? '')) {
          cuerpo.fecha_fin_prevista = datos.fecha_fin_prevista;
        }
        if (datos.fecha_cierre !== (antes.fecha_cierre ?? '')) cuerpo.fecha_cierre = datos.fecha_cierre;
        if (puedeVerPresupuesto && importe.valor !== (antes.presupuesto_asignado ?? null)) {
          cuerpo.presupuesto_asignado = importe.valor;
        }
        if (Object.keys(cuerpo).length === 0) {
          onCerrar();
          return;
        }
      } else {
        cuerpo.nombre = nombre;
        cuerpo.estado = datos.estado;
        cuerpo.prioridad = datos.prioridad;
        if (datos.descripcion.trim()) cuerpo.descripcion = datos.descripcion.trim();
        if (datos.departamento_id) cuerpo.departamento_id = datos.departamento_id;
        if (datos.responsable_id) cuerpo.responsable_id = datos.responsable_id;
        if (datos.fecha_inicio) cuerpo.fecha_inicio = datos.fecha_inicio;
        if (datos.fecha_fin_prevista) cuerpo.fecha_fin_prevista = datos.fecha_fin_prevista;
        if (puedeVerPresupuesto && importe.valor != null) {
          cuerpo.presupuesto_asignado = importe.valor;
        }
      }

      const res = await apiFetch(
        esEdicion ? `/api/proyectos/${encodeURIComponent((proyecto as Proyecto).id_proyecto)}` : '/api/proyectos',
        { method: esEdicion ? 'PATCH' : 'POST', body: JSON.stringify(cuerpo) },
      );
      const data = (await res.json().catch(() => ({}))) as { proyecto?: Proyecto; error?: string };
      if (!res.ok || !data.proyecto) {
        setError(data.error || 'No se pudo guardar el proyecto');
        return;
      }
      onGuardado(data.proyecto);
    } catch (e) {
      console.error('[tasks] fallo al guardar el proyecto', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable style={modal.overlay}>
        <KeyboardAvoidingView
          style={modal.center}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable
            style={[modal.cardWrap, (shouldStackPanels || isCompact) && modal.cardWrapAncho]}
          >
            <View style={modal.card}>
              <View style={modal.header}>
                <Text style={modal.title}>
                  {modo === 'editar' ? 'Editar proyecto' : 'Nuevo proyecto'}
                </Text>
                <TouchableOpacity onPress={onCerrar} style={modal.close} disabled={guardando}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>

              <ScrollView style={modal.body} keyboardShouldPersistTaps="handled">
                <View style={form.group}>
                  <Text style={form.label}>Nombre *</Text>
                  <TextInput
                    style={form.input}
                    value={datos.nombre}
                    onChangeText={(t) => setDatos((p) => ({ ...p, nombre: t }))}
                    placeholder="Ej.: Apertura del local de Triana"
                    placeholderTextColor="#94a3b8"
                    editable={!guardando}
                  />
                </View>

                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    <Text style={form.label}>Descripción</Text>
                    <TextInput
                      style={[
                        form.input,
                        form.inputMultilineaMedia,
                        !shouldStackPanels && { flex: 1 },
                      ]}
                      value={datos.descripcion}
                      onChangeText={(t) => setDatos((p) => ({ ...p, descripcion: t }))}
                      placeholder="Objetivo del proyecto y alcance"
                      placeholderTextColor="#94a3b8"
                      multiline
                      numberOfLines={5}
                      editable={!guardando}
                    />
                  </View>

                  <View style={form.col}>
                    <View style={form.group}>
                      <Text style={form.label}>Estado</Text>
                      <View style={form.chipsRow}>
                        {ESTADOS_PROYECTO.map((e) => (
                          <TouchableOpacity
                            key={e}
                            style={[
                              form.chip,
                              isCompact && form.chipTactil,
                              datos.estado === e && form.chipActivo,
                            ]}
                            onPress={() => setDatos((p) => ({ ...p, estado: e }))}
                            disabled={guardando}
                          >
                            <Text style={[form.chipTexto, datos.estado === e && form.chipTextoActivo]}>
                              {ETIQUETA_ESTADO_PROYECTO[e]}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>

                    <View style={form.group}>
                      <Text style={form.label}>Prioridad</Text>
                      <View style={form.chipsRow}>
                        {PRIORIDADES.map((p) => (
                          <TouchableOpacity
                            key={p}
                            style={[
                              form.chip,
                              isCompact && form.chipTactil,
                              datos.prioridad === p && form.chipActivo,
                            ]}
                            onPress={() => setDatos((prev) => ({ ...prev, prioridad: p }))}
                            disabled={guardando}
                          >
                            <Text
                              style={[form.chipTexto, datos.prioridad === p && form.chipTextoActivo]}
                            >
                              {ETIQUETA_PRIORIDAD[p]}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>

                    <View style={form.group}>
                      <SelectorDesplegable
                        label="Departamento"
                        icono="account-tree"
                        placeholder="Sin departamento"
                        tituloLista="Selecciona un departamento"
                        iconoLista="account-tree"
                        valorId={datos.departamento_id}
                        opciones={opcionesDepartamento}
                        vacioTexto="No hay departamentos activos"
                        disabled={guardando}
                        loading={departamentos.cargando}
                        onSeleccionar={(id) => setDatos((p) => ({ ...p, departamento_id: id }))}
                      />
                    </View>

                    <View style={form.group}>
                      <SelectorDesplegable
                        label="Responsable"
                        icono="person"
                        placeholder={modo === 'crear' ? 'Yo' : 'Sin responsable'}
                        tituloLista="Selecciona el responsable"
                        iconoLista="person"
                        buscador
                        buscadorPlaceholder="Buscar usuario…"
                        valorId={datos.responsable_id}
                        opciones={opcionesResponsable}
                        vacioTexto="No hay usuarios disponibles"
                        disabled={guardando || usuarios.noDisponibles}
                        loading={usuarios.cargando}
                        onSeleccionar={(id) => setDatos((p) => ({ ...p, responsable_id: id }))}
                      />
                      {usuarios.noDisponibles ? (
                        <View style={form.aviso}>
                          <MaterialIcons name="info-outline" size={14} color="#d97706" />
                          <Text style={form.avisoTexto}>
                            No se puede elegir responsable sin el permiso de usuarios. Se conserva el
                            que ya tuviera el proyecto.
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                      <View style={form.col}>
                        <Text style={form.label}>Inicio</Text>
                        <InputFecha
                          compact
                          valueIso={datos.fecha_inicio}
                          onChangeIso={(iso) => setDatos((p) => ({ ...p, fecha_inicio: iso }))}
                          editable={!guardando}
                          style={estiloCampoFechaCompacto}
                        />
                      </View>
                      <View style={form.col}>
                        <Text style={form.label}>Fin previsto</Text>
                        <InputFecha
                          compact
                          valueIso={datos.fecha_fin_prevista}
                          onChangeIso={(iso) => setDatos((p) => ({ ...p, fecha_fin_prevista: iso }))}
                          editable={!guardando}
                          style={estiloCampoFechaCompacto}
                        />
                      </View>
                    </View>

                    {puedeVerPresupuesto ? (
                      <View style={form.group}>
                        <Text style={form.label}>Presupuesto asignado (€)</Text>
                        <TextInput
                          style={form.input}
                          value={datos.presupuesto_asignado}
                          onChangeText={(t) => setDatos((p) => ({ ...p, presupuesto_asignado: t }))}
                          placeholder="Ej.: 12000"
                          placeholderTextColor="#94a3b8"
                          keyboardType="decimal-pad"
                          editable={!guardando}
                        />
                        <Text style={form.help}>
                          Déjalo vacío si el proyecto no tiene presupuesto asignado. El gasto
                          comprometido y el real se calculan solos a partir de las líneas de compra.
                        </Text>
                      </View>
                    ) : null}

                    {modo === 'editar' && (datos.estado === 'cerrado' || datos.fecha_cierre) ? (
                      <View style={form.group}>
                        <Text style={form.label}>Fecha de cierre</Text>
                        <InputFecha
                          compact
                          valueIso={datos.fecha_cierre}
                          onChangeIso={(iso) => setDatos((p) => ({ ...p, fecha_cierre: iso }))}
                          editable={!guardando}
                          style={estiloCampoFechaCompacto}
                        />
                      </View>
                    ) : null}
                  </View>
                </View>
              </ScrollView>

              {error ? <Text style={modal.error}>{error}</Text> : null}

              <View style={modal.footer}>
                <TouchableOpacity
                  style={[modal.btn, isCompact && modal.btnTactil]}
                  onPress={onCerrar}
                  disabled={guardando}
                >
                  <Text style={modal.btnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[modal.btn, modal.btnPrimario, isCompact && modal.btnTactil]}
                  onPress={guardar}
                  disabled={guardando}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={modal.btnTextPrimario}>{modo === 'editar' ? 'Guardar' : 'Crear'}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
