import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { ICONS, ICON_SIZE } from '../constants/icons';
import { emailValido } from '../utils/validation';
import { formatId6 } from '../utils/idFormat';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const MAX_TEXT_LENGTH = 30;

// Atributos exactos de la tabla igp_usuarios en AWS (mismo orden que api/server.js TABLE_USUARIOS_ATTRS). No añadir campos nuevos.
const ATRIBUTOS_TABLA_USUARIOS = ['id_usuario', 'Nombre', 'Apellidos', 'Email', 'Password', 'Telefono', 'Rol', 'Local'] as const;

// Columnas de la tabla (todos los atributos menos Password, que no se muestra)
const ORDEN_COLUMNAS = ATRIBUTOS_TABLA_USUARIOS.filter((k) => k !== 'Password');

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

const ROL_OPCIONES = ['Administrador', 'SuperUser', 'Administracion', 'Local', 'Socio'] as const;

type Usuario = Record<string, string | number | undefined>;

/** Ítem de igp_Locales (API puede devolver nombre/sede en minúsculas o PascalCase) */
type LocalItem = { sede?: string; Sede?: string; nombre?: string; Nombre?: string; id_Locales?: string };

function truncar(val: string): string {
  if (val.length <= MAX_TEXT_LENGTH) return val;
  return val.slice(0, MAX_TEXT_LENGTH - 3) + '…';
}

