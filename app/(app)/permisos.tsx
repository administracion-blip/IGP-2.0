import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../utils/api';

const ROLES_OPCIONES = ['Administrador', 'SuperUser', 'Administracion', 'Local', 'Socio'] as const;

const PERMISOS_CODIGOS = [
  // --- Módulos (menú lateral) ---
  'base_datos.ver',
  'mantenimiento.ver',
  'compras.ver',
  'cajas.ver',
  'cashflow.ver',
  'actuaciones.ver',
  'rrpp.ver',
  'recursos_humanos.ver',
  'rrss.ver',
  'mystery_guest.ver',
  'reservas.ver',
  // --- Usuarios ---
  'usuarios.ver',
  'usuarios.crear',
  'usuarios.editar',
  'usuarios.borrar',
  // --- Locales ---
  'locales.ver',
  'locales.crear',
  'locales.editar',
  'locales.borrar',
  // --- Empresas ---
  'empresas.ver',
  'empresas.crear',
  'empresas.editar',
  'empresas.importar',
  // --- Productos ---
  'productos.ver',
  'productos.editar',
  'productos.sincronizar',
  // --- Almacenes ---
  'almacenes.ver',
  'almacenes.crear',
  'almacenes.editar',
  'almacenes.borrar',
  'almacenes.sincronizar',
  // --- Usuarios Ágora (maestro) ---
  'usuarios_agora.ver',
  'usuarios_agora.sincronizar',
  // --- Puntos de venta ---
  'puntos_venta.ver',
  'puntos_venta.editar',
  // --- Permisos ---
  'permisos.ver',
  'permisos.crear',
  'permisos.editar',
  'permisos.borrar',
  // --- Cajas: Cierres teóricos ---
  'cierres.ver',
  'cierres.crear',
  'cierres.editar',
  'cierres.borrar',
  'cierres.sincronizar',
  'cierres.exportar',
  // --- Cajas: Comparativa fechas ---
  'comparativa.ver',
  'comparativa.crear',
  'comparativa.editar',
  'comparativa.borrar',
  'comparativa.importar',
  'comparativa.exportar',
  // --- Cajas: Objetivos ---
  'objetivos.ver',
  'objetivos.compartir',
  // --- Cajas: Control de excepciones ---
  'excepciones.ver',
  'excepciones.exportar',
  // --- Cajas: Top ---
  'top.ver',
  'top.exportar',
  // --- Mantenimiento ---
  'mantenimiento.crear',
  'mantenimiento.editar',
  'mantenimiento.borrar',
  // --- Compras: Pedidos ---
  'pedidos.ver',
  'pedidos.ver_completados',
  'pedidos.preparar',
  'pedidos.exportar_traspaso',
  'pedidos.crear',
  'pedidos.editar',
  'pedidos.borrar',
  'pedidos.editar_enviado',
  'pedidos.borrar_enviado',
  // --- Compras: Compras proveedor ---
  'compras_proveedor.ver',
  'compras_proveedor.sincronizar',
  // --- Acuerdos ---
  'acuerdos.ver',
  'acuerdos.crear',
  'acuerdos.editar',
  'acuerdos.borrar',
  'acuerdos.exportar',
  // --- Facturación ---
  'facturacion.ver',
  'facturacion.crear',
  'facturacion.editar',
  'facturacion.emitir',
  'facturacion.anular',
  'facturacion.cobrar_pagar',
  'facturacion.series',
  'facturacion.exportar',
  // --- Ajustes ---
  'ajustes.ver',
  'ajustes.sincronizaciones.agora_productos',
  'ajustes.sincronizaciones.agora_usuarios',
  'ajustes.sincronizaciones.compras_proveedor',
  'ajustes.sincronizaciones.closeouts',
  'ajustes.sincronizaciones.almacenes',
  'ajustes.sincronizaciones.empleados',
  // --- Planning del Día ---
  'planning_dia.ver',
  // --- Recursos Humanos ---
  'personal.ver',
  'rrhh.horas',
  // --- Marketing ---
  'marketing.proponer',
  'marketing.gestionar',
] as const;

