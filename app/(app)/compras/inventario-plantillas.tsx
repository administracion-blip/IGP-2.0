/**
 * Plantillas de inventario por almacén, armadas con familias de producto.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { apiFetch } from '../../utils/api';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import {
  colors,
  fontFamily,
  fontSizes,
  inputCursorProps,
  inputCursorStyle,
  radius,
  MIN_TOUCH,
  SPACING,
} from '../../constants/theme';

type Almacen = { Id?: string | number; Nombre?: string };
type Familia = { id: string; nombre: string };
type PlantillaLista = {
  plantillaId: string;
  nombre: string;
  modo: string;
  numMiembros?: number;
};
type Editor = {
  plantillaId: string | null;
  nombre: string;
  miembros: Familia[];
};

async function leerJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function mensajeDe(body: Record<string, unknown>, respaldo: string): string {
  return typeof body.error === 'string' && body.error.trim() ? body.error : respaldo;
}

export default function PlantillasInventarioScreen() {
  const { hasPermiso } = useAuth();
  const puede = hasPermiso('inventario.gestionar');
  const { shouldStackPanels } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [familias, setFamilias] = useState<Familia[]>([]);
  const [plantillas, setPlantillas] = useState<PlantillaLista[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [filtro, setFiltro] = useState('');
  const [cargando, setCargando] = useState(true);
  const [cargandoLista, setCargandoLista] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avisoFamilias, setAvisoFamilias] = useState<string | null>(null);
  const listaTicket = useRef(0);

  const opcionesAlmacen = useMemo(
    () =>
      almacenes
        .map((a) => ({
          id: String(a.Id ?? '').trim(),
          titulo: String(a.Nombre || a.Id || '').trim() || 'Almacén',
        }))
        .filter((a) => a.id)
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    [almacenes],
  );

  const familiasVisibles = useMemo(() => {
    const q = filtro.trim().toLocaleLowerCase('es');
    const list = [...familias].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    if (!q) return list;
    return list.filter(
      (f) => f.nombre.toLocaleLowerCase('es').includes(q) || f.id.toLocaleLowerCase('es').includes(q),
    );
  }, [familias, filtro]);

  const idsMarcados = useMemo(() => new Set(editor?.miembros.map((m) => m.id) ?? []), [editor]);
  const familiasFuera = useMemo(() => {
    if (!editor) return [];
    const conocidas = new Set(familias.map((f) => f.id));
    return editor.miembros.filter((m) => !conocidas.has(m.id));
  }, [editor, familias]);

  const cargarPlantillas = useCallback(async (wid: string) => {
    const ticket = ++listaTicket.current;
    setCargandoLista(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/inventarios/plantillas?warehouseId=${encodeURIComponent(wid)}`);
      const body = await leerJson(res);
      if (ticket !== listaTicket.current) return;
      if (!res.ok) {
        setPlantillas([]);
        setError(mensajeDe(body, 'No se han podido cargar las plantillas'));
        return;
      }
      setPlantillas(Array.isArray(body.plantillas) ? (body.plantillas as PlantillaLista[]) : []);
    } catch (e) {
      if (ticket !== listaTicket.current) return;
      setPlantillas([]);
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      if (ticket === listaTicket.current) setCargandoLista(false);
    }
  }, []);

  useEffect(() => {
    if (!puede) {
      setCargando(false);
      return;
    }
    let vivo = true;
    (async () => {
      try {
        const [resAlm, resFam] = await Promise.all([
          apiFetch('/api/almacenes'),
          apiFetch('/api/inventarios/familias'),
        ]);
        const alm = await leerJson(resAlm);
        const fam = await leerJson(resFam);
        if (!vivo) return;
        setAlmacenes(Array.isArray(alm.almacenes) ? (alm.almacenes as Almacen[]) : []);
        if (!resFam.ok) {
          setAvisoFamilias(mensajeDe(fam, 'No se han podido cargar las familias'));
          setFamilias([]);
        } else {
          const crudas = Array.isArray(fam.familias) ? fam.familias : [];
          setFamilias(
            crudas
              .map((f) => {
                const fila = f as { id?: unknown; nombre?: unknown };
                return { id: String(fila.id ?? '').trim(), nombre: String(fila.nombre ?? '').trim() };
              })
              .filter((f) => f.id),
          );
        }
      } catch (e) {
        if (!vivo) return;
        setError(e instanceof Error ? e.message : 'Error de conexión');
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [puede]);

  useEffect(() => {
    if (!warehouseId) {
      setPlantillas([]);
      return;
    }
    setEditor(null);
    setFiltro('');
    void cargarPlantillas(warehouseId);
  }, [warehouseId, cargarPlantillas]);

  function nueva() {
    setError(null);
    setFiltro('');
    setEditor({ plantillaId: null, nombre: '', miembros: [] });
  }

  async function editar(plantillaId: string) {
    setError(null);
    setFiltro('');
    try {
      const res = await apiFetch(`/api/inventarios/plantillas/${encodeURIComponent(plantillaId)}`);
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido abrir la plantilla'));
        return;
      }
      const miembros = Array.isArray(body.miembros) ? body.miembros : [];
      setEditor({
        plantillaId,
        nombre: String(body.nombre ?? ''),
        miembros: miembros
          .map((m) => {
            const fila = m as { id?: unknown; nombre?: unknown };
            return { id: String(fila.id ?? '').trim(), nombre: String(fila.nombre ?? '').trim() };
          })
          .filter((m) => m.id),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    }
  }

  function alternarFamilia(familia: Familia) {
    setEditor((actual) => {
      if (!actual) return actual;
      const ya = actual.miembros.some((m) => m.id === familia.id);
      return {
        ...actual,
        miembros: ya
          ? actual.miembros.filter((m) => m.id !== familia.id)
          : [...actual.miembros, { id: familia.id, nombre: familia.nombre || familia.id }],
      };
    });
  }

  async function guardar() {
    if (!editor || !warehouseId || guardando) return;
    const nombre = editor.nombre.trim();
    if (!nombre) {
      setError('El nombre es obligatorio');
      return;
    }
    setGuardando(true);
    setError(null);
    const miembros = editor.miembros.map((m) => ({ id: m.id, nombre: m.nombre || m.id }));
    try {
      const res = editor.plantillaId
        ? await apiFetch(`/api/inventarios/plantillas/${encodeURIComponent(editor.plantillaId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre, modo: 'familias', miembros }),
          })
        : await apiFetch('/api/inventarios/plantillas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ warehouseId, nombre, modo: 'familias', miembros }),
          });
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido guardar la plantilla'));
        return;
      }
      setEditor(null);
      setFiltro('');
      await cargarPlantillas(warehouseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardando(false);
    }
  }

  async function borrar(plantilla: PlantillaLista) {
    const ok = await confirmar(
      'Borrar plantilla',
      `Se borrará «${plantilla.nombre}». Los inventarios ya hechos no se tocan.`,
      { variant: 'danger', confirmarLabel: 'Borrar' },
    );
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/inventarios/plantillas/${encodeURIComponent(plantilla.plantillaId)}`, {
        method: 'DELETE',
      });
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido borrar la plantilla'));
        return;
      }
      if (editor?.plantillaId === plantilla.plantillaId) setEditor(null);
      if (warehouseId) await cargarPlantillas(warehouseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    }
  }

  if (!puede) {
    return (
      <View style={styles.pagina}>
        <Text style={styles.titulo}>Plantillas de inventario</Text>
        <Text style={styles.aviso}>No tienes permiso para gestionar las plantillas de inventario.</Text>
      </View>
    );
  }

  const mostrarLista = !editor || !shouldStackPanels;

  return (
    <View style={styles.pagina}>
      <Text style={styles.titulo}>Plantillas de inventario</Text>
      <Text style={styles.subtitulo}>Elige el almacén y las familias que se contarán.</Text>

      <View style={[styles.toolbar, shouldStackPanels && styles.toolbarCol]}>
        <View style={styles.selector}>
          <SelectorDesplegable
            label="Almacén"
            placeholder="Elige un almacén"
            icono="warehouse"
            opciones={opcionesAlmacen}
            valorId={warehouseId}
            onSeleccionar={setWarehouseId}
            tituloLista="Almacén"
            loading={cargando}
            buscador
            buscadorPlaceholder="Buscar almacén"
          />
        </View>
        <Pressable
          style={[styles.boton, !warehouseId && styles.botonOff]}
          disabled={!warehouseId}
          onPress={nueva}
          accessibilityRole="button"
          accessibilityLabel="Nueva plantilla"
        >
          <MaterialIcons name="add" size={20} color={colors.surface} />
          <Text style={styles.botonTexto}>Nueva plantilla</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {avisoFamilias ? <Text style={styles.aviso}>{avisoFamilias}</Text> : null}

      {cargando ? (
        <ActivityIndicator color={colors.accent} style={styles.carga} />
      ) : (
        <View style={[styles.cuerpo, shouldStackPanels && styles.cuerpoCol]}>
          {mostrarLista ? (
            <View style={styles.panel}>
              {!warehouseId ? (
                <Text style={styles.vacio}>Elige un almacén para ver sus plantillas.</Text>
              ) : cargandoLista ? (
                <ActivityIndicator color={colors.accent} style={styles.carga} />
              ) : plantillas.length === 0 ? (
                <Text style={styles.vacio}>Este almacén no tiene plantillas.</Text>
              ) : (
                <ScrollView contentContainerStyle={styles.lista}>
                  {plantillas.map((p) => {
                    const n = p.numMiembros ?? 0;
                    const activa = editor?.plantillaId === p.plantillaId;
                    return (
                      <View key={p.plantillaId} style={[styles.fila, activa && styles.filaActiva]}>
                        <View style={styles.filaTexto}>
                          <Text style={styles.filaNombre}>{p.nombre}</Text>
                          <Text style={styles.filaMeta}>
                            {p.modo === 'familias'
                              ? `${n} ${n === 1 ? 'familia' : 'familias'}`
                              : 'Productos'}
                          </Text>
                        </View>
                        {p.modo === 'familias' ? (
                          <Pressable
                            style={styles.iconoBtn}
                            onPress={() => void editar(p.plantillaId)}
                            accessibilityRole="button"
                            accessibilityLabel={`Editar ${p.nombre}`}
                          >
                            <MaterialIcons name="edit" size={20} color={colors.accent} />
                          </Pressable>
                        ) : null}
                        <Pressable
                          style={styles.iconoBtn}
                          onPress={() => void borrar(p)}
                          accessibilityRole="button"
                          accessibilityLabel={`Borrar ${p.nombre}`}
                        >
                          <MaterialIcons name="delete-outline" size={22} color={colors.danger} />
                        </Pressable>
                      </View>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          ) : null}

          {editor ? (
            <View style={styles.panel}>
              <View style={styles.editorCab}>
                {shouldStackPanels ? (
                  <Pressable
                    style={styles.iconoBtn}
                    onPress={() => setEditor(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Volver al listado"
                  >
                    <MaterialIcons name="arrow-back" size={22} color={colors.textStrong} />
                  </Pressable>
                ) : null}
                <Text style={styles.editorTitulo}>
                  {editor.plantillaId ? 'Editar plantilla' : 'Nueva plantilla'}
                </Text>
              </View>
              <TextInput
                value={editor.nombre}
                onChangeText={(nombre) => setEditor({ ...editor, nombre })}
                placeholder="Nombre de la plantilla"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, inputCursorStyle]}
                {...inputCursorProps}
              />
              <TextInput
                value={filtro}
                onChangeText={setFiltro}
                placeholder="Buscar familia"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, inputCursorStyle]}
                {...inputCursorProps}
              />
              <Text style={styles.cuenta}>
                {editor.miembros.length} {editor.miembros.length === 1 ? 'familia marcada' : 'familias marcadas'}
              </Text>
              <ScrollView style={styles.familias} contentContainerStyle={styles.familiasInner}>
                {familiasFuera.map((f) => (
                  <Pressable
                    key={f.id}
                    style={styles.familia}
                    onPress={() => alternarFamilia(f)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: true }}
                    accessibilityLabel={f.nombre || f.id}
                  >
                    <MaterialIcons name="check-box" size={22} color={colors.accent} />
                    <Text style={styles.familiaNombre}>{f.nombre || f.id}</Text>
                  </Pressable>
                ))}
                {familiasVisibles.length === 0 && familiasFuera.length === 0 ? (
                  <Text style={styles.vacio}>No hay familias que coincidan.</Text>
                ) : (
                  familiasVisibles.map((f) => {
                    const marcada = idsMarcados.has(f.id);
                    return (
                      <Pressable
                        key={f.id}
                        style={styles.familia}
                        onPress={() => alternarFamilia(f)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: marcada }}
                        accessibilityLabel={f.nombre || f.id}
                      >
                        <MaterialIcons
                          name={marcada ? 'check-box' : 'check-box-outline-blank'}
                          size={22}
                          color={marcada ? colors.accent : colors.textMuted}
                        />
                        <Text style={styles.familiaNombre}>{f.nombre || f.id}</Text>
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
              <View style={styles.acciones}>
                <Pressable
                  style={[styles.boton, styles.botonGhost]}
                  onPress={() => setEditor(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancelar"
                >
                  <Text style={styles.botonGhostTexto}>Cancelar</Text>
                </Pressable>
                <Pressable
                  style={[styles.boton, guardando && styles.botonOff]}
                  disabled={guardando}
                  onPress={() => void guardar()}
                  accessibilityRole="button"
                  accessibilityLabel="Guardar plantilla"
                >
                  {guardando ? (
                    <ActivityIndicator color={colors.surface} />
                  ) : (
                    <Text style={styles.botonTexto}>Guardar</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      )}
      <ConfirmarView />
    </View>
  );
}

const styles = StyleSheet.create({
  pagina: { flex: 1, padding: SPACING.lg, backgroundColor: colors.bg },
  titulo: { fontFamily: fontFamily.bold, fontSize: fontSizes[20], color: colors.textStrong },
  subtitulo: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textSecondary,
    marginTop: 4,
    marginBottom: SPACING.md,
  },
  toolbar: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.md, marginBottom: SPACING.md },
  toolbarCol: { flexDirection: 'column', alignItems: 'stretch' },
  selector: { flex: 1, minWidth: 220 },
  cuerpo: { flex: 1, flexDirection: 'row', gap: SPACING.md },
  cuerpoCol: { flexDirection: 'column' },
  panel: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: SPACING.md,
    minHeight: 200,
  },
  lista: { gap: SPACING.sm },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    minHeight: MIN_TOUCH,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.md,
  },
  filaActiva: { backgroundColor: colors.accentMuted },
  filaTexto: { flex: 1 },
  filaNombre: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textStrong },
  filaMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textSecondary },
  iconoBtn: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  editorCab: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginBottom: SPACING.sm },
  editorTitulo: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textStrong },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[16],
    color: colors.textStrong,
    backgroundColor: colors.surface,
  },
  cuenta: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[13],
    color: colors.textSecondary,
    marginBottom: SPACING.xs,
  },
  familias: { flex: 1 },
  familiasInner: { paddingBottom: SPACING.sm },
  familia: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, minHeight: MIN_TOUCH },
  familiaNombre: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[16], color: colors.textPrimary },
  acciones: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.sm, marginTop: SPACING.sm },
  boton: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.lg,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  botonOff: { opacity: 0.5 },
  botonTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.surface },
  botonGhost: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  botonGhostTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.textPrimary },
  vacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textSecondary },
  aviso: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.warning, marginBottom: SPACING.sm },
  error: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.danger, marginBottom: SPACING.sm },
  carga: { marginTop: SPACING.lg },
});
