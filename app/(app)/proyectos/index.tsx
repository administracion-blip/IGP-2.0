/**
 * Hub del módulo de dirección.
 *
 * Home de dirección: franja de KPIs accionables (vencidas, proyectos no
 * terminales, acuerdos incumplidos) encima de las HubNavCard existentes.
 * «Mis tareas» sigue primero: el hábito diario de abrir la lista propia.
 * Reuniones no tiene entrada en el menú lateral: se abre desde aquí (D-22).
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { TasksHubKpis, type TasksHubKpiItem } from '../../components/tasks/TasksHubKpis';
import { TasksPageHeader } from '../../components/tasks/TasksPageHeader';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { tasksColor } from '../../constants/tasksUiTokens';
import { puedeVerCuadroMando, puedeVerProyectos, puedeVerReuniones } from '../../lib/tasksAcceso';
import { apiFetch } from '../../utils/api';
import { ESTADOS_PROYECTO, type EstadoProyecto } from '../../types/tasks';

/** Estados que siguen en cartera (excluye cerrado / cancelado). */
const ESTADOS_PROYECTO_NO_TERMINALES = ESTADOS_PROYECTO.filter(
  (e) => e !== 'cerrado' && e !== 'cancelado',
);

type CuadroMandoHub = {
  proyectos?: {
    por_estado?: Partial<Record<EstadoProyecto, number>>;
  };
  acuerdos_incumplidos?: unknown[];
  acuerdos_incumplidos_truncado?: boolean;
  acuerdos_incumplidos_aviso?: string;
};

function sumarNoTerminales(porEstado: Partial<Record<EstadoProyecto, number>> | undefined): number {
  if (!porEstado) return 0;
  let total = 0;
  for (const estado of ESTADOS_PROYECTO_NO_TERMINALES) {
    total += Number(porEstado[estado]) || 0;
  }
  return total;
}

