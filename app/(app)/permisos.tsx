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
  Modal,
  Alert,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../utils/api';
import { SelectorDesplegable } from '../components/SelectorDesplegable';
import { MODULOS, PERMISOS_MENU_CONFIGURACION } from '../constants/modulos';

type RolCatalogo = {
  nombre: string;
  descripcion?: string;
  sistema?: boolean;
  orden?: number;
  permisosCount?: number;
};

/**
 * Familias de permisos: cada módulo incluye primero el permiso de acceso (menú)
 * y después las acciones granulares. Una fila = un código; marcar/desmarcar
 * sigue bloqueando o concediendo solo ese permiso al rol.
 */
const GRUPOS_PERMISOS: { titulo: string; codigos: string[] }[] = [
  {
    titulo: 'Configuración (engranaje)',
    codigos: [
      'permisos.ver',
      'permisos.crear',
      'permisos.editar',
      'permisos.borrar',
      'ajustes.ver',
      'ajustes.sincronizaciones.agora_productos',
      'ajustes.sincronizaciones.agora_usuarios',
      'ajustes.sincronizaciones.compras_proveedor',
      'ajustes.sincronizaciones.closeouts',
      'ajustes.sincronizaciones.almacenes',
      'ajustes.sincronizaciones.empleados',
    ],
  },
  {
    titulo: 'Base de datos',
    codigos: [
      'base_datos.ver',
      'usuarios.ver',
      'usuarios.crear',
      'usuarios.editar',
      'usuarios.borrar',
      'locales.ver',
      'locales.crear',
      'locales.editar',
      'locales.borrar',
      'empresas.ver',
      'empresas.crear',
      'empresas.editar',
      'empresas.importar',
      'productos.ver',
      'productos.editar',
      'productos.sincronizar',
      'almacenes.ver',
      'almacenes.crear',
      'almacenes.editar',
      'almacenes.borrar',
      'almacenes.sincronizar',
      'usuarios_agora.ver',
      'usuarios_agora.sincronizar',
      'puntos_venta.ver',
      'puntos_venta.editar',
    ],
  },
  {
    titulo: 'Compras',
    codigos: [
      'compras.ver',
      'pedidos.ver',
      'pedidos.ver_completados',
      'pedidos.preparar',
      'pedidos.exportar_traspaso',
      'pedidos.crear',
      'pedidos.editar',
      'pedidos.borrar',
      'pedidos.editar_enviado',
      'pedidos.borrar_enviado',
      'compras_proveedor.ver',
      'compras_proveedor.sincronizar',
    ],
  },
  {
    titulo: 'Cajas',
    codigos: [
      'cajas.ver',
      'cierres.ver',
      'cierres.crear',
      'cierres.editar',
      'cierres.borrar',
      'cierres.sincronizar',
      'cierres.exportar',
      'formas_pago.editar',
      'comparativa.ver',
      'comparativa.crear',
      'comparativa.editar',
      'comparativa.borrar',
      'comparativa.importar',
      'comparativa.exportar',
      'objetivos.ver',
      'objetivos.compartir',
      'incentivos_producto.ver',
      'incentivos_producto.gestionar',
      'incentivos_producto.exportar',
      'excepciones.ver',
      'excepciones.exportar',
      'top.ver',
      'top.exportar',
    ],
  },
  { titulo: 'Cashflow', codigos: ['cashflow.ver', 'cashflow.registrar', 'cashflow.validar'] },
  {
    titulo: 'Asistentes IA',
    codigos: [
      'ia.informes',
      'ia.informe_objetivos',
      'ia.informe_compras',
      'ia.informe_ventas_hora',
      'ia.prompts_gestionar',
      'ia.ajustes',
    ],
  },
  {
    titulo: 'Actuaciones',
    codigos: [
      'actuaciones.ver',
      'actuaciones.programacion',
      'actuaciones.crear',
      'actuaciones.editar',
      'actuaciones.borrar',
      'actuaciones.firma',
      'actuaciones.facturacion',
    ],
  },
  { titulo: 'Rrpp', codigos: ['rrpp.ver'] },
  {
    titulo: 'Recursos Humanos',
    codigos: ['recursos_humanos.ver', 'personal.ver', 'rrhh.horas'],
  },
  {
    titulo: 'Marketing',
    codigos: ['marketing.proponer', 'marketing.gestionar'],
  },
  { titulo: 'Mystery Guest', codigos: ['mystery_guest.ver'] },
  {
    titulo: 'Reservas',
    codigos: ['reservas.ver', 'activaciones.ver', 'activaciones.gestionar'],
  },
  {
    titulo: 'Acuerdos',
    codigos: [
      'acuerdos.ver',
      'acuerdos.crear',
      'acuerdos.editar',
      'acuerdos.borrar',
      'acuerdos.exportar',
      'mayorista.ver',
      'mayorista.crear',
      'mayorista.editar',
      'mayorista.confirmar',
      'mayorista.borrar',
      'mayorista.exportar',
    ],
  },
  {
    titulo: 'Facturación',
    codigos: [
      'facturacion.ver',
      'facturacion.crear',
      'facturacion.editar',
      'facturacion.emitir',
      'facturacion.anular',
      'facturacion.cobrar_pagar',
      'facturacion.series',
      'facturacion.exportar',
      'remesas.ver',
      'remesas.gestionar',
    ],
  },
  {
    titulo: 'Planning del Día',
    codigos: [
      'planning_dia.ver',
      'planning_dia.objetivo_card',
      'planning_dia.actuaciones',
      'planning_dia.activaciones',
      'planning_dia.arqueo',
    ],
  },
  {
    titulo: 'Mantenimiento',
    codigos: [
      'mantenimiento.ver',
      'mantenimiento.crear',
      'mantenimiento.editar',
      'mantenimiento.borrar',
    ],
  },
  {
    titulo: 'Limpieza',
    codigos: [
      'limpieza.ver',
      'limpieza.completar',
      'limpieza.programar',
      'limpieza.catalogo',
      'limpieza.informes',
      'limpieza.borrar',
    ],
  },
  { titulo: 'Legacy / obsoleto', codigos: ['rrss.ver'] },
];

