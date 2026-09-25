/**
 * Alta de tarea o reunión desde un hueco vacío de la semana.
 * Primero elige el tipo (si hay más de uno) y luego abre el formulario
 * anclado al clic, con fecha y hora ya rellenas.
 */
import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { tasksUi } from '../../constants/tasksUiTokens';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import { useNombresUsuarios } from '../../hooks/useNombresUsuarios';
import {
  puedeEditarProyectos,
  puedeGestionarReuniones,
  type AccesoTasks,
} from '../../lib/tasksAcceso';
import type { Tarea } from '../../types/tasks';
import { marcoFichaFlotante } from './estilosTasks';
import { ModalFormularioTarea } from './ModalFormularioTarea';
import { ModalFormularioReunion, type ResultadoGuardadoReunion } from './ModalFormularioReunion';

export type HuecoAgenda = {
  iso: string;
  /** Vacío en «Todo el día». */
  horaInicio: string;
  x: number;
  y: number;
};

type TipoAlta = 'tarea' | 'reunion';

export function AltaHuecoAgenda({
  hueco,
  acceso,
  onCerrar,
  onCreada,
}: {
  hueco: HuecoAgenda;
  acceso: AccesoTasks;
  onCerrar: () => void;
  onCreada: (aviso?: string) => void;
}) {
  const puedeTarea = puedeEditarProyectos(acceso);
  const puedeReunion = puedeGestionarReuniones(acceso);
  const opciones = useMemo(() => {
    const lista: TipoAlta[] = [];
    if (puedeTarea) lista.push('tarea');
    if (puedeReunion) lista.push('reunion');
    return lista;
  }, [puedeTarea, puedeReunion]);

  const [tipo, setTipo] = useState<TipoAlta | null>(opciones.length === 1 ? opciones[0] : null);
  const usuarios = useNombresUsuarios();
  const departamentos = useDepartamentos();

  if (opciones.length === 0) return null;

  const avisoDe = (aviso?: string) => {
    onCreada(aviso);
  };

  if (tipo === 'tarea') {
    return (
      <ModalFormularioTarea
        visible
        modo="crear"
        presentacion="flotante"
        fechaPorDefecto={hueco.iso}
        horaInicioPorDefecto={hueco.horaInicio}
        usuarios={usuarios}
        departamentos={departamentos}
        onCerrar={onCerrar}
        onGuardada={(_tarea: Tarea, extras) => avisoDe(extras?.avisoCalendario)}
      />
    );
  }

  if (tipo === 'reunion') {
    return (
      <ModalFormularioReunion
        visible
        modo="crear"
        presentacion="flotante"
        fechaPorDefecto={hueco.iso}
        horaInicioPorDefecto={hueco.horaInicio}
        usuarios={usuarios}
        departamentos={departamentos}
        onCerrar={onCerrar}
        onGuardado={(resultado: ResultadoGuardadoReunion) => avisoDe(resultado.avisoCalendario)}
      />
    );
  }

  const marco = marcoFichaFlotante(hueco);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable style={styles.overlay} onPress={onCerrar}>
        <View style={[styles.menu, { left: marco.left, top: marco.top }]}>
          {puedeTarea ? (
            <TouchableOpacity style={styles.item} onPress={() => setTipo('tarea')} accessibilityRole="button">
              <MaterialIcons name="check-box" size={18} color={tasksUi.color.textoPrimario} />
              <Text style={styles.texto}>Tarea</Text>
            </TouchableOpacity>
          ) : null}
          {puedeReunion ? (
            <TouchableOpacity style={styles.item} onPress={() => setTipo('reunion')} accessibilityRole="button">
              <MaterialIcons name="event" size={18} color={tasksUi.color.textoPrimario} />
              <Text style={styles.texto}>Reunión</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.12)' },
  menu: {
    position: 'absolute',
    minWidth: 180,
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    overflow: 'hidden',
    ...tasksUi.sombraFlotante,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  texto: { ...tasksUi.tipo.dato, color: tasksUi.color.textoPrimario },
});