const PERMISOS_LABELS: Record<string, string> = {
  'base_datos.ver': 'Base de datos (menú)',
  'mantenimiento.ver': 'Mantenimiento (menú)',
  'compras.ver': 'Compras (menú)',
  'cajas.ver': 'Cajas (menú)',
  'cashflow.ver': 'Cashflow (menú)',
  'actuaciones.ver': 'Actuaciones (menú)',
  'rrpp.ver': 'Rrpp (menú)',
  'recursos_humanos.ver': 'Recursos Humanos (menú)',
  'rrss.ver': 'Marketing (menú)',
  'mystery_guest.ver': 'Mystery Guest (menú)',
  'reservas.ver': 'Reservas (menú)',
  'usuarios.ver': 'Usuarios · Ver',
  'usuarios.crear': 'Usuarios · Crear',
  'usuarios.editar': 'Usuarios · Editar',
  'usuarios.borrar': 'Usuarios · Borrar',
  'locales.ver': 'Locales · Ver',
  'locales.crear': 'Locales · Crear',
  'locales.editar': 'Locales · Editar',
  'locales.borrar': 'Locales · Borrar',
  'empresas.ver': 'Empresas · Ver',
  'empresas.crear': 'Empresas · Crear',
  'empresas.editar': 'Empresas · Editar',
  'empresas.importar': 'Empresas · Importar',
  'productos.ver': 'Productos · Ver',
  'productos.editar': 'Productos · Editar',
  'productos.sincronizar': 'Productos · Sincronizar',
  'almacenes.ver': 'Almacenes · Ver',
  'almacenes.crear': 'Almacenes · Crear',
  'almacenes.editar': 'Almacenes · Editar',
  'almacenes.borrar': 'Almacenes · Borrar',
  'almacenes.sincronizar': 'Almacenes · Sincronizar',
  'usuarios_agora.ver': 'Usuarios Ágora · Ver',
  'usuarios_agora.sincronizar': 'Usuarios Ágora · Sincronizar',
  'puntos_venta.ver': 'Puntos de venta · Ver',
  'puntos_venta.editar': 'Puntos de venta · Editar',
  'permisos.ver': 'Permisos · Ver',
  'permisos.crear': 'Permisos · Crear',
  'permisos.editar': 'Permisos · Editar',
  'permisos.borrar': 'Permisos · Borrar',
  'cierres.ver': 'Cierres teóricos · Ver',
  'cierres.crear': 'Cierres teóricos · Crear',
  'cierres.editar': 'Cierres teóricos · Editar',
  'cierres.borrar': 'Cierres teóricos · Borrar',
  'cierres.sincronizar': 'Cierres teóricos · Sincronizar',
  'cierres.exportar': 'Cierres teóricos · Exportar',
  'comparativa.ver': 'Comparativa fechas · Ver',
  'comparativa.crear': 'Comparativa fechas · Crear',
  'comparativa.editar': 'Comparativa fechas · Editar',
  'comparativa.borrar': 'Comparativa fechas · Borrar',
  'comparativa.importar': 'Comparativa fechas · Importar',
  'comparativa.exportar': 'Comparativa fechas · Exportar',
  'objetivos.ver': 'Objetivos · Ver',
  'objetivos.compartir': 'Objetivos · Compartir',
  'excepciones.ver': 'Control excepciones · Ver',
  'excepciones.exportar': 'Control excepciones · Exportar',
  'top.ver': 'Top · Ver',
  'top.exportar': 'Top · Exportar',
  'mantenimiento.crear': 'Mantenimiento · Crear',
  'mantenimiento.editar': 'Mantenimiento · Editar',
  'mantenimiento.borrar': 'Mantenimiento · Borrar',
  'pedidos.ver': 'Pedidos · Ver',
  'pedidos.ver_completados': 'Pedidos · Ver completados',
  'pedidos.preparar': 'Pedidos · Preparar (almacén)',
  'pedidos.exportar_traspaso': 'Pedidos · Exportar traspasos a Agora',
  'pedidos.crear': 'Pedidos · Crear',
  'pedidos.editar': 'Pedidos · Editar',
  'pedidos.borrar': 'Pedidos · Borrar',
  'pedidos.editar_enviado': 'Pedidos · Editar (enviado)',
  'pedidos.borrar_enviado': 'Pedidos · Borrar (enviado)',
  'compras_proveedor.ver': 'Compras proveedor · Ver',
  'compras_proveedor.sincronizar': 'Compras proveedor · Sincronizar',
  'acuerdos.ver': 'Acuerdos (menú) · Ver',
  'acuerdos.crear': 'Acuerdos · Crear',
  'acuerdos.editar': 'Acuerdos · Editar',
  'acuerdos.borrar': 'Acuerdos · Borrar',
  'acuerdos.exportar': 'Acuerdos · Exportar',
  'facturacion.ver': 'Facturación (menú) · Ver',
  'facturacion.crear': 'Facturación · Crear',
  'facturacion.editar': 'Facturación · Editar',
  'facturacion.emitir': 'Facturación · Emitir',
  'facturacion.anular': 'Facturación · Anular',
  'facturacion.cobrar_pagar': 'Facturación · Cobrar/Pagar',
  'facturacion.series': 'Facturación · Series',
  'facturacion.exportar': 'Facturación · Exportar',
  'ajustes.ver': 'Ajustes (menú)',
  'ajustes.sincronizaciones.agora_productos': 'Ajustes · Sync Productos Agora',
  'ajustes.sincronizaciones.agora_usuarios': 'Ajustes · Sync Usuarios Agora',
  'ajustes.sincronizaciones.compras_proveedor': 'Ajustes · Sync Compras Proveedor',
  'ajustes.sincronizaciones.closeouts': 'Ajustes · Sync Cierres de caja',
  'ajustes.sincronizaciones.almacenes': 'Ajustes · Sync Almacenes',
  'ajustes.sincronizaciones.empleados': 'Ajustes · Sync Empleados',
  'marketing.proponer': 'Marketing · Proponer',
  'marketing.gestionar': 'Marketing · Gestionar',
  'personal.ver': 'Personal · Ver empleados',
  'rrhh.horas': 'RRHH · Horas por facturación',
  'planning_dia.ver': 'Planning del Día (menú)',
};