/** Catálogo plano (sin duplicados); mismo orden que los grupos. */
const PERMISOS_CODIGOS: string[] = GRUPOS_PERMISOS.flatMap((g) => g.codigos);

const PERMISOS_LABELS: Record<string, string> = {
  'rrss.ver': 'Marketing · Ver módulo (obsoleto; usar marketing.proponer)',
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
  'formas_pago.editar': 'Formas de pago · Editar maestro',
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
  'limpieza.ver': 'Limpieza · Ver',
  'limpieza.completar': 'Limpieza · Completar checklist (foto+firma)',
  'limpieza.programar': 'Limpieza · Programar (reglas y plantillas)',
  'limpieza.catalogo': 'Limpieza · Catálogo de objetos',
  'limpieza.informes': 'Limpieza · Informes e histórico',
  'limpieza.borrar': 'Limpieza · Borrar registros',
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
  'acuerdos.crear': 'Acuerdos · Crear',
  'acuerdos.editar': 'Acuerdos · Editar',
  'acuerdos.borrar': 'Acuerdos · Borrar',
  'acuerdos.exportar': 'Acuerdos · Exportar',
  'mayorista.ver': 'Mayorista · Ver operaciones',
  'mayorista.crear': 'Mayorista · Crear operaciones',
  'mayorista.editar': 'Mayorista · Editar borradores',
  'mayorista.confirmar': 'Mayorista · Confirmar operaciones',
  'mayorista.borrar': 'Mayorista · Borrar borradores',
  'mayorista.exportar': 'Mayorista · Exportar PDF',
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
  'marketing.gestionar': 'Marketing · Gestionar',
  'activaciones.ver': 'Activaciones · Ver / marcar realizada',
  'incentivos_producto.ver': 'Incentivos producto · Ver',
  'incentivos_producto.gestionar': 'Incentivos producto · Gestionar',
  'incentivos_producto.exportar': 'Incentivos producto · Exportar',
  'remesas.ver': 'Remesas de pago · Ver',
  'remesas.gestionar': 'Remesas de pago · Gestionar',
  'activaciones.gestionar': 'Activaciones · Gestionar campañas y sesiones',
  'personal.ver': 'Personal · Ver empleados',
  'rrhh.horas': 'RRHH · Horas por facturación',
  'planning_dia.objetivo_card': 'Planning del Día · Card objetivo mensual',
  'planning_dia.actuaciones': 'Planning del Día · Actuaciones del día',
  'planning_dia.activaciones': 'Planning del Día · Activaciones del día',
  'planning_dia.arqueo': 'Planning del Día · Arqueo de caja',
  'actuaciones.programacion': 'Actuaciones · Programación y artistas',
  'actuaciones.crear': 'Actuaciones · Crear actuaciones / huecos',
  'actuaciones.editar': 'Actuaciones · Editar actuaciones',
  'actuaciones.borrar': 'Actuaciones · Borrar actuaciones',
  'actuaciones.firma': 'Actuaciones · Firmar actuación',
  'actuaciones.facturacion': 'Actuaciones · Asociar facturas de gasto',
  'cashflow.registrar': 'Cashflow · Registrar y firmar movimientos',
  'cashflow.validar': 'Cashflow · Validar importes altos y anular',
  'ia.informes': 'Informes IA · Operar (ver, ejecutar y leer)',
  'ia.informe_objetivos': 'Informes IA · Fuente Objetivos (con importes)',
  'ia.informe_compras': 'Informes IA · Fuente Compras',
  'ia.informe_ventas_hora': 'Informes IA · Fuente Ventas por hora',
  'ia.prompts_gestionar': 'Informes IA · Gestionar plantillas de prompt',
  'ia.ajustes': 'Informes IA · Modificar ajustes de la IA',
};

