import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { ICONS, ICON_SIZE } from '../constants/icons';
import { erpTableStyles } from '../constants/erpTableStyles';
import { colors, iconSize } from '../constants/theme';
import { EstadoVacio } from '../components/ui/EstadoVacio';
import { emailValido } from '../utils/validation';
import { formatId6 } from '../utils/idFormat';
import { useAuth, UserSession } from '../contexts/AuthContext';
import { SelectorDesplegable } from '../components/SelectorDesplegable';
import { apiFetch } from '../utils/api';
import { calcularProximoIdLocal } from '../lib/localId';
import type { Departamento } from '../types/tasks';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const MAX_TEXT_LENGTH = 30;

// Atributos exactos de la tabla igp_usuarios en AWS (mismo orden que api/server.js TABLE_USUARIOS_ATTRS). No añadir campos nuevos.
const ATRIBUTOS_TABLA_USUARIOS = ['id_usuario', 'Nombre', 'Apellidos', 'Email', 'Password', 'Telefono', 'Rol', 'Local'] as const;

/**
 * Columnas de la tabla: todos los atributos menos `Password`, que no se muestra,
 * más `Departamentos`.
 *
 * `Departamentos` va aparte y no dentro de `ATRIBUTOS_TABLA_USUARIOS` porque ese
 * array es también el bucle que construye el cuerpo al guardar, y el campo es
 * disperso: se escribe por su cuenta. Aquí solo se muestra, resuelto a nombres.
 */
const ORDEN_COLUMNAS: string[] = [
  ...ATRIBUTOS_TABLA_USUARIOS.filter((k) => k !== 'Password'),
  'Departamentos',
];

const COL_LABELS: Record<string, string> = {
  id_usuario: 'ID',
  Nombre: 'Nombre',
  Apellidos: 'Apellidos',
  Email: 'Email',
  Telefono: 'Teléfono',
  Rol: 'Rol',
  Local: 'Local',
  Departamentos: 'Departamentos',
};

function labelColumna(col: string): string {
  return (COL_LABELS[col] ?? col).toUpperCase();
}

type ToolbarSecId = 'editar' | 'borrar';

// Campos del formulario nuevo registro (todos menos id_usuario, que se calcula en el servidor/app)
const CAMPOS_FORM: { key: (typeof ATRIBUTOS_TABLA_USUARIOS)[number]; label: string; secure?: boolean }[] = [
  { key: 'Nombre', label: 'Nombre' },
  { key: 'Apellidos', label: 'Apellidos' },
  { key: 'Email', label: 'Email' },
  { key: 'Password', label: 'Password', secure: true },
  { key: 'Telefono', label: 'Teléfono' },
  { key: 'Rol', label: 'Rol' },
  { key: 'Local', label: 'Local' },
];

const INITIAL_FORM = Object.fromEntries(CAMPOS_FORM.map((c) => [c.key, ''])) as Record<(typeof ATRIBUTOS_TABLA_USUARIOS)[number], string>;

type RolCatalogo = { nombre: string; descripcion?: string; sistema?: boolean };

type Usuario = Record<string, string | number | undefined>;

/** Ítem de igp_Locales (API puede devolver nombre/sede en minúsculas o PascalCase) */
type LocalItem = { sede?: string; Sede?: string; nombre?: string; Nombre?: string; id_Locales?: string };

function truncar(val: string): string {
  if (val.length <= MAX_TEXT_LENGTH) return val;
  return val.slice(0, MAX_TEXT_LENGTH - 3) + '…';
}

