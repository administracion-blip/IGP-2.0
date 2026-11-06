/**
 * Stock máximo del almacén. Los cambios se quedan en la fila hasta pulsar Guardar.
 * Salir con cambios pendientes pide confirmación.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { apiFetch } from '../../../utils/api';
import { BotonPrincipal } from '../../../components/ui/BotonPrincipal';
import { CampoSelector } from '../../../components/mia/CampoSelector';
import { SelectorDesplegableMulti } from '../../../components/SelectorDesplegableMulti';
import {
  altoControl,
  colores,
  estiloEtiqueta,
  familia,
  modoPrevision,
  peso,
} from '../../../components/prevision/tokens';
import {
  StockMaximoEditor,
  type BorradorStock,
  type FilaStockMaximo,
  type UnidadAgora,
} from '../../../components/mia/StockMaximoEditor';
import { MIN_TOUCH, SPACING } from '../../../constants/layout';

type Almacen = { id: string; nombre: string };
type Familia = { id: string; nombre: string };
type ItemApi = {
  productId: string;
  nombre: string;
  familiaId: string;
  familiaNombre: string;
  stock: number | null;
  maximo: number | null;
  formatoCompra: number | null;
  purchaseUnitId: string;
  purchaseUnitName?: string;
  unidades: UnidadAgora[];
  unidadUltima?: string;
  unidadPorDefecto?: boolean;
};

const LIMITE = 80;
const TEXTO = '#0f172a';
const SECUNDARIO = '#64748b';

function textoNumero(n: number | null) {
  return n == null ? '' : String(n);
}

function canon(texto: string) {
  return texto.trim().replace(',', '.');
}

function errorMaximo(texto: string) {
  const t = canon(texto);
  if (!t) return '';
  if (t.startsWith('-')) return 'El máximo no puede ser negativo';
  if (!/^\d+(\.\d+)?$/.test(t)) return 'El máximo tiene que ser un número ≥ 0';
  return '';
}

function errorFormato(texto: string) {
  const t = canon(texto);
  if (!t) return '';
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) {
    return 'El formato de compra tiene que ser un número mayor que 0';
  }
  return '';
}

function baseDe(it: ItemApi): BorradorStock {
  return {
    maximo: textoNumero(it.maximo),
    formato: textoNumero(it.formatoCompra),
    unidadId: it.purchaseUnitId || '',
  };
}

function parametro(valor: string | string[] | undefined) {
  return Array.isArray(valor) ? valor[0] || '' : valor || '';
}

function elegirAlmacen(lista: { id: string }[], pedido: string) {
  if (pedido && lista.some((a) => a.id === pedido)) return pedido;
  return lista[0]?.id ?? '';
}

export default function StockMaximoScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ warehouseId?: string; sinMaximo?: string }>();
  const almacenPedido = parametro(params.warehouseId);
  const { hasPermiso } = useAuth();
  const { isPhone, width } = useBreakpoint();
  const alto = altoControl(modoPrevision(width));
  const { confirmar, ConfirmarView } = useConfirmar();
  const puedeVer = hasPermiso('mia.ver');
  const puedeEditar = hasPermiso('mia.configurar');

  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [familias, setFamilias] = useState<Familia[]>([]);
  const [familiasSel, setFamiliasSel] = useState<string[]>([]);
  const [sinMaximo, setSinMaximo] = useState(parametro(params.sinMaximo) === '1');
  const [busqueda, setBusqueda] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ItemApi[]>([]);
  const [total, setTotal] = useState(0);
  const [borradores, setBorradores] = useState<Record<string, BorradorStock>>({});
  const [cargando, setCargando] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const salirLibre = useRef(false);
  const suciosRef = useRef(0);
  const peticion = useRef(0);

  const sucios = Object.keys(borradores).length;
  suciosRef.current = sucios;

  useEffect(() => {
    const t = setTimeout(() => setQ(busqueda.trim()), 300);
    return () => clearTimeout(t);
  }, [busqueda]);

  useEffect(() => {
    if (!puedeVer) return;
    let vivo = true;
    apiFetch('/api/mia/locales-almacenes')
      .then((r) => r.json())
      .then((data) => {
        if (!vivo) return;
        const lista: Almacen[] = (data.almacenes || []).map((a: Almacen) => ({
          id: String(a.id),
          nombre: String(a.nombre || a.id),
        }));
        lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        setAlmacenes(lista);
        setWarehouseId((prev) => prev || elegirAlmacen(lista, almacenPedido));
      })
      .catch(() => {
        if (vivo) setError('No se pudieron cargar los almacenes');
      });
    return () => {
      vivo = false;
    };
  }, [puedeVer, almacenPedido]);

  const cargar = useCallback(async (offset: number, reemplazar: boolean) => {
    if (!warehouseId) return;
    const id = reemplazar ? ++peticion.current : peticion.current;
    if (reemplazar) setCargando(true);
    else setCargandoMas(true);
    setError('');
    try {
      const params = new URLSearchParams({
        warehouseId,
        limit: String(LIMITE),
        offset: String(offset),
      });
      if (familiasSel.length > 0) params.set('familias', familiasSel.join(','));
      if (sinMaximo) params.set('sinMaximo', '1');
      if (q) params.set('q', q);
      const r = await apiFetch(`/api/mia/stock-maximo?${params.toString()}`);
      const data = await r.json();
      if (id !== peticion.current) return;
      if (!r.ok) {
        setError(data.error || 'No se pudo cargar el stock máximo');
        if (reemplazar) setItems([]);
        return;
      }
      const pagina: ItemApi[] = data.items || [];
      setFamilias(data.familias || []);
      setTotal(Number(data.total) || 0);
      setItems((prev) => (reemplazar ? pagina : [...prev, ...pagina]));
    } catch {
      if (id === peticion.current) setError('No se pudo cargar el stock máximo');
    } finally {
      if (id === peticion.current) {
        setCargando(false);
        setCargandoMas(false);
      }
    }
  }, [warehouseId, familiasSel, sinMaximo, q]);

  useEffect(() => {
    setItems([]);
    setTotal(0);
    void cargar(0, true);
  }, [cargar]);

  useEffect(() => {
    if (Platform.OS !== 'web' || sucios === 0) return undefined;
    const fn = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      ev.returnValue = '';
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [sucios]);

  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e: { preventDefault: () => void; data: { action: unknown } }) => {
      if (salirLibre.current || suciosRef.current === 0) return;
      e.preventDefault();
      void (async () => {
        const ok = await confirmar(
          'Cambios sin guardar',
          'Hay cambios de stock máximo sin guardar. ¿Salir sin guardarlos?',
          { confirmarLabel: 'Salir sin guardar', variant: 'danger' },
        );
        if (!ok) return;
        salirLibre.current = true;
        navigation.dispatch(e.data.action as never);
      })();
    });
    return sub;
  }, [navigation, confirmar]);

  const pedirCambioAlmacen = useCallback(async (id: string) => {
    if (id === warehouseId) return;
    if (suciosRef.current > 0) {
      const ok = await confirmar(
        'Cambios sin guardar',
        'Si cambias de almacén se pierden los cambios sin guardar.',
        { confirmarLabel: 'Cambiar almacén', variant: 'danger' },
      );
      if (!ok) return;
    }
    setBorradores({});
    setAviso('');
    setFamiliasSel([]);
    setWarehouseId(id);
  }, [warehouseId, confirmar]);

  const onCambio = useCallback((productId: string, campo: keyof BorradorStock, valor: string) => {
    setAviso('');
    setBorradores((prev) => {
      const item = items.find((it) => it.productId === productId);
      if (!item) return prev;
      const actual = prev[productId] ?? baseDe(item);
      const siguiente = { ...actual, [campo]: valor };
      const original = baseDe(item);
      const igual = canon(siguiente.maximo) === canon(original.maximo)
        && canon(siguiente.formato) === canon(original.formato)
        && siguiente.unidadId === original.unidadId;
      const copia = { ...prev };
      if (igual) delete copia[productId];
      else copia[productId] = siguiente;
      return copia;
    });
  }, [items]);

  const errores = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, b] of Object.entries(borradores)) {
      const msg = errorMaximo(b.maximo) || errorFormato(b.formato);
      if (msg) out[id] = msg;
    }
    return out;
  }, [borradores]);

  const filas: FilaStockMaximo[] = items.map((it) => {
    const b = borradores[it.productId] ?? baseDe(it);
    return {
      productId: it.productId,
      nombre: it.nombre,
      familiaNombre: it.familiaNombre,
      stock: it.stock,
      unidades: it.unidades || [],
      unidadUltima: it.unidadUltima || '',
      unidadPorDefecto: !!it.unidadPorDefecto && b.unidadId === it.purchaseUnitId,
      maximo: b.maximo,
      formato: b.formato,
      unidadId: b.unidadId,
      sucia: !!borradores[it.productId],
    };
  });

  const guardar = useCallback(async () => {
    if (!sucios || Object.keys(errores).length > 0) return;
    setGuardando(true);
    setError('');
    setAviso('');
    try {
      const lineas = Object.entries(borradores).map(([productId, b]) => ({
        productId,
        maximo: b.maximo.trim(),
        formatoCompra: b.formato.trim(),
        purchaseUnitId: b.unidadId,
      }));
      const r = await apiFetch('/api/mia/stock-maximo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouseId, lineas }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || 'No se pudo guardar');
        return;
      }
      setItems((prev) => prev.map((it) => {
        const b = borradores[it.productId];
        if (!b) return it;
        const maximo = canon(b.maximo);
        const formato = canon(b.formato);
        const unidad = (it.unidades || []).find((u) => u.id === b.unidadId);
        return {
          ...it,
          maximo: maximo === '' ? null : Number(maximo),
          formatoCompra: formato === '' ? null : Number(formato),
          purchaseUnitId: b.unidadId,
          purchaseUnitName: unidad?.nombre || '',
          unidadPorDefecto: false,
        };
      }));
      setBorradores({});
      setAviso(`Guardados ${data.guardados ?? lineas.length} cambios`);
    } catch {
      setError('No se pudo guardar');
    } finally {
      setGuardando(false);
    }
  }, [sucios, errores, borradores, warehouseId]);

  if (!puedeVer) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="lock-outline" size={32} color={SECUNDARIO} />
        <Text style={styles.avisoCentro}>No tienes permiso para ver el stock máximo.</Text>
      </View>
    );
  }

  const hayError = Object.keys(errores).length > 0;

  return (
    <View style={styles.pantalla}>
      <View style={styles.cabecera}>
        <Text style={styles.migas}>
          <Text style={styles.migaLink} onPress={() => router.push('/compras')}>Compras</Text>
          {' › Pedidos a proveedores › '}
          <Text style={styles.migaLink} onPress={() => router.push('/compras/aprovisionamiento')}>MIA — Aprovisionamiento</Text>
          {' › '}
          <Text style={styles.migaActual}>Stock máximo</Text>
        </Text>
        <View style={[styles.filtros, isPhone && styles.filtrosPila]}>
          <View style={styles.filtro}>
            <CampoSelector
              etiqueta="Almacén"
              alto={alto}
              placeholder="Elige almacén…"
              buscador
              buscadorPlaceholder="Buscar almacén…"
              opciones={almacenes.map((a) => ({ id: a.id, titulo: a.nombre }))}
              valorId={warehouseId}
              onSeleccionar={(id) => { void pedirCambioAlmacen(id); }}
            />
          </View>
          <View style={styles.filtro}>
            <Text style={styles.etiquetaFamilia}>Familia</Text>
            <SelectorDesplegableMulti
              sinIconoTrigger
              buscador
              buscadorPlaceholder="Buscar familia…"
              placeholder="Todas las familias"
              etiquetaVarios="familias"
              tituloLista="Familias"
              opciones={familias.filter((f) => f.id !== '').map((f) => ({ id: f.id, titulo: f.nombre }))}
              valorIds={familiasSel}
              onChange={setFamiliasSel}
              style={styles.selectorFamilia}
              triggerStyle={[styles.triggerFamilia, { minHeight: alto, height: alto }]}
              triggerTextStyle={styles.triggerFamiliaTexto}
            />
          </View>
          <Pressable
            style={[styles.chip, sinMaximo && styles.chipOn]}
            onPress={() => setSinMaximo((v) => !v)}
            accessibilityRole="button"
          >
            <Text style={[styles.chipTexto, sinMaximo && styles.chipTextoOn]}>Sin máximo</Text>
          </Pressable>
          <TextInput
            value={busqueda}
            onChangeText={setBusqueda}
            placeholder="Buscar por id, nombre o familia"
            placeholderTextColor="#94a3b8"
            style={styles.buscar}
          />
        </View>
        <View style={styles.guardarFila}>
          <Text style={styles.contador}>
            {sucios === 0 ? 'Sin cambios pendientes' : `${sucios} cambio${sucios === 1 ? '' : 's'} sin guardar`}
            {total ? ` · ${items.length} de ${total}` : ''}
          </Text>
          {puedeEditar ? (
            <BotonPrincipal
              titulo={sucios > 0 ? `Guardar (${sucios})` : 'Guardar'}
              onPress={() => { void guardar(); }}
              disabled={sucios === 0 || hayError || guardando}
              estado={guardando ? 'enviando' : 'idle'}
              accessibilityLabel={sucios > 0 ? `Guardar ${sucios} cambios` : 'Guardar'}
            />
          ) : (
            <Text style={styles.soloLectura}>Solo lectura</Text>
          )}
        </View>
        {hayError ? <Text style={styles.error}>Revisa los máximos marcados antes de guardar.</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {aviso ? <Text style={styles.ok}>{aviso}</Text> : null}
      </View>
      {cargando ? (
        <ActivityIndicator color="#ec4899" style={{ marginTop: SPACING.xl }} />
      ) : (
        <StockMaximoEditor
          filas={filas}
          errores={errores}
          puedeEditar={puedeEditar}
          hayMas={items.length < total}
          cargandoMas={cargandoMas}
          onCambio={onCambio}
          onMas={() => { void cargar(items.length, false); }}
          enTarjetas={isPhone}
        />
      )}
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: '#f8fafc' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.lg },
  avisoCentro: { color: SECUNDARIO, fontSize: 15, textAlign: 'center' },
  cabecera: {
    backgroundColor: '#fff',
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: SPACING.sm,
  },
  migas: { color: SECUNDARIO, fontSize: 13 },
  migaLink: { color: '#ec4899', fontWeight: '600' },
  migaActual: { color: TEXTO, fontWeight: '700' },
  filtros: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, alignItems: 'flex-end' },
  filtrosPila: { flexDirection: 'column', alignItems: 'stretch' },
  filtro: { minWidth: 220, flexGrow: 1 },
  etiquetaFamilia: { ...estiloEtiqueta, marginBottom: 6 },
  selectorFamilia: { width: '100%' },
  triggerFamilia: {
    width: '100%',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  triggerFamiliaTexto: {
    fontSize: 13,
    fontFamily: familia.medio,
    fontWeight: peso.medio,
    color: colores.texto,
  },
  chip: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  chipOn: { backgroundColor: '#fdf2f8', borderColor: '#f9a8d4' },
  chipTexto: { color: SECUNDARIO, fontWeight: '700' },
  chipTextoOn: { color: '#be185d' },
  buscar: {
    minHeight: MIN_TOUCH,
    minWidth: 180,
    flexGrow: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    color: TEXTO,
  },
  guardarFila: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.md },
  contador: { color: SECUNDARIO, fontSize: 13, flex: 1 },
  soloLectura: { color: SECUNDARIO, fontSize: 13 },
  error: { color: '#b91c1c', fontSize: 13 },
  ok: { color: '#047857', fontSize: 13 },
});
