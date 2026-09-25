/**
 * Alta rápida desde la agenda del inicio: mismo formulario de tarea / proyecto /
 * reunión, sin navegar al módulo. Los maestros de usuarios y departamentos solo
 * se piden al abrir el modal (`GET /api/usuarios` exige `usuarios.ver`).
 */
import { useMemo, useState, type ComponentProps } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { tasksUi } from '../../constants/tasksUiTokens';
import { useNombresUsuarios } from '../../hooks/useNombresUsuarios';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import {
  puedeCrearProyectos,
  puedeEditarProyectos,
  puedeGestionarReuniones,
  puedeVerPresupuesto,
  type AccesoTasks,
} from '../../lib/tasksAcceso';
import { ModalFormularioTarea } from './ModalFormularioTarea';
import { ModalFormularioProyecto } from './ModalFormularioProyecto';
import {
  ModalFormularioReunion,
  type ResultadoGuardadoReunion,
} from './ModalFormularioReunion';
import type { Tarea } from '../../types/tasks';

type TipoCrearAgenda = 'tarea' | 'proyecto' | 'reunion';

const OPCIONES: Array<{
  tipo: TipoCrearAgenda;
  etiqueta: string;
  icono: ComponentProps<typeof MaterialIcons>['name'];
}> = [
  { tipo: 'tarea', etiqueta: 'Tarea', icono: 'check-box' },
  { tipo: 'proyecto', etiqueta: 'Proyecto', icono: 'folder' },
  { tipo: 'reunion', etiqueta: 'Reunión', icono: 'event' },
];

