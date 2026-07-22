import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { hubTileSideSize } from '../../constants/layout';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';
import { abrirEnlaceExterno } from '../../utils/enlaceExterno';
import {
  type EnlacePlanning,
  enlacesDesdeItemAjuste,
  enlacePlanningVisible,
  iconoEnlaceValido,
} from '../../lib/planningEnlaces';
import HubTile from '../../components/HubTile';
import { ObjetivoMensualCard } from '../../components/ObjetivoMensualCard';
import {
  puedeVerActuacionesPlanning,
  puedeVerActivacionesPlanning,
  puedeVerArqueoCaja,
} from '../../lib/permisosModulos';

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

type TarjetaInterna = {
  id: string;
  label: string;
  descripcion: string;
  icon: IconName;
  ruta: string;
  permiso: string;
  variant?: 'default' | 'accent';
};

const TARJETAS_INTERNAS: TarjetaInterna[] = [
  {
    id: 'cuadrante',
    label: 'Cuadrante de personal',
    descripcion: 'Turnos vs fichajes (Factorial HR) por local y fechas',
    icon: 'groups',
    ruta: '/planning-dia/cuadrante',
    permiso: 'planning_dia.ver',
  },
  {
    id: 'almacen',
    label: 'Preparar pedidos',
    descripcion: 'Almacén: preparar los pedidos enviados por los locales',
    icon: 'inventory-2',
    ruta: '/compras/almacen',
    permiso: 'pedidos.preparar',
    variant: 'accent',
  },
  {
    id: 'actuaciones',
    label: 'Actuaciones del día',
    descripcion: 'Músicos del día, firma, observaciones y valoración',
    icon: 'mic',
    ruta: '/planning-dia/actuaciones',
    permiso: 'actuaciones.ver',
  },
  {
    id: 'arqueo-caja',
    label: 'Arqueo de Caja',
    descripcion: 'Cuadrar y cerrar caja al final del día',
    icon: 'account-balance-wallet',
    ruta: '/cajas/arqueo-caja',
    permiso: 'cierres.ver',
  },
  {
    id: 'activaciones',
    label: 'Activaciones del día',
    descripcion: 'Campañas de marca programadas para hoy en tu local',
    icon: 'celebration',
    ruta: '/planning-dia/activaciones-dia',
    permiso: 'activaciones.ver',
  },
  {
    id: 'limpieza',
    label: 'Limpieza de hoy',
    descripcion: 'Checklist de limpieza pendiente por local con foto y firma',
    icon: 'cleaning-services',
    ruta: '/mantenimiento/limpieza/registros',
    permiso: 'limpieza.ver',
  },
];

function aviso(msg: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(msg);
  } else {
    Alert.alert('Planning del día', msg);
  }
}

