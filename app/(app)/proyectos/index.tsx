/**
 * Hub del módulo de dirección.
 *
 * «Mis tareas» va primero y con el contador de vencidas a la vista: el objetivo
 * de esta fase no es la funcionalidad, es el hábito de abrir la lista propia
 * todos los días. Reuniones no tiene entrada en el menú lateral: se abre desde
 * aquí (D-22).
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { puedeVerProyectos, puedeVerReuniones } from '../../lib/tasksAcceso';
import { apiFetch } from '../../utils/api';

export default function ProyectosHubScreen() {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { cardWidth, compact } = useHubNavGrid();
  const [vencidas, setVencidas] = useState(0);

  const puedeVer = puedeVerProyectos(acceso);
  const puedeReuniones = puedeVerReuniones(acceso);
  const puedeEntrar = puedeVer || puedeReuniones;

  // Solo el recuento: se pide una tarea porque `vencidas` viene en la misma
  // respuesta que la primera página de la vista personal.
  const cargarVencidas = useCallback(async () => {
    if (!puedeVer) {
      setVencidas(0);
      return;
    }
    try {
      const res = await apiFetch('/api/tareas/mias?limite=1');
      const data = (await res.json().catch(() => ({}))) as { vencidas?: number };
      setVencidas(res.ok ? Number(data.vencidas) || 0 : 0);
    } catch (e) {
      console.error('[tasks] no se pudo leer el recuento de tareas vencidas', e);
      setVencidas(0);
    }
  }, [puedeVer]);

  useFocusEffect(
    useCallback(() => {
      void cargarVencidas();
    }, [cargarVencidas]),
  );

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
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={styles.headerTexto}>
          <Text style={styles.title}>Proyectos</Text>
          <Text style={styles.subtitle}>
            Proyectos, tareas y reuniones internas del grupo
          </Text>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
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
              badgeCount={vencidas}
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
  container: { flex: 1, padding: 16, backgroundColor: '#ffffff' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 },
  headerTexto: { flex: 1, minWidth: 0 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 2 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
});
