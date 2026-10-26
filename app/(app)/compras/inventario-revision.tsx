/**
 * Revisión del conteo contra el stock teórico copiado al abrirlo.
 * El porcentaje del semáforo lo guarda quien revisa. No se vuelve a leer Ágora.
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
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { apiFetch } from '../../utils/api';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { clasificarLinea, stockContado, type Semaforo } from '../../lib/inventarioDiferencia';
import {
  colors,
  fontFamily,
  fontSizes,
  inputCursorProps,
  inputCursorStyle,
  radius,
  statusColors,
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
  familiaNombre: string;
  unidad: string;
  stockTeorico: number;
  stockReal: number | null;
  botellasAbiertas: number;
};
type Inventario = {
  inventarioId: string;
  fecha: string;
  employeeNombre?: string;
  plantillaNombre?: string;
  estado: string;
  estadoEn?: string | null;
  estadoPor?: string;
  exportaciones?: number;
  ultimaExportacionEn?: string | null;
  ultimaExportacionPor?: string;
  lineas?: Linea[];
};
type Resumen = {
  inventarioId: string;
  fecha: string;
  employeeNombre?: string;
  plantillaNombre?: string;
  estado: string;
};
type Filtro = 'todas' | 'fuera' | 'sin-contar';

const EDITABLES = new Set(['contado', 'revisado']);

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

function formato(n: number): string {
  return n.toLocaleString('es-ES', { maximumFractionDigits: 4 });
}

function parseCantidad(raw: string): number | null | 'mal' {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 'mal';
  return n;
}

function parsePorcentaje(raw: string): number | null | 'mal' {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 'mal';
  return n;
}

function totalEscrito(texto: string, botellas: number): number | null {
  const parsed = parseCantidad(texto);
  if (parsed === 'mal') return null;
  return stockContado({ stockReal: parsed, botellasAbiertas: botellas });
}

function TotalContado({ texto, botellas, nombre }: { texto: string; botellas: number; nombre: string }) {
  const total = totalEscrito(texto, botellas);
  const visible = total == null ? '—' : textoCantidad(total);
  return (
    <View style={styles.totalCaja} accessibilityLabel={`Total de ${nombre}: ${visible}`}>
      <Text style={styles.totalEtiqueta}>Total</Text>
      <Text style={styles.totalValor}>{visible}</Text>
    </View>
  );
}

function mismaBotella(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function fechaHoraEs(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(binary);
  // @ts-expect-error Buffer en entornos Node/web embebido
  return Buffer.from(bytes).toString('base64');
}

function textoSemaforo(s: Semaforo): string {
  if (s === 'ok') return 'Dentro';
  if (s === 'fuera') return 'Fuera';
  if (s === 'sin-contar') return 'Sin contar';
  return 'Sin umbral';
}

export default function InventarioRevisionScreen() {
  const { hasPermiso, user } = useAuth();
  const puede = hasPermiso('inventario.gestionar');
  const { shouldStackPanels } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const [almacenes, setAlmacenes] = useState<Array<{ id: string; titulo: string }>>([]);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [lista, setLista] = useState<Resumen[]>([]);
  const [inventario, setInventario] = useState<Inventario | null>(null);
  const [textos, setTextos] = useState<Record<string, string>>({});
  const [umbralTexto, setUmbralTexto] = useState('');
  const [umbralGuardado, setUmbralGuardado] = useState<number | null>(null);
  const [filtroLinea, setFiltroLinea] = useState<Filtro>('todas');
  const [busqueda, setBusqueda] = useState('');
  const [cargando, setCargando] = useState(true);
  const [cargandoLista, setCargandoLista] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardandoId, setGuardandoId] = useState<string | null>(null);
  const [descargando, setDescargando] = useState(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const listaTicket = useRef(0);

  const porcentajeVista = useMemo(() => {
    const parsed = parsePorcentaje(umbralTexto);
    if (parsed === 'mal') return umbralGuardado;
    return parsed;
  }, [umbralTexto, umbralGuardado]);

  const lineas = inventario?.lineas || [];
  const clases = useMemo(
    () => lineas.map((l) => clasificarLinea(l, porcentajeVista)),
    [lineas, porcentajeVista],
  );
  const fueraN = clases.filter((c) => c.semaforo === 'fuera').length;
  const sinContarN = clases.filter((c) => c.semaforo === 'sin-contar').length;

  const lineasVisibles = useMemo(() => {
    const q = busqueda.trim().toLocaleLowerCase('es');
    return lineas.filter((l, i) => {
      const clase = clases[i];
      if (filtroLinea === 'fuera' && clase?.semaforo !== 'fuera') return false;
      if (filtroLinea === 'sin-contar' && clase?.semaforo !== 'sin-contar') return false;
      if (!q) return true;
      return l.nombre.toLocaleLowerCase('es').includes(q) || l.productId.toLocaleLowerCase('es').includes(q);
    });
  }, [lineas, clases, filtroLinea, busqueda]);

  const editable = !!inventario && EDITABLES.has(inventario.estado);

  const cargarBase = useCallback(async () => {
    const [resAlm, resUmb] = await Promise.all([
      apiFetch('/api/almacenes'),
      apiFetch('/api/inventarios/umbral'),
    ]);
    const alm = await leerJson(resAlm);
    const umb = await leerJson(resUmb);
    const filas = Array.isArray(alm.almacenes) ? alm.almacenes : [];
    setAlmacenes(
      filas
        .map((a) => {
          const fila = a as { Id?: unknown; Nombre?: unknown };
          return { id: String(fila.Id ?? '').trim(), titulo: String(fila.Nombre || fila.Id || 'Almacén') };
        })
        .filter((a) => a.id)
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    );
    if (resUmb.ok && (typeof umb.porcentaje === 'number' || umb.porcentaje == null)) {
      const n = typeof umb.porcentaje === 'number' ? umb.porcentaje : null;
      setUmbralGuardado(n);
      setUmbralTexto(n == null ? '' : textoCantidad(n));
    }
  }, []);

  const cargarLista = useCallback(async (wid: string) => {
    const ticket = ++listaTicket.current;
    setCargandoLista(true);
    try {
      const res = await apiFetch(`/api/inventarios?warehouseId=${encodeURIComponent(wid)}`);
      const body = await leerJson(res);
      if (ticket !== listaTicket.current) return;
      if (!res.ok) {
        setLista([]);
        setError(mensajeDe(body, 'No se han podido cargar los inventarios'));
        return;
      }
      const filas = Array.isArray(body.inventarios) ? (body.inventarios as Resumen[]) : [];
      setLista(filas.filter((i) => i.estado !== 'borrador'));
    } catch (e) {
      if (ticket !== listaTicket.current) return;
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
    cargarBase()
      .catch((e) => vivo && setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
      for (const t of Object.values(timers.current)) clearTimeout(t);
    };
  }, [puede, cargarBase]);

  useEffect(() => {
    setInventario(null);
    if (!warehouseId) {
      setLista([]);
      return;
    }
    void cargarLista(warehouseId);
  }, [warehouseId, cargarLista]);

  function entrar(inv: Inventario) {
    const normalizadas = (inv.lineas || []).map((l) => ({
      productId: String(l.productId),
      nombre: String(l.nombre || l.productId),
      familiaNombre: String(l.familiaNombre || ''),
      unidad: String(l.unidad || ''),
      stockTeorico: Number(l.stockTeorico ?? 0),
      stockReal: l.stockReal ?? null,
      botellasAbiertas: Number(l.botellasAbiertas ?? 0),
    }));
    setInventario({ ...inv, lineas: normalizadas });
    const mapa: Record<string, string> = {};
    for (const l of normalizadas) mapa[l.productId] = textoCantidad(l.stockReal);
    setTextos(mapa);
    setBusqueda('');
    setFiltroLinea('todas');
    setError(null);
  }

  async function abrir(id: string) {
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
    }
  }

  async function guardarUmbral() {
    const parsed = parsePorcentaje(umbralTexto);
    if (parsed === 'mal') {
      setError('El porcentaje debe ser un número ≥ 0');
      return;
    }
    setError(null);
    try {
      const res = await apiFetch('/api/inventarios/umbral', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ porcentaje: parsed }),
      });
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido guardar el umbral'));
        return;
      }
      const n = typeof body.porcentaje === 'number' ? body.porcentaje : null;
      setUmbralGuardado(n);
      setUmbralTexto(n == null ? '' : textoCantidad(n));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
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
      setTextos((t) => ({ ...t, [productId]: textoCantidad(stockReal) }));
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
    if (!editable) return;
    const previo = timers.current[linea.productId];
    if (previo) clearTimeout(previo);
    const parsed = parseCantidad(textos[linea.productId] ?? textoCantidad(linea.stockReal));
    const stockReal = parsed === 'mal' ? linea.stockReal : parsed;
    void persistir(linea.productId, stockReal, valor);
  }

  async function cambiarEstado(estado: 'revisado' | 'contado' | 'importado') {
    if (!inventario) return false;
    try {
      const res = await apiFetch(`/api/inventarios/${encodeURIComponent(inventario.inventarioId)}/estado`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado }),
      });
      const body = await leerJson(res);
      if (!res.ok) {
        setError(mensajeDe(body, 'No se ha podido cambiar el estado'));
        return false;
      }
      setInventario((actual) => (actual ? {
        ...actual,
        estado: typeof body.estado === 'string' ? body.estado : estado,
        estadoEn: typeof body.estadoEn === 'string' ? body.estadoEn : actual.estadoEn,
        estadoPor: typeof body.estadoPor === 'string' ? body.estadoPor : actual.estadoPor,
      } : actual));
      if (warehouseId) await cargarLista(warehouseId);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
      return false;
    }
  }

  async function marcarRevisado() {
    if (!inventario || inventario.estado !== 'contado') return;
    const avisos = [
      sinContarN > 0 ? `${sinContarN} sin contar` : '',
      fueraN > 0 ? `${fueraN} fuera del umbral` : '',
    ].filter(Boolean);
    const ok = await confirmar(
      'Marcar como revisado',
      avisos.length > 0
        ? `Hay ${avisos.join(' y ')}. El teórico no se vuelve a leer de Ágora.`
        : 'El conteo queda revisado. El teórico es el del momento en que se abrió.',
      { confirmarLabel: 'Marcar revisado' },
    );
    if (!ok) return;
    await cambiarEstado('revisado');
  }

  async function recontar(linea: Linea) {
    if (!inventario || !editable) return;
    const vuelve = inventario.estado === 'revisado';
    const ok = await confirmar(
      'Recontar producto',
      vuelve
        ? 'Se vacía el stock real y el inventario vuelve a contado para que lo cuenten otra vez.'
        : 'Se vacía el stock real de este producto para contarlo otra vez.',
      { confirmarLabel: 'Recontar' },
    );
    if (!ok) return;
    if (vuelve) {
      const cambio = await cambiarEstado('contado');
      if (!cambio) return;
    }
    const previo = timers.current[linea.productId];
    if (previo) clearTimeout(previo);
    await persistir(linea.productId, null, 0);
  }

  async function descargarExcel() {
    if (!inventario || descargando) return;
    const id = inventario.inventarioId;
    if (inventario.estado === 'exportado') {
      const cuando = fechaHoraEs(inventario.ultimaExportacionEn || inventario.estadoEn);
      const persona = inventario.ultimaExportacionPor || inventario.estadoPor || '';
      const ok = await confirmar(
        'Ya se exportó',
        `Este Excel ya se descargó${cuando ? ` el ${cuando}` : ''}${persona ? ` por ${persona}` : ''}. Ágora no se actualiza solo. ¿Descargarlo otra vez?`,
        { confirmarLabel: 'Descargar otra vez' },
      );
      if (!ok) return;
    }
    setDescargando(true);
    setError(null);
    try {
      const repetir = inventario.estado === 'exportado' ? '?repetir=1' : '';
      const res = await apiFetch(`/api/inventarios/${encodeURIComponent(id)}/excel${repetir}`, { timeoutMs: 0 });
      if (!res.ok) {
        const body = await leerJson(res);
        setError(mensajeDe(body, 'No se ha podido generar el Excel'));
        return;
      }
      const buffer = await res.arrayBuffer();
      const disp = res.headers.get('Content-Disposition') || '';
      const nombre = disp.match(/filename="?([^"]+)"?/)?.[1] || `Inventario-${inventario.fecha}.xlsx`;
      if (Platform.OS === 'web') {
        const blob = new Blob([buffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombre;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
        const fileUri = `${cacheDir}${nombre}`;
        await FileSystemLegacy.writeAsStringAsync(fileUri, arrayBufferToBase64(buffer), {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: nombre,
        });
      }
      await abrir(id);
      if (warehouseId) await cargarLista(warehouseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setDescargando(false);
    }
  }

  async function marcarImportado() {
    if (!inventario || inventario.estado !== 'exportado') return;
    const persona = user?.Nombre || user?.email || 'esta sesión';
    const ok = await confirmar(
      'Marcar como importado',
      `Se anota ahora, a nombre de ${persona}. El inventario queda cerrado. Ágora solo cambia cuando importas el Excel a mano.`,
      { confirmarLabel: 'Marcar importado' },
    );
    if (!ok) return;
    await cambiarEstado('importado');
  }

  async function volverARevisado() {
    const ok = await confirmar(
      'Volver a revisado',
      'Podrás corregir líneas y volver a descargar el Excel.',
      { confirmarLabel: 'Volver a revisado' },
    );
    if (!ok) return;
    await cambiarEstado('revisado');
  }

  if (!puede) {
    return (
      <View style={styles.pagina}>
        <Text style={styles.titulo}>Revisión de inventario</Text>
        <Text style={styles.aviso}>No tienes permiso para revisar inventarios.</Text>
      </View>
    );
  }

  const mostrarLista = !inventario || !shouldStackPanels;

  return (
    <View style={styles.pagina}>
      <ScrollView contentContainerStyle={styles.contenido} keyboardShouldPersistTaps="handled">
        <Text style={styles.titulo}>Revisión de inventario</Text>
        <Text style={styles.subtitulo}>
          El stock teórico es el que había en Ágora al abrir el conteo. No se vuelve a consultar.
        </Text>

        <View style={styles.umbralFila}>
          <View style={styles.umbralCampo}>
            <Text style={styles.etiqueta}>Diferencia aceptable (%)</Text>
            <TextInput
              value={umbralTexto}
              onChangeText={setUmbralTexto}
              placeholder="Sin definir"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              style={[styles.input, inputCursorStyle]}
              accessibilityLabel="Porcentaje de diferencia aceptable"
              {...inputCursorProps}
            />
          </View>
          <Pressable style={styles.boton} onPress={() => void guardarUmbral()} accessibilityRole="button">
            <Text style={styles.botonTexto}>Guardar umbral</Text>
          </Pressable>
        </View>
        <Text style={styles.ayuda}>
          {umbralGuardado == null
            ? 'Todavía no hay umbral. Las líneas se ven sin color hasta que guardes uno.'
            : `Umbral guardado: ${formato(umbralGuardado)} %. Dentro de ese porcentaje, en verde.`}
        </Text>

        <View style={styles.selector}>
          <SelectorDesplegable
            label="Almacén"
            placeholder="Elige un almacén"
            icono="warehouse"
            opciones={almacenes}
            valorId={warehouseId}
            onSeleccionar={setWarehouseId}
            tituloLista="Almacén"
            loading={cargando}
            buscador
            buscadorPlaceholder="Buscar almacén"
          />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={[styles.cuerpo, shouldStackPanels && styles.cuerpoCol]}>
          {mostrarLista ? (
            <View style={styles.panel}>
              {cargandoLista ? <ActivityIndicator color={colors.accent} /> : null}
              {!warehouseId ? (
                <Text style={styles.vacio}>Elige un almacén para ver sus conteos.</Text>
              ) : lista.length === 0 && !cargandoLista ? (
                <Text style={styles.vacio}>No hay conteos listos para revisar.</Text>
              ) : (
                lista.map((item) => {
                  const activo = inventario?.inventarioId === item.inventarioId;
                  return (
                    <Pressable
                      key={item.inventarioId}
                      style={[styles.fila, activo && styles.filaActiva]}
                      onPress={() => void abrir(item.inventarioId)}
                      accessibilityRole="button"
                      accessibilityLabel={`Revisar inventario ${item.fecha}`}
                    >
                      <Text style={styles.filaNombre}>{item.fecha} · {item.estado}</Text>
                      <Text style={styles.filaMeta}>
                        {item.employeeNombre || 'Sin persona'} · {item.plantillaNombre || ''}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </View>
          ) : null}

          {inventario ? (
            <View style={styles.detalle}>
              <View style={styles.cabecera}>
                {shouldStackPanels ? (
                  <Pressable
                    style={styles.iconoBtn}
                    onPress={() => setInventario(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Volver a la lista"
                  >
                    <MaterialIcons name="arrow-back" size={22} color={colors.textStrong} />
                  </Pressable>
                ) : null}
                <View style={styles.cabeceraTexto}>
                  <Text style={styles.detalleTitulo}>
                    {inventario.fecha} · {inventario.estado}
                  </Text>
                  <Text style={styles.filaMeta}>
                    {inventario.employeeNombre || 'Sin persona'} · {inventario.plantillaNombre || ''}
                    {` · ${fueraN} fuera · ${sinContarN} sin contar`}
                  </Text>
                </View>
              </View>

              <TextInput
                value={busqueda}
                onChangeText={setBusqueda}
                placeholder="Buscar producto"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, inputCursorStyle]}
                {...inputCursorProps}
              />
              <View style={styles.chips}>
                {([
                  ['todas', 'Todas'],
                  ['fuera', 'Fuera'],
                  ['sin-contar', 'Sin contar'],
                ] as const).map(([id, label]) => (
                  <Pressable
                    key={id}
                    style={[styles.chip, filtroLinea === id && styles.chipActivo]}
                    onPress={() => setFiltroLinea(id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: filtroLinea === id }}
                  >
                    <Text style={[styles.chipTexto, filtroLinea === id && styles.chipTextoActivo]}>{label}</Text>
                  </Pressable>
                ))}
              </View>

              {lineasVisibles.map((linea) => {
                const clase = clasificarLinea(linea, porcentajeVista);
                const tono = clase.semaforo === 'ok'
                  ? statusColors.success
                  : clase.semaforo === 'fuera'
                    ? statusColors.danger
                    : clase.semaforo === 'sin-contar'
                      ? statusColors.warning
                      : statusColors.neutral;
                const diff = clase.diferencia;
                const diffTexto = diff == null
                  ? '—'
                  : `${diff > 0 ? '+' : ''}${formato(diff)}${clase.porcentaje == null ? '' : ` (${formato(clase.porcentaje)} %)`}`;
                return (
                  <View key={linea.productId} style={styles.tarjeta}>
                    <View style={styles.tarjetaCab}>
                      <View style={styles.cabeceraTexto}>
                        <Text style={styles.producto}>{linea.nombre}</Text>
                        <Text style={styles.filaMeta}>
                          {linea.familiaNombre}{linea.unidad ? ` · ${linea.unidad}` : ''}
                        </Text>
                      </View>
                      <View style={[styles.pill, { backgroundColor: tono.bg }]}>
                        <Text style={[styles.pillTexto, { color: tono.text }]}>{textoSemaforo(clase.semaforo)}</Text>
                      </View>
                      {guardandoId === linea.productId ? <ActivityIndicator color={colors.accent} /> : null}
                    </View>
                    <Text style={styles.numeros}>
                      Teórico {formato(linea.stockTeorico)} · Diferencia {diffTexto}
                    </Text>
                    <View style={styles.conteoFila}>
                      <TextInput
                        value={textos[linea.productId] ?? ''}
                        onChangeText={(raw) => editable && programar(linea.productId, raw, linea.botellasAbiertas)}
                        editable={editable}
                        keyboardType="decimal-pad"
                        placeholder="Enteras"
                        placeholderTextColor={colors.textMuted}
                        style={[styles.input, styles.inputEnteras, inputCursorStyle]}
                        accessibilityLabel={`Botellas enteras de ${linea.nombre}`}
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
                      <TotalContado
                        texto={textos[linea.productId] ?? ''}
                        botellas={linea.botellasAbiertas}
                        nombre={linea.nombre}
                      />
                    </View>
                    {editable ? (
                      <Pressable
                        style={styles.secundario}
                        onPress={() => void recontar(linea)}
                        accessibilityRole="button"
                        accessibilityLabel={`Recontar ${linea.nombre}`}
                      >
                        <Text style={styles.secundarioTexto}>Recontar</Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}

              {inventario.estado === 'contado' ? (
                <Pressable style={styles.boton} onPress={() => void marcarRevisado()} accessibilityRole="button">
                  <Text style={styles.botonTexto}>Marcar como revisado</Text>
                </Pressable>
              ) : null}
              {inventario.estado === 'revisado' || inventario.estado === 'exportado' ? (
                <Pressable
                  style={[styles.boton, descargando && styles.botonOff]}
                  disabled={descargando}
                  onPress={() => void descargarExcel()}
                  accessibilityRole="button"
                  accessibilityLabel="Descargar Excel"
                >
                  {descargando
                    ? <ActivityIndicator color={colors.surface} />
                    : <Text style={styles.botonTexto}>Descargar Excel</Text>}
                </Pressable>
              ) : null}
              {inventario.estado === 'exportado' ? (
                <View style={styles.acciones}>
                  <Pressable style={styles.boton} onPress={() => void marcarImportado()} accessibilityRole="button">
                    <Text style={styles.botonTexto}>Marcar como importado</Text>
                  </Pressable>
                  <Pressable style={styles.secundario} onPress={() => void volverARevisado()} accessibilityRole="button">
                    <Text style={styles.secundarioTexto}>Volver a revisado</Text>
                  </Pressable>
                </View>
              ) : null}
              <Text style={styles.aviso}>
                {inventario.estado === 'revisado'
                  ? 'Puedes corregir una línea antes de descargar. El Excel lleva el stock real contado, sin redondear. Ubicación y código de barras van vacíos.'
                  : inventario.estado === 'exportado'
                    ? `Exportado${fechaHoraEs(inventario.ultimaExportacionEn) ? ` el ${fechaHoraEs(inventario.ultimaExportacionEn)}` : ''}${inventario.ultimaExportacionPor ? ` por ${inventario.ultimaExportacionPor}` : ''}. Cuando lo importes en Ágora, márcalo aquí.`
                    : inventario.estado === 'importado'
                      ? `Importado${fechaHoraEs(inventario.estadoEn) ? ` el ${fechaHoraEs(inventario.estadoEn)}` : ''}${inventario.estadoPor ? ` por ${inventario.estadoPor}` : ''}. Ya no se puede corregir.`
                      : editable
                        ? ''
                        : `Estado ${inventario.estado}. Este inventario ya no se corrige aquí.`}
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  pagina: { flex: 1, backgroundColor: colors.bg },
  contenido: { padding: SPACING.lg, paddingBottom: SPACING.xl, gap: SPACING.sm },
  titulo: { fontFamily: fontFamily.bold, fontSize: fontSizes[20], color: colors.textStrong },
  subtitulo: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textSecondary },
  detalleTitulo: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textStrong },
  etiqueta: { fontFamily: fontFamily.semibold, fontSize: fontSizes[13], color: colors.textSecondary, marginBottom: 4 },
  ayuda: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textSecondary },
  umbralFila: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: SPACING.sm },
  umbralCampo: { flexGrow: 1, minWidth: 180, maxWidth: 280 },
  selector: { maxWidth: 420, marginTop: SPACING.sm },
  cuerpo: { flexDirection: 'row', gap: SPACING.md, alignItems: 'flex-start' },
  cuerpoCol: { flexDirection: 'column' },
  panel: { width: 320, maxWidth: '100%', gap: SPACING.sm },
  detalle: { flex: 1, minWidth: 280, gap: SPACING.sm },
  fila: {
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  filaActiva: { borderColor: colors.accent },
  filaNombre: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.textStrong },
  filaMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textSecondary },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  cabeceraTexto: { flex: 1 },
  iconoBtn: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: SPACING.md,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[16],
    color: colors.textStrong,
    backgroundColor: colors.surface,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  chip: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  chipActivo: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.textPrimary },
  chipTextoActivo: { color: colors.surface },
  tarjeta: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  tarjetaCab: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  producto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.textStrong },
  numeros: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary },
  pill: { borderRadius: radius.pill, paddingHorizontal: SPACING.sm, paddingVertical: 4 },
  pillTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[12] },
  conteoFila: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm },
  inputEnteras: { width: 88 },
  totalCaja: {
    minHeight: MIN_TOUCH,
    minWidth: 72,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  totalEtiqueta: { fontFamily: fontFamily.medium, fontSize: fontSizes[12], color: colors.textSecondary },
  totalValor: { fontFamily: fontFamily.bold, fontSize: fontSizes[16], color: colors.textStrong },
  botellas: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, flexGrow: 1 },
  botella: {
    minWidth: 64,
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
  botellaTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.textPrimary },
  botellaTextoActiva: { color: colors.surface },
  boton: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
  },
  botonOff: { opacity: 0.5 },
  acciones: { gap: SPACING.sm },
  botonTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.surface },
  secundario: {
    minHeight: MIN_TOUCH,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  secundarioTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.accent },
  vacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textSecondary },
  aviso: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.warning },
  error: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.danger },
});
