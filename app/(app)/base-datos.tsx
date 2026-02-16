import { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const TABLAS = [
  { id: 'usuarios', label: 'Usuarios', icon: 'people' as const, descripcion: 'Cuentas y permisos de acceso' },
  { id: 'locales', label: 'Locales', icon: 'store' as const, descripcion: 'Sedes y puntos de venta' },
  { id: 'empresas', label: 'Empresas', icon: 'business' as const, descripcion: 'Listado de empresas' },
  { id: 'productos', label: 'Productos', icon: 'inventory' as const, descripcion: 'Carta y stock' },
  { id: 'puntos-venta', label: 'Puntos de Venta', icon: 'storefront' as const, descripcion: 'Puntos de venta y TPV' },
  { id: 'artistas', label: 'Artistas', icon: 'mic' as const, descripcion: 'Actuaciones y programación' },
];

export default function BaseDatosScreen() {
  const router = useRouter();
  const [apiConectado, setApiConectado] = useState<boolean | null>(null);
  const [comprobando, setComprobando] = useState(true);

  const comprobarConexion = useCallback(() => {
    setComprobando(true);
    setApiConectado(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch(`${API_URL}/api/health`, { method: 'GET', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.resolve(null)))
      .then((data) => {
        setApiConectado(data?.ok === true);
      })
      .catch(() => setApiConectado(false))
      .finally(() => {
        clearTimeout(timeout);
        setComprobando(false);
      });
  }, []);

  useEffect(() => {
    comprobarConexion();
  }, [comprobarConexion]);

  function handleSeleccionar(id: string) {
    if (id === 'usuarios') router.push('/usuarios');
    if (id === 'locales') router.push('/locales');
    if (id === 'empresas') router.push('/empresas');
    if (id === 'productos') router.push('/productos');
    if (id === 'puntos-venta') router.push('/puntos-venta');
    // Artistas: más adelante
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Base de Datos</Text>
      <Text style={styles.subtitle}>Selecciona una tabla para gestionar sus datos</Text>

      {comprobando && (
        <View style={styles.banner}>
          <ActivityIndicator size="small" color="#0ea5e9" />
          <Text style={styles.bannerText}>Comprobando conexión con el servidor…</Text>
        </View>
      )}
      {!comprobando && apiConectado === false && (
        <View style={styles.bannerError}>
          <MaterialIcons name="cloud-off" size={20} color="#fff" />
          <Text style={styles.bannerErrorText}>
            No se puede conectar al servidor. Las tablas no cargarán datos.
          </Text>
          <Text style={styles.bannerErrorUrl}>{API_URL}</Text>
          <Text style={styles.bannerErrorHint}>
            Arranca el API con: npm run dev (o en otra terminal: cd api && npm run dev)
          </Text>
          <TouchableOpacity style={styles.retryBtn} onPress={comprobarConexion}>
            <Text style={styles.retryBtnText}>Reintentar conexión</Text>
          </TouchableOpacity>
        </View>
      )}
      {!comprobando && apiConectado === true && (
        <View style={styles.bannerOk}>
          <MaterialIcons name="cloud-done" size={18} color="#0f766e" />
          <Text style={styles.bannerOkText}>Conectado al servidor</Text>
        </View>
      )}

      <View style={styles.grid}>
        {TABLAS.map((tabla) => (
          <TouchableOpacity
            key={tabla.id}
            style={styles.card}
            onPress={() => handleSeleccionar(tabla.id)}
            activeOpacity={0.7}
          >
            <View style={styles.cardLeft}>
              <MaterialIcons name={tabla.icon} size={24} color="#0ea5e9" />
              <Text style={styles.cardLabel}>{tabla.label}</Text>
            </View>
            <Text style={styles.cardDescripcion} numberOfLines={2}>
              {tabla.descripcion}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 16,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    marginBottom: 12,
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  bannerText: {
    fontSize: 13,
    color: '#0369a1',
  },
  bannerOk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 8,
    marginBottom: 12,
    backgroundColor: '#ccfbf1',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#5eead4',
  },
  bannerOkText: {
    fontSize: 13,
    color: '#0f766e',
    fontWeight: '500',
  },
  bannerError: {
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#dc2626',
    borderRadius: 8,
  },
  bannerErrorText: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '500',
    marginTop: 4,
  },
  bannerErrorUrl: {
    fontSize: 12,
    color: '#fecaca',
    marginTop: 4,
    fontFamily: 'monospace',
  },
  bannerErrorHint: {
    fontSize: 12,
    color: '#fecaca',
    marginTop: 8,
  },
  retryBtn: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  retryBtnText: {
    fontSize: 13,
    color: '#fff',
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    width: '47%',
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 10,
  },
  cardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  cardLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: '#334155',
  },
  cardDescripcion: {
    flex: 1,
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'italic',
    color: '#94a3b8',
    marginLeft: 8,
    textAlign: 'right',
  },
});