export default function PlanningDiaIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { width, height } = useBreakpoint();
  const tileSize = hubTileSideSize(width, height);
  const [activacionesHoy, setActivacionesHoy] = useState(0);
  const [actuacionesHoy, setActuacionesHoy] = useState(0);
  const [limpiezaHoy, setLimpiezaHoy] = useState(0);
  const [objetivoLocalIdx, setObjetivoLocalIdx] = useState(0);
  const [enlacesExternos, setEnlacesExternos] = useState<EnlacePlanning[]>([]);
  const puedeObjetivoCard = hasPermiso('planning_dia.objetivo_card');

  const tarjetaInternaVisible = useCallback(
    (t: TarjetaInterna) => {
      if (t.id === 'actuaciones') return puedeVerActuacionesPlanning(hasPermiso);
      if (t.id === 'activaciones') return puedeVerActivacionesPlanning(hasPermiso);
      if (t.id === 'arqueo-caja') return puedeVerArqueoCaja(hasPermiso);
      if (t.id === 'limpieza') return hasPermiso('limpieza.ver');
      return hasPermiso(t.permiso);
    },
    [hasPermiso],
  );

  const cargarEnlacesExternos = useCallback(async () => {
    if (!hasPermiso('planning_dia.ver')) {
      setEnlacesExternos([]);
      return;
    }
    try {
      const r = await apiFetch('/api/ajustes/planning_dia/enlaces');
      const d = await r.json();
      if (r.ok && d?.item) {
        setEnlacesExternos(enlacesDesdeItemAjuste(d.item as Record<string, unknown>));
      } else {
        setEnlacesExternos([]);
      }
    } catch {
      setEnlacesExternos([]);
    }
  }, [hasPermiso]);

  const abrirEnlace = useCallback(async (url: string) => {
    const res = await abrirEnlaceExterno(url);
    if (!res.ok) aviso(res.error);
  }, []);

  const cargarContadoresDia = useCallback(async () => {
    const fecha = encodeURIComponent(fechaJornadaNegocioIso());

    if (!puedeVerActivacionesPlanning(hasPermiso)) {
      setActivacionesHoy(0);
    } else {
      try {
        const r = await apiFetch(`/api/activaciones/sesiones/pendientes-dia?fecha=${fecha}`);
        const d = await r.json();
        setActivacionesHoy(r.ok ? Number(d.total) || 0 : 0);
      } catch {
        setActivacionesHoy(0);
      }
    }

    if (!puedeVerActuacionesPlanning(hasPermiso)) {
      setActuacionesHoy(0);
    } else {
      try {
        const r = await apiFetch(`/api/actuaciones/dia/total?fecha=${fecha}`);
        const d = await r.json();
        setActuacionesHoy(r.ok ? Number(d.total) || 0 : 0);
      } catch {
        setActuacionesHoy(0);
      }
    }

    if (!hasPermiso('limpieza.ver')) {
      setLimpiezaHoy(0);
    } else {
      try {
        const r = await apiFetch(`/api/limpieza/registros/pendientes-dia?fecha=${fecha}`);
        const d = await r.json();
        setLimpiezaHoy(r.ok ? Number(d.total) || 0 : 0);
      } catch {
        setLimpiezaHoy(0);
      }
    }
  }, [hasPermiso]);

  useFocusEffect(
    useCallback(() => {
      cargarContadoresDia();
      cargarEnlacesExternos();
    }, [cargarContadoresDia, cargarEnlacesExternos]),
  );

  const enlacesVisibles = useMemo(
    () => enlacesExternos.filter((e) => enlacePlanningVisible(e, hasPermiso)),
    [enlacesExternos, hasPermiso],
  );

  const tarjetasInternasVisibles = useMemo(
    () => TARJETAS_INTERNAS.filter((t) => tarjetaInternaVisible(t)),
    [tarjetaInternaVisible],
  );

  const hayContenido = tarjetasInternasVisibles.length > 0 || enlacesVisibles.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Planning del día</Text>
          <Text style={styles.subtitle}>Acciones rápidas del día a día</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {puedeObjetivoCard ? (
          <ObjetivoMensualCard
            localIndex={objetivoLocalIdx}
            onLocalIndexChange={setObjetivoLocalIdx}
          />
        ) : null}
        {!hayContenido ? (
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
            <Text style={styles.emptyText}>
              No tienes permisos para acceder a las acciones del día.
            </Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {tarjetasInternasVisibles.map((t) => (
              <HubTile
                key={t.id}
                label={t.label}
                description={t.descripcion}
                icon={t.icon}
                size={tileSize}
                variant={t.variant}
                badgeCount={
                  t.id === 'activaciones'
                    ? activacionesHoy
                    : t.id === 'actuaciones'
                      ? actuacionesHoy
                      : t.id === 'limpieza'
                        ? limpiezaHoy
                        : undefined
                }
                onPress={() => router.push(t.ruta as never)}
                favorito={{ route: t.ruta, label: t.label, icon: t.icon, permiso: t.permiso }}
              />
            ))}
            {enlacesVisibles.map((e) => (
              <HubTile
                key={`ext-${e.id}`}
                label={e.label}
                description={e.descripcion ?? 'Abre enlace externo en nueva pestaña'}
                icon={iconoEnlaceValido(e.icon) as IconName}
                size={tileSize}
                onPress={() => { void abrirEnlace(e.url); }}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 2 },
  scrollContent: { paddingBottom: 24 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
