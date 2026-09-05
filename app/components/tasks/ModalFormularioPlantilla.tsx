/**
 * Alta y edición de una plantilla de proyecto (META + tareas embebidas).
 * Si el cuerpo incluye `tareas`, el PATCH sustituye el set completo.
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
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch, errorMessage } from '../../utils/api';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import {
  MAX_CHECKLIST,
  MAX_TAREAS_LOTE,
  type PlantillaProyecto,
  type PlantillaTarea,
} from '../../types/tasks';
import { estilosFormTasks as form, estilosModalTasks as modal } from './estilosTasks';
import type { MaestroDepartamentos } from '../../hooks/useDepartamentos';
import { MIN_TOUCH } from '../../constants/layout';

const SIN_VALOR = '';

type ChecklistForm = { texto: string };

type TareaForm = {
  clave: string;
  titulo: string;
  descripcion: string;
  dias_desde_inicio: string;
  rol_responsable_sugerido: string;
  checklist: ChecklistForm[];
};

type FormPlantilla = {
  nombre: string;
  descripcion: string;
  departamento_id: string;
  tareas: TareaForm[];
};

function checklistDesdeApi(bruto: PlantillaTarea['checklist']): ChecklistForm[] {
  if (!Array.isArray(bruto)) return [];
  return bruto
    .map((c) => ({ texto: typeof c === 'string' ? c : (c?.texto ?? '') }))
    .filter((c) => c.texto.trim() !== '');
}

function tareaDesdeApi(t: PlantillaTarea, i: number): TareaForm {
  return {
    clave: `t-${i}-${t.titulo ?? ''}`,
    titulo: t.titulo ?? '',
    descripcion: t.descripcion ?? '',
    dias_desde_inicio:
      t.dias_desde_inicio != null && Number.isFinite(t.dias_desde_inicio)
        ? String(t.dias_desde_inicio)
        : '',
    rol_responsable_sugerido: t.rol_responsable_sugerido ?? '',
    checklist: checklistDesdeApi(t.checklist),
  };
}

function nuevaTarea(): TareaForm {
  return {
    clave: `nueva-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    titulo: '',
    descripcion: '',
    dias_desde_inicio: '',
    rol_responsable_sugerido: '',
    checklist: [],
  };
}

const INICIAL: FormPlantilla = {
  nombre: '',
  descripcion: '',
  departamento_id: '',
  tareas: [],
};

export function ModalFormularioPlantilla({
  visible,
  modo,
  plantilla,
  departamentos,
  onCerrar,
  onGuardado,
}: {
  visible: boolean;
  modo: 'crear' | 'editar';
  plantilla?: PlantillaProyecto | null;
  departamentos: MaestroDepartamentos;
  onCerrar: () => void;
  onGuardado: (plantilla: PlantillaProyecto) => void;
}) {
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const [datos, setDatos] = useState<FormPlantilla>(INICIAL);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    if (modo === 'editar' && plantilla) {
      setDatos({
        nombre: plantilla.nombre ?? '',
        descripcion: plantilla.descripcion ?? '',
        departamento_id: plantilla.departamento_id ?? '',
        tareas: Array.isArray(plantilla.tareas)
          ? plantilla.tareas.map((t, i) => tareaDesdeApi(t, i))
          : [],
      });
    } else {
      setDatos(INICIAL);
    }
  }, [visible, modo, plantilla]);

  const opcionesDepartamento = useMemo<OpcionDesplegable[]>(
    () => [{ id: SIN_VALOR, titulo: '(sin departamento)' }, ...departamentos.opciones],
    [departamentos.opciones],
  );

  function actualizarTarea(clave: string, patch: Partial<TareaForm>) {
    setDatos((prev) => ({
      ...prev,
      tareas: prev.tareas.map((t) => (t.clave === clave ? { ...t, ...patch } : t)),
    }));
  }

  function moverTarea(indice: number, delta: number) {
    setDatos((prev) => {
      const destino = indice + delta;
      if (destino < 0 || destino >= prev.tareas.length) return prev;
      const copia = [...prev.tareas];
      const [item] = copia.splice(indice, 1);
      copia.splice(destino, 0, item);
      return { ...prev, tareas: copia };
    });
  }

  function construirTareasPayload():
    | { ok: true; tareas: Record<string, unknown>[] }
    | { ok: false; error: string } {
    if (datos.tareas.length > MAX_TAREAS_LOTE) {
      return {
        ok: false,
        error: `Una plantilla no admite más de ${MAX_TAREAS_LOTE} tareas`,
      };
    }
    const tareas: Record<string, unknown>[] = [];
    for (let i = 0; i < datos.tareas.length; i += 1) {
      const t = datos.tareas[i];
      const titulo = t.titulo.trim().replace(/\s+/g, ' ');
      if (!titulo) {
        return { ok: false, error: `La tarea ${i + 1} necesita un título` };
      }
      if (t.checklist.length > MAX_CHECKLIST) {
        return {
          ok: false,
          error: `La tarea ${i + 1} no admite más de ${MAX_CHECKLIST} elementos en la lista`,
        };
      }
      const checklist: string[] = [];
      for (const c of t.checklist) {
        const texto = c.texto.trim();
        if (!texto) {
          return {
            ok: false,
            error: `Hay un elemento vacío en la lista de comprobación de la tarea ${i + 1}`,
          };
        }
        checklist.push(texto);
      }
      const entrada: Record<string, unknown> = { titulo, orden: i };
      if (t.descripcion.trim()) entrada.descripcion = t.descripcion.trim();
      if (t.rol_responsable_sugerido.trim()) {
        entrada.rol_responsable_sugerido = t.rol_responsable_sugerido.trim();
      }
      if (checklist.length) entrada.checklist = checklist;
      const diasBruto = t.dias_desde_inicio.trim();
      if (diasBruto !== '') {
        const n = Number(diasBruto);
        if (!Number.isInteger(n) || n < 0) {
          return {
            ok: false,
            error: `Tarea ${i + 1}: los días desde el inicio deben ser un entero ≥ 0`,
          };
        }
        entrada.dias_desde_inicio = n;
      }
      tareas.push(entrada);
    }
    return { ok: true, tareas };
  }

  async function guardar() {
    const nombre = datos.nombre.trim().replace(/\s+/g, ' ');
    if (!nombre) {
      setError('El nombre de la plantilla es obligatorio');
      return;
    }
    const tareasNorm = construirTareasPayload();
    if (!tareasNorm.ok) {
      setError(tareasNorm.error);
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      const esEdicion = modo === 'editar' && plantilla != null;
      const cuerpo: Record<string, unknown> = {
        nombre,
        descripcion: datos.descripcion.trim(),
        departamento_id: datos.departamento_id,
        tareas: tareasNorm.tareas,
      };

      const res = await apiFetch(
        esEdicion
          ? `/api/proyectos/plantillas/${encodeURIComponent(plantilla!.id_plantilla)}`
          : '/api/proyectos/plantillas',
        { method: esEdicion ? 'PATCH' : 'POST', body: JSON.stringify(cuerpo) },
      );
      const data = (await res.json().catch(() => ({}))) as {
        plantilla?: PlantillaProyecto;
        error?: string;
      };
      if (!res.ok || !data.plantilla) {
        setError(data.error || 'No se pudo guardar la plantilla');
        return;
      }
      onGuardado(data.plantilla);
    } catch (e) {
      console.error('[tasks] fallo al guardar la plantilla', e);
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
                  {modo === 'editar' ? 'Editar plantilla' : 'Nueva plantilla'}
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
                    placeholder="Ej.: Apertura de local"
                    placeholderTextColor="#94a3b8"
                    editable={!guardando}
                  />
                </View>

                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    <Text style={form.label}>Descripción</Text>
                    <TextInput
                      style={[form.input, form.inputMultilineaMedia]}
                      value={datos.descripcion}
                      onChangeText={(t) => setDatos((p) => ({ ...p, descripcion: t }))}
                      placeholder="Para qué sirve esta plantilla"
                      placeholderTextColor="#94a3b8"
                      multiline
                      numberOfLines={4}
                      editable={!guardando}
                    />
                  </View>
                  <View style={form.col}>
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
                    <Text style={form.help}>
                      Al usar la plantilla se puede cambiar. Las tareas se crean en bloque al
                      instanciar.
                    </Text>
                  </View>
                </View>

                <View style={styles.tareasCabecera}>
                  <Text style={styles.tareasTitulo}>
                    Tareas ({datos.tareas.length}/{MAX_TAREAS_LOTE})
                  </Text>
                  <TouchableOpacity
                    style={[styles.btnAdd, isCompact && styles.btnAddTactil]}
                    onPress={() => {
                      if (datos.tareas.length >= MAX_TAREAS_LOTE) {
                        setError(`Una plantilla no admite más de ${MAX_TAREAS_LOTE} tareas`);
                        return;
                      }
                      setDatos((p) => ({ ...p, tareas: [...p.tareas, nuevaTarea()] }));
                    }}
                    disabled={guardando}
                  >
                    <MaterialIcons name="add" size={16} color="#0ea5e9" />
                    <Text style={styles.btnAddTexto}>Añadir tarea</Text>
                  </TouchableOpacity>
                </View>

                {datos.tareas.length === 0 ? (
                  <Text style={form.help}>
                    Sin tareas: al usar la plantilla solo se crea el proyecto vacío.
                  </Text>
                ) : null}

                {datos.tareas.map((tarea, indice) => (
                  <View key={tarea.clave} style={styles.tareaCard}>
                    <View style={styles.tareaHeader}>
                      <Text style={styles.tareaOrden}>Tarea {indice + 1}</Text>
                      <View style={styles.tareaAcciones}>
                        <TouchableOpacity
                          onPress={() => moverTarea(indice, -1)}
                          disabled={guardando || indice === 0}
                          style={styles.iconBtn}
                          accessibilityLabel="Subir tarea"
                        >
                          <MaterialIcons
                            name="arrow-upward"
                            size={18}
                            color={indice === 0 ? '#cbd5e1' : '#64748b'}
                          />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => moverTarea(indice, 1)}
                          disabled={guardando || indice === datos.tareas.length - 1}
                          style={styles.iconBtn}
                          accessibilityLabel="Bajar tarea"
                        >
                          <MaterialIcons
                            name="arrow-downward"
                            size={18}
                            color={
                              indice === datos.tareas.length - 1 ? '#cbd5e1' : '#64748b'
                            }
                          />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() =>
                            setDatos((p) => ({
                              ...p,
                              tareas: p.tareas.filter((x) => x.clave !== tarea.clave),
                            }))
                          }
                          disabled={guardando}
                          style={styles.iconBtn}
                          accessibilityLabel="Quitar tarea"
                        >
                          <MaterialIcons name="delete-outline" size={18} color="#d97706" />
                        </TouchableOpacity>
                      </View>
                    </View>

                    <View style={form.group}>
                      <Text style={form.label}>Título *</Text>
                      <TextInput
                        style={form.input}
                        value={tarea.titulo}
                        onChangeText={(t) => actualizarTarea(tarea.clave, { titulo: t })}
                        placeholder="Ej.: Contratar personal"
                        placeholderTextColor="#94a3b8"
                        editable={!guardando}
                      />
                    </View>

                    <View style={form.group}>
                      <Text style={form.label}>Descripción</Text>
                      <TextInput
                        style={[form.input, form.inputMultilinea]}
                        value={tarea.descripcion}
                        onChangeText={(t) => actualizarTarea(tarea.clave, { descripcion: t })}
                        placeholder="Detalle opcional"
                        placeholderTextColor="#94a3b8"
                        multiline
                        editable={!guardando}
                      />
                    </View>

                    <View
                      style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}
                    >
                      <View style={form.col}>
                        <Text style={form.label}>Días desde el inicio</Text>
                        <TextInput
                          style={form.input}
                          value={tarea.dias_desde_inicio}
                          onChangeText={(t) =>
                            actualizarTarea(tarea.clave, {
                              dias_desde_inicio: t.replace(/[^\d]/g, ''),
                            })
                          }
                          placeholder="Ej.: 7"
                          placeholderTextColor="#94a3b8"
                          keyboardType="number-pad"
                          editable={!guardando}
                        />
                        <Text style={form.help}>
                          Fecha límite = inicio del proyecto + estos días. Vacío = sin límite.
                        </Text>
                      </View>
                      <View style={form.col}>
                        <Text style={form.label}>Rol sugerido</Text>
                        <TextInput
                          style={form.input}
                          value={tarea.rol_responsable_sugerido}
                          onChangeText={(t) =>
                            actualizarTarea(tarea.clave, { rol_responsable_sugerido: t })
                          }
                          placeholder="p. ej. obra, cocina…"
                          placeholderTextColor="#94a3b8"
                          editable={!guardando}
                        />
                        <Text style={form.help}>
                          Texto orientativo al usar la plantilla; no restringe permisos ni
                          asignaciones.
                        </Text>
                      </View>
                    </View>

                    <View style={form.group}>
                      <View style={styles.checklistCabecera}>
                        <Text style={form.label}>
                          Lista de comprobación ({tarea.checklist.length}/{MAX_CHECKLIST})
                        </Text>
                        <TouchableOpacity
                          style={styles.btnAddMini}
                          onPress={() => {
                            if (tarea.checklist.length >= MAX_CHECKLIST) {
                              setError(
                                `La lista de comprobación no admite más de ${MAX_CHECKLIST} elementos`,
                              );
                              return;
                            }
                            actualizarTarea(tarea.clave, {
                              checklist: [...tarea.checklist, { texto: '' }],
                            });
                          }}
                          disabled={guardando}
                        >
                          <MaterialIcons name="playlist-add" size={16} color="#0ea5e9" />
                          <Text style={styles.btnAddTexto}>Añadir</Text>
                        </TouchableOpacity>
                      </View>
                      {tarea.checklist.map((item, ci) => (
                        <View key={`c-${ci}`} style={styles.checklistFila}>
                          <TextInput
                            style={[form.input, styles.checklistInput]}
                            value={item.texto}
                            onChangeText={(texto) => {
                              const checklist = tarea.checklist.map((c, j) =>
                                j === ci ? { texto } : c,
                              );
                              actualizarTarea(tarea.clave, { checklist });
                            }}
                            placeholder="Elemento de la lista"
                            placeholderTextColor="#94a3b8"
                            editable={!guardando}
                          />
                          <TouchableOpacity
                            onPress={() =>
                              actualizarTarea(tarea.clave, {
                                checklist: tarea.checklist.filter((_, j) => j !== ci),
                              })
                            }
                            disabled={guardando}
                            style={styles.iconBtn}
                          >
                            <MaterialIcons name="close" size={18} color="#94a3b8" />
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  </View>
                ))}
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
                  onPress={() => void guardar()}
                  disabled={guardando}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={modal.btnTextPrimario}>
                      {modo === 'editar' ? 'Guardar' : 'Crear'}
                    </Text>
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

const styles = StyleSheet.create({
  tareasCabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 8,
  },
  tareasTitulo: { fontSize: 13, fontWeight: '600', color: '#334155' },
  btnAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  btnAddTactil: { minHeight: MIN_TOUCH },
  btnAddMini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  btnAddTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  tareaCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#ffffff',
  },
  tareaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  tareaOrden: { fontSize: 12, fontWeight: '700', color: '#64748b' },
  tareaAcciones: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  iconBtn: {
    padding: 6,
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checklistCabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  checklistFila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  checklistInput: { flex: 1 },
});
