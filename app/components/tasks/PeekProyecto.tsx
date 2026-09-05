/**
 * Panel lateral de vistazo (peek) sobre un proyecto del listado.
 *
 * No sustituye la ficha ni el `ModalVistazoProyecto` (calendario / Mis tareas):
 * resume la fila ya cargada, refresca cabecera en segundo plano y ofrece CTA
 * «Abrir ficha» / «Editar».
 */
import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import {
  tasksColor,
  tasksIcono,
  tasksRadius,
  tasksSpace,
  tasksSombraFlotante,
  tasksTabularNums,
  tasksTipo,
} from '../../constants/tasksUiTokens';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { nombreUsuario } from '../../lib/tasksUi';
import { formatFecha } from '../../utils/formatFecha';
import { apiFetch } from '../../utils/api';
import type { Proyecto } from '../../types/tasks';
import { BadgeEstadoProyecto, BadgePrioridad } from './BadgesTasks';

const ANCHO_PEEK = 360;

export function PeekProyecto({
  proyecto,
  nombreDepartamento,
  onCerrar,
  onAbrirFicha,
  onEditar,
  width = ANCHO_PEEK,
  stacked = false,
  style,
}: {
  /** Fila seleccionada; `null` → tip de vacío (solo en layout lado a lado). */
  proyecto: Proyecto | null;
  nombreDepartamento: (id?: string | null) => string;
  onCerrar: () => void;
  onAbrirFicha: (proyecto: Proyecto) => void;
  onEditar?: (proyecto: Proyecto) => void;
  width?: number;
  /** En apilado el panel ocupa el ancho completo bajo la tabla. */
  stacked?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { isCompact } = useBreakpoint();
  const [detalle, setDetalle] = useState<Proyecto | null>(null);
  const [refrescando, setRefrescando] = useState(false);

  const id = proyecto?.id_proyecto ?? null;

  useEffect(() => {
    if (!id) {
      setDetalle(null);
      setRefrescando(false);
      return;
    }
    let cancelado = false;
    setDetalle(null);
    setRefrescando(true);
    apiFetch(`/api/proyectos/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          proyecto?: Proyecto;
        };
        if (cancelado) return;
        if (res.ok && data.proyecto) setDetalle(data.proyecto);
      })
      .catch((e) => {
        if (cancelado) return;
        console.error('[tasks] fallo al refrescar peek del proyecto', e);
      })
      .finally(() => {
        if (!cancelado) setRefrescando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [id]);

  // Datos de fila al instante; el detalle mejora cabecera si llega.
  const visible = detalle && detalle.id_proyecto === id ? { ...proyecto!, ...detalle } : proyecto;

  if (!visible) {
    return (
      <View
        style={[
          styles.panel,
          tasksSombraFlotante,
          stacked ? styles.panelStacked : { width },
          styles.panelVacio,
          style,
        ]}
        accessibilityLabel="Vistazo de proyecto"
      >
        <MaterialIcons name="touch-app" size={28} color={tasksColor.textoTerciario} />
        <Text style={styles.tipTitulo}>Selecciona un proyecto</Text>
        <Text style={styles.tipTexto}>
          Pulsa una fila del listado para ver aquí un resumen rápido.
        </Text>
      </View>
    );
  }

  const dpto = visible.departamento_id
    ? nombreDepartamento(visible.departamento_id)
    : '—';
  const responsable = nombreUsuario(visible.responsable_id, visible.responsable_nombre);
  const inicio = formatFecha(visible.fecha_inicio);
  const fin = formatFecha(visible.fecha_fin_prevista);
  const puedeEditar = Boolean(visible.permisos_fila?.editar && onEditar);

  return (
    <View
      style={[
        styles.panel,
        tasksSombraFlotante,
        stacked ? styles.panelStacked : { width },
        style,
      ]}
      accessibilityLabel={`Vistazo: ${visible.nombre}`}
    >
      <View style={styles.cabecera}>
        <View style={styles.cabeceraTexto}>
          <Text style={styles.titulo} numberOfLines={2}>
            {visible.nombre || 'Proyecto'}
          </Text>
          {refrescando ? (
            <ActivityIndicator size="small" color={tasksColor.acento} style={styles.spinner} />
          ) : null}
        </View>
        <TouchableOpacity
          style={[styles.cerrar, isCompact && styles.cerrarTactil]}
          onPress={onCerrar}
          accessibilityLabel="Cerrar vistazo"
        >
          <MaterialIcons name="close" size={20} color={tasksColor.textoSecundario} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.cuerpo} contentContainerStyle={styles.cuerpoContent}>
        <View style={styles.badges}>
          <BadgeEstadoProyecto estado={visible.estado} />
          {visible.prioridad ? <BadgePrioridad prioridad={visible.prioridad} /> : null}
        </View>

        <Campo etiqueta="Departamento" valor={dpto} />
        <Campo etiqueta="Responsable" valor={responsable} />
        <Campo
          etiqueta="Fechas"
          valor={`${inicio} → ${fin}`}
          tabular
        />

        {visible.descripcion?.trim() ? (
          <View style={styles.campo}>
            <Text style={styles.etiqueta}>Descripción</Text>
            <Text style={styles.descripcion} numberOfLines={4}>
              {visible.descripcion.trim()}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.pie}>
        {puedeEditar ? (
          <TouchableOpacity
            style={[styles.btnSecundario, isCompact && styles.btnTactil]}
            onPress={() => onEditar?.(visible)}
            accessibilityLabel="Editar proyecto"
          >
            <MaterialIcons name="edit" size={tasksIcono.sizeSm} color={tasksColor.textoSecundario} />
            <Text style={styles.btnSecundarioTexto}>Editar</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.btnPrimario, isCompact && styles.btnTactil, !puedeEditar && styles.btnAncho]}
          onPress={() => onAbrirFicha(visible)}
          accessibilityLabel="Abrir ficha del proyecto"
        >
          <MaterialIcons name="open-in-new" size={tasksIcono.sizeSm} color={tasksColor.textoInverso} />
          <Text style={styles.btnPrimarioTexto}>Abrir ficha</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Campo({
  etiqueta,
  valor,
  tabular,
}: {
  etiqueta: string;
  valor: string;
  tabular?: boolean;
}) {
  return (
    <View style={styles.campo}>
      <Text style={styles.etiqueta}>{etiqueta}</Text>
      <Text style={[styles.valor, tabular && tasksTabularNums]} numberOfLines={2}>
        {valor}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: tasksColor.superficie,
    borderRadius: tasksRadius.contenedor,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    overflow: 'hidden',
    minHeight: 0,
    flexShrink: 0,
  },
  panelStacked: {
    width: '100%',
    maxHeight: 320,
    marginTop: tasksSpace[2],
  },
  panelVacio: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: tasksSpace[5],
    gap: tasksSpace[2],
  },
  tipTitulo: {
    ...tasksTipo.tituloSeccion,
    textAlign: 'center',
  },
  tipTexto: {
    ...tasksTipo.micro,
    textAlign: 'center',
    maxWidth: 220,
  },

  cabecera: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: tasksSpace[2],
    paddingHorizontal: tasksSpace[4],
    paddingVertical: tasksSpace[3],
    borderBottomWidth: 1,
    borderBottomColor: tasksColor.bordeSutil,
  },
  cabeceraTexto: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: tasksSpace[2] },
  titulo: { ...tasksTipo.tituloSeccion, flex: 1, minWidth: 0 },
  spinner: { marginTop: 2 },
  cerrar: {
    padding: tasksSpace[1],
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cerrarTactil: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH },

  cuerpo: { flex: 1, minHeight: 0 },
  cuerpoContent: {
    paddingHorizontal: tasksSpace[4],
    paddingVertical: tasksSpace[3],
    gap: tasksSpace[3],
    flexGrow: 1,
  },
  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: tasksSpace[2] },

  campo: { gap: 2 },
  etiqueta: { ...tasksTipo.etiqueta },
  valor: { ...tasksTipo.dato },
  descripcion: { ...tasksTipo.cuerpo },

  pie: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tasksSpace[2],
    paddingHorizontal: tasksSpace[4],
    paddingVertical: tasksSpace[3],
    borderTopWidth: 1,
    borderTopColor: tasksColor.bordeSutil,
  },
  btnPrimario: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tasksSpace[1],
    paddingVertical: tasksSpace[2],
    paddingHorizontal: tasksSpace[3],
    borderRadius: tasksRadius.control,
    backgroundColor: tasksColor.acento,
  },
  btnAncho: { flex: 1 },
  btnPrimarioTexto: {
    fontSize: 13,
    fontWeight: '600',
    color: tasksColor.textoInverso,
  },
  btnSecundario: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tasksSpace[1],
    paddingVertical: tasksSpace[2],
    paddingHorizontal: tasksSpace[3],
    borderRadius: tasksRadius.control,
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    backgroundColor: tasksColor.superficieHundida,
  },
  btnSecundarioTexto: {
    fontSize: 13,
    fontWeight: '500',
    color: tasksColor.textoSecundario,
  },
  btnTactil: { minHeight: MIN_TOUCH },
});