export default function UsuariosScreen() {
  const router = useRouter();
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [modalNuevoVisible, setModalNuevoVisible] = useState(false);
  const [editingUsuarioId, setEditingUsuarioId] = useState<string | null>(null);
  const [formNuevo, setFormNuevo] = useState<Record<string, string>>(INITIAL_FORM);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [rolDropdownOpen, setRolDropdownOpen] = useState(false);
  const [rolSearchFilter, setRolSearchFilter] = useState('');
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [localSearchFilter, setLocalSearchFilter] = useState('');
  const [localesGrupoParipe, setLocalesGrupoParipe] = useState<LocalItem[]>([]);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [modalCrearLocalVisible, setModalCrearLocalVisible] = useState(false);
  const [formCrearLocal, setFormCrearLocal] = useState({ Nombre: '' });
  const [guardandoCrearLocal, setGuardandoCrearLocal] = useState(false);
  const [errorCrearLocal, setErrorCrearLocal] = useState<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  const abrirModalNuevo = () => {
    setEditingUsuarioId(null);
    setFormNuevo(INITIAL_FORM);
    setModalNuevoVisible(true);
    setErrorForm(null);
    setRolDropdownOpen(false);
    setRolSearchFilter('');
    setLocalDropdownOpen(false);
    setLocalSearchFilter('');
  };
  const abrirModalEditar = (usuario: Usuario) => {
    const form: Record<string, string> = { ...INITIAL_FORM };
    for (const key of CAMPOS_FORM.map((c) => c.key)) {
      const v = usuario[key];
      form[key] = v != null ? String(v) : '';
    }
    form.Password = '';
    setFormNuevo(form);
    setEditingUsuarioId(usuario.id_usuario != null ? String(usuario.id_usuario) : null);
    setModalNuevoVisible(true);
    setErrorForm(null);
    setRolDropdownOpen(false);
    setRolSearchFilter('');
    setLocalDropdownOpen(false);
    setLocalSearchFilter('');
  };
  const cerrarModalNuevo = () => {
    setModalNuevoVisible(false);
    setFormNuevo(INITIAL_FORM);
    setEditingUsuarioId(null);
    setErrorForm(null);
    setRolDropdownOpen(false);
    setRolSearchFilter('');
    setLocalDropdownOpen(false);
    setLocalSearchFilter('');
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
      const res = await fetch(`${API_URL}/api/locales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Nombre: nombre,
          Sede: 'Grupo Paripe',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorCrearLocal(data.error || 'Error al crear local');
        return;
      }
      refetchLocales();
      setFormNuevo((prev) => ({ ...prev, Local: nombre }));
      setLocalDropdownOpen(false);
      setLocalSearchFilter('');
      cerrarModalCrearLocal();
    } catch (e) {
      setErrorCrearLocal('No se pudo conectar con el servidor');
    } finally {
      setGuardandoCrearLocal(false);
    }
  };

  const rolesFiltrados = useMemo(() => {
    const q = rolSearchFilter.trim().toLowerCase();
    const list = !q ? [...ROL_OPCIONES] : ROL_OPCIONES.filter((r) => r.toLowerCase().includes(q));
    return [...list].sort((a, b) => a.localeCompare(b));
  }, [rolSearchFilter]);
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
  const ordenarPorId = useCallback((lista: Usuario[]) => {
    return [...lista].sort((a, b) => {
      const na = typeof a.id_usuario === 'number' ? a.id_usuario : parseInt(String(a.id_usuario ?? 0).replace(/^0+/, ''), 10) || 0;
      const nb = typeof b.id_usuario === 'number' ? b.id_usuario : parseInt(String(b.id_usuario ?? 0).replace(/^0+/, ''), 10) || 0;
      return na - nb;
    });
  }, []);

  const refetchUsuarios = useCallback(() => {
    fetch(`${API_URL}/api/usuarios`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setUsuarios(ordenarPorId(data.usuarios || []));
      })
      .catch((e) => setError(e.message || 'Error de conexión'));
  }, [ordenarPorId]);

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
    setErrorForm(null);
    setGuardando(true);
    try {
      const body: Record<string, string | number> = {};
      for (const key of ATRIBUTOS_TABLA_USUARIOS) {
        if (key === 'id_usuario') body[key] = isEdit ? editingUsuarioId! : próximoId;
        else if (key === 'Email') body[key] = (formNuevo.Email ?? '').trim();
        else if (key === 'Password') body[key] = formNuevo.Password ?? '';
        else body[key] = formNuevo[key] ?? '';
      }
      const url = `${API_URL}/api/usuarios`;
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
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
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/usuarios`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
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

  const toolbarBtns = [
    { id: 'crear', label: 'Crear registro', icon: ICONS.add },
    { id: 'editar', label: 'Editar', icon: ICONS.edit },
    { id: 'borrar', label: 'Borrar', icon: ICONS.delete },
  ];

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? DEFAULT_COL_WIDTH, [columnWidths]);

  const columnas = useMemo(() => {
    if (!usuarios.length) return [];
    const keys = Object.keys(usuarios[0]).filter((k) => k !== 'Password');
    return ORDEN_COLUMNAS.filter((k) => keys.includes(k));
  }, [usuarios]);

  const usuariosFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return usuarios;
    return usuarios.filter((u) => {
      return columnas.some((col) => {
        const val = u[col];
        return val != null && String(val).toLowerCase().includes(q);
      });
    });
  }, [usuarios, filtroBusqueda, columnas]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/usuarios`)
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
    fetch(`${API_URL}/api/locales`)
      .then((res) => res.json())
      .then((data: { locales?: LocalItem[] }) => {
        const list = data.locales || [];
        const filtrados = list.filter(
          (item) => (item.sede ?? item.Sede ?? '') === 'Grupo Paripe'
        );
        setLocalesGrupoParipe(filtrados);
      })
      .catch(() => setLocalesGrupoParipe([]));
  }, []);

  useEffect(() => {
    refetchLocales();
  }, [refetchLocales]);

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
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando usuarios…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Usuarios</Text>
      </View>

      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {toolbarBtns.map((btn) => (
            <View
              key={btn.id}
              style={styles.toolbarBtnWrap}
              {...(Platform.OS === 'web' ? { onMouseEnter: () => setHoveredBtn(btn.id), onMouseLeave: () => setHoveredBtn(null) } as unknown as object : {})}
            >
              {hoveredBtn === btn.id && (
                <View style={styles.tooltip}>
                  <Text style={styles.tooltipText}>{btn.label}</Text>
                </View>
              )}
              <TouchableOpacity
                style={[styles.toolbarBtn, (btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null && styles.toolbarBtnDisabled]}
                onPress={() => {
                  if (btn.id === 'crear') abrirModalNuevo();
                  if (btn.id === 'editar' && selectedRowIndex != null) abrirModalEditar(usuariosFiltrados[selectedRowIndex]);
                  if (btn.id === 'borrar' && selectedRowIndex != null) borrarSeleccionado();
                }}
                disabled={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null)}
                accessibilityLabel={btn.label}
              >
              <MaterialIcons name={btn.icon} size={ICON_SIZE} color={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null) ? '#94a3b8' : '#0ea5e9'} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor="#94a3b8"
          />
        </View>
      </View>

      <Text style={styles.subtitle}>
        {filtroBusqueda.trim() ? `${usuariosFiltrados.length} de ${usuarios.length} registro${usuarios.length !== 1 ? 's' : ''}` : `${usuarios.length} registro${usuarios.length !== 1 ? 's' : ''} en la tabla`}
      </Text>

      <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.table}>
          <View style={styles.rowHeader}>
            {columnas.map((col) => (
              <View key={col} style={[styles.cellHeader, { width: getColWidth(col) }]}>
                <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">
                  {col}
                </Text>
                {Platform.OS === 'web' && (
                  <View
                    style={styles.resizeHandle}
                    {...({ onMouseDown: (e: React.MouseEvent) => handleResizeStart(col, e) } as unknown as object)}
                  />
                )}
              </View>
            ))}
          </View>
          {usuariosFiltrados.map((usuario, idx) => (
            <TouchableOpacity
              key={idx}
              style={[styles.row, selectedRowIndex === idx && styles.rowSelected]}
              onPress={() => seleccionarFila(idx)}
              activeOpacity={0.8}
            >
              {columnas.map((col) => {
                const raw =
                  col.startsWith('id_') && usuario[col] != null
                    ? formatId6(usuario[col])
                    : usuario[col] != null
                      ? String(usuario[col])
                      : '—';
                const text = raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw;
                return (
                  <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                    <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">
                      {text}
                    </Text>
                  </View>
                );
              })}
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      <Modal
        visible={modalNuevoVisible}
        transparent
        animationType="fade"
        onRequestClose={cerrarModalNuevo}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView
            style={styles.modalContentWrap}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editingUsuarioId != null ? 'Editar registro' : 'Nuevo registro'}</Text>
                <TouchableOpacity onPress={cerrarModalNuevo} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.modalBodyRow}>
                <View style={styles.modalIdSide}>
                  <Text style={styles.modalIdLabel}>ID</Text>
                  <Text style={styles.modalIdValue}>{formatId6(editingUsuarioId ?? próximoId)}</Text>
                </View>
                <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                  {CAMPOS_FORM.map((campo) =>
                    campo.key === 'Rol' ? (
                      <View key={campo.key} style={styles.formGroup}>
                        <Text style={styles.formLabel}>{campo.label}</Text>
                        <TouchableOpacity
                          style={[styles.formInput, styles.formInputRow]}
                          onPress={() => setRolDropdownOpen((o) => !o)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.formInputText, !formNuevo.Rol && styles.formInputPlaceholder]} numberOfLines={1}>
                            {formNuevo.Rol || `${campo.label}…`}
                          </Text>
                          <MaterialIcons name={rolDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" style={styles.rolChevron} />
                        </TouchableOpacity>
                        {rolDropdownOpen && (
                          <View style={styles.dropdownWrap}>
                            <TextInput
                              style={styles.dropdownSearch}
                              value={rolSearchFilter}
                              onChangeText={setRolSearchFilter}
                              placeholder="Buscar rol…"
                              placeholderTextColor="#94a3b8"
                            />
                            <ScrollView style={styles.dropdownScroll} keyboardShouldPersistTaps="handled">
                              {formNuevo.Rol ? (
                                <TouchableOpacity
                                  style={[styles.dropdownOption, styles.dropdownVaciarOption]}
                                  onPress={() => {
                                    setFormNuevo((prev) => ({ ...prev, Rol: '' }));
                                    setRolDropdownOpen(false);
                                    setRolSearchFilter('');
                                  }}
                                  activeOpacity={0.7}
                                >
                                  <MaterialIcons name="clear" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
                                  <Text style={styles.dropdownVaciarText}>Vaciar</Text>
                                </TouchableOpacity>
                              ) : null}
                              {rolesFiltrados.length === 0 ? (
                                <View style={styles.dropdownOption}>
                                  <Text style={styles.dropdownOptionText}>Sin resultados</Text>
                                </View>
                              ) : (
                                rolesFiltrados.map((opcion) => (
                                  <TouchableOpacity
                                    key={opcion}
                                    style={styles.dropdownOption}
                                    onPress={() => {
                                      setFormNuevo((prev) => ({ ...prev, Rol: opcion }));
                                      setRolDropdownOpen(false);
                                      setRolSearchFilter('');
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <Text style={styles.dropdownOptionText}>{opcion}</Text>
                                  </TouchableOpacity>
                                ))
                              )}
                            </ScrollView>
                          </View>
                        )}
                      </View>
                    ) : campo.key === 'Local' ? (
                      <View key={campo.key} style={styles.formGroup}>
                        <Text style={styles.formLabel}>{campo.label}</Text>
                        <TouchableOpacity
                          style={[styles.formInput, styles.formInputRow]}
                          onPress={() => setLocalDropdownOpen((o) => !o)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.formInputText, !formNuevo.Local && styles.formInputPlaceholder]} numberOfLines={1}>
                            {formNuevo.Local || `${campo.label}…`}
                          </Text>
                          <MaterialIcons name={localDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" style={styles.rolChevron} />
                        </TouchableOpacity>
                        {localDropdownOpen && (
                          <View style={styles.dropdownWrap}>
                            <TextInput
                              style={styles.dropdownSearch}
                              value={localSearchFilter}
                              onChangeText={setLocalSearchFilter}
                              placeholder="Buscar local…"
                              placeholderTextColor="#94a3b8"
                            />
                            <ScrollView style={styles.dropdownScroll} keyboardShouldPersistTaps="handled">
                              {formNuevo.Local ? (
                                <TouchableOpacity
                                  style={[styles.dropdownOption, styles.dropdownVaciarOption]}
                                  onPress={() => {
                                    setFormNuevo((prev) => ({ ...prev, Local: '' }));
                                    setLocalDropdownOpen(false);
                                    setLocalSearchFilter('');
                                  }}
                                  activeOpacity={0.7}
                                >
                                  <MaterialIcons name="clear" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
                                  <Text style={styles.dropdownVaciarText}>Vaciar</Text>
                                </TouchableOpacity>
                              ) : null}
                              {localesGrupoParipe.length === 0 ? (
                                <>
                                  <View style={styles.dropdownOption}>
                                    <Text style={styles.dropdownOptionText}>Sin locales</Text>
                                  </View>
                                  <TouchableOpacity
                                    style={[styles.dropdownOption, styles.dropdownCrearNuevoOption]}
                                    onPress={() => {
                                      setLocalDropdownOpen(false);
                                      abrirModalCrearLocal();
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="add-circle-outline" size={16} color="#0ea5e9" style={{ marginRight: 6 }} />
                                    <Text style={styles.dropdownCrearNuevoText}>Crear nuevo local</Text>
                                  </TouchableOpacity>
                                </>
                              ) : localesFiltrados.length === 0 ? (
                                <TouchableOpacity
                                  style={[styles.dropdownOption, styles.dropdownCrearNuevoOption]}
                                  onPress={() => {
                                    setLocalDropdownOpen(false);
                                    abrirModalCrearLocal();
                                  }}
                                  activeOpacity={0.7}
                                >
                                  <MaterialIcons name="add-circle-outline" size={16} color="#0ea5e9" style={{ marginRight: 6 }} />
                                  <Text style={styles.dropdownCrearNuevoText}>Crear nuevo local</Text>
                                </TouchableOpacity>
                              ) : (
                                <>
                                  {localesFiltrados.map((loc) => {
                                    const nombre = loc.nombre ?? loc.Nombre ?? '';
                                    return (
                                      <TouchableOpacity
                                        key={loc.id_Locales ?? nombre}
                                        style={styles.dropdownOption}
                                        onPress={() => {
                                          setFormNuevo((prev) => ({ ...prev, Local: nombre }));
                                          setLocalDropdownOpen(false);
                                          setLocalSearchFilter('');
                                        }}
                                        activeOpacity={0.7}
                                      >
                                        <Text style={styles.dropdownOptionText}>{nombre || '—'}</Text>
                                      </TouchableOpacity>
                                    );
                                  })}
                                  <TouchableOpacity
                                    style={[styles.dropdownOption, styles.dropdownCrearNuevoOption]}
                                    onPress={() => {
                                      setLocalDropdownOpen(false);
                                      abrirModalCrearLocal();
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="add-circle-outline" size={16} color="#0ea5e9" style={{ marginRight: 6 }} />
                                    <Text style={styles.dropdownCrearNuevoText}>Crear nuevo local</Text>
                                  </TouchableOpacity>
                                </>
                              )}
                            </ScrollView>
                          </View>
                        )}
                      </View>
                    ) : (
                      <View key={campo.key} style={styles.formGroup}>
                        <Text style={styles.formLabel}>{campo.label}</Text>
                        <TextInput
                          style={styles.formInput}
                          value={formNuevo[campo.key] ?? ''}
                          onChangeText={(t) => setFormNuevo((prev) => ({ ...prev, [campo.key]: t }))}
                          placeholder={`${campo.label}…`}
                          placeholderTextColor="#94a3b8"
                          secureTextEntry={campo.secure}
                          autoCapitalize={campo.key === 'Email' ? 'none' : 'words'}
                        />
                      </View>
                    )
                  )}
                </ScrollView>
              </View>
              {errorForm ? (
                <Text style={styles.modalError}>{errorForm}</Text>
              ) : null}
              <View style={styles.modalFooter}>
                <TouchableOpacity style={styles.modalFooterBtn} onPress={guardarNuevo} accessibilityLabel={editingUsuarioId != null ? 'Guardar' : 'Añadir'} disabled={guardando}>
                  {guardando ? <ActivityIndicator size="small" color="#0ea5e9" /> : <MaterialIcons name={editingUsuarioId != null ? 'save' : ICONS.add} size={ICON_SIZE} color="#0ea5e9" />}
                </TouchableOpacity>
              </View>
            </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalCrearLocalVisible} transparent animationType="fade" onRequestClose={cerrarModalCrearLocal}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
            <View style={[styles.modalCard, { maxWidth: 360 }]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Crear nuevo local</Text>
                <TouchableOpacity onPress={cerrarModalCrearLocal} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={[styles.modalBody, { maxHeight: 200 }]}>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Nombre *</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formCrearLocal.Nombre}
                    onChangeText={(t) => setFormCrearLocal((prev) => ({ ...prev, Nombre: t }))}
                    placeholder="Nombre del local"
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="words"
                  />
                </View>
                {errorCrearLocal ? <Text style={styles.modalError}>{errorCrearLocal}</Text> : null}
              </View>
              <View style={styles.modalFooter}>
                <TouchableOpacity style={[styles.modalFooterBtn, { flexDirection: 'row', alignItems: 'center' }]} onPress={cerrarModalCrearLocal} activeOpacity={0.7}>
                  <Text style={{ color: '#64748b', fontSize: 14 }}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalFooterBtn, { flexDirection: 'row', alignItems: 'center' }]}
                  onPress={guardarCrearLocal}
                  disabled={guardandoCrearLocal}
                  activeOpacity={0.7}
                >
                  {guardandoCrearLocal ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <>
                      <MaterialIcons name="add" size={ICON_SIZE} color="#0ea5e9" />
                      <Text style={{ color: '#0ea5e9', fontSize: 14, marginLeft: 6 }}>Crear</Text>
                    </>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 10,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    fontSize: 12,
    color: '#64748b',
  },
  errorText: {
    fontSize: 12,
    color: '#f87171',
    textAlign: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  backBtn: {
    padding: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#334155',
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 12,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 280,
    height: 32,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  searchIcon: {
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    color: '#334155',
    paddingVertical: 0,
  },
  toolbarBtnWrap: {
    position: 'relative',
  },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: 4,
    backgroundColor: '#334155',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
    zIndex: 10,
  },
  tooltipText: {
    fontSize: 9,
    color: '#f8fafc',
    fontWeight: '400',
  },
  toolbarBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  toolbarBtnDisabled: {
    opacity: 0.6,
  },
  subtitle: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 8,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 20,
  },
  table: {
    minWidth: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  rowHeader: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  cellCheckbox: {
    width: 36,
    minWidth: 36,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellCheckboxRow: {
    borderRightColor: '#e2e8f0',
    paddingVertical: 4,
  },
  cellHeader: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    position: 'relative',
  },
  cellHeaderText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#334155',
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize',
  } as unknown as ViewStyle,
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  rowSelected: {
    backgroundColor: '#e0f2fe',
  },
  cell: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
  },
  cellText: {
    fontSize: 11,
    color: '#475569',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalContentWrap: {
    width: '100%',
    maxWidth: 420,
    padding: 24,
    alignItems: 'center',
  },
  modalCardTouch: {
    width: '100%',
  },
  modalCard: {
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#334155',
  },
  modalClose: {
    padding: 4,
  },
  modalBodyRow: {
    flexDirection: 'row',
  },
  modalIdSide: {
    width: 56,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  modalIdLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    marginBottom: 2,
  },
  modalIdValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
  },
  modalBody: {
    flex: 1,
    maxHeight: 400,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  formGroup: {
    marginBottom: 8,
  },
  formLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: '#475569',
    marginBottom: 2,
  },
  formInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 13,
    color: '#334155',
  },
  formInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  formInputText: {
    fontSize: 13,
    color: '#334155',
    flex: 1,
  },
  formInputPlaceholder: {
    color: '#94a3b8',
  },
  rolChevron: {
    marginLeft: 4,
  },
  rolDropdown: {
    marginTop: 2,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    overflow: 'hidden',
    maxHeight: 180,
  },
  rolOption: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  rolOptionText: {
    fontSize: 11,
    color: '#334155',
  },
  dropdownWrap: { marginTop: 4, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', maxHeight: 200 },
  dropdownSearch: { paddingVertical: 6, paddingHorizontal: 8, fontSize: 11, color: '#334155', backgroundColor: '#f8fafc', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  dropdownScroll: { maxHeight: 150 },
  dropdownOption: { paddingVertical: 5, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  dropdownOptionText: { fontSize: 11, color: '#334155' },
  dropdownVaciarOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderBottomColor: '#e2e8f0' },
  dropdownVaciarText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  dropdownCrearNuevoOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f0f9ff', borderBottomColor: '#e2e8f0' },
  dropdownCrearNuevoText: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  modalError: {
    fontSize: 11,
    color: '#f87171',
    paddingHorizontal: 20,
    paddingVertical: 4,
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalFooterBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
});