/**
 * Familias de permisos (orden y agrupación visual de la matriz). Cada familia
 * reúne los códigos que comparten contexto funcional; se definen explícitamente
 * (en vez de partir por el primer segmento del código) para títulos legibles y
 * para no mezclar familias distintas como `usuarios` y `usuarios_agora`.
 */
const GRUPOS_PERMISOS: { titulo: string; codigos: string[] }[] = [
  { titulo: 'Menú lateral', codigos: ['base_datos.ver', 'mantenimiento.ver', 'compras.ver', 'cajas.ver', 'cashflow.ver', 'actuaciones.ver', 'rrpp.ver', 'recursos_humanos.ver', 'rrss.ver', 'mystery_guest.ver', 'reservas.ver'] },
  { titulo: 'Usuarios', codigos: ['usuarios.ver', 'usuarios.crear', 'usuarios.editar', 'usuarios.borrar'] },
  { titulo: 'Locales', codigos: ['locales.ver', 'locales.crear', 'locales.editar', 'locales.borrar'] },
  { titulo: 'Empresas', codigos: ['empresas.ver', 'empresas.crear', 'empresas.editar', 'empresas.importar'] },
  { titulo: 'Productos', codigos: ['productos.ver', 'productos.editar', 'productos.sincronizar'] },
  { titulo: 'Almacenes', codigos: ['almacenes.ver', 'almacenes.crear', 'almacenes.editar', 'almacenes.borrar', 'almacenes.sincronizar'] },
  { titulo: 'Usuarios Ágora', codigos: ['usuarios_agora.ver', 'usuarios_agora.sincronizar'] },
  { titulo: 'Puntos de venta', codigos: ['puntos_venta.ver', 'puntos_venta.editar'] },
  { titulo: 'Permisos', codigos: ['permisos.ver', 'permisos.crear', 'permisos.editar', 'permisos.borrar'] },
  { titulo: 'Cierres teóricos', codigos: ['cierres.ver', 'cierres.crear', 'cierres.editar', 'cierres.borrar', 'cierres.sincronizar', 'cierres.exportar'] },
  { titulo: 'Comparativa fechas', codigos: ['comparativa.ver', 'comparativa.crear', 'comparativa.editar', 'comparativa.borrar', 'comparativa.importar', 'comparativa.exportar'] },
  { titulo: 'Objetivos', codigos: ['objetivos.ver', 'objetivos.compartir'] },
  { titulo: 'Control de excepciones', codigos: ['excepciones.ver', 'excepciones.exportar'] },
  { titulo: 'Top', codigos: ['top.ver', 'top.exportar'] },
  { titulo: 'Mantenimiento', codigos: ['mantenimiento.crear', 'mantenimiento.editar', 'mantenimiento.borrar'] },
  { titulo: 'Pedidos', codigos: ['pedidos.ver', 'pedidos.ver_completados', 'pedidos.preparar', 'pedidos.exportar_traspaso', 'pedidos.crear', 'pedidos.editar', 'pedidos.borrar', 'pedidos.editar_enviado', 'pedidos.borrar_enviado'] },
  { titulo: 'Compras proveedor', codigos: ['compras_proveedor.ver', 'compras_proveedor.sincronizar'] },
  { titulo: 'Acuerdos', codigos: ['acuerdos.ver', 'acuerdos.crear', 'acuerdos.editar', 'acuerdos.borrar', 'acuerdos.exportar'] },
  { titulo: 'Facturación', codigos: ['facturacion.ver', 'facturacion.crear', 'facturacion.editar', 'facturacion.emitir', 'facturacion.anular', 'facturacion.cobrar_pagar', 'facturacion.series', 'facturacion.exportar'] },
  { titulo: 'Ajustes', codigos: ['ajustes.ver', 'ajustes.sincronizaciones.agora_productos', 'ajustes.sincronizaciones.agora_usuarios', 'ajustes.sincronizaciones.compras_proveedor', 'ajustes.sincronizaciones.closeouts', 'ajustes.sincronizaciones.almacenes', 'ajustes.sincronizaciones.empleados'] },
  { titulo: 'Planning del Día', codigos: ['planning_dia.ver'] },
  { titulo: 'Recursos Humanos', codigos: ['personal.ver', 'rrhh.horas'] },
  { titulo: 'Marketing', codigos: ['marketing.proponer', 'marketing.gestionar'] },
];

