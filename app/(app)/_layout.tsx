import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Modal, Pressable } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { AuthProvider, useAuth, AUTH_KEY } from '../contexts/AuthContext';

const MENU_ITEMS: { route: string; label: string; icon: string; permiso: string | null }[] = [
  { route: '/', label: 'Inicio', icon: 'home', permiso: null },
  { route: '/base-datos', label: 'Base de Datos', icon: 'storage', permiso: 'base_datos.ver' },
  { route: '/mantenimiento', label: 'Mantenimiento', icon: 'build', permiso: 'mantenimiento.ver' },
  { route: '/compras', label: 'Compras', icon: 'shopping-cart', permiso: 'compras.ver' },
  { route: '/cajas', label: 'Cajas', icon: 'point-of-sale', permiso: 'cajas.ver' },
  { route: '/cashflow', label: 'Cashflow', icon: 'trending-up', permiso: 'cashflow.ver' },
  { route: '/actuaciones', label: 'Actuaciones', icon: 'mic', permiso: 'actuaciones.ver' },
  { route: '/rrpp', label: 'Rrpp', icon: 'people', permiso: 'rrpp.ver' },
  { route: '/mystery-guest', label: 'Mystery Guest', icon: 'visibility', permiso: 'mystery_guest.ver' },
  { route: '/reservas', label: 'Reservas', icon: 'event-available', permiso: 'reservas.ver' },
];

function AppLayoutContent() {
  const router = useRouter();
  const { user, loading, hasPermiso, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(Platform.OS === 'web');
  const [configOpen, setConfigOpen] = useState(false);
  const [configLabelVisible, setConfigLabelVisible] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/login');
  }, [user, loading, router]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  if (loading || !user) return null;

  return (
    <View style={styles.wrapper}>
      {/* Barra superior */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => setSidebarOpen((o) => !o)}
          style={styles.menuButton}
        >
          <MaterialIcons name="menu" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={styles.headerSpacer} />
        <View
          style={styles.headerConfigWrap}
          onMouseEnter={Platform.OS === 'web' ? () => setConfigLabelVisible(true) : undefined}
          onMouseLeave={Platform.OS === 'web' ? () => setConfigLabelVisible(false) : undefined}
        >
          {configLabelVisible && Platform.OS === 'web' ? (
            <View style={styles.configTooltip}>
              <Text style={styles.configTooltipText}>Configuración</Text>
            </View>
          ) : null}
          <TouchableOpacity
            onPress={() => setConfigOpen((o) => !o)}
            style={styles.headerConfigBtn}
            accessibilityLabel="Configuración"
          >
            <MaterialIcons name="settings" size={22} color="#64748b" />
          </TouchableOpacity>
        </View>
        <Modal visible={configOpen} transparent animationType="fade">
          <Pressable style={styles.configOverlay} onPress={() => setConfigOpen(false)}>
            <Pressable style={styles.configDropdown} onPress={() => {}}>
              <TouchableOpacity
                style={styles.configDropdownItem}
                onPress={() => {
                  setConfigOpen(false);
                  router.push('/permisos');
                }}
                activeOpacity={0.7}
              >
                <MaterialIcons name="lock" size={18} color="#475569" />
                <Text style={styles.configDropdownItemText}>Permisos</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.configDropdownItem, styles.configDropdownItemBorder]}
                onPress={() => {
                  setConfigOpen(false);
                  handleLogout();
                }}
                activeOpacity={0.7}
              >
                <MaterialIcons name="logout" size={18} color="#475569" />
                <Text style={styles.configDropdownItemText}>Cerrar sesión</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
        <View style={styles.headerUserBlock}>
          <Text style={styles.headerNombre} numberOfLines={1}>
            {user.Nombre || user.email}
            {user.Rol ? (
              <Text style={styles.headerRol}> ({user.Rol})</Text>
            ) : null}
          </Text>
        </View>
      </View>

      <View style={styles.body}>
        {/* Sidebar: contraído solo icono, expandido icono + texto */}
        <View style={[styles.sidebar, sidebarOpen ? styles.sidebarExpanded : styles.sidebarCollapsed]}>
          <View style={styles.sidebarInner}>
            {MENU_ITEMS.filter((item) => !item.permiso || hasPermiso(item.permiso)).map((item) => (
              <TouchableOpacity
                key={item.route}
                style={[styles.menuItem, !sidebarOpen && styles.menuItemCollapsed]}
                onPress={() => router.push(item.route as any)}
                activeOpacity={0.7}
              >
                <MaterialIcons name={item.icon as any} size={18} color="#0ea5e9" />
                {sidebarOpen ? <Text style={styles.menuItemText}>{item.label}</Text> : null}
              </TouchableOpacity>
            ))}
            <View style={styles.sidebarSpacer} />
          </View>
        </View>

        {/* Contenido */}
        <View style={styles.content}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="base-datos" />
            <Stack.Screen name="mantenimiento" />
            <Stack.Screen name="compras" />
            <Stack.Screen name="cajas" />
            <Stack.Screen name="cashflow" />
            <Stack.Screen name="actuaciones" />
            <Stack.Screen name="rrpp" />
            <Stack.Screen name="mystery-guest" />
            <Stack.Screen name="reservas" />
            <Stack.Screen name="usuarios" />
            <Stack.Screen name="locales" />
            <Stack.Screen name="almacenes" />
            <Stack.Screen name="empresas" />
            <Stack.Screen name="productos" />
            <Stack.Screen name="puntos-venta" />
            <Stack.Screen name="permisos" />
          </Stack>
        </View>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>ERP Hostelería © {new Date().getFullYear()}</Text>
      </View>
    </View>
  );
}