export default function ProyectosHubScreen() {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { isCompact, shouldStackToolbar } = useBreakpoint();
  const { cardWidth, compact } = useHubNavGrid();

  const [vencidas, setVencidas] = useState<number | null>(null);
  const [proyectosActivos, setProyectosActivos] = useState<number | null>(null);
  const [incumplidos, setIncumplidos] = useState<number | null>(null);
  const [incumplidosTruncado, setIncumplidosTruncado] = useState(false);
  const [incumplidosAviso, setIncumplidosAviso] = useState<string | null>(null);

  const puedeVer = puedeVerProyectos(acceso);
  const puedeReuniones = puedeVerReuniones(acceso);
  const puedeCuadro = puedeVerCuadroMando(acceso);
  const puedeEntrar = puedeVer || puedeReuniones || puedeCuadro;

  const cargarKpis = useCallback(async (signal?: { cancelado: boolean }) => {
    const vivo = () => !signal?.cancelado;
    const promesas: Promise<void>[] = [];

    if (puedeVer) {
      promesas.push(
        (async () => {
          try {
            const res = await apiFetch('/api/tareas/mias?limite=1');
            if (!vivo()) return;
            const data = (await res.json().catch(() => ({}))) as { vencidas?: number };
            if (!vivo()) return;
            setVencidas(res.ok ? Number(data.vencidas) || 0 : null);
          } catch (e) {
            if (!vivo()) return;
            console.error('[tasks] no se pudo leer el recuento de tareas vencidas', e);
            setVencidas(null);
          }
        })(),
      );
    } else if (vivo()) {
      setVencidas(null);
    }

    if (puedeCuadro) {
      promesas.push(
        (async () => {
          try {
            const res = await apiFetch('/api/proyectos/cuadro-mando');
            if (!vivo()) return;
            const data = (await res.json().catch(() => ({}))) as CuadroMandoHub;
            if (!vivo()) return;
            if (!res.ok) {
              setProyectosActivos(null);
              setIncumplidos(null);
              setIncumplidosTruncado(false);
              setIncumplidosAviso(null);
              return;
            }
            setProyectosActivos(sumarNoTerminales(data.proyectos?.por_estado));
            const lista = Array.isArray(data.acuerdos_incumplidos) ? data.acuerdos_incumplidos : [];
            setIncumplidos(lista.length);
            setIncumplidosTruncado(Boolean(data.acuerdos_incumplidos_truncado));
            setIncumplidosAviso(
              typeof data.acuerdos_incumplidos_aviso === 'string' && data.acuerdos_incumplidos_aviso
                ? data.acuerdos_incumplidos_aviso
                : data.acuerdos_incumplidos_truncado
                  ? 'Listado truncado; puede haber más'
                  : null,
            );
          } catch (e) {
            if (!vivo()) return;
            console.error('[tasks] no se pudo leer el cuadro de mando del hub', e);
            setProyectosActivos(null);
            setIncumplidos(null);
            setIncumplidosTruncado(false);
            setIncumplidosAviso(null);
          }
        })(),
      );
    } else if (vivo()) {
      setProyectosActivos(null);
      setIncumplidos(null);
      setIncumplidosTruncado(false);
      setIncumplidosAviso(null);
    }

    await Promise.all(promesas);
  }, [puedeVer, puedeCuadro]);

  useFocusEffect(
    useCallback(() => {
      const signal = { cancelado: false };
      void cargarKpis(signal);
      return () => {
        signal.cancelado = true;
      };
    }, [cargarKpis]),
  );

  const kpis: TasksHubKpiItem[] = [];
  if (puedeVer) {
    kpis.push({
      id: 'vencidas',
      valor: vencidas,
      etiqueta: vencidas === 1 ? 'Vencida' : 'Vencidas',
      tono: 'peligro',
      accessibilityLabel:
        vencidas === null
          ? 'Tareas vencidas no disponibles. Abrir mis tareas'
          : vencidas === 1
            ? '1 tarea vencida. Abrir mis tareas'
            : `${vencidas} tareas vencidas. Abrir mis tareas`,
      onPress: () => router.push('/proyectos/mis-tareas' as never),
    });
  }
  if (puedeCuadro) {
    kpis.push({
      id: 'proyectos-activos',
      valor: proyectosActivos,
      etiqueta: 'Proyectos en curso',
      tono: 'normal',
      accessibilityLabel:
        proyectosActivos === null
          ? 'Proyectos en curso no disponibles. Abrir cuadro de mando'
          : `${proyectosActivos} proyectos en curso. Abrir cuadro de mando`,
      onPress: () => router.push('/proyectos/cuadro-mando' as never),
    });
    kpis.push({
      id: 'incumplidos',
      valor: incumplidos,
      etiqueta: incumplidos === 1 ? 'Acuerdo incumplido' : 'Acuerdos incumplidos',
      tono: 'aviso',
      accessibilityLabel:
        incumplidos === null
          ? 'Acuerdos incumplidos no disponibles. Abrir cuadro de mando'
          : `${incumplidos} acuerdos incumplidos${incumplidosTruncado ? ', listado truncado' : ''}. Abrir cuadro de mando`,
      nota: incumplidosTruncado ? incumplidosAviso || 'Listado truncado' : undefined,
      onPress: () => router.push('/proyectos/cuadro-mando' as never),
    });
  }

  if (acceso.permisosCargando) {
    return (
      <View style={styles.centro}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.centroTexto}>Cargando permisos…</Text>
      </View>
    );
  }

  if (!puedeEntrar) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="lock-outline" size={30} color="#94a3b8" />
        <Text style={styles.centroTexto}>No tienes permiso para acceder al módulo de proyectos.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <TasksPageHeader
        title="Proyectos"
        subtitle="Resumen y accesos del módulo de dirección"
        onBack={() => router.push('/' as never)}
        backAccessibilityLabel="Volver al inicio"
        compact={isCompact}
      />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <TasksHubKpis items={kpis} stacked={shouldStackToolbar} />

        <HubNavGrid>
          {puedeVer ? (
            <HubNavCard
              label="Mis tareas"
              description="Lo que tienes abierto, ordenado por vencimiento"
              icon="task-alt"
              accentBg="#e0f2fe"
              accentFg="#0ea5e9"
              width={cardWidth}
              compact={compact}
              badgeCount={vencidas ?? undefined}
              onPress={() => router.push('/proyectos/mis-tareas' as never)}
            />
          ) : null}
          {puedeVer ? (
            <HubNavCard
              label="Proyectos"
              description="Listado, alta y ficha de cada proyecto"
              icon="folder-open"
              accentBg="#dcfce7"
              accentFg="#16a34a"
              width={cardWidth}
              compact={compact}
              onPress={() => router.push('/proyectos/listado' as never)}
            />
          ) : null}
          {puedeVer ? (
            <HubNavCard
              label="Plantillas"
              description="Modelos reutilizables para abrir proyectos con tareas"
              icon="content-copy"
              accentBg="#ede9fe"
              accentFg="#7c3aed"
              width={cardWidth}
              compact={compact}
              onPress={() => router.push('/proyectos/plantillas' as never)}
            />
          ) : null}
          {puedeCuadro ? (
            <HubNavCard
              label="Cuadro de mando"
              description="Estado de proyectos, acuerdos incumplidos y carga"
              icon="analytics"
              accentBg="#fce7f3"
              accentFg="#db2777"
              width={cardWidth}
              compact={compact}
              onPress={() => router.push('/proyectos/cuadro-mando' as never)}
            />
          ) : null}
          {puedeReuniones ? (
            <HubNavCard
              label="Reuniones"
              description="Convocatorias, actas manuales y acuerdos"
              icon="groups"
              accentBg="#fef3c7"
              accentFg="#d97706"
              width={cardWidth}
              compact={compact}
              onPress={() => router.push('/reuniones' as never)}
            />
          ) : null}
        </HubNavGrid>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: tasksColor.fondoApp },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
});
