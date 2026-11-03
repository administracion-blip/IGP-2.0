/**
 * Hub de MIA — Aprovisionamiento: conteo, stock máximo y tramos.
 * El MIA de consumo sigue en su ruta.
 */

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useHubNavGrid } from '../../../hooks/useHubNavGrid';
import { apiFetch } from '../../../utils/api';
import { formatCreadoEn } from '../../../utils/formatFecha';
import { HubNavCard, HubNavGrid } from '../../../components/ui/HubNavCard';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { hubAccentById } from '../../../lib/hubNavAccent';
import { SPACING } from '../../../constants/layout';

type Almacen = { id: string; nombre: string };
type ConteoResumen = { creadoEn: string | null; estado: string };

const TEXTO = '#0f172a';
const SECUNDARIO = '#64748b';
const ESTADO: Record<string, string> = {
  generado: 'Generado',
  enviando: 'Enviando',
  pedido: 'Pedido',
  confirmado: 'Confirmado',
  mixto: 'Mixto',
};

function textoConteo(ultimo: ConteoResumen | null, fallo: boolean) {
  if (fallo) return 'No se pudo consultar el último conteo';
  if (!ultimo) return 'Todavía no hay conteos';
  const cuando = formatCreadoEn(ultimo.creadoEn);
  const estado = ESTADO[ultimo.estado] || ultimo.estado || 'Sin estado';
  return `Último conteo: ${cuando} · ${estado}`;
}

function textoSinMaximo(total: number | null, fallo: boolean) {
  if (fallo || total == null) return 'No se pudo consultar el stock máximo';
  if (total === 0) return 'Todos los productos tienen máximo';
  if (total === 1) return '1 producto sin máximo';
  return `${total} productos sin máximo`;
}

function textoTramos(cantidad: number | null, heredados: boolean, fallo: boolean) {
  if (fallo || cantidad == null) return 'No se pudo consultar los tramos';
  if (cantidad === 0) return 'Sin tramos';
  if (heredados) return cantidad === 1 ? 'Hereda 1 tramo global' : `Hereda ${cantidad} tramos globales`;
  return cantidad === 1 ? '1 tramo propio' : `${cantidad} tramos propios`;
}

