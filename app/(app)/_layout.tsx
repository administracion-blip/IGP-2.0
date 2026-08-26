import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Modal,
  Pressable,
  ActivityIndicator,
  useWindowDimensions,
  Image,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, usePathname, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { ProductosCacheProvider } from '../contexts/ProductosCache';
import { ComprasProveedorCacheProvider } from '../contexts/ComprasProveedorCache';
import { fetchImagenApp } from '../lib/personalizacion';
import { MODULOS as MENU_ITEMS, moduloDeRuta } from '../constants/modulos';
import { colors, iconSize, radius, shadowCard, sidebar, SPACING, typography } from '../constants/theme';
import { SidebarNavItem } from '../components/ui/SidebarNavItem';
import { SidebarApiStatus } from '../components/ui/SidebarApiStatus';
import { SoftPulseBorderWrap } from '../components/ui/SoftPulseBorderWrap';

function normalizarPath(pathname: string): string {
  const p = pathname.replace(/\/$/, '');
  return p === '' ? '/' : p;
}

/** Maestros accesibles desde el hub Base de datos (no son módulo raíz en MODULOS). */
const RUTAS_HUB_BASE_DATOS = new Set([
  '/usuarios',
  '/locales',
  '/almacenes',
  '/empresas',
  '/productos',
  '/puntos-venta',
  '/personal',
  '/usuarios-agora',
  '/formas-pago',
]);

function rutaMenuActiva(pathname: string, itemRoute: string): boolean {
  const path = normalizarPath(pathname);
  const route = normalizarPath(itemRoute);
  if (route === '/') return path === '/';
  if (path === route || path.startsWith(`${route}/`)) return true;
  const padre = moduloDeRuta(path);
  if (padre?.route === route) return true;
  if (route === '/base-datos' && RUTAS_HUB_BASE_DATOS.has(path)) return true;
  return false;
}

