import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { hubAccentById } from '../../lib/hubNavAccent';
import { apiFetch } from '../../utils/api';
import { abrirEnlaceExterno } from '../../utils/enlaceExterno';
import {
  type EnlacePlanning,
  enlacesDesdeItemAjuste,
  enlacePlanningVisible,
  iconoEnlaceValido,
} from '../../lib/planningEnlaces';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { ObjetivoMensualCard, type ObjetivoMensualLocal } from '../../components/ObjetivoMensualCard';
import { CampanasActivasPlanningCard } from '../../components/CampanasActivasPlanningCard';
import { TopCamarerosPlanningCard } from '../../components/TopCamarerosPlanningCard';
import { prefetchTopCamarerosPlanning } from '../../lib/topCamarerosPlanningCache';
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
  {
    id: 'reportar-incidencia',
    label: 'Reportar incidencia',
    descripcion: 'Avisar de una avería o incidencia en el local',
    icon: 'report-problem',
    ruta: '/mantenimiento/reportar',
    permiso: 'mantenimiento.crear',
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
  const { cardWidth, compact, rowSpanWidth } = useHubNavGrid();
  const { shouldStackPanels } = useBreakpoint();
  const [activacionesHoy, setActivacionesHoy] = useState(0);
  const [actuacionesHoy, setActuacionesHoy] = useState(0);
  const [limpiezaHoy, setLimpiezaHoy] = useState(0);
  const [objetivoLocalIdx, setObjetivoLocalIdx] = useState(0);
  const [objetivoLocales, setObjetivoLocales] = useState<ObjetivoMensualLocal[]>([]);
  const [enlacesExternos, setEnlacesExternos] = useState<EnlacePlanning[]>([]);
  const puedeObjetivoCard = hasPermiso('planning_dia.objetivo_card');
  const puedeCampanasActivas = hasPermiso('incentivos_producto.ver');
  const puedeTopCamareros = hasPermiso('top.ver');
  const muestraFilaSuperior = puedeObjetivoCard || puedeCampanasActivas || puedeTopCamareros;
  const localIdObjetivo = objetivoLocales[objetivoLocalIdx]?.localId ?? null;

  useEffect(() => {
    if (!hasPermiso('top.ver') || objetivoLocales.length === 0) return;
    prefetchTopCamarerosPlanning(objetivoLocales.map((l) => l.localId));
  }, [objetivoLocales, hasPermiso]);

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

  const objetivosThirdStyle = useMemo(
    () => [
      styles.objetivosThird,
      shouldStackPanels && styles.objetivosThirdStack,
    ],
    [shouldStackPanels],
  );

  const hubItems = useMemo(() => {
    type Item =
      | {
          kind: 'internal';
          id: string;
          label: string;
          descripcion: string;
          icon: IconName;
          ruta: string;
          permiso: string;
          variant?: 'default' | 'accent';
          badgeCount?: number;
        }
      | {
          kind: 'external';
          id: string;
          label: string;
          descripcion: string;
          icon: IconName;
          url: string;
        };

    const internas: Item[] = tarjetasInternasVisibles.map((t) => ({
      kind: 'internal',
      id: t.id,
      label: t.label,
      descripcion: t.descripcion,
      icon: t.icon,
      ruta: t.ruta,
      permiso: t.permiso,
      variant: t.variant,
      badgeCount:
        t.id === 'activaciones'
          ? activacionesHoy
          : t.id === 'actuaciones'
            ? actuacionesHoy
            : t.id === 'limpieza'
              ? limpiezaHoy
              : undefined,
    }));

    const externas: Item[] = enlacesVisibles.map((e) => ({
      kind: 'external',
      id: e.id,
      label: e.label,
      descripcion: e.descripcion ?? 'Abre enlace externo en nueva pestaña',
      icon: iconoEnlaceValido(e.icon) as IconName,
      url: e.url,
    }));

    return [...internas, ...externas].sort((a, b) => a.label.localeCompare(b.label, 'es'));
  }, [tarjetasInternasVisibles, enlacesVisibles, activacionesHoy, actuacionesHoy, limpiezaHoy]);

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
        {!hayContenido && !muestraFilaSuperior ? (
          <View style={styles.emptyBox}>
            <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
            <Text style={styles.emptyText}>
              No tienes permisos para acceder a las acciones del día.
            </Text>
          </View>
        ) : (
          <>
            {muestraFilaSuperior ? (
              <View
                style={[
                  styles.objetivosRow,
                  { width: rowSpanWidth },
                  shouldStackPanels && styles.objetivosRowStack,
                ]}
              >
                {puedeObjetivoCard ? (
                  <View style={objetivosThirdStyle}>
                    <ObjetivoMensualCard
                      localIndex={objetivoLocalIdx}
                      onLocalIndexChange={setObjetivoLocalIdx}
                      onLocalesLoaded={setObjetivoLocales}
                    />
                  </View>
                ) : null}
                {puedeCampanasActivas ? (
                  <View style={objetivosThirdStyle}>
                    <CampanasActivasPlanningCard
                      localId={localIdObjetivo}
                      filtrarPorLocal={puedeObjetivoCard}
                      localIndex={objetivoLocalIdx}
                    />
                  </View>
                ) : null}
                {puedeTopCamareros ? (
                  <View style={objetivosThirdStyle}>
                    <TopCamarerosPlanningCard
                      localId={localIdObjetivo}
                      filtrarPorLocal={puedeObjetivoCard}
                      localIndex={objetivoLocalIdx}
                    />
                  </View>
                ) : null}
              </View>
            ) : null}
            {muestraFilaSuperior ? (
              <View style={[styles.sectionDivider, { width: rowSpanWidth }]} />
            ) : null}
            <HubNavGrid>
            {hubItems.map((item) => {
              const accent = hubAccentById(item.id);
              if (item.kind === 'internal') {
                return (
                  <HubNavCard
                    key={item.id}
                    label={item.label}
                    description={item.descripcion}
                    icon={item.icon}
                    accentBg={accent.accentBg}
                    accentFg={accent.accentFg}
                    variant={item.variant === 'accent' ? 'accent' : 'default'}
                    width={cardWidth}
                    compact={compact}
                    badgeCount={item.badgeCount}
                    onPress={() => router.push(item.ruta as never)}
                    trailing={
                      <EstrellaFavorito
                        favorito={{
                          route: item.ruta,
                          label: item.label,
                          icon: item.icon,
                          permiso: item.permiso,
                        }}
                      />
                    }
                  />
                );
              }
              return (
                <HubNavCard
                  key={`ext-${item.id}`}
                  label={item.label}
                  description={item.descripcion}
                  icon={item.icon}
                  accentBg={accent.accentBg}
                  accentFg={accent.accentFg}
                  width={cardWidth}
                  compact={compact}
                  onPress={() => { void abrirEnlace(item.url); }}
                />
              );
            })}
          </HubNavGrid>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#ffffff' },
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
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 2 },
  scrollContent: { paddingBottom: 24 },
  objetivosRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginBottom: 12,
    gap: 12,
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e2e8f0',
    marginTop: 4,
    marginBottom: 16,
    alignSelf: 'flex-start',
  },
  objetivosRowStack: {
    flexDirection: 'column',
  },
  objetivosThird: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
    alignSelf: 'stretch',
  },
  objetivosThirdStack: {
    flex: undefined,
    flexBasis: undefined,
    width: '100%',
  },
  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