export default function AprovisionamientoHub() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { cardWidth, compact } = useHubNavGrid();
  const puedeVer = hasPermiso('mia.ver');
  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [conteo, setConteo] = useState('Cargando…');
  const [sinMaximo, setSinMaximo] = useState('Cargando…');
  const [tramos, setTramos] = useState('Cargando…');
  const [sinMaximoTotal, setSinMaximoTotal] = useState(0);

  useEffect(() => {
    if (!puedeVer) return;
    let vivo = true;
    apiFetch('/api/mia/locales-almacenes')
      .then((r) => r.json())
      .then((data) => {
        if (!vivo) return;
        const lista: Almacen[] = (data.almacenes || []).map((a: Almacen) => ({
          id: String(a.id),
          nombre: String(a.nombre || a.id),
        }));
        lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        setAlmacenes(lista);
        setWarehouseId((prev) => prev || (lista[0]?.id ?? ''));
      })
      .catch(() => {
        if (!vivo) return;
        setConteo('No se pudieron cargar los almacenes');
        setSinMaximo('No se pudieron cargar los almacenes');
        setTramos('No se pudieron cargar los almacenes');
      });
    return () => {
      vivo = false;
    };
  }, [puedeVer]);

  useEffect(() => {
    if (!puedeVer || !warehouseId) return;
    let vivo = true;
    setConteo('Cargando…');
    setSinMaximo('Cargando…');
    setTramos('Cargando…');
    const id = encodeURIComponent(warehouseId);
    void (async () => {
      const [rConteos, rStock, rTramos] = await Promise.all([
        apiFetch(`/api/mia/conteos?warehouseId=${id}`),
        apiFetch(`/api/mia/stock-maximo?warehouseId=${id}&sinMaximo=1&limit=1`),
        apiFetch(`/api/mia/tramos?warehouseId=${id}`),
      ]);
      if (!vivo) return;
      const [dConteos, dStock, dTramos] = await Promise.all([
        rConteos.json().catch(() => ({})),
        rStock.json().catch(() => ({})),
        rTramos.json().catch(() => ({})),
      ]);
      if (!vivo) return;
      const ultimo = rConteos.ok && Array.isArray(dConteos.conteos) ? (dConteos.conteos[0] ?? null) : null;
      setConteo(textoConteo(rConteos.ok ? ultimo : null, !rConteos.ok));
      const total = rStock.ok ? Number(dStock.total) || 0 : null;
      setSinMaximoTotal(total ?? 0);
      setSinMaximo(textoSinMaximo(total, !rStock.ok));
      const lista = rTramos.ok && Array.isArray(dTramos.tramos) ? dTramos.tramos : null;
      setTramos(textoTramos(lista ? lista.length : null, dTramos.heredados === true, !rTramos.ok));
    })();
    return () => {
      vivo = false;
    };
  }, [puedeVer, warehouseId]);

  if (!puedeVer) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="lock-outline" size={32} color={SECUNDARIO} />
        <Text style={styles.aviso}>No tienes permiso para ver el aprovisionamiento.</Text>
      </View>
    );
  }

  const q = warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : '';
  const stockQ = `${q}${q ? '&' : '?'}sinMaximo=${sinMaximoTotal > 0 ? '1' : '0'}`;
  const tarjetas = [
    {
      id: 'conteo',
      label: 'Conteo',
      icon: 'inventory' as const,
      description: conteo,
      ruta: `/compras/aprovisionamiento/conteo${q}`,
    },
    {
      id: 'stock-maximo',
      label: 'Stock máximo',
      icon: 'tune' as const,
      description: sinMaximo,
      ruta: `/compras/aprovisionamiento/stock-maximo${stockQ}`,
    },
    {
      id: 'tramos',
      label: 'Tramos',
      icon: 'stacked-line-chart' as const,
      description: tramos,
      ruta: `/compras/aprovisionamiento/tramos${q}`,
    },
    {
      id: 'mia-consumo',
      label: 'MIA de consumo',
      icon: 'psychology' as const,
      description: 'El cálculo por consumo, el calendario y la aprobación de siempre',
      ruta: '/compras/mia-consumo',
    },
  ];

  return (
    <View style={styles.pantalla}>
      <Text style={styles.migas}>
        <Text style={styles.migaLink} onPress={() => router.push('/compras')}>Compras</Text>
        {' › Pedidos a proveedores › '}
        <Text style={styles.migaActual}>MIA — Aprovisionamiento</Text>
      </Text>
      <Text style={styles.titulo}>MIA — Aprovisionamiento</Text>
      <Text style={styles.nota}>Conteo, stock máximo y tramos. El dato es del almacén elegido.</Text>
      <View style={styles.filtro}>
        <SelectorDesplegable
          placeholder="Almacén"
          icono="warehouse"
          compact
          opciones={almacenes.map((a) => ({ id: a.id, titulo: a.nombre }))}
          valorId={warehouseId}
          onSeleccionar={setWarehouseId}
        />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <HubNavGrid>
          {tarjetas.map((tarjeta) => {
            const accent = hubAccentById(tarjeta.id);
            return (
              <HubNavCard
                key={tarjeta.id}
                label={tarjeta.label}
                description={tarjeta.description}
                icon={tarjeta.icon}
                accentBg={accent.accentBg}
                accentFg={accent.accentFg}
                width={cardWidth}
                compact={compact}
                onPress={() => router.push(tarjeta.ruta as never)}
              />
            );
          })}
        </HubNavGrid>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: '#f8fafc', padding: SPACING.lg },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.lg },
  aviso: { color: SECUNDARIO, fontSize: 15, textAlign: 'center' },
  migas: { color: SECUNDARIO, fontSize: 13, marginBottom: SPACING.sm },
  migaLink: { color: '#ec4899', fontWeight: '600' },
  migaActual: { color: TEXTO, fontWeight: '700' },
  titulo: { color: TEXTO, fontSize: 20, fontWeight: '700' },
  nota: { color: SECUNDARIO, fontSize: 14, marginTop: 4, marginBottom: SPACING.md },
  filtro: { maxWidth: 360, marginBottom: SPACING.md },
  scroll: { paddingBottom: SPACING.xl },
});
