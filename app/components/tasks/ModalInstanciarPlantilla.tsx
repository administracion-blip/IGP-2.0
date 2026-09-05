/**
 * Crear un proyecto real a partir de una plantilla (`POST …/instanciar`).
 * Pide nombre, responsable, departamento y fecha de inicio; el resto lo hereda
 * la plantilla o lo fija el servidor.
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
  type PlantillaProyecto,
  type Prioridad,
  type Proyecto,
} from '../../types/tasks';
import { estilosFormTasks as form, estilosModalTasks as modal } from './estilosTasks';
import type { NombresUsuarios } from '../../hooks/useNombresUsuarios';
import type { MaestroDepartamentos } from '../../hooks/useDepartamentos';

const SIN_VALOR = '';

function hoyIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type FormInstanciar = {
  nombre: string;
  responsable_id: string;
  departamento_id: string;
  fecha_inicio: string;
  estado: EstadoProyecto;
  prioridad: Prioridad;
};

export type ResumenInstanciarPlantilla = {
  creadas: number;
  omitidas: number;
  esperadas: number;
};

export function instanciarPlantillaConProblemas(resumen: ResumenInstanciarPlantilla): boolean {
  return resumen.omitidas > 0 || resumen.creadas < resumen.esperadas;
}

export function mensajeInstanciarPlantillaParcial(resumen: ResumenInstanciarPlantilla): string {
  const partes: string[] = [];
  if (resumen.esperadas > 0 && resumen.creadas < resumen.esperadas) {
    partes.push(
      `Se crearon ${resumen.creadas} de ${resumen.esperadas} tareas de la plantilla.`,
    );
  }
  if (resumen.omitidas > 0) {
    partes.push(
      `${resumen.omitidas} tarea${resumen.omitidas === 1 ? '' : 's'} se omitieron (duplicadas o ya existentes).`,
    );
  }
  return partes.length > 0
    ? `${partes.join(' ')} Revisa el proyecto antes de continuar.`
    : 'La creación de tareas fue parcial. Revisa el proyecto.';
}

export function ModalInstanciarPlantilla({
  visible,
  plantilla,
  usuarios,
  departamentos,
  onCerrar,
  onCreado,
}: {
  visible: boolean;
  plantilla: PlantillaProyecto | null;
  usuarios: NombresUsuarios;
  departamentos: MaestroDepartamentos;
  onCerrar: () => void;
  onCreado: (proyecto: Proyecto, resumen: ResumenInstanciarPlantilla) => void;
}) {
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const [datos, setDatos] = useState<FormInstanciar>({
    nombre: '',
    responsable_id: '',
    departamento_id: '',
    fecha_inicio: hoyIso(),
    estado: 'activo',
    prioridad: 'media',
  });
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultadoParcial, setResultadoParcial] = useState<{
    proyecto: Proyecto;
    resumen: ResumenInstanciarPlantilla;
  } | null>(null);

  useEffect(() => {
    if (!visible || !plantilla) return;
    setError(null);
    setResultadoParcial(null);
    setDatos({
      nombre: plantilla.nombre ?? '',
      responsable_id: '',
      departamento_id: plantilla.departamento_id ?? '',
      fecha_inicio: hoyIso(),
      estado: 'activo',
      prioridad: 'media',
    });
  }, [visible, plantilla]);

  const opcionesDepartamento = useMemo<OpcionDesplegable[]>(
    () => [{ id: SIN_VALOR, titulo: '(sin departamento)' }, ...departamentos.opciones],
    [departamentos.opciones],
  );

  const opcionesResponsable = useMemo<OpcionDesplegable[]>(() => {
    const lista: OpcionDesplegable[] = [
      { id: SIN_VALOR, titulo: '(yo)' },
      ...usuarios.opciones,
    ];
    const actual = datos.responsable_id.trim();
    if (actual && !lista.some((o) => o.id === actual)) {
      lista.push({ id: actual, titulo: usuarios.nombrePorId(actual), icono: 'person' });
    }
    return lista;
  }, [usuarios, datos.responsable_id]);

  const nTareas = Array.isArray(plantilla?.tareas) ? plantilla!.tareas.length : 0;

  async function confirmar() {
    if (!plantilla) return;
    const nombre = datos.nombre.trim().replace(/\s+/g, ' ');
    if (!nombre) {
      setError('El nombre del proyecto es obligatorio');
      return;
    }
    if (datos.fecha_inicio && !/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha_inicio)) {
      setError('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      const cuerpo: Record<string, unknown> = {
        nombre,
        estado: datos.estado,
        prioridad: datos.prioridad,
      };
      if (datos.fecha_inicio) cuerpo.fecha_inicio = datos.fecha_inicio;
      if (datos.departamento_id) cuerpo.departamento_id = datos.departamento_id;
      if (datos.responsable_id) cuerpo.responsable_id = datos.responsable_id;

      const res = await apiFetch(
        `/api/proyectos/plantillas/${encodeURIComponent(plantilla.id_plantilla)}/instanciar`,
        { method: 'POST', body: JSON.stringify(cuerpo) },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        proyecto?: Proyecto;
        creadas?: unknown[];
        omitidas?: unknown[];
        error?: string;
      };
      if (!res.ok || !data.proyecto) {
        setError(data.error || 'No se pudo crear el proyecto desde la plantilla');
        return;
      }
      const resumen: ResumenInstanciarPlantilla = {
        creadas: Array.isArray(data.creadas) ? data.creadas.length : 0,
        omitidas: Array.isArray(data.omitidas) ? data.omitidas.length : 0,
        esperadas: nTareas,
      };
      if (instanciarPlantillaConProblemas(resumen)) {
        setResultadoParcial({ proyecto: data.proyecto, resumen });
        return;
      }
      onCreado(data.proyecto, resumen);
    } catch (e) {
      console.error('[tasks] fallo al instanciar plantilla', e);
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
            style={[
              modal.cardWrap,
              modal.cardWrapEstrecho,
              (shouldStackPanels || isCompact) && modal.cardWrapAncho,
            ]}
          >
            <View style={modal.card}>
              <View style={modal.header}>
                <Text style={modal.title}>Usar plantilla</Text>
                <TouchableOpacity onPress={onCerrar} style={modal.close} disabled={guardando}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>

              <ScrollView style={modal.body} keyboardShouldPersistTaps="handled">
                {resultadoParcial ? (
                  <>
                    <View style={form.aviso}>
                      <MaterialIcons name="warning-amber" size={18} color="#d97706" />
                      <Text style={form.avisoTexto}>
                        El proyecto «{resultadoParcial.proyecto.nombre ?? datos.nombre}» se creó,
                        pero no todas las tareas de la plantilla se generaron correctamente.
                      </Text>
                    </View>
                    <Text style={form.help}>
                      {mensajeInstanciarPlantillaParcial(resultadoParcial.resumen)}
                    </Text>
                  </>
                ) : (
                  <>
                <Text style={form.help}>
                  Se creará un proyecto a partir de «{plantilla?.nombre ?? '—'}» con {nTareas}{' '}
                  {nTareas === 1 ? 'tarea' : 'tareas'}. Las fechas límite se calculan desde la
                  fecha de inicio.
                </Text>

                <View style={form.group}>
                  <Text style={form.label}>Nombre del proyecto *</Text>
                  <TextInput
                    style={form.input}
                    value={datos.nombre}
                    onChangeText={(t) => setDatos((p) => ({ ...p, nombre: t }))}
                    placeholder="Nombre del nuevo proyecto"
                    placeholderTextColor="#94a3b8"
                    editable={!guardando}
                  />
                </View>

                <View style={form.group}>
                  <SelectorDesplegable
                    label="Responsable"
                    icono="person"
                    placeholder="Yo"
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
                        Sin permiso de usuarios quedarás como responsable del proyecto.
                      </Text>
                    </View>
                  ) : null}
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
                  <Text style={form.label}>Fecha de inicio</Text>
                  <InputFecha
                    compact
                    valueIso={datos.fecha_inicio}
                    onChangeIso={(iso) => setDatos((p) => ({ ...p, fecha_inicio: iso }))}
                    editable={!guardando}
                    style={estiloCampoFechaCompacto}
                  />
                </View>

                <View style={form.group}>
                  <Text style={form.label}>Estado</Text>
                  <View style={form.chipsRow}>
                    {ESTADOS_PROYECTO.filter((e) => e !== 'cerrado' && e !== 'cancelado').map(
                      (e) => (
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
                          <Text
                            style={[form.chipTexto, datos.estado === e && form.chipTextoActivo]}
                          >
                            {ETIQUETA_ESTADO_PROYECTO[e]}
                          </Text>
                        </TouchableOpacity>
                      ),
                    )}
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
                          style={[
                            form.chipTexto,
                            datos.prioridad === p && form.chipTextoActivo,
                          ]}
                        >
                          {ETIQUETA_PRIORIDAD[p]}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                  </>
                )}
              </ScrollView>

              {error ? <Text style={modal.error}>{error}</Text> : null}

              <View style={modal.footer}>
                {resultadoParcial ? (
                  <TouchableOpacity
                    style={[
                      modal.btn,
                      modal.btnPrimario,
                      isCompact && modal.btnTactil,
                      { flex: 1 },
                    ]}
                    onPress={() => onCreado(resultadoParcial.proyecto, resultadoParcial.resumen)}
                  >
                    <Text style={modal.btnTextPrimario}>Ver proyecto</Text>
                  </TouchableOpacity>
                ) : (
                  <>
                <TouchableOpacity
                  style={[modal.btn, isCompact && modal.btnTactil]}
                  onPress={onCerrar}
                  disabled={guardando}
                >
                  <Text style={modal.btnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[modal.btn, modal.btnPrimario, isCompact && modal.btnTactil]}
                  onPress={() => void confirmar()}
                  disabled={guardando}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={modal.btnTextPrimario}>Crear proyecto</Text>
                  )}
                </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