function AppLayoutContent() {
  const router = useRouter();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user, loading, hasPermiso, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(Platform.OS === 'web');
  const didInitTabletSidebar = useRef(false);
  useEffect(() => {
    if (Platform.OS === 'web' || didInitTabletSidebar.current || width < 768) return;
    didInitTabletSidebar.current = true;
    setSidebarOpen(true);
  }, [width]);
  const [configOpen, setConfigOpen] = useState(false);
  const [configLabelVisible, setConfigLabelVisible] = useState(false);
  const [imagenApp, setImagenApp] = useState<string | null>(null);

  useEffect(() => {
    fetchImagenApp().then(setImagenApp);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/login');
  }, [user, loading, router]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  const menuItemsVisibles = MENU_ITEMS.filter((item) => {
    if (item.route === '/informes-ia') return false;
    // Reuniones ya no tiene entrada propia: vive en el hub de Proyectos (D-22).
    // Quien solo tenga reuniones.ver debe poder abrir ese hub desde el lateral.
    if (item.route === '/proyectos') {
      return hasPermiso('proyectos.ver') || hasPermiso('reuniones.ver');
    }
    return !item.permiso || hasPermiso(item.permiso);
  });

  const irMenu = useCallback((route: string) => router.push(route as never), [router]);

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Cargando sesión…</Text>
      </View>
    );
  }

  if (!user) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Redirigiendo al inicio de sesión…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrapper, { paddingTop: insets.top }]}>
      {/* Barra superior */}
      <View style={[styles.header, { paddingLeft: Math.max(10, insets.left), paddingRight: Math.max(10, insets.right) }]}>
        <Pressable
          onPress={() => setSidebarOpen((o) => !o)}
          style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}
          accessibilityLabel={sidebarOpen ? 'Contraer menú' : 'Expandir menú'}
        >
          <MaterialIcons name="menu" size={iconSize.tab} color={colors.textPrimary} />
        </Pressable>
        {imagenApp ? (
          <Image
            source={{ uri: imagenApp }}
            style={styles.headerLogo}
            resizeMode="contain"
            accessibilityLabel="Logo"
          />
        ) : null}
        <View style={styles.headerSpacer} />
        {hasPermiso('ia.informes') ? (
          <SoftPulseBorderWrap preset="ia" borderRadius={radius.sm} style={styles.headerIaWrap}>
            <TouchableOpacity
              style={styles.headerIaBtn}
              onPress={() => router.push('/informes-ia' as never)}
              activeOpacity={0.85}
              accessibilityLabel="Informes IA"
            >
              <MaterialIcons name="auto-awesome" size={18} color="#92400e" />
              {width >= 640 ? <Text style={styles.headerIaBtnText}>Informes IA</Text> : null}
            </TouchableOpacity>
          </SoftPulseBorderWrap>
        ) : null}
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
            <MaterialIcons name="settings" size={iconSize.tab} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
        <Modal visible={configOpen} transparent animationType="fade">
          <Pressable style={styles.configOverlay} onPress={() => setConfigOpen(false)}>
            <Pressable style={styles.configDropdown} onPress={() => {}}>
              {hasPermiso('permisos.ver') && (
              <TouchableOpacity
                style={styles.configDropdownItem}
                onPress={() => {
                  setConfigOpen(false);
                  router.push('/permisos');
                }}
                activeOpacity={0.7}
              >
                <MaterialIcons name="lock" size={iconSize.chip} color={colors.textSecondary} />
                <Text style={styles.configDropdownItemText}>Permisos</Text>
              </TouchableOpacity>
              )}
              {hasPermiso('ajustes.ver') && (
              <TouchableOpacity
                style={[styles.configDropdownItem, styles.configDropdownItemBorder]}
                onPress={() => {
                  setConfigOpen(false);
                  router.push('/ajustes');
                }}
                activeOpacity={0.7}
              >
                <MaterialIcons name="tune" size={iconSize.chip} color={colors.textSecondary} />
                <Text style={styles.configDropdownItemText}>Ajustes</Text>
              </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.configDropdownItem, styles.configDropdownItemBorder]}
                onPress={() => {
                  setConfigOpen(false);
                  handleLogout();
                }}
                activeOpacity={0.7}
              >
                <MaterialIcons name="logout" size={iconSize.chip} color={colors.textSecondary} />
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
        <View style={[styles.sidebar, sidebarOpen ? styles.sidebarExpanded : styles.sidebarCollapsed]}>
          <ScrollView
            style={styles.sidebarScroll}
            contentContainerStyle={styles.sidebarScrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <SidebarNavItem
              label="Favoritos"
              icon="star-border"
              collapsed={!sidebarOpen}
              active={rutaMenuActiva(pathname, '/favoritos')}
              onPress={() => irMenu('/favoritos')}
              accentFavoritos
            />
            <View style={styles.sidebarDivider} />
            {sidebarOpen ? (
              <Text style={styles.sidebarSectionLabel}>Módulos</Text>
            ) : null}
            {menuItemsVisibles.map((item) => (
              <SidebarNavItem
                key={item.route}
                label={item.label}
                icon={item.icon as ComponentProps<typeof MaterialIcons>['name']}
                collapsed={!sidebarOpen}
                active={rutaMenuActiva(pathname, item.route)}
                onPress={() => irMenu(item.route)}
              />
            ))}
          </ScrollView>
          <View style={styles.sidebarDivider} />
          <SidebarApiStatus collapsed={!sidebarOpen} />
        </View>

        {/* Contenido */}
        <View style={styles.content}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen
              name="index"
              options={{ contentStyle: { backgroundColor: '#ffffff' } }}
            />
            <Stack.Screen name="base-datos" />
            <Stack.Screen name="mantenimiento" />
            <Stack.Screen name="compras" />
            <Stack.Screen name="cajas" />
            <Stack.Screen name="cashflow" />
            <Stack.Screen name="informes-ia" />
            <Stack.Screen name="actuaciones" />
            <Stack.Screen name="rrpp" />
            <Stack.Screen name="recursos-humanos" />
            <Stack.Screen name="rrss" />
            <Stack.Screen name="mystery-guest" />
            <Stack.Screen name="reservas" />
            <Stack.Screen name="usuarios" />
            <Stack.Screen name="usuarios-agora" />
            <Stack.Screen name="locales" />
            <Stack.Screen name="almacenes" />
            <Stack.Screen name="empresas" />
            <Stack.Screen name="productos" />
            <Stack.Screen name="puntos-venta" />
            <Stack.Screen name="permisos" />
            <Stack.Screen name="acuerdos" />
            <Stack.Screen name="acuerdos-productos-activos" />
            <Stack.Screen name="acuerdos-informe-compras" />
            <Stack.Screen name="mayorista/index" />
            <Stack.Screen name="mayorista/[id]" />
            <Stack.Screen name="facturacion" />
            <Stack.Screen name="banca" />
            <Stack.Screen name="ajustes" />
            <Stack.Screen name="planning-dia" />
            <Stack.Screen name="proyectos" />
            <Stack.Screen name="reuniones" />
            <Stack.Screen name="favoritos" />
          </Stack>
        </View>
      </View>

      {/* Footer */}
      <View style={[styles.footer, { paddingBottom: Math.max(6, insets.bottom), paddingLeft: Math.max(10, insets.left), paddingRight: Math.max(10, insets.right) }]}>
        <Text style={styles.footerText}>ERP Hostelería © {new Date().getFullYear()}</Text>
      </View>
    </View>
  );
}