const TOTAL_PERMISOS = PERMISOS_CODIGOS.length;
const LABEL_COL_WIDTH = 240;
const ROLE_COL_WIDTH = 104;

type ItemPermiso = { rol: string; permiso: string };

function celKey(rol: string, permiso: string): string {
  return `${rol}\u0001${permiso}`;
}

/** Etiqueta corta para la fila: quita el prefijo de familia (lo da el grupo). */
function etiquetaFila(codigo: string): string {
  const label = PERMISOS_LABELS[codigo] ?? codigo;
  const partes = label.split('·');
  return partes.length > 1 ? partes.slice(1).join('·').trim() : label;
}

export default function PermisosScreen() {
  const router = useRouter();
  const [items, setItems] = useState<ItemPermiso[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [colapsados, setColapsados] = useState<Set<string>>(new Set());
  const [savingCells, setSavingCells] = useState<Set<string>>(new Set());

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    apiFetch('/api/permisos/todos')
      .then((res) => res.json())
      .then((data: { items?: ItemPermiso[]; error?: string }) => {
        if (data.error) setError(data.error);
        else setItems(data.items || []);
      })
      .catch((e) => setError(e?.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const asignados = useMemo(
    () => new Set(items.map((i) => celKey(i.rol, i.permiso))),
    [items]
  );

  const conteoPorRol = useMemo(() => {
    const map: Record<string, number> = {};
    for (const rol of ROLES_OPCIONES) {
      map[rol] = PERMISOS_CODIGOS.reduce(
        (acc, codigo) => acc + (asignados.has(celKey(rol, codigo)) ? 1 : 0),
        0
      );
    }
    return map;
  }, [asignados]);

  const q = busqueda.trim().toLowerCase();
  const grupos = useMemo(() => {
    return GRUPOS_PERMISOS.map((g) => {
      const codigos = q
        ? g.codigos.filter(
            (c) =>
              c.toLowerCase().includes(q) ||
              (PERMISOS_LABELS[c] ?? '').toLowerCase().includes(q) ||
              g.titulo.toLowerCase().includes(q)
          )
        : g.codigos;
      return { ...g, codigos };
    }).filter((g) => g.codigos.length > 0);
  }, [q]);

  const toggleGrupoColapsado = useCallback((titulo: string) => {
    setColapsados((prev) => {
      const next = new Set(prev);
      if (next.has(titulo)) next.delete(titulo);
      else next.add(titulo);
      return next;
    });
  }, []);

  const setCeldasGuardando = useCallback((keys: string[], on: boolean) => {
    setSavingCells((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);

  /** Alterna un único permiso para un rol (optimista, revierte si falla). */
  const toggleCelda = useCallback(
    async (rol: string, permiso: string) => {
      const k = celKey(rol, permiso);
      if (savingCells.has(k)) return;
      const tiene = asignados.has(k);
      setItems((prev) =>
        tiene
          ? prev.filter((i) => !(i.rol === rol && i.permiso === permiso))
          : [...prev, { rol, permiso }]
      );
      setCeldasGuardando([k], true);
      try {
        const res = await apiFetch('/api/permisos', {
          method: tiene ? 'DELETE' : 'POST',
          body: JSON.stringify({ rol, permiso }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Error al guardar el permiso');
        }
        setError(null);
      } catch (e) {
        setItems((prev) =>
          tiene
            ? [...prev, { rol, permiso }]
            : prev.filter((i) => !(i.rol === rol && i.permiso === permiso))
        );
        setError(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        setCeldasGuardando([k], false);
      }
    },
    [asignados, savingCells, setCeldasGuardando]
  );

  /** Marca o quita TODA una familia para un rol (si está completa, la vacía). */
  const toggleGrupoRol = useCallback(
    async (codigos: string[], rol: string) => {
      const todos = codigos.every((c) => asignados.has(celKey(rol, c)));
      const objetivoActivo = !todos;
      const cambios = codigos.filter(
        (c) => asignados.has(celKey(rol, c)) !== objetivoActivo
      );
      if (cambios.length === 0) return;
      const keys = cambios.map((c) => celKey(rol, c));
      setItems((prev) => {
        if (objetivoActivo) {
          const faltan = cambios.map((permiso) => ({ rol, permiso }));
          return [...prev, ...faltan];
        }
        const aQuitar = new Set(cambios);
        return prev.filter((i) => !(i.rol === rol && aQuitar.has(i.permiso)));
      });
      setCeldasGuardando(keys, true);
      try {
        const resultados = await Promise.allSettled(
          cambios.map((permiso) =>
            apiFetch('/api/permisos', {
              method: objetivoActivo ? 'POST' : 'DELETE',
              body: JSON.stringify({ rol, permiso }),
            }).then((res) => {
              if (!res.ok) throw new Error('fallo');
            })
          )
        );
        const algunFallo = resultados.some((r) => r.status === 'rejected');
        if (algunFallo) {
          setError('Algunos permisos no se pudieron guardar. Se han recargado los datos.');
          refetch();
        } else {
          setError(null);
        }
      } catch {
        setError('Error al guardar la familia. Se han recargado los datos.');
        refetch();
      } finally {
        setCeldasGuardando(keys, false);
      }
    },
    [asignados, refetch, setCeldasGuardando]
  );

  if (loading && items.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando permisos…</Text>
      </View>
    );
  }

  if (error && items.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Permisos</Text>
        </View>
        <View style={styles.center}>
          <MaterialIcons name="error-outline" size={48} color="#f87171" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const todoColapsado = grupos.every((g) => colapsados.has(g.titulo));

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Permisos</Text>
        <View style={styles.headerSpacer} />
        <TouchableOpacity
          style={styles.headerActionBtn}
          onPress={() => {
            if (todoColapsado) setColapsados(new Set());
            else setColapsados(new Set(GRUPOS_PERMISOS.map((g) => g.titulo)));
          }}
          accessibilityLabel={todoColapsado ? 'Expandir todo' : 'Colapsar todo'}
        >
          <MaterialIcons
            name={todoColapsado ? 'unfold-more' : 'unfold-less'}
            size={20}
            color="#0ea5e9"
          />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.headerActionBtn}
          onPress={refetch}
          disabled={loading}
          accessibilityLabel="Actualizar"
        >
          <MaterialIcons name="refresh" size={20} color={loading ? '#94a3b8' : '#0ea5e9'} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={busqueda}
          onChangeText={setBusqueda}
          placeholder="Buscar permiso o familia…"
          placeholderTextColor="#94a3b8"
        />
        {busqueda.length > 0 && (
          <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={8}>
            <MaterialIcons name="close" size={16} color="#94a3b8" />
          </TouchableOpacity>
        )}
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <MaterialIcons name="error-outline" size={16} color="#dc2626" />
          <Text style={styles.errorBarText}>{error}</Text>
        </View>
      ) : null}

      <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={{ minWidth: LABEL_COL_WIDTH + ROLE_COL_WIDTH * ROLES_OPCIONES.length }}>
          {/* Cabecera: roles + contador por rol */}
          <View style={styles.matrixHeader}>
            <View style={[styles.labelCell, styles.labelHeaderCell]}>
              <Text style={styles.labelHeaderText}>Permiso</Text>
            </View>
            {ROLES_OPCIONES.map((rol) => (
              <View key={rol} style={styles.roleHeadCell}>
                <Text style={styles.roleHeadText} numberOfLines={2}>{rol}</Text>
                <Text style={styles.roleHeadCount}>{conteoPorRol[rol]}/{TOTAL_PERMISOS}</Text>
              </View>
            ))}
          </View>

          <ScrollView style={styles.matrixBody} nestedScrollEnabled>
            {grupos.length === 0 ? (
              <View style={styles.emptyWrap}>
                <MaterialIcons name="search-off" size={40} color="#cbd5e1" />
                <Text style={styles.emptyText}>Sin permisos que coincidan con «{busqueda}».</Text>
              </View>
            ) : (
              grupos.map((g) => {
                const colapsado = !q && colapsados.has(g.titulo);
                return (
                  <View key={g.titulo}>
                    <TouchableOpacity
                      style={styles.groupHeaderRow}
                      onPress={() => toggleGrupoColapsado(g.titulo)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.groupHeaderLabel}>
                        <MaterialIcons
                          name={colapsado ? 'chevron-right' : 'expand-more'}
                          size={20}
                          color="#475569"
                        />
                        <Text style={styles.groupHeaderText}>{g.titulo}</Text>
                        <Text style={styles.groupHeaderCount}>{g.codigos.length}</Text>
                      </View>
                      {ROLES_OPCIONES.map((rol) => {
                        const total = g.codigos.length;
                        const activos = g.codigos.reduce(
                          (acc, c) => acc + (asignados.has(celKey(rol, c)) ? 1 : 0),
                          0
                        );
                        const estado = activos === 0 ? 'none' : activos === total ? 'all' : 'some';
                        return (
                          <TouchableOpacity
                            key={rol}
                            style={styles.groupRoleCell}
                            onPress={() => toggleGrupoRol(g.codigos, rol)}
                            accessibilityLabel={`${estado === 'all' ? 'Quitar' : 'Marcar'} todo ${g.titulo} para ${rol}`}
                          >
                            <MaterialIcons
                              name={
                                estado === 'all'
                                  ? 'check-box'
                                  : estado === 'some'
                                    ? 'indeterminate-check-box'
                                    : 'check-box-outline-blank'
                              }
                              size={18}
                              color={estado === 'none' ? '#cbd5e1' : '#0ea5e9'}
                            />
                          </TouchableOpacity>
                        );
                      })}
                    </TouchableOpacity>

                    {!colapsado &&
                      g.codigos.map((codigo, idx) => (
                        <View
                          key={codigo}
                          style={[styles.matrixRow, idx % 2 === 1 && styles.matrixRowAlt]}
                        >
                          <View style={styles.labelCell}>
                            <Text style={styles.labelText} numberOfLines={1}>
                              {etiquetaFila(codigo)}
                            </Text>
                            <Text style={styles.labelCode} numberOfLines={1}>
                              {codigo}
                            </Text>
                          </View>
                          {ROLES_OPCIONES.map((rol) => {
                            const k = celKey(rol, codigo);
                            const activo = asignados.has(k);
                            const saving = savingCells.has(k);
                            return (
                              <TouchableOpacity
                                key={rol}
                                style={[styles.matrixCell, activo && styles.matrixCellOn]}
                                onPress={() => toggleCelda(rol, codigo)}
                                disabled={saving}
                                activeOpacity={0.6}
                                accessibilityLabel={`${activo ? 'Quitar' : 'Dar'} ${codigo} a ${rol}`}
                              >
                                {saving ? (
                                  <ActivityIndicator size="small" color="#0ea5e9" />
                                ) : activo ? (
                                  <MaterialIcons name="check" size={18} color="#16a34a" />
                                ) : (
                                  <Text style={styles.matrixDash}>—</Text>
                                )}
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      ))}
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  retryBtn: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#fef2f2', borderRadius: 8 },
  retryBtnText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  headerSpacer: { flex: 1 },
  headerActionBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 36,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
    gap: 6,
  },
  searchIcon: { marginRight: 2 },
  searchInput: { flex: 1, fontSize: 13, color: '#334155', paddingVertical: 0, outlineStyle: 'none' as any },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    marginBottom: 8,
  },
  errorBarText: { flex: 1, fontSize: 12, color: '#dc2626' },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  matrixHeader: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    overflow: 'hidden',
  },
  labelCell: {
    width: LABEL_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: 10,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
  },
  labelHeaderCell: { borderRightColor: '#334155' },
  labelHeaderText: { fontSize: 12, fontWeight: '700', color: '#f8fafc' },
  roleHeadCell: {
    width: ROLE_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: '#334155',
  },
  roleHeadText: { fontSize: 11, fontWeight: '700', color: '#f8fafc', textAlign: 'center' },
  roleHeadCount: { fontSize: 10, color: '#94a3b8', marginTop: 2 },
  matrixBody: { flex: 1 },
  groupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  groupHeaderLabel: {
    width: LABEL_COL_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 7,
    paddingHorizontal: 6,
  },
  groupHeaderText: { fontSize: 12, fontWeight: '700', color: '#334155', flex: 1 },
  groupHeaderCount: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  groupRoleCell: {
    width: ROLE_COL_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    borderLeftWidth: 1,
    borderLeftColor: '#cbd5e1',
  },
  matrixRow: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  matrixRowAlt: { backgroundColor: '#fafbfc' },
  labelText: { fontSize: 12, color: '#334155', fontWeight: '500' },
  labelCode: { fontSize: 10, color: '#94a3b8', marginTop: 1 },
  matrixCell: {
    width: ROLE_COL_WIDTH,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: '#f1f5f9',
  },
  matrixCellOn: { backgroundColor: '#f0fdf4' },
  matrixDash: { fontSize: 13, color: '#cbd5e1' },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 50, gap: 10 },
  emptyText: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },
});
