/**
 * Conteo a ciegas. La fecha, la persona, el almacén y la plantilla se eligen aquí.
 * El stock teórico no se muestra. Cada cambio se guarda al momento.
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
import { useConfirmar } from '../../hooks/useConfirmar';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';
import { InputFecha } from '../../components/InputFecha';
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

const BOTELLAS = [
  { valor: 0, etiqueta: '0' },
  { valor: 0.1, etiqueta: '0,10' },
  { valor: 0.25, etiqueta: '0,25' },
  { valor: 0.5, etiqueta: '0,50' },
  { valor: 0.75, etiqueta: '0,75' },
  { valor: 0.9, etiqueta: '0,90' },
] as const;

type Linea = {
  productId: string;
  nombre: string;
  unidad: string;
  stockReal: number | null;
  botellasAbiertas: number;
};
type Inventario = {
  inventarioId: string;
  fecha: string;
  employeeNombre?: string;
  plantillaNombre?: string;
  estado: string;
  lineas?: Linea[];
};
type Abierto = {
  inventarioId: string;
  fecha: string;
  employeeNombre?: string;
  plantillaNombre?: string;
  estado: string;
};

async function leerJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function mensajeDe(body: Record<string, unknown>, respaldo: string): string {
  return typeof body.error === 'string' && body.error.trim() ? body.error : respaldo;
}

function textoCantidad(n: number | null | undefined): string {
  if (n == null) return '';
  return String(n).replace('.', ',');
}

function parseCantidad(raw: string): number | null | 'mal' {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 'mal';
  return n;
}

function mismaBotella(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

export default function InventarioConteoScreen() {
  const { hasPermiso } = useAuth();
  const puede = hasPermiso('inventario.contar') || hasPermiso('inventario.gestionar');
  const { confirmar, ConfirmarView } = useConfirmar();

  const [fecha, setFecha] = useState(fechaJornadaNegocioIso);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [plantillaId, setPlantillaId] = useState<string | null>(null);
  const [almacenes, setAlmacenes] = useState<Array<{ id: string; titulo: string }>>([]);
  const [empleados, setEmpleados] = useState<Array<{ id: string; titulo: string }>>([]);
  const [plantillas, setPlantillas] = useState<Array<{ id: string; titulo: string }>>([]);
  const [abiertos, setAbiertos] = useState<Abierto[]>([]);
  const [inventario, setInventario] = useState<Inventario | null>(null);
  const [textos, setTextos] = useState<Record<string, string>>({});
  const [filtro, setFiltro] = useState('');
  const [cargando, setCargando] = useState(true);
  const [abriendo, setAbriendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardandoId, setGuardandoId] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const lineasVisibles = useMemo(() => {
    const q = filtro.trim().toLocaleLowerCase('es');
    const lineas = inventario?.lineas || [];
    if (!q) return lineas;
    return lineas.filter(
      (l) => l.nombre.toLocaleLowerCase('es').includes(q) || l.productId.toLocaleLowerCase('es').includes(q),
    );
  }, [inventario, filtro]);

  const cargarBase = useCallback(async () => {
    const [resAlm, resEmp] = await Promise.all([
      apiFetch('/api/almacenes'),
      apiFetch('/api/personal/employees'),
    ]);
    const alm = await leerJson(resAlm);
    const emp = await leerJson(resEmp);
    const listaAlm = Array.isArray(alm.almacenes) ? alm.almacenes : [];
    setAlmacenes(
      listaAlm
        .map((a) => {
          const fila = a as { Id?: unknown; Nombre?: unknown };
          return { id: String(fila.Id ?? '').trim(), titulo: String(fila.Nombre || fila.Id || 'Almacén') };
        })
        .filter((a) => a.id)
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    );
    const listaEmp = Array.isArray(emp.employees) ? emp.employees : [];
    setEmpleados(
      listaEmp
        .filter((e) => (e as { active?: unknown }).active !== false)
        .map((e) => {
          const fila = e as { employee_id?: unknown; full_name?: unknown };
          const id = String(fila.employee_id ?? '').trim();
          return { id, titulo: String(fila.full_name || id) };
        })
        .filter((e) => e.id)
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    );
  }, []);

  const cargarPlantillas = useCallback(async (wid: string) => {
    const res = await apiFetch(`/api/inventarios/plantillas?warehouseId=${encodeURIComponent(wid)}`);
    const body = await leerJson(res);
    if (!res.ok) {
      setPlantillas([]);
      setError(mensajeDe(body, 'No se han podido cargar las plantillas'));
      return;
    }
    const lista = Array.isArray(body.plantillas) ? body.plantillas : [];
    setPlantillas(
      lista
        .filter((p) => (p as { modo?: string }).modo === 'familias')
        .map((p) => {
          const fila = p as { plantillaId?: unknown; nombre?: unknown };
          return { id: String(fila.plantillaId ?? ''), titulo: String(fila.nombre || 'Plantilla') };
        })
        .filter((p) => p.id),
    );
  }, []);

  const cargarAbiertos = useCallback(async (wid: string) => {
    const res = await apiFetch(`/api/inventarios?warehouseId=${encodeURIComponent(wid)}`);
    const body = await leerJson(res);
    if (!res.ok) {
      setAbiertos([]);
      return;
    }
    const lista = Array.isArray(body.inventarios) ? body.inventarios : [];
    setAbiertos(
      (lista as Abierto[]).filter((i) => i.estado === 'borrador' || i.estado === 'contado'),
    );
  }, []);

  useEffect(() => {
    if (!puede) {
      setCargando(false);
      return;
    }
    let vivo = true;
    cargarBase()
      .catch((e) => vivo && setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
      for (const t of Object.values(timers.current)) clearTimeout(t);
    };
  }, [puede, cargarBase]);

  useEffect(() => {
    if (!warehouseId) {
      setPlantillas([]);
      setAbiertos([]);
      setPlantillaId(null);
      return;
    }
    setPlantillaId(null);
    void cargarPlantillas(warehouseId);
    void cargarAbiertos(warehouseId);
  }, [warehouseId, cargarPlantillas, cargarAbiertos]);

  function entrar(inv: Inventario) {
    const lineas = (inv.lineas || []).map((l) => ({
      productId: String(l.productId),
      nombre: String(l.nombre || l.productId),
      unidad: String(l.unidad || ''),
      stockReal: l.stockReal ?? null,
      botellasAbiertas: Number(l.botellasAbiertas ?? 0),
    }));
    setInventario({ ...inv, lineas });
    const mapa: Record<string, string> = {};
    for (const l of lineas) mapa[l.productId] = textoCantidad(l.stockReal);
    setTextos(mapa);
    setFiltro('');
    setError(null);
  }

  async function abrirExistente(id: string) {
    setAbriendo(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/inventarios/${encodeURIComponent(id)}`);
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido abrir el inventario'));
        return;
      }
      entrar(body as unknown as Inventario);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setAbriendo(false);
    }
  }

  async function empezar() {
    if (!warehouseId || !employeeId || !plantillaId || abriendo) return;
    const persona = empleados.find((e) => e.id === employeeId);
    setAbriendo(true);
    setError(null);
    try {
      const res = await apiFetch('/api/inventarios/conteo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          warehouseId,
          fecha,
          employeeId,
          employeeNombre: persona?.titulo || '',
          plantillaId,
        }),
      });
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido abrir el conteo'));
        return;
      }
      entrar(body as unknown as Inventario);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setAbriendo(false);
    }
  }

  const persistir = useCallback(async (productId: string, stockReal: number | null, botellasAbiertas: number) => {
    if (!inventario) return;
    setGuardandoId(productId);
    try {
      const res = await apiFetch(
        `/api/inventarios/${encodeURIComponent(inventario.inventarioId)}/lineas/${encodeURIComponent(productId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stockReal, botellasAbiertas }),
        },
      );
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido guardar la línea'));
        return;
      }
      setInventario((actual) => {
        if (!actual?.lineas) return actual;
        return {
          ...actual,
          lineas: actual.lineas.map((l) => (
            l.productId === productId ? { ...l, stockReal, botellasAbiertas } : l
          )),
        };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardandoId((id) => (id === productId ? null : id));
    }
  }, [inventario]);

  function programar(productId: string, raw: string, botellasAbiertas: number) {
    setTextos((t) => ({ ...t, [productId]: raw }));
    const parsed = parseCantidad(raw);
    if (parsed === 'mal') return;
    const previo = timers.current[productId];
    if (previo) clearTimeout(previo);
    timers.current[productId] = setTimeout(() => {
      void persistir(productId, parsed, botellasAbiertas);
    }, 400);
  }

  function elegirBotella(linea: Linea, valor: number) {
    const previo = timers.current[linea.productId];
    if (previo) clearTimeout(previo);
    const parsed = parseCantidad(textos[linea.productId] ?? textoCantidad(linea.stockReal));
    const stockReal = parsed === 'mal' ? linea.stockReal : parsed;
    setInventario((actual) => {
      if (!actual?.lineas) return actual;
      return {
        ...actual,
        lineas: actual.lineas.map((l) => (
          l.productId === linea.productId ? { ...l, botellasAbiertas: valor } : l
        )),
      };
    });
    void persistir(linea.productId, stockReal, valor);
  }

  async function marcarContado() {
    if (!inventario || inventario.estado !== 'borrador') return;
    const ok = await confirmar(
      'Marcar como contado',
      'El conteo quedará listo para revisarlo en Compras.',
      { confirmarLabel: 'Marcar contado' },
    );
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/inventarios/${encodeURIComponent(inventario.inventarioId)}/estado`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'contado' }),
      });
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido marcar el conteo'));
        return;
      }
      setInventario((actual) => (actual ? { ...actual, estado: 'contado' } : actual));
      if (warehouseId) await cargarAbiertos(warehouseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    }
  }

  if (!puede) {
    return (
      <View style={styles.pagina}>
        <Text style={styles.titulo}>Inventario</Text>
        <Text style={styles.aviso}>No tienes permiso para contar.</Text>
      </View>
    );
  }

  if (inventario) {
    const editable = inventario.estado === 'borrador' || inventario.estado === 'contado';
    return (
      <View style={styles.pagina}>
        <View style={styles.columna}>
          <View style={styles.cabecera}>
            <Pressable
              style={styles.iconoBtn}
              onPress={() => setInventario(null)}
              accessibilityRole="button"
              accessibilityLabel="Volver"
            >
              <MaterialIcons name="arrow-back" size={22} color={colors.textStrong} />
            </Pressable>
            <View style={styles.cabeceraTexto}>
              <Text style={styles.titulo}>Conteo</Text>
              <Text style={styles.subtitulo}>
                {inventario.fecha} · {inventario.employeeNombre || 'Sin persona'} · {inventario.plantillaNombre || ''}
              </Text>
            </View>
          </View>
          <Text style={styles.ciego}>El stock teórico no se muestra.</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TextInput
            value={filtro}
            onChangeText={setFiltro}
            placeholder="Buscar producto"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, inputCursorStyle]}
            {...inputCursorProps}
          />
          <ScrollView style={styles.flex} contentContainerStyle={styles.lista} keyboardShouldPersistTaps="handled">
            {lineasVisibles.map((linea) => (
              <View key={linea.productId} style={styles.tarjeta}>
                <View style={styles.tarjetaCab}>
                  <Text style={styles.producto}>{linea.nombre}</Text>
                  {guardandoId === linea.productId ? <ActivityIndicator color={colors.accent} /> : null}
                </View>
                {linea.unidad ? <Text style={styles.unidad}>{linea.unidad}</Text> : null}
                <TextInput
                  value={textos[linea.productId] ?? ''}
                  onChangeText={(raw) => editable && programar(linea.productId, raw, linea.botellasAbiertas)}
                  editable={editable}
                  keyboardType="decimal-pad"
                  placeholder="Stock real"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, inputCursorStyle]}
                  accessibilityLabel={`Stock real de ${linea.nombre}`}
                  {...inputCursorProps}
                />
                <View style={styles.botellas}>
                  {BOTELLAS.map((b) => {
                    const activa = mismaBotella(linea.botellasAbiertas, b.valor);
                    return (
                      <Pressable
                        key={b.etiqueta}
                        style={[styles.botella, activa && styles.botellaActiva]}
                        disabled={!editable}
                        onPress={() => elegirBotella(linea, b.valor)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: activa }}
                        accessibilityLabel={`Botella abierta ${b.etiqueta}`}
                      >
                        <Text style={[styles.botellaTexto, activa && styles.botellaTextoActiva]}>{b.etiqueta}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ))}
          </ScrollView>
          {inventario.estado === 'borrador' ? (
            <Pressable style={styles.boton} onPress={() => void marcarContado()} accessibilityRole="button">
              <Text style={styles.botonTexto}>Marcar como contado</Text>
            </Pressable>
          ) : (
            <Text style={styles.aviso}>Estado: {inventario.estado}. El conteo sigue guardado.</Text>
          )}
        </View>
        <ConfirmarView />
      </View>
    );
  }

  return (
    <View style={styles.pagina}>
      <ScrollView contentContainerStyle={styles.formulario} keyboardShouldPersistTaps="handled">
        <View style={styles.columna}>
          <Text style={styles.titulo}>Inventario</Text>
          <Text style={styles.subtitulo}>Elige fecha, persona, almacén y plantilla. El conteo es a ciegas.</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {cargando ? <ActivityIndicator color={colors.accent} /> : null}
          <Text style={styles.etiqueta}>Fecha</Text>
          <InputFecha valueIso={fecha} onChangeIso={setFecha} />
          <SelectorDesplegable
            label="Persona"
            placeholder="Elige a la persona"
            icono="person"
            opciones={empleados}
            valorId={employeeId}
            onSeleccionar={setEmployeeId}
            tituloLista="Persona"
            buscador
            buscadorPlaceholder="Buscar persona"
          />
          <SelectorDesplegable
            label="Almacén"
            placeholder="Elige un almacén"
            icono="warehouse"
            opciones={almacenes}
            valorId={warehouseId}
            onSeleccionar={setWarehouseId}
            tituloLista="Almacén"
            buscador
            buscadorPlaceholder="Buscar almacén"
          />
          <SelectorDesplegable
            label="Plantilla"
            placeholder="Elige una plantilla"
            icono="inventory"
            opciones={plantillas}
            valorId={plantillaId}
            onSeleccionar={setPlantillaId}
            tituloLista="Plantilla"
            disabled={!warehouseId}
            vacioTexto="Este almacén no tiene plantillas de familias"
          />
          <Pressable
            style={[styles.boton, (!warehouseId || !employeeId || !plantillaId || abriendo) && styles.botonOff]}
            disabled={!warehouseId || !employeeId || !plantillaId || abriendo}
            onPress={() => void empezar()}
            accessibilityRole="button"
            accessibilityLabel="Empezar conteo"
          >
            {abriendo ? <ActivityIndicator color={colors.surface} /> : <Text style={styles.botonTexto}>Empezar conteo</Text>}
          </Pressable>
          {abiertos.length > 0 ? (
            <View style={styles.abiertos}>
              <Text style={styles.etiqueta}>Conteos abiertos</Text>
              {abiertos.map((a) => (
                <Pressable
                  key={a.inventarioId}
                  style={styles.abierto}
                  onPress={() => void abrirExistente(a.inventarioId)}
                  accessibilityRole="button"
                  accessibilityLabel={`Continuar conteo ${a.fecha}`}
                >
                  <Text style={styles.producto}>{a.fecha} · {a.employeeNombre || 'Sin persona'}</Text>
                  <Text style={styles.unidad}>{a.plantillaNombre || a.estado}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>
      <ConfirmarView />
    </View>
  );
}

const styles = StyleSheet.create({
  pagina: { flex: 1, backgroundColor: colors.bg },
  columna: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', padding: SPACING.lg },
  formulario: { paddingBottom: SPACING.xl },
  flex: { flex: 1 },
  titulo: { fontFamily: fontFamily.bold, fontSize: fontSizes[20], color: colors.textStrong },
  subtitulo: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textSecondary,
    marginTop: 4,
    marginBottom: SPACING.md,
  },
  ciego: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[13],
    color: colors.textSecondary,
    marginBottom: SPACING.sm,
  },
  etiqueta: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[13],
    color: colors.textSecondary,
    marginBottom: 4,
    marginTop: SPACING.sm,
  },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginBottom: SPACING.sm },
  cabeceraTexto: { flex: 1 },
  iconoBtn: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  lista: { gap: SPACING.sm, paddingBottom: SPACING.md },
  tarjeta: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: SPACING.md,
  },
  tarjetaCab: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  producto: { flex: 1, fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textStrong },
  unidad: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textSecondary, marginBottom: SPACING.xs },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[16],
    color: colors.textStrong,
    backgroundColor: colors.surface,
  },
  botellas: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  botella: {
    minWidth: 72,
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  botellaActiva: { backgroundColor: colors.accent, borderColor: colors.accent },
  botellaTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textPrimary },
  botellaTextoActiva: { color: colors.surface },
  boton: {
    minHeight: MIN_TOUCH,
    marginTop: SPACING.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  botonOff: { opacity: 0.5 },
  botonTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.surface },
  abiertos: { marginTop: SPACING.lg, gap: SPACING.sm },
  abierto: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  aviso: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.warning, marginTop: SPACING.sm },
  error: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.danger, marginBottom: SPACING.sm },
});
