/**
 * Historial de actividad de un proyecto o de una tarea, paginado.
 *
 * El autor se pinta con el nombre que ya resolvió el backend (`usuario_nombre`)
 * y, si falta, con el que resuelva la pantalla: nunca el identificador.
 *
 * `modo="embebido"`: solo la lista (p. ej. dentro de un modal), sin `SeccionFicha`.
 */
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { formatCreadoEn } from '../../utils/formatFecha';
import { etiquetaAccionActividad, resumirDetalleActividad } from '../../lib/tasksUi';
import { SeccionFicha } from './SeccionFicha';
import type { ActividadPaginada } from '../../hooks/useActividadTasks';

function ListaHistorial({
  actividad,
  nombrePorId,
}: {
  actividad: ActividadPaginada;
  nombrePorId: (id?: string | null) => string;
}) {
  const { isCompact } = useBreakpoint();
  const { entradas, cargandoMas, error, hayMas, cargarMas } = actividad;

  return (
    <View style={styles.lista}>
      {entradas.map((entrada, indice) => {
        const autor = entrada.usuario_nombre?.trim() || nombrePorId(entrada.usuario_id);
        const lineas = resumirDetalleActividad(entrada.detalle);
        return (
          <View key={`${entrada.creado_en}-${indice}`} style={styles.entrada}>
            <View style={styles.punto} />
            <View style={styles.entradaCuerpo}>
              <Text style={styles.accion}>{etiquetaAccionActividad(entrada.accion)}</Text>
              <Text style={styles.autor}>
                {autor} · {formatCreadoEn(entrada.creado_en)}
              </Text>
              {lineas.map((linea, i) => (
                <Text key={i} style={styles.detalle}>
                  {linea}
                </Text>
              ))}
            </View>
          </View>
        );
      })}

      {error ? <Text style={styles.errorPie}>{error}</Text> : null}

      {hayMas ? (
        <TouchableOpacity
          style={[styles.masBtn, isCompact && styles.masBtnTactil]}
          onPress={cargarMas}
          disabled={cargandoMas}
        >
          {cargandoMas ? (
            <ActivityIndicator size="small" color="#0ea5e9" />
          ) : (
            <>
              <MaterialIcons name="expand-more" size={16} color="#0ea5e9" />
              <Text style={styles.masTexto}>Ver más movimientos</Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function HistorialActividad({
  actividad,
  nombrePorId,
  modo = 'seccion',
}: {
  actividad: ActividadPaginada;
  nombrePorId: (id?: string | null) => string;
  /** `embebido`: lista suelta sin tarjeta de sección (modal). */
  modo?: 'seccion' | 'embebido';
}) {
  const { entradas, cargando, error, recargar } = actividad;

  if (modo === 'embebido') {
    if (cargando && entradas.length === 0) {
      return (
        <View style={styles.centro}>
          <ActivityIndicator size="small" color="#0ea5e9" />
        </View>
      );
    }
    if (entradas.length === 0 && error) {
      return (
        <View style={styles.centro}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.reintentar} onPress={recargar}>
            <MaterialIcons name="refresh" size={16} color="#0ea5e9" />
            <Text style={styles.reintentarTexto}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (entradas.length === 0) {
      return <Text style={styles.vacio}>Todavía no hay movimientos registrados.</Text>;
    }
    return <ListaHistorial actividad={actividad} nombrePorId={nombrePorId} />;
  }

  return (
    <SeccionFicha
      titulo="Historial"
      icono="history"
      cargando={cargando && entradas.length === 0}
      error={entradas.length === 0 ? error : null}
      onReintentar={recargar}
      vacio="Todavía no hay movimientos registrados."
    >
      {entradas.length > 0 ? (
        <ListaHistorial actividad={actividad} nombrePorId={nombrePorId} />
      ) : null}
    </SeccionFicha>
  );
}

const styles = StyleSheet.create({
  centro: { alignItems: 'center', gap: 8, paddingVertical: 16 },
  error: { fontSize: 12, color: '#ef4444', textAlign: 'center' },
  reintentar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reintentarTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  vacio: { fontSize: 12, color: '#94a3b8', paddingVertical: 6, lineHeight: 18 },
  lista: { gap: 10 },
  entrada: { flexDirection: 'row', gap: 8 },
  punto: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#cbd5e1',
    marginTop: 5,
    flexShrink: 0,
  },
  entradaCuerpo: { flex: 1, minWidth: 0, gap: 2 },
  accion: { fontSize: 13, fontWeight: '600', color: '#334155' },
  autor: { fontSize: 11, color: '#94a3b8' },
  detalle: { fontSize: 12, color: '#64748b', lineHeight: 17 },
  errorPie: { fontSize: 11, color: '#ef4444' },
  masBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  masBtnTactil: { minHeight: MIN_TOUCH },
  masTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
});