export default function UsuariosScreen() {
  const router = useRouter();
  const { hasPermiso, user, setUser } = useAuth();
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Las dos columnas de lista nacen más anchas: llevan varios valores separados por comas.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ Local: 160, Departamentos: 160 });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [modalNuevoVisible, setModalNuevoVisible] = useState(false);
  const [editingUsuarioId, setEditingUsuarioId] = useState<string | null>(null);
  const [formNuevo, setFormNuevo] = useState<Record<string, string>>(INITIAL_FORM);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [localSearchFilter, setLocalSearchFilter] = useState('');
  // Lista completa: el desplegable solo muestra los de Grupo Paripe, pero el próximo
  // `id_Locales` libre debe calcularse sobre todos para no pisar ninguno.
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [formLocales, setFormLocales] = useState<string[]>([]);
  // Maestro completo: el desplegable solo ofrece los activos, pero los inactivos
  // hacen falta para resolver el nombre de los que un usuario ya tenga grabados.
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  // Si el maestro no carga (p. ej. limitador de peticiones), el formulario lo
  // avisa: los ids ya asignados se conservan, pero no se pueden resolver.
  const [errorDepartamentos, setErrorDepartamentos] = useState(false);
  const [formDepartamentos, setFormDepartamentos] = useState<string[]>([]);
  const [deptoDropdownOpen, setDeptoDropdownOpen] = useState(false);
  const [deptoSearchFilter, setDeptoSearchFilter] = useState('');
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [modalCrearLocalVisible, setModalCrearLocalVisible] = useState(false);
  const [formCrearLocal, setFormCrearLocal] = useState({ Nombre: '' });
  const [guardandoCrearLocal, setGuardandoCrearLocal] = useState(false);
  const [errorCrearLocal, setErrorCrearLocal] = useState<string | null>(null);
  const [rolesCatalogo, setRolesCatalogo] = useState<RolCatalogo[]>([]);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const abrirModalNuevo = () => {
    setEditingUsuarioId(null);
    setFormNuevo(INITIAL_FORM);
    setFormLocales([]);
    setFormDepartamentos([]);
    setModalNuevoVisible(true);
    setErrorForm(null);
    setLocalDropdownOpen(false);
    setLocalSearchFilter('');
    setDeptoDropdownOpen(false);
    setDeptoSearchFilter('');
  };
  const abrirModalEditar = (usuario: Usuario) => {
    const form: Record<string, string> = { ...INITIAL_FORM };
    for (const key of CAMPOS_FORM.map((c) => c.key)) {
      if (key === 'Local') continue;
      const v = usuario[key];
      form[key] = v != null ? String(v) : '';
    }
    form.Password = '';
    const rawLocal = usuario.Local;
    const locArr = Array.isArray(rawLocal)
      ? (rawLocal as string[]).filter((l) => l != null && String(l).trim() !== '').map((l) => String(l).trim())
      : (rawLocal != null && String(rawLocal).trim() !== '' ? [String(rawLocal).trim()] : []);
    setFormLocales(locArr);
    // `Departamentos` es una lista de IDs y es un atributo disperso: ausente en
    // quien no tenga ninguno, y entonces vale lista vacía.
    const rawDeptos = usuario.Departamentos;
    setFormDepartamentos(
      Array.isArray(rawDeptos)
        ? (rawDeptos as string[]).map((d) => String(d).trim()).filter(Boolean)
        : [],
    );
    setFormNuevo(form);
    setEditingUsuarioId(usuario.id_usuario != null ? String(usuario.id_usuario) : null);
    setModalNuevoVisible(true);
    setErrorForm(null);
    setLocalDropdownOpen(false);
    setLocalSearchFilter('');
    setDeptoDropdownOpen(false);
    setDeptoSearchFilter('');
  };
  const cerrarModalNuevo = () => {
    setModalNuevoVisible(false);
    setFormNuevo(INITIAL_FORM);
    setFormLocales([]);
    setFormDepartamentos([]);
    setEditingUsuarioId(null);
    setErrorForm(null);
    setLocalDropdownOpen(false);
    setLocalSearchFilter('');
    setDeptoDropdownOpen(false);
    setDeptoSearchFilter('');
  };
  const abrirModalCrearLocal = () => {
    setFormCrearLocal({ Nombre: '' });
    setErrorCrearLocal(null);
    setModalCrearLocalVisible(true);
  };

  const cerrarModalCrearLocal = () => {
    setModalCrearLocalVisible(false);
    setFormCrearLocal({ Nombre: '' });
    setErrorCrearLocal(null);
  };

  const guardarCrearLocal = async () => {
    const nombre = formCrearLocal.Nombre?.trim();
    if (!nombre) {
      setErrorCrearLocal('Nombre es obligatorio');
      return;
    }
    setErrorCrearLocal(null);
    setGuardandoCrearLocal(true);
    try {
      const res = await apiFetch('/api/locales', {
        method: 'POST',
        body: JSON.stringify({
          // Sin id el backend guardaría el local con `000000` y pisaría el que ya lo tenga.
          id_Locales: calcularProximoIdLocal(locales),
          Nombre: nombre,
          Sede: 'Grupo Paripe',
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        if (res.status === 409) {
          // Alguien ha creado un local mientras tanto: al recargar la lista el siguiente id ya es libre.
          refetchLocales();
          setErrorCrearLocal('Ese identificador de local acaba de ocuparse. Vuelve a pulsar «Crear» para reintentarlo.');
          return;
        }
        setErrorCrearLocal(data.error || 'Error al crear local');
        return;
      }
      refetchLocales();
      setFormLocales((prev) => prev.includes(nombre) ? prev : [...prev, nombre]);
      setLocalSearchFilter('');
      cerrarModalCrearLocal();
    } catch (e) {
      setErrorCrearLocal('No se pudo conectar con el servidor');
    } finally {
      setGuardandoCrearLocal(false);
    }
  };

  const rolOpciones = useMemo(
    () =>
      [...rolesCatalogo]
        .sort((a, b) => a.nombre.localeCompare(b.nombre))
        .map((r) => ({
          id: r.nombre,
          titulo: r.nombre,
          subtitulo: r.descripcion || undefined,
          icono: 'badge' as const,
        })),
    [rolesCatalogo]
  );
  const localesGrupoParipe = useMemo(
    () => locales.filter((item) => (item.sede ?? item.Sede ?? '') === 'Grupo Paripe'),
    [locales],
  );
  const localesFiltrados = useMemo(() => {
    const q = localSearchFilter.trim().toLowerCase();
    const list = !q ? localesGrupoParipe : localesGrupoParipe.filter((l) => {
      const n = (l.nombre ?? l.Nombre ?? '').toLowerCase();
      return n.includes(q);
    });
    return [...list].sort((a, b) => {
      const na = (a.nombre ?? a.Nombre ?? '').toLowerCase();
      const nb = (b.nombre ?? b.Nombre ?? '').toLowerCase();
      return na.localeCompare(nb);
    });
  }, [localesGrupoParipe, localSearchFilter]);
  const nombreDepartamento = useCallback(
    // Nunca el id crudo: si el maestro no está cargado o el departamento ya no
    // existe, un texto legible. El id asignado se conserva igualmente.
    (id: string) => departamentos.find((d) => d.id === id)?.nombre?.trim() || 'Departamento no disponible',
    [departamentos],
  );
  /**
   * Los departamentos de un usuario, en texto, para la celda de la tabla y para el
   * buscador.
   *
   * El marcador de los que no se pueden resolver va **una sola vez** con su
   * recuento, en lugar de por cada id: lo que falla es la carga del maestro, y
   * falla para todos a la vez, así que repetirlo llenaría la celda de ruido.
   */
  const textoDepartamentos = useCallback(
    (valor: unknown): string => {
      const ids = Array.isArray(valor) ? valor.map((v) => String(v).trim()).filter(Boolean) : [];
      if (ids.length === 0) return '—';
      const nombres: string[] = [];
      let sinResolver = 0;
      for (const id of ids) {
        const nombre = departamentos.find((d) => d.id === id)?.nombre?.trim();
        if (nombre) nombres.push(nombre);
        else sinResolver += 1;
      }
      nombres.sort((a, b) => a.localeCompare(b, 'es'));
      if (sinResolver > 0) nombres.push(`${sinResolver} sin resolver`);
      return nombres.join(', ');
    },
    [departamentos],
  );
  /**
   * Solo los activos, más los inactivos que el usuario ya tuviera grabados: si
   * desaparecieran de la lista se le borrarían sin querer al guardar.
   */
  const departamentosSeleccionables = useMemo(() => {
    const yaAsignados = new Set(formDepartamentos);
    const visibles = departamentos.filter((d) => d.activo || yaAsignados.has(d.id));
    const q = deptoSearchFilter.trim().toLowerCase();
    const filtrados = q ? visibles.filter((d) => (d.nombre ?? '').toLowerCase().includes(q)) : visibles;
    return [...filtrados].sort((a, b) => (a.nombre ?? '').localeCompare(b.nombre ?? '', 'es'));
  }, [departamentos, formDepartamentos, deptoSearchFilter]);

  const ordenarPorId = useCallback((lista: Usuario[]) => {
    return [...lista].sort((a, b) => {
      const na = typeof a.id_usuario === 'number' ? a.id_usuario : parseInt(String(a.id_usuario ?? 0).replace(/^0+/, ''), 10) || 0;
      const nb = typeof b.id_usuario === 'number' ? b.id_usuario : parseInt(String(b.id_usuario ?? 0).replace(/^0+/, ''), 10) || 0;
      return na - nb;
    });
  }, []);

  const refetchUsuarios = useCallback(() => {
    apiFetch('/api/usuarios')
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setUsuarios(ordenarPorId(data.usuarios || []));
      })
      .catch((e) => setError(e.message || 'Error de conexión'));
  }, [ordenarPorId]);

  const refetchRoles = useCallback(() => {
    apiFetch('/api/roles')
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) setRolesCatalogo(data.roles || []);
      })
      .catch(() => {});
  }, []);

  const guardarNuevo = async () => {
    const isEdit = editingUsuarioId != null;
    if (!formNuevo.Email?.trim()) {
      setErrorForm('Email es obligatorio');
      return;
    }
    if (!isEdit && !formNuevo.Password) {
      setErrorForm('Email y Password son obligatorios');
      return;
    }
    if (!emailValido(formNuevo.Email)) {
      setErrorForm('El email debe contener @');
      return;
    }
    if (isEdit) {
      const original = usuarios.find((u) => String(u.id_usuario) === editingUsuarioId);
      if (original && String(original.Rol) === 'Administrador' && formNuevo.Rol !== 'Administrador') {
        const admins = usuarios.filter((u) => String(u.Rol) === 'Administrador');
        if (admins.length <= 1) {
          setErrorForm('Debe haber al menos un usuario con rol Administrador');
          return;
        }
      }
    }
    setErrorForm(null);
    setGuardando(true);
    try {
      const body: Record<string, string | number | string[]> = {};
      for (const key of ATRIBUTOS_TABLA_USUARIOS) {
        if (key === 'id_usuario') body[key] = isEdit ? editingUsuarioId! : próximoId;
        else if (key === 'Email') body[key] = (formNuevo.Email ?? '').trim();
        else if (key === 'Password') body[key] = formNuevo.Password ?? '';
        else if (key === 'Local') body[key] = formLocales;
        else body[key] = formNuevo[key] ?? '';
      }
      // Campo aprobado en D-12: lista de IDs de departamento, no de nombres.
      body.Departamentos = formDepartamentos;
      const url = '/api/usuarios';
      const res = await apiFetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      if (isEdit && editingUsuarioId === user?.id_usuario) {
        const updatedSession: UserSession = {
          ...user!,
          Nombre: (formNuevo.Nombre ?? '').trim() || user!.Nombre,
          email: (formNuevo.Email ?? '').trim().toLowerCase() || user!.email,
          Rol: (formNuevo.Rol ?? '').trim() || user!.Rol,
          Locales: formLocales.length > 0 ? formLocales : user!.Locales,
          Departamentos: formDepartamentos,
        };
        setUser(updatedSession);
      }
      refetchUsuarios();
      setSelectedRowIndex(null);
      cerrarModalNuevo();
    } catch (e) {
      setErrorForm('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const borrarSeleccionado = async () => {
    if (selectedRowIndex == null) return;
    const usuario = usuariosFiltrados[selectedRowIndex];
    const id = usuario?.id_usuario != null ? String(usuario.id_usuario) : '';
    if (!id) return;
    if (String(usuario.Rol) === 'Administrador') {
      const admins = usuarios.filter((u) => String(u.Rol) === 'Administrador');
      if (admins.length <= 1) {
        setError('No se puede borrar: debe haber al menos un Administrador');
        return;
      }
    }
    setGuardando(true);
    try {
      const res = await apiFetch('/api/usuarios', {
        method: 'DELETE',
        body: JSON.stringify({ id_usuario: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      refetchUsuarios();
      setSelectedRowIndex(null);
    } catch (e) {
      setError('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const próximoId = (() => {
    if (!usuarios.length) return formatId6(1);
    const ids = usuarios.map((u) => {
      const v = u.id_usuario ?? 0;
      const n = typeof v === 'number' ? v : parseInt(String(v).replace(/^0+/, ''), 10);
      return Number.isNaN(n) ? 0 : n;
    });
    return formatId6(Math.max(0, ...ids) + 1);
  })();

  const seleccionarFila = (idx: number) => {
    setSelectedRowIndex((prev) => (prev === idx ? null : idx));
  };

  const puedeCrear = hasPermiso('usuarios.crear');
  const puedeEditar = hasPermiso('usuarios.editar');
  const puedeBorrar = hasPermiso('usuarios.borrar');

  const toolbarSecundarios = [
    puedeEditar && { id: 'editar' as const, label: 'Editar', icon: ICONS.edit as ComponentProps<typeof MaterialIcons>['name'] },
    puedeBorrar && { id: 'borrar' as const, label: 'Borrar', icon: ICONS.delete as ComponentProps<typeof MaterialIcons>['name'] },
  ].filter(Boolean) as { id: ToolbarSecId; label: string; icon: ComponentProps<typeof MaterialIcons>['name'] }[];

  const filaSeleccionDisabled = selectedRowIndex == null;
  const toolbarBusy = guardando;

  const valorCelda = useCallback((usuario: Usuario, col: string) => {
    if (col.startsWith('id_') && usuario[col] != null) {
      return formatId6(usuario[col]);
    }
    if (col === 'Local') {
      const locVal = usuario[col];
      if (Array.isArray(locVal)) return (locVal as string[]).join(', ') || '—';
      return locVal != null && String(locVal).trim() !== '' ? String(locVal) : '—';
    }
    // `Local` guarda nombres y se pinta tal cual; `Departamentos` guarda IDs y hay
    // que resolverlos contra el maestro.
    if (col === 'Departamentos') return textoDepartamentos(usuario[col]);
    const raw = usuario[col];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') return String(raw);
    return '—';
  }, [textoDepartamentos]);

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? DEFAULT_COL_WIDTH, [columnWidths]);

  const columnas = useMemo(() => {
    if (!usuarios.length) return [];
    const keys = Object.keys(usuarios[0]).filter((k) => k !== 'Password');
    // `Departamentos` es un atributo disperso: si el primer usuario de la lista no
    // tiene ninguno, no está entre sus claves y la columna desaparecería para todos.
    return ORDEN_COLUMNAS.filter((k) => k === 'Departamentos' || keys.includes(k));
  }, [usuarios]);

  const usuariosFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return usuarios;
    return usuarios.filter((u) => {
      return columnas.some((col) => {
        const val = u[col];
        // Se busca sobre los nombres, no sobre los IDs guardados: nadie escribe un
        // UUID en el buscador.
        if (col === 'Departamentos') return textoDepartamentos(val).toLowerCase().includes(q);
        if (Array.isArray(val)) return val.some((v) => String(v).toLowerCase().includes(q));
        return val != null && String(val).toLowerCase().includes(q);
      });
    });
  }, [usuarios, filtroBusqueda, columnas, textoDepartamentos]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/usuarios')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setUsuarios(ordenarPorId(data.usuarios || []));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Error de conexión');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ordenarPorId]);

  const refetchLocales = useCallback(() => {
    apiFetch('/api/locales')
      .then((res) => res.json())
      .then((data: { locales?: LocalItem[] }) => setLocales(data.locales || []))
      .catch(() => setLocales([]));
  }, []);

  const refetchDepartamentos = useCallback(() => {
    apiFetch('/api/departamentos')
      .then((res) => res.json())
      .then((data: { departamentos?: Departamento[]; error?: string }) => {
        if (data.error || !Array.isArray(data.departamentos)) {
          setDepartamentos([]);
          setErrorDepartamentos(true);
          return;
        }
        setDepartamentos(data.departamentos);
        setErrorDepartamentos(false);
      })
      .catch(() => {
        setDepartamentos([]);
        setErrorDepartamentos(true);
      });
  }, []);

  useEffect(() => {
    refetchLocales();
  }, [refetchLocales]);

  useEffect(() => {
    refetchDepartamentos();
  }, [refetchDepartamentos]);

  useEffect(() => {
    refetchRoles();
  }, [refetchRoles]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.max(MIN_COL_WIDTH, r.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [r.col]: next }));
    };
    const handleUp = () => {
      resizeRef.current = null;
      setResizingCol(null);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [resizingCol]);

  const handleResizeStart = (col: string, e: { nativeEvent?: { clientX: number }; clientX?: number }) => {
    if (Platform.OS !== 'web') return;
    const clientX = e.nativeEvent?.clientX ?? (e as { clientX: number }).clientX ?? 0;
    resizeRef.current = { col, startX: clientX, startWidth: getColWidth(col) };
    setResizingCol(col);
  };

  if (loading) {
    return (
      <View style={erpTableStyles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={erpTableStyles.loadingText}>Cargando usuarios…</Text>
      </View>
    );
  }

  if (error && usuarios.length === 0) {
    return (
      <View style={erpTableStyles.center}>
        <MaterialIcons name="error-outline" size={48} color={colors.danger} />
        <Text style={erpTableStyles.errorText}>{error}</Text>
        <TouchableOpacity style={erpTableStyles.btnPrimary} onPress={refetchUsuarios}>
          <MaterialIcons name="refresh" size={iconSize.chip} color={colors.surface} />
          <Text style={erpTableStyles.btnPrimaryText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={erpTableStyles.screen}>
      <View style={erpTableStyles.headerRow}>
        <Pressable onPress={() => router.back()} style={erpTableStyles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={iconSize.tab} color={colors.textPrimary} />
        </Pressable>
        <Text style={erpTableStyles.title}>Usuarios</Text>
      </View>

      <View style={erpTableStyles.subtitleRow}>
        <Text style={erpTableStyles.subtitle}>
          {usuariosFiltrados.length} usuario{usuariosFiltrados.length === 1 ? '' : 's'}
          {filtroBusqueda.trim() ? ` · filtrado de ${usuarios.length}` : ''}
        </Text>
      </View>

      <View style={erpTableStyles.toolbarRow}>
        <View style={erpTableStyles.toolbar}>
          {puedeCrear ? (
            <TouchableOpacity
              style={erpTableStyles.btnPrimary}
              onPress={abrirModalNuevo}
              disabled={toolbarBusy}
              accessibilityLabel="Nuevo usuario"
            >
              <MaterialIcons name={ICONS.add} size={iconSize.chip} color={colors.surface} />
              <Text style={erpTableStyles.btnPrimaryText}>Nuevo usuario</Text>
            </TouchableOpacity>
          ) : null}

          {toolbarSecundarios.map((btn) => {
            const disabled = toolbarBusy || filaSeleccionDisabled;
            return (
              <View
                key={btn.id}
                style={erpTableStyles.toolbarBtnWrap}
                {...(Platform.OS === 'web'
                  ? ({
                      onMouseEnter: () => setHoveredBtn(btn.id),
                      onMouseLeave: () => setHoveredBtn(null),
                    } as object)
                  : {})}
              >
                {hoveredBtn === btn.id ? (
                  <View style={erpTableStyles.tooltip}>
                    <Text style={erpTableStyles.tooltipText}>{btn.label}</Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  style={[erpTableStyles.toolbarBtn, disabled && erpTableStyles.toolbarBtnDisabled]}
                  onPress={() => {
                    if (btn.id === 'editar' && selectedRowIndex != null) {
                      abrirModalEditar(usuariosFiltrados[selectedRowIndex]);
                    }
                    if (btn.id === 'borrar' && selectedRowIndex != null) borrarSeleccionado();
                  }}
                  disabled={disabled}
                  accessibilityLabel={btn.label}
                >
                  <MaterialIcons
                    name={btn.icon}
                    size={ICON_SIZE}
                    color={disabled ? colors.textMuted : colors.textSecondary}
                  />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        <View style={[erpTableStyles.searchWrap, erpTableStyles.searchWrapFlex]}>
          <MaterialIcons name="search" size={iconSize.chip} color={colors.textSecondary} style={erpTableStyles.searchIcon} />
          <TextInput
            style={erpTableStyles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor={colors.textMuted}
          />
        </View>
      </View>

      <ScrollView
        style={erpTableStyles.scrollVertical}
        contentContainerStyle={erpTableStyles.scrollVerticalContent}
        showsVerticalScrollIndicator
      >
        <ScrollView
          horizontal
          style={erpTableStyles.scrollTable}
          contentContainerStyle={erpTableStyles.scrollTableContent}
          showsHorizontalScrollIndicator
        >
          <View style={erpTableStyles.table}>
            <View style={erpTableStyles.rowHeader}>
              {columnas.map((col, colIdx) => (
                <View
                  key={col}
                  style={[
                    erpTableStyles.cellHeader,
                    colIdx === columnas.length - 1 && erpTableStyles.cellHeaderLast,
                    { width: getColWidth(col), minWidth: MIN_COL_WIDTH },
                  ]}
                >
                  <Text style={erpTableStyles.cellHeaderText} numberOfLines={1}>
                    {labelColumna(col)}
                  </Text>
                  {Platform.OS === 'web' ? (
                    <View
                      style={erpTableStyles.resizeHandle}
                      {...({
                        onMouseDown: (e: { nativeEvent?: { clientX: number }; clientX?: number }) =>
                          handleResizeStart(col, e),
                      } as object)}
                    />
                  ) : null}
                </View>
              ))}
            </View>

            {usuariosFiltrados.length === 0 ? (
              <EstadoVacio
                icon="people"
                mensaje={
                  filtroBusqueda.trim()
                    ? 'No hay usuarios que coincidan con la búsqueda.'
                    : 'No hay usuarios registrados.'
                }
                accion={
                  puedeCrear && !filtroBusqueda.trim() ? (
                    <TouchableOpacity style={erpTableStyles.btnPrimary} onPress={abrirModalNuevo}>
                      <MaterialIcons name={ICONS.add} size={iconSize.chip} color={colors.surface} />
                      <Text style={erpTableStyles.btnPrimaryText}>Nuevo usuario</Text>
                    </TouchableOpacity>
                  ) : undefined
                }
              />
            ) : (
              usuariosFiltrados.map((usuario, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={[
                    erpTableStyles.row,
                    idx === usuariosFiltrados.length - 1 && erpTableStyles.rowLast,
                    selectedRowIndex === idx && erpTableStyles.rowSelected,
                  ]}
                  onPress={() => seleccionarFila(idx)}
                  activeOpacity={0.7}
                >
                  {columnas.map((col, colIdx) => (
                    <View
                      key={col}
                      style={[
                        erpTableStyles.cell,
                        colIdx === columnas.length - 1 && erpTableStyles.cellLast,
                        { width: getColWidth(col), minWidth: MIN_COL_WIDTH },
                      ]}
                    >
                      <Text style={erpTableStyles.cellText} numberOfLines={1} ellipsizeMode="tail">
                        {truncar(valorCelda(usuario, col))}
                      </Text>
                    </View>
                  ))}
                </TouchableOpacity>
              ))
            )}
          </View>
        </ScrollView>
      </ScrollView>

      <Modal
        visible={modalNuevoVisible}
        transparent
        animationType="fade"
        onRequestClose={cerrarModalNuevo}
      >
        <TouchableOpacity style={erpTableStyles.modalOverlayCenter} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView
            style={erpTableStyles.modalContentWrap}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: '100%' }}>
              <View style={erpTableStyles.modalCard}>
                <View style={erpTableStyles.modalHeader}>
                  <Text style={erpTableStyles.modalHeaderTitle}>
                    {editingUsuarioId != null ? 'Editar usuario' : 'Nuevo usuario'}
                  </Text>
                  <TouchableOpacity onPress={cerrarModalNuevo} style={erpTableStyles.modalCloseBtn}>
                    <MaterialIcons name="close" size={iconSize.tab} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
                <View style={erpTableStyles.modalBodyRow}>
                  <View style={erpTableStyles.modalIdSide}>
                    <Text style={erpTableStyles.modalIdLabel}>ID</Text>
                    <Text style={erpTableStyles.modalIdValue}>{formatId6(editingUsuarioId ?? próximoId)}</Text>
                  </View>
                  <ScrollView style={erpTableStyles.modalBodyScroll} keyboardShouldPersistTaps="handled">
                    {CAMPOS_FORM.map((campo) =>
                      campo.key === 'Rol' ? (
                        <View key={campo.key} style={erpTableStyles.formGroup}>
                          <SelectorDesplegable
                            label={campo.label}
                            icono="badge"
                            placeholder={`${campo.label}…`}
                            tituloLista="Selecciona un rol"
                            iconoLista="badge"
                            buscador
                            buscadorPlaceholder="Buscar rol…"
                            valorId={formNuevo.Rol || ''}
                            opciones={[{ id: '', titulo: '(sin rol)' }, ...rolOpciones]}
                            onSeleccionar={(id) => setFormNuevo((prev) => ({ ...prev, Rol: id }))}
                          />
                        </View>
                      ) : campo.key === 'Local' ? (
                        <View key={campo.key} style={erpTableStyles.formGroup}>
                          <Text style={erpTableStyles.formLabel}>{campo.label} (multi)</Text>
                          <TouchableOpacity
                            style={[erpTableStyles.formInput, erpTableStyles.formInputRow]}
                            onPress={() => setLocalDropdownOpen((o) => !o)}
                            activeOpacity={0.7}
                          >
                            <Text
                              style={[
                                erpTableStyles.formInputText,
                                formLocales.length === 0 && erpTableStyles.formInputPlaceholder,
                              ]}
                              numberOfLines={1}
                            >
                              {formLocales.length > 0 ? formLocales.join(', ') : 'Seleccionar locales…'}
                            </Text>
                            <MaterialIcons
                              name={localDropdownOpen ? 'expand-less' : 'expand-more'}
                              size={iconSize.chip}
                              color={colors.textSecondary}
                              style={{ marginLeft: 4 }}
                            />
                          </TouchableOpacity>
                          {formLocales.length > 0 ? (
                            <View style={erpTableStyles.localesChipsWrap}>
                              {formLocales.map((loc) => (
                                <View key={loc} style={erpTableStyles.localChip}>
                                  <Text style={erpTableStyles.localChipText} numberOfLines={1}>
                                    {loc}
                                  </Text>
                                  <TouchableOpacity
                                    onPress={() => setFormLocales((prev) => prev.filter((l) => l !== loc))}
                                    style={erpTableStyles.localChipRemove}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="close" size={14} color={colors.textSecondary} />
                                  </TouchableOpacity>
                                </View>
                              ))}
                            </View>
                          ) : null}
                          {localDropdownOpen ? (
                            <View style={erpTableStyles.dropdownWrap}>
                              <TextInput
                                style={erpTableStyles.dropdownSearch}
                                value={localSearchFilter}
                                onChangeText={setLocalSearchFilter}
                                placeholder="Buscar local…"
                                placeholderTextColor={colors.textMuted}
                              />
                              <ScrollView style={erpTableStyles.dropdownScroll} keyboardShouldPersistTaps="handled">
                                {formLocales.length > 0 ? (
                                  <TouchableOpacity
                                    style={[erpTableStyles.dropdownOption, erpTableStyles.dropdownVaciarOption]}
                                    onPress={() => {
                                      setFormLocales([]);
                                      setLocalSearchFilter('');
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="clear" size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
                                    <Text style={erpTableStyles.dropdownVaciarText}>Quitar todos</Text>
                                  </TouchableOpacity>
                                ) : null}
                                {localesGrupoParipe.length === 0 ? (
                                  <>
                                    <View style={erpTableStyles.dropdownOption}>
                                      <Text style={erpTableStyles.dropdownOptionText}>Sin locales</Text>
                                    </View>
                                    <TouchableOpacity
                                      style={[erpTableStyles.dropdownOption, erpTableStyles.dropdownCrearOption]}
                                      onPress={() => {
                                        setLocalDropdownOpen(false);
                                        abrirModalCrearLocal();
                                      }}
                                      activeOpacity={0.7}
                                    >
                                      <MaterialIcons name="add-circle-outline" size={16} color={colors.accent} style={{ marginRight: 6 }} />
                                      <Text style={erpTableStyles.dropdownCrearText}>Crear nuevo local</Text>
                                    </TouchableOpacity>
                                  </>
                                ) : localesFiltrados.length === 0 ? (
                                  <TouchableOpacity
                                    style={[erpTableStyles.dropdownOption, erpTableStyles.dropdownCrearOption]}
                                    onPress={() => {
                                      setLocalDropdownOpen(false);
                                      abrirModalCrearLocal();
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="add-circle-outline" size={16} color={colors.accent} style={{ marginRight: 6 }} />
                                    <Text style={erpTableStyles.dropdownCrearText}>Crear nuevo local</Text>
                                  </TouchableOpacity>
                                ) : (
                                  <>
                                    {localesFiltrados.map((loc) => {
                                      const nombre = loc.nombre ?? loc.Nombre ?? '';
                                      const isSelected = formLocales.includes(nombre);
                                      return (
                                        <TouchableOpacity
                                          key={loc.id_Locales ?? nombre}
                                          style={[
                                            erpTableStyles.dropdownOption,
                                            isSelected && erpTableStyles.dropdownOptionSelected,
                                          ]}
                                          onPress={() => {
                                            setFormLocales((prev) =>
                                              isSelected ? prev.filter((l) => l !== nombre) : [...prev, nombre],
                                            );
                                          }}
                                          activeOpacity={0.7}
                                        >
                                          <MaterialIcons
                                            name={isSelected ? 'check-box' : 'check-box-outline-blank'}
                                            size={18}
                                            color={isSelected ? colors.accent : colors.textMuted}
                                            style={{ marginRight: 8 }}
                                          />
                                          <Text
                                            style={[
                                              erpTableStyles.dropdownOptionText,
                                              isSelected && { color: colors.accentPressed, fontWeight: '600' },
                                            ]}
                                          >
                                            {nombre || '—'}
                                          </Text>
                                        </TouchableOpacity>
                                      );
                                    })}
                                    <TouchableOpacity
                                      style={[erpTableStyles.dropdownOption, erpTableStyles.dropdownCrearOption]}
                                      onPress={() => {
                                        setLocalDropdownOpen(false);
                                        abrirModalCrearLocal();
                                      }}
                                      activeOpacity={0.7}
                                    >
                                      <MaterialIcons name="add-circle-outline" size={16} color={colors.accent} style={{ marginRight: 6 }} />
                                      <Text style={erpTableStyles.dropdownCrearText}>Crear nuevo local</Text>
                                    </TouchableOpacity>
                                  </>
                                )}
                              </ScrollView>
                            </View>
                          ) : null}
                        </View>
                      ) : (
                        <View key={campo.key} style={erpTableStyles.formGroup}>
                          <Text style={erpTableStyles.formLabel}>{campo.label}</Text>
                          <TextInput
                            style={erpTableStyles.formInput}
                            value={formNuevo[campo.key] ?? ''}
                            onChangeText={(t) => setFormNuevo((prev) => ({ ...prev, [campo.key]: t }))}
                            placeholder={`${campo.label}…`}
                            placeholderTextColor={colors.textMuted}
                            secureTextEntry={campo.secure}
                            autoCapitalize={campo.key === 'Email' ? 'none' : 'words'}
                          />
                        </View>
                      ),
                    )}

                    <View style={erpTableStyles.formGroup}>
                      <Text style={erpTableStyles.formLabel}>Departamentos (multi)</Text>
                      <TouchableOpacity
                        style={[erpTableStyles.formInput, erpTableStyles.formInputRow]}
                        onPress={() => setDeptoDropdownOpen((o) => !o)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            erpTableStyles.formInputText,
                            formDepartamentos.length === 0 && erpTableStyles.formInputPlaceholder,
                          ]}
                          numberOfLines={1}
                        >
                          {formDepartamentos.length > 0
                            ? formDepartamentos.map(nombreDepartamento).join(', ')
                            : 'Seleccionar departamentos…'}
                        </Text>
                        <MaterialIcons
                          name={deptoDropdownOpen ? 'expand-less' : 'expand-more'}
                          size={iconSize.chip}
                          color={colors.textSecondary}
                          style={{ marginLeft: 4 }}
                        />
                      </TouchableOpacity>
                      <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4, lineHeight: 16 }}>
                        Informativo, para agrupar y filtrar. No es un permiso: no restringe a qué proyectos, tareas o
                        reuniones se puede asignar a esta persona.
                      </Text>
                      {errorDepartamentos ? (
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 4 }}>
                          <MaterialIcons name="info-outline" size={14} color={colors.warning} />
                          <Text style={{ flex: 1, fontSize: 11, color: colors.warning, lineHeight: 16 }}>
                            No se ha podido cargar la lista de departamentos. Inténtalo de nuevo en unos segundos; los
                            que ya tuviera asignados se conservan.
                          </Text>
                        </View>
                      ) : null}
                      {formDepartamentos.length > 0 ? (
                        <View style={erpTableStyles.localesChipsWrap}>
                          {formDepartamentos.map((id) => (
                            <View key={id} style={erpTableStyles.localChip}>
                              <Text style={erpTableStyles.localChipText} numberOfLines={1}>
                                {nombreDepartamento(id)}
                              </Text>
                              <TouchableOpacity
                                onPress={() =>
                                  setFormDepartamentos((prev) => prev.filter((d) => d !== id))
                                }
                                style={erpTableStyles.localChipRemove}
                                activeOpacity={0.7}
                              >
                                <MaterialIcons name="close" size={14} color={colors.textSecondary} />
                              </TouchableOpacity>
                            </View>
                          ))}
                        </View>
                      ) : null}
                      {deptoDropdownOpen ? (
                        <View style={erpTableStyles.dropdownWrap}>
                          <TextInput
                            style={erpTableStyles.dropdownSearch}
                            value={deptoSearchFilter}
                            onChangeText={setDeptoSearchFilter}
                            placeholder="Buscar departamento…"
                            placeholderTextColor={colors.textMuted}
                          />
                          <ScrollView style={erpTableStyles.dropdownScroll} keyboardShouldPersistTaps="handled">
                            {formDepartamentos.length > 0 ? (
                              <TouchableOpacity
                                style={[erpTableStyles.dropdownOption, erpTableStyles.dropdownVaciarOption]}
                                onPress={() => {
                                  setFormDepartamentos([]);
                                  setDeptoSearchFilter('');
                                }}
                                activeOpacity={0.7}
                              >
                                <MaterialIcons name="clear" size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
                                <Text style={erpTableStyles.dropdownVaciarText}>Quitar todos</Text>
                              </TouchableOpacity>
                            ) : null}
                            {departamentosSeleccionables.length === 0 ? (
                              <View style={erpTableStyles.dropdownOption}>
                                <Text style={erpTableStyles.dropdownOptionText}>
                                  {departamentos.length === 0
                                    ? 'Sin departamentos. Créalos en Base de Datos › Departamentos.'
                                    : 'Ningún departamento coincide con la búsqueda'}
                                </Text>
                              </View>
                            ) : (
                              departamentosSeleccionables.map((depto) => {
                                const isSelected = formDepartamentos.includes(depto.id);
                                return (
                                  <TouchableOpacity
                                    key={depto.id}
                                    style={[
                                      erpTableStyles.dropdownOption,
                                      isSelected && erpTableStyles.dropdownOptionSelected,
                                    ]}
                                    onPress={() => {
                                      setFormDepartamentos((prev) =>
                                        isSelected ? prev.filter((d) => d !== depto.id) : [...prev, depto.id],
                                      );
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons
                                      name={isSelected ? 'check-box' : 'check-box-outline-blank'}
                                      size={18}
                                      color={isSelected ? colors.accent : colors.textMuted}
                                      style={{ marginRight: 8 }}
                                    />
                                    <Text
                                      style={[
                                        erpTableStyles.dropdownOptionText,
                                        isSelected && { color: colors.accentPressed, fontWeight: '600' },
                                      ]}
                                    >
                                      {depto.nombre || '—'}
                                      {depto.activo ? '' : ' (inactivo)'}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })
                            )}
                          </ScrollView>
                        </View>
                      ) : null}
                    </View>
                  </ScrollView>
                </View>
                {errorForm ? <Text style={erpTableStyles.errorForm}>{errorForm}</Text> : null}
                <View style={erpTableStyles.modalFooter}>
                  <TouchableOpacity style={erpTableStyles.modalBtnCancel} onPress={cerrarModalNuevo} disabled={guardando}>
                    <Text style={erpTableStyles.modalBtnCancelText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={erpTableStyles.modalBtnSave} onPress={guardarNuevo} disabled={guardando}>
                    {guardando ? (
                      <ActivityIndicator size="small" color={colors.surface} />
                    ) : (
                      <Text style={erpTableStyles.modalBtnSaveText}>Guardar</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalCrearLocalVisible} transparent animationType="fade" onRequestClose={cerrarModalCrearLocal}>
        <TouchableOpacity style={erpTableStyles.modalOverlayCenter} activeOpacity={1} onPress={() => {}}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={erpTableStyles.modalContentWrap}>
            <View style={[erpTableStyles.modalCard, { maxWidth: 360 }]}>
              <View style={erpTableStyles.modalHeader}>
                <Text style={erpTableStyles.modalHeaderTitle}>Crear nuevo local</Text>
                <TouchableOpacity onPress={cerrarModalCrearLocal} style={erpTableStyles.modalCloseBtn}>
                  <MaterialIcons name="close" size={iconSize.tab} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <View style={[erpTableStyles.modalBodyScroll, { maxHeight: 200 }]}>
                <View style={erpTableStyles.formGroup}>
                  <Text style={erpTableStyles.formLabel}>Nombre *</Text>
                  <TextInput
                    style={erpTableStyles.formInput}
                    value={formCrearLocal.Nombre}
                    onChangeText={(t) => setFormCrearLocal((prev) => ({ ...prev, Nombre: t }))}
                    placeholder="Nombre del local"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="words"
                  />
                </View>
                {errorCrearLocal ? <Text style={erpTableStyles.errorForm}>{errorCrearLocal}</Text> : null}
              </View>
              <View style={erpTableStyles.modalFooter}>
                <TouchableOpacity style={erpTableStyles.modalBtnCancel} onPress={cerrarModalCrearLocal}>
                  <Text style={erpTableStyles.modalBtnCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={erpTableStyles.modalBtnSave} onPress={guardarCrearLocal} disabled={guardandoCrearLocal}>
                  {guardandoCrearLocal ? (
                    <ActivityIndicator size="small" color={colors.surface} />
                  ) : (
                    <Text style={erpTableStyles.modalBtnSaveText}>Crear</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}