export default function AppLayout() {
  return (
    <AuthProvider>
      <ProductosCacheProvider>
        <ComprasProveedorCacheProvider>
          <AppLayoutContent />
        </ComprasProveedorCacheProvider>
      </ProductosCacheProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  menuButton: {
    padding: SPACING.xs,
    marginRight: SPACING.xs,
    borderRadius: radius.sm,
  },
  menuButtonPressed: {
    backgroundColor: colors.navActive,
  },
  headerLogo: {
    height: 36,
    maxWidth: 140,
    marginRight: SPACING.sm,
  },
  headerSpacer: {
    flex: 1,
  },
  headerIaWrap: {
    marginRight: SPACING.sm,
  },
  headerIaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#fef3c7',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm - 2,
  },
  headerIaBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#92400e',
  },
  headerConfigWrap: {
    position: 'relative',
    marginRight: SPACING.sm,
  },
  headerConfigBtn: {
    padding: SPACING.xs,
    borderRadius: radius.sm,
  },
  configTooltip: {
    position: 'absolute',
    bottom: '100%',
    left: '50%',
    marginBottom: SPACING.xs,
    transform: [{ translateX: -50 }],
    backgroundColor: colors.textPrimary,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: radius.sm,
    zIndex: 10,
  },
  configTooltipText: {
    fontSize: 11,
    color: colors.bgSubtle,
    fontWeight: '500',
  },
  configOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 38,
    paddingRight: SPACING.sm,
  },
  configDropdown: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 160,
    paddingVertical: SPACING.xs,
    ...shadowCard(),
  },
  configDropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
  },
  configDropdownItemText: {
    ...typography.cuerpo,
    fontWeight: '500',
  },
  configDropdownItemBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  headerUserBlock: {
    alignItems: 'flex-end',
    marginRight: SPACING.sm,
    maxWidth: 180,
  },
  headerNombre: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  headerRol: {
    fontSize: 11,
    height: 16,
    color: colors.textSecondary,
    fontStyle: 'italic',
    fontWeight: '400',
  },
  body: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebar: {
    flexDirection: 'column',
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  sidebarExpanded: {
    width: sidebar.widthExpanded,
  },
  sidebarCollapsed: {
    width: sidebar.widthCollapsed,
  },
  sidebarScroll: {
    flex: 1,
  },
  sidebarScrollContent: {
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  sidebarDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: SPACING.md,
    marginVertical: SPACING.sm,
  },
  sidebarSectionLabel: {
    fontSize: 11,
    fontWeight: '400',
    color: '#0f172a',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginLeft: SPACING.md + 2,
    marginBottom: SPACING.xs,
    marginTop: SPACING.xs,
  },
  content: {
    flex: 1,
    padding: SPACING.sm + 2,
  },
  footer: {
    paddingVertical: SPACING.xs + 2,
    paddingHorizontal: SPACING.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  loadingWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.bg,
    gap: SPACING.md,
  },
  loadingText: {
    ...typography.cuerpo,
    color: colors.textSecondary,
    fontWeight: '500',
  },
});
