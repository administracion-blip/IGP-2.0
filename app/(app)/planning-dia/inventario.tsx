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
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { FotoDobleConteo } from './FotoDobleConteo';
import {
  alSubirFoto,
  drenarCola,
  encolarFoto,
  numerosEnCola,
  resumenCola,
  siguienteNumero,
  suscribirCola,
} from './colaFotosConteo';
import {
  colors,
  statusColors,
  fontFamily,
  fontSizes,
  inputCursorProps,
  inputCursorStyle,
  radius,
  typography,
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
type PlantillaOpcion = {
  id: string;
  titulo: string;
  modo: string;
  numMiembros: number | null;
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

const GRUPO_SIN_LOCAL = 'Sin local';

function normalizarNombreAlmacen(val: string): string {
  return val
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function nombresAlmacenOrigen(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mismaBotella(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function fechaVisible(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** El listado trae cuántos miembros hay, no cuántos productos salen de cada familia. */
function textoResumen(plantilla: PlantillaOpcion): string | null {
  if (plantilla.numMiembros == null) return null;
  const n = plantilla.numMiembros;
  if (plantilla.modo === 'productos') {
    return `${n} ${n === 1 ? 'producto' : 'productos'}`;
  }
  if (plantilla.modo === 'familias') {
    return `${n} ${n === 1 ? 'familia' : 'familias'}`;
  }
  return null;
}

export default function InventarioConteoScreen() {
  const { hasPermiso } = useAuth();
  const puede = hasPermiso('inventario.contar') || hasPermiso('inventario.gestionar');
  const { isPhone } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const [fecha, setFecha] = useState(fechaJornadaNegocioIso);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [plantillaId, setPlantillaId] = useState<string | null>(null);
  const [almacenes, setAlmacenes] = useState<Array<{ id: string; titulo: string }>>([]);
  const [origenLocal, setOrigenLocal] = useState<Array<{ nombre: string; almacenes: string[] }>>([]);
  const [empleados, setEmpleados] = useState<Array<{ id: string; titulo: string }>>([]);
  const [plantillas, setPlantillas] = useState<PlantillaOpcion[]>([]);
  const [abiertos, setAbiertos] = useState<Abierto[]>([]);
  const [inventario, setInventario] = useState<Inventario | null>(null);
  const [textos, setTextos] = useState<Record<string, string>>({});
  const [filtro, setFiltro] = useState('');
  const [cargando, setCargando] = useState(true);
  const [abriendo, setAbriendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardandoId, setGuardandoId] = useState<string | null>(null);
  const [anadiendo, setAnadiendo] = useState(false);
  const [cargandoCatalogo, setCargandoCatalogo] = useState(false);
  const [catalogo, setCatalogo] = useState<Array<{ id: string; titulo: string; subtitulo?: string; badge?: string }> | null>(null);
  const [fotosServidor, setFotosServidor] = useState<Array<{ numero: number }>>([]);
  const [numerosReservados, setNumerosReservados] = useState<number[]>([]);
  const [capturando, setCapturando] = useState(false);
  const [colaTick, setColaTick] = useState(0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const lineasVisibles = useMemo(() => {
    const q = filtro.trim().toLocaleLowerCase('es');
    const lineas = inventario?.lineas || [];
    if (!q) return lineas;
    return lineas.filter(
      (l) => l.nombre.toLocaleLowerCase('es').includes(q) || l.productId.toLocaleLowerCase('es').includes(q),
    );
  }, [inventario, filtro]);

  const opcionesAnadir = useMemo(() => {
    const ya = new Set((inventario?.lineas || []).map((l) => l.productId));
    return (catalogo || []).filter((p) => !ya.has(p.id));
  }, [catalogo, inventario]);

  const opcionesAlmacen = useMemo(() => {
    const porNombre = new Map<string, string[]>();
    for (const loc of origenLocal) {
      for (const nom of loc.almacenes) {
        const key = normalizarNombreAlmacen(nom);
        if (!key) continue;
        const actuales = porNombre.get(key) ?? [];
        if (!actuales.includes(loc.nombre)) actuales.push(loc.nombre);
        porNombre.set(key, actuales);
      }
    }
    const agrupar = porNombre.size > 0;
    if (!agrupar) {
      return [...almacenes].sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'));
    }
    const filas: Array<{ id: string; titulo: string; grupo: string }> = [];
    for (const a of almacenes) {
      const locales = (porNombre.get(normalizarNombreAlmacen(a.titulo)) ?? [])
        .slice()
        .sort((x, y) => x.localeCompare(y, 'es'));
      if (locales.length === 0) {
        filas.push({ ...a, grupo: GRUPO_SIN_LOCAL });
        continue;
      }
      for (const nombre of locales) {
        filas.push({ id: a.id, titulo: a.titulo, grupo: nombre });
      }
    }
    filas.sort((a, b) => {
      const aSin = a.grupo === GRUPO_SIN_LOCAL ? 1 : 0;
      const bSin = b.grupo === GRUPO_SIN_LOCAL ? 1 : 0;
      if (aSin !== bSin) return aSin - bSin;
      const porGrupo = a.grupo.localeCompare(b.grupo, 'es');
      if (porGrupo !== 0) return porGrupo;
      return a.titulo.localeCompare(b.titulo, 'es');
    });
    return filas;
  }, [almacenes, origenLocal]);

  const cargarBase = useCallback(async () => {
    const [resAlm, resEmp, resLoc] = await Promise.all([
      apiFetch('/api/almacenes'),
      apiFetch('/api/personal/employees'),
      apiFetch('/api/locales'),
    ]);
    const alm = await leerJson(resAlm);
    const emp = await leerJson(resEmp);
    if (resLoc.ok) {
      const loc = await leerJson(resLoc);
      const listaLoc = Array.isArray(loc.locales) ? loc.locales : [];
      setOrigenLocal(
        listaLoc
          .map((l) => {
            const fila = l as Record<string, unknown>;
            const nombre = String(fila.nombre ?? fila.Nombre ?? '').trim();
            return {
              nombre,
              almacenes: nombresAlmacenOrigen(fila['almacen origen'] ?? fila['Almacen origen']),
            };
          })
          .filter((l) => l.nombre),
      );
    } else {
      setOrigenLocal([]);
    }
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

  const cargarPlantillas = useCallback(async () => {
    const res = await apiFetch('/api/inventarios/plantillas');
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
          const fila = p as { plantillaId?: unknown; nombre?: unknown; modo?: unknown; numMiembros?: unknown };
          const n = fila.numMiembros;
          return {
            id: String(fila.plantillaId ?? ''),
            titulo: String(fila.nombre || 'Plantilla'),
            modo: String(fila.modo || ''),
            numMiembros: typeof n === 'number' && Number.isFinite(n) ? n : null,
          };
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
    void cargarPlantillas().catch((e) => vivo && setError(e instanceof Error ? e.message : 'Error de conexión'));
    cargarBase()
      .catch((e) => vivo && setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
      for (const t of Object.values(timers.current)) clearTimeout(t);
    };
  }, [puede, cargarBase, cargarPlantillas]);

  useEffect(() => {
    if (!warehouseId) {
      setAbiertos([]);
      return;
    }
    void cargarAbiertos(warehouseId);
  }, [warehouseId, cargarAbiertos]);

  useEffect(() => {
    if (!inventario?.inventarioId) return;
    const id = inventario.inventarioId;
    let vivo = true;
    const cargarFotos = async () => {
      try {
        const res = await apiFetch(`/api/inventarios/${encodeURIComponent(id)}/fotos`);
        const body = await leerJson(res);
        if (!vivo || !res.ok) return;
        const lista = Array.isArray(body.fotos) ? body.fotos : [];
        setFotosServidor(
          lista
            .map((f) => Number((f as { numero?: unknown }).numero))
            .filter((n) => Number.isInteger(n) && n >= 1)
            .map((numero) => ({ numero })),
        );
      } catch { /* la cola sigue; se reintenta al volver la red */ }
    };
    void cargarFotos();
    alSubirFoto(() => { void cargarFotos(); });
    const dejar = suscribirCola(() => setColaTick((n) => n + 1));
    const reloj = setInterval(() => { void drenarCola(); }, 15000);
    return () => {
      vivo = false;
      alSubirFoto(null);
      dejar();
      clearInterval(reloj);
    };
  }, [inventario?.inventarioId]);

  useEffect(() => {
    if (!inventario?.inventarioId) return;
    const id = inventario.inventarioId;
    const enCola = new Set(numerosEnCola(id));
    const enServidor = new Set(fotosServidor.map((f) => f.numero));
    setNumerosReservados((prev) => prev.filter((n) => !enCola.has(n) && !enServidor.has(n)));
  }, [inventario?.inventarioId, fotosServidor, colaTick]);

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
    setAnadiendo(false);
  }

  async function prepararAnadir() {
    setAnadiendo(true);
    setError(null);
    if (catalogo) return;
    setCargandoCatalogo(true);
    try {
      const res = await apiFetch('/api/inventarios/productos');
      const body = await leerJson(res);
      if (!res.ok) {
        setCatalogo([]);
        setError(mensajeDe(body, 'No se han podido cargar los productos'));
        return;
      }
      const lista = Array.isArray(body.productos) ? body.productos : [];
      setCatalogo(
        lista
          .map((p) => {
            const fila = p as { productId?: unknown; nombre?: unknown; familiaNombre?: unknown };
            const id = String(fila.productId ?? '').trim();
            return {
              id,
              titulo: String(fila.nombre || id),
              subtitulo: String(fila.familiaNombre || '').trim() || undefined,
              badge: id,
            };
          })
          .filter((p) => p.id),
      );
    } catch (e) {
      setCatalogo([]);
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setCargandoCatalogo(false);
    }
  }

  async function anadirReferencia(productId: string) {
    if (!inventario) return;
    if (guardandoId) {
      setError('Espera a que se guarde la línea anterior.');
      return;
    }
    setGuardandoId(productId);
    setError(null);
    try {
      const res = await apiFetch(`/api/inventarios/${encodeURIComponent(inventario.inventarioId)}/lineas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      });
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido añadir el producto'));
        return;
      }
      const linea: Linea = {
        productId: String(body.productId ?? productId),
        nombre: String(body.nombre || productId),
        unidad: String(body.unidad || ''),
        stockReal: null,
        botellasAbiertas: Number(body.botellasAbiertas ?? 0),
      };
      setTextos((t) => ({ ...t, [linea.productId]: '' }));
      setInventario((actual) => {
        if (!actual) return actual;
        const lineas = [...(actual.lineas || []).filter((l) => l.productId !== linea.productId), linea];
        lineas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.productId.localeCompare(b.productId, 'es'));
        return { ...actual, lineas };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardandoId((id) => (id === productId ? null : id));
    }
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
    const fotosCupo = [
      ...fotosServidor,
      ...numerosReservados.map((numero) => ({ numero })),
    ];
    const cupo = resumenCola(inventario.inventarioId, fotosCupo);
    const colaFotos = resumenCola(inventario.inventarioId, fotosServidor);
    const numeroLibre = siguienteNumero(inventario.inventarioId, fotosCupo);
    return (
      <View style={styles.pagina}>
        <View style={styles.columna}>
          <View style={styles.cabecera}>
            <Pressable
              style={styles.iconoBtn}
              onPress={() => { setInventario(null); setAnadiendo(false); }}
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
          <View style={styles.buscadorFila}>
            <TextInput
              value={filtro}
              onChangeText={setFiltro}
              placeholder="Buscar producto"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, styles.buscadorFlex, inputCursorStyle]}
              {...inputCursorProps}
            />
            {editable ? (
              <Pressable
                style={[styles.botonFoto, numeroLibre == null && styles.botonOff]}
                disabled={numeroLibre == null}
                onPress={() => setCapturando(true)}
                accessibilityRole="button"
                accessibilityLabel={`Foto ${cupo.ocupados} de 6`}
              >
                <MaterialIcons name="photo-camera" size={18} color={colors.surface} />
                <Text style={styles.botonFotoTexto}>{`Foto (${cupo.ocupados}/6)`}</Text>
              </Pressable>
            ) : null}
          </View>
          {editable ? (
            <Text key={`cola-${colaTick}`} style={styles.colaFotos}>
              {`${colaFotos.subidas} subidas · ${colaFotos.enProceso} en proceso`}
            </Text>
          ) : null}
          <FotoDobleConteo
            visible={capturando}
            numero={numeroLibre}
            onCerrar={() => setCapturando(false)}
            onPar={(par) => {
              const numero = siguienteNumero(inventario.inventarioId, fotosCupo);
              setCapturando(false);
              if (numero == null) return;
              setNumerosReservados((prev) => (prev.includes(numero) ? prev : [...prev, numero]));
              void (async () => {
                try {
                  for (const foto of par) {
                    await encolarFoto({
                      inventarioId: inventario.inventarioId,
                      numero,
                      posicion: foto.posicion,
                      uri: foto.uri,
                      nombre: foto.nombre,
                      contentType: foto.contentType,
                      tamano: foto.tamano,
                    });
                  }
                } catch {
                  setNumerosReservados((prev) => prev.filter((n) => n !== numero));
                  setError('No se ha podido guardar la foto en el dispositivo');
                }
              })();
            }}
          />
          {editable ? (
            anadiendo ? (
              <SelectorDesplegable
                label="Añadir producto"
                placeholder="Elige un producto"
                icono="add"
                opciones={opcionesAnadir}
                valorId={null}
                onSeleccionar={(id) => void anadirReferencia(id)}
                tituloLista="Producto"
                buscador
                buscadorPlaceholder="Buscar producto"
                minCharsBusqueda={2}
                limiteResultados={40}
                loading={cargandoCatalogo}
                vacioTexto="No hay más productos"
              />
            ) : (
              <Pressable
                style={styles.botonAnadir}
                onPress={() => void prepararAnadir()}
                accessibilityRole="button"
                accessibilityLabel="Añadir producto"
              >
                <MaterialIcons name="add" size={20} color={colors.accent} />
                <Text style={styles.botonAnadirTexto}>Añadir producto</Text>
              </Pressable>
            )
          ) : null}
          <ScrollView style={styles.flex} contentContainerStyle={styles.lista} keyboardShouldPersistTaps="handled">
            {lineasVisibles.map((linea) => (
              <View key={linea.productId} style={styles.tarjeta}>
                <View style={styles.tarjetaCab}>
                  <View style={styles.productoFila}>
                    <View style={styles.badgeId}>
                      <Text style={styles.badgeIdTexto}>{linea.productId}</Text>
                    </View>
                    <Text style={styles.producto}>{linea.nombre}</Text>
                  </View>
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
        {ConfirmarView}
      </View>
    );
  }

  const datosListos = Boolean(warehouseId && employeeId && plantillaId);
  const elegida = plantillas.find((p) => p.id === plantillaId) ?? null;
  const resumenVisible = elegida ? textoResumen(elegida) : null;

  const botonEmpezar = (
    <Pressable
      style={[styles.botonEmpezar, !datosListos && styles.botonEmpezarOff, !isPhone && styles.botonEmpezarEnTarjeta]}
      disabled={!datosListos || abriendo}
      onPress={() => void empezar()}
      accessibilityRole="button"
      accessibilityState={{ disabled: !datosListos || abriendo }}
      accessibilityLabel={datosListos ? 'Empezar conteo' : 'Faltan datos'}
    >
      {abriendo ? (
        <ActivityIndicator color={colors.surface} />
      ) : (
        <View style={styles.botonEmpezarFila}>
          <Text style={[styles.botonEmpezarTexto, !datosListos && styles.botonEmpezarTextoOff]}>
            {datosListos ? 'Empezar conteo' : 'Faltan datos'}
          </Text>
          {datosListos ? <MaterialIcons name="arrow-forward" size={20} color={colors.surface} /> : null}
        </View>
      )}
    </Pressable>
  );

  return (
    <View style={styles.pagina}>
      <ScrollView
        style={styles.formularioScroll}
        contentContainerStyle={[styles.formulario, isPhone && styles.formularioMovil]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.tarjetaInicio}>
          <Text style={styles.titulo}>Inventario</Text>
          <Text style={styles.subtitulo}>Elige fecha, persona, almacén y plantilla. El conteo es a ciegas.</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {cargando ? <ActivityIndicator color={colors.accent} /> : null}
          <View style={styles.campos}>
            <View>
              <Text style={styles.etiquetaCampo}>Fecha</Text>
              <View style={styles.fechaCaja}>
                <MaterialIcons name="calendar-today" size={16} color={colors.accent} />
                <Text style={styles.fechaValor} numberOfLines={1}>{fechaVisible(fecha) || 'dd/mm/aaaa'}</Text>
                <MaterialIcons name="arrow-drop-down" size={22} color={colors.textMuted} />
                <View style={styles.fechaCapa}>
                  <InputFecha valueIso={fecha} onChangeIso={setFecha} style={styles.fechaInputCapa} />
                </View>
              </View>
            </View>
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
              opciones={opcionesAlmacen}
              valorId={warehouseId}
              onSeleccionar={setWarehouseId}
              tituloLista="Almacén"
              buscador
              buscadorPlaceholder="Buscar almacén"
            />
            <View>
              <SelectorDesplegable
                label="Plantilla"
                placeholder="Elige una plantilla"
                icono="inventory"
                opciones={plantillas}
                valorId={plantillaId}
                onSeleccionar={setPlantillaId}
                tituloLista="Plantilla"
                vacioTexto="No hay plantillas de familias"
              />
              {resumenVisible ? <Text style={styles.resumen}>{resumenVisible}</Text> : null}
            </View>
          </View>
          {isPhone ? null : botonEmpezar}
        </View>
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
      </ScrollView>
      {isPhone ? <View style={styles.botonFijo}>{botonEmpezar}</View> : null}
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  pagina: { flex: 1, backgroundColor: colors.bg },
  columna: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', padding: SPACING.lg },
  formularioScroll: { flex: 1, width: '100%' },
  formulario: {
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: SPACING.xl,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.xl,
  },
  formularioMovil: { paddingBottom: MIN_TOUCH + SPACING.xl },
  tarjetaInicio: {
    width: '100%',
    maxWidth: 560,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: SPACING.xl,
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)' } as object)
      : {
          shadowColor: '#0f172a',
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.08,
          shadowRadius: 16,
          elevation: 4,
        }),
  },
  campos: { gap: SPACING.lg },
  etiquetaCampo: {
    ...typography.etiqueta,
    marginBottom: SPACING.xs,
  },
  fechaCaja: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: colors.bg,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    minHeight: 46,
  },
  fechaValor: {
    flex: 1,
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[13],
    color: colors.textStrong,
  },
  fechaCapa: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0,
  },
  fechaInputCapa: {
    minHeight: 46,
    height: 46,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  resumen: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[12],
    color: colors.textSecondary,
    marginTop: SPACING.xs,
  },
  botonEmpezar: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  botonEmpezarEnTarjeta: { marginTop: SPACING.lg },
  botonEmpezarOff: { backgroundColor: colors.borderStrong },
  botonEmpezarFila: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  botonEmpezarTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.surface },
  botonEmpezarTextoOff: { color: colors.textSecondary },
  botonFijo: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.lg,
    backgroundColor: colors.bg,
  },
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
  productoFila: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, minWidth: 0 },
  badgeId: {
    flexShrink: 0,
    backgroundColor: statusColors.info.bg,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeIdTexto: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[12],
    color: statusColors.info.text,
  },
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
  buscadorFila: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  buscadorFlex: { flex: 1, minWidth: 0, marginTop: SPACING.sm },
  botonFoto: {
    minHeight: MIN_TOUCH,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    flexShrink: 0,
  },
  botonFotoTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.surface },
  colaFotos: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[13],
    color: colors.textSecondary,
    marginBottom: SPACING.sm,
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
  botonAnadir: {
    minHeight: MIN_TOUCH,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.lg,
  },
  botonAnadirTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.accentPressed },
  abiertos: { width: '100%', maxWidth: 560, marginTop: SPACING.lg, gap: SPACING.sm },
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