export function BotonCrearAgendaInicio({
  acceso,
  compact,
  menuAbierto,
  onMenuCambio,
  onRecargar,
  onAvisoCalendario,
}: {
  acceso: AccesoTasks;
  compact?: boolean;
  menuAbierto: boolean;
  onMenuCambio: (abierto: boolean) => void;
  onRecargar: () => void;
  onAvisoCalendario: (aviso: string | null) => void;
}) {
  const [modal, setModal] = useState<TipoCrearAgenda | null>(null);

  const opciones = useMemo(
    () =>
      OPCIONES.filter((o) => {
        if (o.tipo === 'tarea') return puedeEditarProyectos(acceso);
        if (o.tipo === 'proyecto') return puedeCrearProyectos(acceso);
        return puedeGestionarReuniones(acceso);
      }),
    [acceso],
  );

  if (opciones.length === 0) return null;

  const abrir = (tipo: TipoCrearAgenda) => {
    onMenuCambio(false);
    setModal(tipo);
  };

  const onCrear = () => {
    if (opciones.length === 1) {
      abrir(opciones[0].tipo);
      return;
    }
    onMenuCambio(!menuAbierto);
  };

  const cerrarModal = () => setModal(null);

  const trasGuardar = (extras?: { avisoCalendario?: string }) => {
    setModal(null);
    onRecargar();
    if (extras?.avisoCalendario) onAvisoCalendario(extras.avisoCalendario);
    else onAvisoCalendario(null);
  };

  const trasGuardarReunion = (resultado: ResultadoGuardadoReunion) => {
    setModal(null);
    onRecargar();
    if (resultado.avisoCalendario) onAvisoCalendario(resultado.avisoCalendario);
    else if (resultado.calendarioSincronizado === false) {
      onAvisoCalendario('La reunión se guardó, pero no se pudo sincronizar con Google Calendar.');
    } else {
      onAvisoCalendario(null);
    }
  };

  return (
    <>
      <View style={styles.ancla}>
        <TouchableOpacity
          style={[styles.crearBtn, compact && styles.crearBtnTactil]}
          onPress={onCrear}
          accessibilityLabel="Crear"
          accessibilityState={{ expanded: opciones.length > 1 ? menuAbierto : undefined }}
        >
          <MaterialIcons name="add" size={18} color={tasksUi.color.textoInverso} />
          <Text style={styles.crearTexto}>Crear</Text>
        </TouchableOpacity>

        {menuAbierto && opciones.length > 1 ? (
          <View style={styles.menu}>
            {opciones.map((o, i) => (
              <TouchableOpacity
                key={o.tipo}
                style={[
                  styles.menuItem,
                  compact && styles.menuItemTactil,
                  i === opciones.length - 1 && styles.menuItemUltimo,
                ]}
                onPress={() => abrir(o.tipo)}
                accessibilityLabel={o.etiqueta}
              >
                <MaterialIcons name={o.icono} size={18} color={tasksUi.color.textoSecundario} />
                <Text style={styles.menuTexto}>{o.etiqueta}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </View>

      {modal === 'tarea' ? (
        <ModalTareaConMaestros
          responsablePorDefecto={acceso.usuarioId}
          onCerrar={cerrarModal}
          onGuardada={(_tarea, extras) => trasGuardar(extras)}
        />
      ) : null}
      {modal === 'proyecto' ? (
        <ModalProyectoConMaestros
          puedeVerPresupuesto={puedeVerPresupuesto(acceso)}
          onCerrar={cerrarModal}
          onGuardado={() => trasGuardar()}
        />
      ) : null}
      {modal === 'reunion' ? (
        <ModalReunionConMaestros onCerrar={cerrarModal} onGuardado={trasGuardarReunion} />
      ) : null}
    </>
  );
}

function ModalTareaConMaestros({
  responsablePorDefecto,
  onCerrar,
  onGuardada,
}: {
  responsablePorDefecto: string;
  onCerrar: () => void;
  onGuardada: (tarea: Tarea, extras?: { avisoCalendario?: string }) => void;
}) {
  const usuarios = useNombresUsuarios();
  const departamentos = useDepartamentos();
  return (
    <ModalFormularioTarea
      visible
      modo="crear"
      responsablePorDefecto={responsablePorDefecto}
      usuarios={usuarios}
      departamentos={departamentos}
      onCerrar={onCerrar}
      onGuardada={onGuardada}
    />
  );
}

function ModalProyectoConMaestros({
  puedeVerPresupuesto: verPresupuesto,
  onCerrar,
  onGuardado,
}: {
  puedeVerPresupuesto: boolean;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const usuarios = useNombresUsuarios();
  const departamentos = useDepartamentos();
  return (
    <ModalFormularioProyecto
      visible
      modo="crear"
      puedeVerPresupuesto={verPresupuesto}
      usuarios={usuarios}
      departamentos={departamentos}
      onCerrar={onCerrar}
      onGuardado={onGuardado}
    />
  );
}

function ModalReunionConMaestros({
  onCerrar,
  onGuardado,
}: {
  onCerrar: () => void;
  onGuardado: (resultado: ResultadoGuardadoReunion) => void;
}) {
  const usuarios = useNombresUsuarios();
  const departamentos = useDepartamentos();
  return (
    <ModalFormularioReunion
      visible
      modo="crear"
      usuarios={usuarios}
      departamentos={departamentos}
      onCerrar={onCerrar}
      onGuardado={onGuardado}
    />
  );
}

const styles = StyleSheet.create({
  ancla: { position: 'relative', zIndex: 31, flexShrink: 0 },
  crearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: tasksUi.color.acento,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: tasksUi.radius.control,
  },
  crearBtnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 14 },
  crearTexto: { ...tasksUi.tipo.dato, fontWeight: '700', color: tasksUi.color.textoInverso },
  menu: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 4,
    minWidth: 168,
    backgroundColor: tasksUi.color.superficie,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeFuerte,
    borderRadius: tasksUi.radius.contenedor,
    overflow: 'hidden',
    zIndex: 32,
    ...tasksUi.sombraFlotante,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }
      : { elevation: 12 }),
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: tasksUi.color.bordeSutil,
  },
  menuItemTactil: { minHeight: MIN_TOUCH },
  menuItemUltimo: { borderBottomWidth: 0 },
  menuTexto: { ...tasksUi.tipo.dato, color: tasksUi.color.textoPrimario },
});
