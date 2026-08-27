/**
 * Calendario de «Mis tareas»: semana con pastillas o mes con puntos.
 *
 * Cada tarea cae en su `fecha_limite`. Las que no tienen vencimiento van al
 * cajón de abajo. El color es el departamento (paleta fija: el maestro no
 * guarda color).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { hoyIso } from '../../lib/tasksUi';
import {
  agruparPorFechaLimite,
  celdasCalendarioMes,
  diaNumero,
  diasDeSemana,
  inicioMesIso,
  lunesDeSemanaIso,
  tareasSinFecha,
  weekdayHeaderEs,
  weekdayUltraEs,
} from '../../lib/tasksCalendario';
import { colorDepartamento } from '../../lib/tasksDepartamentoColor';
import { PastillaTareaCalendario } from './PastillaTareaCalendario';
import type { Tarea } from '../../types/tasks';

const COL_MIN = 132;
const MAX_PUNTOS = 3;

export function LeyendaDepartamentos({
  tareas,
  nombreDepartamento,
}: {
  tareas: Tarea[];
  nombreDepartamento: (id?: string | null) => string;
}) {
  const items = useMemo(() => {
    const map = new Map<string, number>();
    let sin = 0;
    for (const t of tareas) {
      const id = (t.departamento_id ?? '').trim();
      if (!id) {
        sin += 1;
        continue;
      }
      map.set(id, (map.get(id) ?? 0) + 1);
    }
    const lista = [...map.entries()]
      .map(([id]) => ({
        id,
        nombre: nombreDepartamento(id),
        color: colorDepartamento(id),
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return { lista, sin };
  }, [tareas, nombreDepartamento]);

  if (items.lista.length === 0 && items.sin === 0) return null;

  return (
    <View style={styles.leyenda}>
      {items.lista.map((d) => (
        <View key={d.id} style={styles.leyendaItem}>
          <View style={[styles.leyendaPunto, { backgroundColor: d.color }]} />
          <Text style={styles.leyendaTexto}>{d.nombre}</Text>
        </View>
      ))}
      {items.sin > 0 ? (
        <View style={styles.leyendaItem}>
          <View style={[styles.leyendaPunto, { backgroundColor: '#94a3b8' }]} />
          <Text style={styles.leyendaTexto}>Sin departamento</Text>
        </View>
      ) : null}
    </View>
  );
}

export function CalendarioMisTareas({
  modo,
  ancla,
  tareas,
  nombreDepartamento,
  onAbrirTarea,
  onAbrirProyecto,
}: {
  modo: 'semana' | 'mes';
  /** Día ISO que ancla la semana o el mes visibles. Lo controla la barra de rango. */
  ancla: string;
  tareas: Tarea[];
  nombreDepartamento: (id?: string | null) => string;
  onAbrirTarea: (tarea: Tarea) => void;
  onAbrirProyecto: (tarea: Tarea) => void;
}) {
  const { isPhone, isPortrait } = useBreakpoint();
  const [diaSeleccionado, setDiaSeleccionado] = useState<string | null>(null);

  const hoy = hoyIso();
  const mesVisible = inicioMesIso(ancla);
  const porDia = useMemo(() => agruparPorFechaLimite(tareas), [tareas]);
  const sinFecha = useMemo(() => tareasSinFecha(tareas), [tareas]);

  useEffect(() => {
    if (modo !== 'mes') return;
    if (diaSeleccionado && diaSeleccionado.slice(0, 7) !== mesVisible.slice(0, 7)) {
      setDiaSeleccionado(null);
    }
  }, [modo, mesVisible, diaSeleccionado]);

  const semanas = useMemo(() => {
    const celdas = celdasCalendarioMes(ancla);
    const filas: { iso: string; delMes: boolean }[][] = [];
    for (let i = 0; i < celdas.length; i += 7) {
      filas.push(celdas.slice(i, i + 7));
    }
    return filas;
  }, [ancla]);

  const pastilla = (tarea: Tarea, compacta = false) => (
    <PastillaTareaCalendario
      key={tarea.id_tarea}
      tarea={tarea}
      nombreDepartamento={nombreDepartamento}
      compacta={compacta}
      onAbrirTarea={() => onAbrirTarea(tarea)}
      onAbrirProyecto={tarea.proyecto_id ? () => onAbrirProyecto(tarea) : undefined}
    />
  );

  return (
    <View style={styles.wrap}>
      {modo === 'semana' ? (
        <ScrollView
          horizontal={isPhone && isPortrait}
          style={styles.semanaScroll}
          contentContainerStyle={[
            styles.semanaFila,
            isPhone && isPortrait && styles.semanaFilaMovil,
          ]}
        >
          {diasDeSemana(lunesDeSemanaIso(ancla)).map((iso) => {
            const delDia = porDia.get(iso) ?? [];
            const esHoy = iso === hoy;
            return (
              <View
                key={iso}
                style={[styles.col, isPhone && isPortrait && styles.colMovil, esHoy && styles.colHoy]}
              >
                <View style={styles.colHeader}>
                  <Text style={[styles.colDia, esHoy && styles.colDiaHoy]}>{weekdayHeaderEs(iso)}</Text>
                  {esHoy ? <Text style={styles.badgeHoy}>Hoy</Text> : null}
                  {delDia.length > 0 ? (
                    <Text style={styles.colCount}>{delDia.length}</Text>
                  ) : null}
                </View>
                <ScrollView
                  style={styles.colLista}
                  contentContainerStyle={styles.colListaContent}
                  nestedScrollEnabled
                >
                  {delDia.map((t) => pastilla(t))}
                </ScrollView>
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <View style={styles.mesWrap}>
          <View style={styles.mesCabecera}>
            {diasDeSemana(lunesDeSemanaIso(hoy)).map((iso) => (
              <Text key={iso} style={styles.mesDow}>
                {weekdayUltraEs(iso)}
              </Text>
            ))}
          </View>
          <View style={styles.mesMarco}>
            {semanas.map((fila, iFila) => (
              <View
                key={fila[0]?.iso ?? iFila}
                style={[styles.mesFila, iFila === semanas.length - 1 && styles.mesFilaUltima]}
              >
                {fila.map(({ iso, delMes }, iCol) => {
                  const delDia = porDia.get(iso) ?? [];
                  const colores = [...new Set(delDia.map((t) => colorDepartamento(t.departamento_id)))];
                  const visibles = colores.slice(0, MAX_PUNTOS);
                  const extra = colores.length - visibles.length;
                  const esHoy = iso === hoy;
                  const seleccionado = iso === diaSeleccionado;
                  return (
                    <TouchableOpacity
                      key={iso}
                      style={[
                        styles.celda,
                        iCol === fila.length - 1 && styles.celdaUltima,
                        !delMes && styles.celdaFuera,
                        esHoy && styles.celdaHoy,
                        seleccionado && styles.celdaSel,
                      ]}
                      onPress={() => setDiaSeleccionado(seleccionado ? null : iso)}
                      accessibilityLabel={`${weekdayHeaderEs(iso)}, ${delDia.length} tareas`}
                    >
                      <Text style={[styles.celdaNum, esHoy && styles.celdaNumHoy, !delMes && styles.celdaNumFuera]}>
                        {diaNumero(iso)}
                      </Text>
                      <View style={styles.puntos}>
                        {visibles.map((c) => (
                          <View key={c} style={[styles.punto, { backgroundColor: c }]} />
                        ))}
                        {extra > 0 ? <Text style={styles.masPuntos}>+{extra}</Text> : null}
                      </View>
                      {delDia.length > 0 ? <Text style={styles.celdaCount}>·{delDia.length}</Text> : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </View>

          {diaSeleccionado ? (
            <View style={styles.diaOverlay} pointerEvents="box-none">
              <View style={styles.diaPanel}>
                <View style={styles.diaPanelHeader}>
                  <Text style={styles.diaPanelTitulo}>
                    {weekdayHeaderEs(diaSeleccionado)}
                    {diaSeleccionado === hoy ? ' · Hoy' : ''}
                  </Text>
                  <TouchableOpacity onPress={() => setDiaSeleccionado(null)} accessibilityLabel="Cerrar">
                    <Text style={styles.diaCerrar}>Cerrar</Text>
                  </TouchableOpacity>
                </View>
                {(porDia.get(diaSeleccionado) ?? []).length === 0 ? (
                  <Text style={styles.vacioDia}>No hay tareas este día.</Text>
                ) : (
                  <ScrollView style={styles.diaListaScroll} contentContainerStyle={styles.diaLista}>
                    {(porDia.get(diaSeleccionado) ?? []).map((t) => pastilla(t))}
                  </ScrollView>
                )}
              </View>
            </View>
          ) : null}
        </View>
      )}

      {sinFecha.length > 0 ? (
        <View style={styles.cajon}>
          <Text style={styles.cajonTitulo}>Sin fecha ({sinFecha.length})</Text>
          <ScrollView
            horizontal
            contentContainerStyle={styles.cajonLista}
            showsHorizontalScrollIndicator={false}
          >
            {sinFecha.map((t) => (
              <View key={t.id_tarea} style={styles.cajonItem}>
                {pastilla(t, true)}
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 0, gap: 10 },
  semanaScroll: { flex: 1, minHeight: 0 },
  semanaFila: { flex: 1, flexDirection: 'row', gap: 6, minHeight: 280 },
  semanaFilaMovil: { flex: 0, paddingRight: 8 },
  col: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  colMovil: { width: COL_MIN, flex: 0 },
  colHoy: { borderColor: '#7dd3fc', backgroundColor: '#f0f9ff' },
  colHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  colDia: { fontSize: 11, fontWeight: '800', color: '#64748b', letterSpacing: 0.3 },
  colDiaHoy: { color: '#0369a1' },
  badgeHoy: { fontSize: 10, fontWeight: '800', color: '#0284c7' },
  colCount: { marginLeft: 'auto', fontSize: 11, fontWeight: '700', color: '#94a3b8' },
  colLista: { flex: 1, minHeight: 0 },
  colListaContent: { padding: 6, gap: 6 },

  mesWrap: { flex: 1, minHeight: 0, position: 'relative' },
  mesCabecera: { flexDirection: 'row', paddingBottom: 6 },
  mesDow: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '800',
    color: '#94a3b8',
    letterSpacing: 0.4,
  },
  mesMarco: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
  },
  mesFila: {
    flex: 1,
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  mesFilaUltima: { borderBottomWidth: 0 },
  celda: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 4,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  celdaUltima: { borderRightWidth: 0 },
  celdaFuera: { backgroundColor: '#f8fafc' },
  celdaHoy: { backgroundColor: '#e0f2fe' },
  celdaSel: { backgroundColor: '#f0f9ff' },
  celdaNum: { fontSize: 13, fontWeight: '700', color: '#334155' },
  celdaNumHoy: { color: '#0369a1' },
  celdaNumFuera: { color: '#94a3b8' },
  puntos: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 8 },
  punto: { width: 7, height: 7, borderRadius: 4 },
  masPuntos: { fontSize: 9, fontWeight: '700', color: '#64748b' },
  celdaCount: { fontSize: 10, fontWeight: '700', color: '#64748b' },
  diaOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    maxHeight: '42%',
  },
  diaPanel: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  diaPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  diaPanelTitulo: { fontSize: 13, fontWeight: '800', color: '#0f172a', textTransform: 'uppercase' },
  diaCerrar: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  diaListaScroll: { maxHeight: 180 },
  diaLista: { gap: 6 },
  vacioDia: { fontSize: 13, color: '#64748b' },

  cajon: { gap: 6 },
  cajonTitulo: { fontSize: 12, fontWeight: '800', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 },
  cajonLista: { gap: 8, paddingBottom: 4 },
  cajonItem: { width: 220 },

  leyenda: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  leyendaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  leyendaPunto: { width: 8, height: 8, borderRadius: 4 },
  leyendaTexto: { fontSize: 12, color: '#475569' },
});