export default function AppLayout() {
  return (
    <AuthProvider>
      <AppLayoutContent />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: '#e2e8f0',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  menuButton: {
    padding: 4,
    marginRight: 4,
  },
  headerSpacer: {
    flex: 1,
  },
  headerConfigWrap: {
    position: 'relative',
    marginRight: 8,
  },
  headerConfigBtn: {
    padding: 4,
  },
  configTooltip: {
    position: 'absolute',
    bottom: '100%',
    left: '50%',
    marginBottom: 4,
    transform: [{ translateX: -50 }],
    backgroundColor: '#334155',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    zIndex: 10,
  },
  configTooltipText: {
    fontSize: 11,
    color: '#f8fafc',
    fontWeight: '500',
  },
  configOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.2)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 38,
    paddingRight: 10,
  },
  configDropdown: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minWidth: 160,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
    paddingVertical: 4,
  },
  configDropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  configDropdownItemText: {
    fontSize: 14,
    color: '#334155',
    fontWeight: '500',
  },
  configDropdownItemBorder: {
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  headerUserBlock: {
    alignItems: 'flex-end',
    marginRight: 8,
    maxWidth: 180,
  },
  headerNombre: {
    fontSize: 13,
    fontWeight: '600',
    color: '#334155',
  },
  headerRol: {
    fontSize: 11,
    height: 16,
    color: '#64748b',
    fontStyle: 'italic',
    fontWeight: '400',
  },
  body: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebar: {
    backgroundColor: '#f1f5f9',
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    paddingTop: 8,
  },
  sidebarExpanded: {
    width: 160,
  },
  sidebarCollapsed: {
    width: 44,
  },
  sidebarInner: { flex: 1 },
  sidebarSpacer: { flex: 1, minHeight: 8 },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    gap: 8,
  },
  menuItemCollapsed: {
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  menuItemText: {
    fontSize: 12,
    color: '#334155',
    fontWeight: '400',
  },
  content: {
    flex: 1,
    padding: 10,
  },
  footer: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#f1f5f9',
    borderTopWidth: 1,
    borderTopColor: '#cbd5e1',
    alignItems: 'center',
  },
  footerText: {
    fontSize: 11,
    color: '#64748b',
  },
});