/** Permiso de acceso al módulo en menú lateral (fuente: MODULOS). */
for (const m of MODULOS) {
  if (m.permiso) {
    PERMISOS_LABELS[m.permiso] = `${m.label} · Ver módulo (menú)`;
  }
}
for (const cod of PERMISOS_MENU_CONFIGURACION) {
  if (cod === 'permisos.ver') PERMISOS_LABELS[cod] = 'Permisos · Ver pantalla (engranaje)';
  if (cod === 'ajustes.ver') PERMISOS_LABELS[cod] = 'Ajustes · Ver pantalla (engranaje)';
}

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
  const [rolesCatalogo, setRolesCatalogo] = useState<RolCatalogo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [colapsados, setColapsados] = useState<Set<string>>(new Set());
  const [savingCells, setSavingCells] = useState<Set<string>>(new Set());
  const [modalNuevoRol, setModalNuevoRol] = useState(false);
  const [nombreNuevoRol, setNombreNuevoRol] = useState('');
  const [descNuevoRol, setDescNuevoRol] = useState('');
  const [clonarDeRol, setClonarDeRol] = useState('');
  const [guardandoRol, setGuardandoRol] = useState(false);
  const [errorModalRol, setErrorModalRol] = useState<string | null>(null);

  const rolesNombres = useMemo(
    () => rolesCatalogo.map((r) => r.nombre),
    [rolesCatalogo]
  );

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    Promise.all([
      apiFetch('/api/permisos/todos').then((res) => res.json()),
      apiFetch('/api/roles').then((res) => res.json()),
    ])
      .then(([permData, rolesData]) => {
        if (permData.error) setError(permData.error);
        else setItems(permData.items || []);
        if (rolesData.error && !permData.error) setError(rolesData.error);
        else setRolesCatalogo(rolesData.roles || []);
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
    for (const rol of rolesNombres) {
      map[rol] = PERMISOS_CODIGOS.reduce(
        (acc, codigo) => acc + (asignados.has(celKey(rol, codigo)) ? 1 : 0),
        0
      );
    }
    return map;
  }, [asignados, rolesNombres]);

  const abrirModalNuevoRol = useCallback(() => {
    setNombreNuevoRol('');
    setDescNuevoRol('');
    setClonarDeRol('');
    setErrorModalRol(null);
    setModalNuevoRol(true);
  }, []);

  const cerrarModalNuevoRol = useCallback(() => {
    setModalNuevoRol(false);
    setErrorModalRol(null);
  }, []);

  const crearRol = useCallback(async () => {
    const nombre = nombreNuevoRol.trim();
    if (!nombre) {
      setErrorModalRol('El nombre del rol es obligatorio');
      return;
    }
    setGuardandoRol(true);
    setErrorModalRol(null);
    try {
      const res = await apiFetch('/api/roles', {
        method: 'POST',
        body: JSON.stringify({
          nombre,
          descripcion: descNuevoRol.trim(),
          clonarDe: clonarDeRol || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorModalRol(data.error || 'No se pudo crear el rol');
        return;
      }
      cerrarModalNuevoRol();
      refetch();
    } catch (e) {
      setErrorModalRol(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardandoRol(false);
    }
  }, [nombreNuevoRol, descNuevoRol, clonarDeRol, cerrarModalNuevoRol, refetch]);

  const confirmarEliminarRol = useCallback(
    (rol: RolCatalogo) => {
      if (rol.sistema) return;
      const ejecutar = async () => {
        setLoading(true);
        try {
          const res = await apiFetch(`/api/roles/${encodeURIComponent(rol.nombre)}`, {
            method: 'DELETE',
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setError(data.error || 'No se pudo eliminar el rol');
            return;
          }
          setError(null);
          refetch();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Error de conexión');
        } finally {
          setLoading(false);
        }
      };

      if (Platform.OS === 'web') {
        if (window.confirm(`¿Eliminar el rol «${rol.nombre}»? Solo es posible si ningún usuario lo tiene asignado.`)) {
          ejecutar();
        }
        return;
      }
      Alert.alert(
        'Eliminar rol',
        `¿Eliminar «${rol.nombre}»? Solo es posible si ningún usuario lo tiene asignado.`,
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Eliminar', style: 'destructive', onPress: ejecutar },
        ]
      );
    },
    [refetch]
  );

  const opcionesClonarRol = useMemo(
    () =>
      rolesCatalogo.map((r) => ({
        id: r.nombre,
        titulo: r.nombre,
        subtitulo: r.descripcion || undefined,
        icono: 'badge' as const,
      })),
    [rolesCatalogo]
  );

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
          style={styles.headerActionBtnPrimary}
          onPress={abrirModalNuevoRol}
          accessibilityLabel="Nuevo rol"
        >
          <MaterialIcons name="person-add" size={18} color="#fff" />
          <Text style={styles.headerActionBtnPrimaryText}>Nuevo rol</Text>
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
        <View style={{ minWidth: LABEL_COL_WIDTH + ROLE_COL_WIDTH * Math.max(rolesNombres.length, 1) }}>
          {/* Cabecera: roles + contador por rol */}
          <View style={styles.matrixHeader}>
            <View style={[styles.labelCell, styles.labelHeaderCell]}>
              <Text style={styles.labelHeaderText}>Permiso</Text>
            </View>
            {rolesNombres.length === 0 ? (
              <View style={styles.roleHeadCell}>
                <Text style={styles.roleHeadText}>Sin roles</Text>
              </View>
            ) : (
              rolesCatalogo.map((rol) => (
                <View key={rol.nombre} style={styles.roleHeadCell}>
                  <Text style={styles.roleHeadText} numberOfLines={2}>{rol.nombre}</Text>
                  <Text style={styles.roleHeadCount}>
                    {conteoPorRol[rol.nombre] ?? 0}/{TOTAL_PERMISOS}
                  </Text>
                  {!rol.sistema ? (
                    <TouchableOpacity
                      style={styles.roleDeleteBtn}
                      onPress={() => confirmarEliminarRol(rol)}
                      accessibilityLabel={`Eliminar rol ${rol.nombre}`}
                      hitSlop={6}
                    >
                      <MaterialIcons name="delete-outline" size={14} color="#fca5a5" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))
            )}
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
                      {rolesNombres.map((rol) => {
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
                          {rolesNombres.map((rol) => {
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

      <Modal visible={modalNuevoRol} transparent animationType="fade" onRequestClose={cerrarModalNuevoRol}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Nuevo rol</Text>
            <Text style={styles.modalHint}>
              Crea un rol vacío o copia los permisos de uno existente.
            </Text>
            <Text style={styles.modalLabel}>Nombre</Text>
            <TextInput
              style={styles.modalInput}
              value={nombreNuevoRol}
              onChangeText={setNombreNuevoRol}
              placeholder="Ej. Contabilidad"
              placeholderTextColor="#94a3b8"
              autoCapitalize="words"
            />
            <Text style={styles.modalLabel}>Descripción (opcional)</Text>
            <TextInput
              style={styles.modalInput}
              value={descNuevoRol}
              onChangeText={setDescNuevoRol}
              placeholder="Uso del rol"
              placeholderTextColor="#94a3b8"
            />
            <SelectorDesplegable
              label="Copiar permisos de"
              placeholder="Ninguno (rol vacío)"
              icono="content-copy"
              opciones={opcionesClonarRol}
              valorId={clonarDeRol || null}
              onSeleccionar={(id) => setClonarDeRol(id)}
              tituloLista="Rol origen"
              buscador
            />
            {errorModalRol ? (
              <Text style={styles.modalError}>{errorModalRol}</Text>
            ) : null}
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnSec} onPress={cerrarModalNuevoRol} disabled={guardandoRol}>
                <Text style={styles.modalBtnSecText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtnPri, guardandoRol && styles.modalBtnDisabled]}
                onPress={crearRol}
                disabled={guardandoRol}
              >
                {guardandoRol ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnPriText}>Crear rol</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  headerActionBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#0ea5e9',
  },
  headerActionBtnPrimaryText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  roleDeleteBtn: { marginTop: 4, padding: 2 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 8,
    ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.12)' } : {}),
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#334155' },
  modalHint: { fontSize: 12, color: '#64748b', marginBottom: 4 },
  modalLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginTop: 4 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'web' ? 8 : 10,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#f8fafc',
    outlineStyle: 'none' as any,
  },
  modalError: { fontSize: 12, color: '#dc2626', marginTop: 4 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  modalBtnSec: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  modalBtnSecText: { fontSize: 13, color: '#475569', fontWeight: '600' },
  modalBtnPri: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
    minWidth: 100,
    alignItems: 'center',
  },
  modalBtnPriText: { fontSize: 13, color: '#fff', fontWeight: '600' },
  modalBtnDisabled: { opacity: 0.7 },
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
