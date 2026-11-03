/**
 * Tramos del multiplicador por importe de previsión, y simulador.
 * El importe de prueba usa las filas de la pantalla. La previsión del rango
 * llama al cálculo de la fase 3 y no escribe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { apiFetch } from '../../../utils/api';
import { formatFecha } from '../../../utils/formatFecha';
import { BotonPrincipal } from '../../../components/ui/BotonPrincipal';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { RangoFechas } from '../../../components/RangoFechas';
import { TramosEditor, type FilaTramo } from '../../../components/mia/TramosEditor';
import { MIN_TOUCH, SPACING } from '../../../constants/layout';

type Almacen = { id: string; nombre: string };
type TramoApi = { desde: number; hasta: number | null; multiplicador: number };
type LineaDesglose = {
  fecha: string;
  localId: string;
  localNombre: string;
  fechaComparativa: string;
  importe: number;
};
type Prevision = {
  previsionImporte: number;
  aviso: string | null;
  desglose: LineaDesglose[];
  tramoDesde: number | null;
  tramoHasta: number | null;
  multiplicador: number | null;
  rangoDesde: string;
  rangoHasta: string;
};

const TEXTO = '#0f172a';
const SECUNDARIO = '#64748b';
const GLOBAL = 'GLOBAL';

function firma(filas: FilaTramo[]) {
  return JSON.stringify(filas.map((f) => [f.desde.trim(), f.hasta.trim(), f.multiplicador.trim()]));
}

function numero(texto: string) {
  const t = texto.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

function euros(n: number) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
}

function textoTope(hasta: number | null) {
  return hasta == null ? 'en adelante' : `hasta ${euros(hasta)}`;
}

export default function TramosScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { hasPermiso } = useAuth();
  const { isPhone } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();
  const puedeVer = hasPermiso('mia.ver');
  const puedeEditar = hasPermiso('mia.configurar');
  const puedeCalcular = hasPermiso('mia.calcular');

  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [ambito, setAmbito] = useState(GLOBAL);
  const [filas, setFilas] = useState<FilaTramo[]>([]);
  const [base, setBase] = useState('[]');
  const [heredados, setHeredados] = useState(false);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [importePrueba, setImportePrueba] = useState('');
  const [almacenSim, setAlmacenSim] = useState('');
  const [semanasDesde, setSemanasDesde] = useState('');
  const [semanasHasta, setSemanasHasta] = useState('');
  const [prevision, setPrevision] = useState<Prevision | null>(null);
  const [simulando, setSimulando] = useState(false);
  const [errorSim, setErrorSim] = useState('');
  const salirLibre = useRef(false);
  const sucioRef = useRef(false);
  const peticion = useRef(0);
  const seq = useRef(1);

  const sucio = firma(filas) !== base;
  sucioRef.current = sucio;

  const nuevaClave = () => {
    seq.current += 1;
    return `t${seq.current}`;
  };

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
        setAlmacenSim((prev) => prev || (lista[0]?.id ?? ''));
      })
      .catch(() => {
        if (vivo) setError('No se pudieron cargar los almacenes');
      });
    return () => {
      vivo = false;
    };
  }, [puedeVer]);

  const cargar = useCallback(async (ambitoId: string) => {
    const id = ++peticion.current;
    setCargando(true);
    setError('');
    setErrores({});
    try {
      const qs = ambitoId === GLOBAL ? '' : `?warehouseId=${encodeURIComponent(ambitoId)}`;
      const r = await apiFetch(`/api/mia/tramos${qs}`);
      const data = await r.json();
      if (id !== peticion.current) return;
      if (!r.ok) {
        setError(data.error || 'No se pudieron cargar los tramos');
        setFilas([]);
        setBase('[]');
        return;
      }
      const siguientes: FilaTramo[] = (data.tramos || []).map((t: TramoApi) => ({
        clave: nuevaClave(),
        desde: String(t.desde),
        hasta: t.hasta == null ? '' : String(t.hasta),
        multiplicador: String(t.multiplicador),
      }));
      setFilas(siguientes);
      setBase(firma(siguientes));
      setHeredados(data.heredados === true);
    } catch {
      if (id === peticion.current) setError('No se pudieron cargar los tramos');
    } finally {
      if (id === peticion.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (!puedeVer) return;
    void cargar(ambito);
  }, [puedeVer, ambito, cargar]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !sucio) return undefined;
    const fn = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      ev.returnValue = '';
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [sucio]);

  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e: { preventDefault: () => void; data: { action: unknown } }) => {
      if (salirLibre.current || !sucioRef.current) return;
      e.preventDefault();
      void (async () => {
        const ok = await confirmar(
          'Cambios sin guardar',
          'Hay tramos sin guardar. ¿Salir sin guardarlos?',
          { confirmarLabel: 'Salir sin guardar', variant: 'danger' },
        );
        if (!ok) return;
        salirLibre.current = true;
        navigation.dispatch(e.data.action as never);
      })();
    });
    return sub;
  }, [navigation, confirmar]);

  const pedirCambioAmbito = useCallback(async (id: string) => {
    if (id === ambito) return;
    if (sucioRef.current) {
      const ok = await confirmar(
        'Cambios sin guardar',
        'Si cambias de ámbito se pierden los tramos sin guardar.',
        { confirmarLabel: 'Cambiar', variant: 'danger' },
      );
      if (!ok) return;
    }
    setAviso('');
    setAmbito(id);
  }, [ambito, confirmar]);

  const onCambio = useCallback((clave: string, campo: 'desde' | 'hasta' | 'multiplicador', valor: string) => {
    setAviso('');
    setErrores((prev) => {
      if (!prev[clave]) return prev;
      const copia = { ...prev };
      delete copia[clave];
      return copia;
    });
    setFilas((prev) => prev.map((f) => (f.clave === clave ? { ...f, [campo]: valor } : f)));
  }, []);

  const onQuitarFila = useCallback((clave: string) => {
    setAviso('');
    setFilas((prev) => prev.filter((f) => f.clave !== clave));
  }, []);

  const onAnadir = useCallback(() => {
    setAviso('');
    setFilas((prev) => {
      const ultimo = prev[prev.length - 1];
      return [...prev, { clave: nuevaClave(), desde: ultimo?.hasta || '', hasta: '', multiplicador: '' }];
    });
  }, []);

  const guardar = useCallback(async () => {
    setGuardando(true);
    setError('');
    setAviso('');
    setErrores({});
    try {
      const r = await apiFetch('/api/mia/tramos', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(ambito !== GLOBAL ? { warehouseId: ambito } : {}),
          tramos: filas.map((f) => ({
            desde: f.desde.trim().replace(',', '.'),
            hasta: f.hasta.trim() === '' ? null : f.hasta.trim().replace(',', '.'),
            multiplicador: f.multiplicador.trim().replace(',', '.'),
          })),
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (Number.isInteger(data.indice) && filas[data.indice]) {
          setErrores({ [filas[data.indice].clave]: data.error || 'Revisa este tramo' });
        } else {
          setError(data.error || 'No se pudieron guardar los tramos');
        }
        return;
      }
      const siguientes: FilaTramo[] = (data.tramos || []).map((t: TramoApi) => ({
        clave: nuevaClave(),
        desde: String(t.desde),
        hasta: t.hasta == null ? '' : String(t.hasta),
        multiplicador: String(t.multiplicador),
      }));
      setFilas(siguientes);
      setBase(firma(siguientes));
      setHeredados(false);
      setAviso('Tramos guardados');
    } catch {
      setError('No se pudieron guardar los tramos');
    } finally {
      setGuardando(false);
    }
  }, [ambito, filas]);

  const quitarPropios = useCallback(async () => {
    const ok = await confirmar(
      'Quitar tramos propios',
      'Este almacén volverá a usar los tramos globales. Los tramos propios se borran.',
      { confirmarLabel: 'Quitar tramos propios', variant: 'danger' },
    );
    if (!ok) return;
    setGuardando(true);
    setError('');
    setAviso('');
    try {
      const r = await apiFetch(`/api/mia/tramos?warehouseId=${encodeURIComponent(ambito)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || 'No se pudieron quitar los tramos');
        return;
      }
      salirLibre.current = true;
      await cargar(ambito);
      salirLibre.current = false;
      setAviso('Este almacén vuelve a usar los tramos globales');
    } catch {
      setError('No se pudieron quitar los tramos');
    } finally {
      setGuardando(false);
    }
  }, [ambito, cargar, confirmar]);

  const simular = useCallback(async () => {
    if (!almacenSim || !semanasDesde || !semanasHasta) return;
    setSimulando(true);
    setErrorSim('');
    setPrevision(null);
    try {
      const r = await apiFetch('/api/mia/tramos/simular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          warehouseId: almacenSim,
          semanasDesde,
          semanasHasta,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setErrorSim(data.error || 'No se pudo simular la previsión');
        return;
      }
      setPrevision(data);
    } catch {
      setErrorSim('No se pudo simular la previsión');
    } finally {
      setSimulando(false);
    }
  }, [almacenSim, semanasDesde, semanasHasta]);

  const prueba = useMemo(() => {
    const texto = importePrueba.trim();
    if (!texto) return null;
    const n = numero(texto);
    if (n == null) return { texto: 'El importe de prueba tiene que ser un número ≥ 0' };
    const lista = filas
      .map((f) => {
        const hastaTexto = f.hasta.trim();
        return {
          desde: numero(f.desde),
          hasta: hastaTexto === '' ? null : numero(hastaTexto),
          hastaInvalido: hastaTexto !== '' && numero(hastaTexto) == null,
          multiplicador: numero(f.multiplicador),
        };
      })
      .filter((f) => f.desde != null && f.multiplicador != null && !f.hastaInvalido && (f.hasta == null || f.hasta > f.desde))
      .sort((a, b) => (a.desde as number) - (b.desde as number));
    const tramo = lista.find((f) => n >= (f.desde as number) && (f.hasta == null || n < (f.hasta as number)));
    if (!tramo) return { texto: 'Ningún tramo de esta pantalla cubre ese importe' };
    return { texto: `Tramo de ${euros(tramo.desde as number)} ${textoTope(tramo.hasta)} · multiplicador ${tramo.multiplicador}` };
  }, [importePrueba, filas]);

  const porLocal = useMemo(() => {
    const mapa = new Map<string, { nombre: string; total: number; lineas: LineaDesglose[] }>();
    for (const linea of prevision?.desglose || []) {
      const actual = mapa.get(linea.localId) || { nombre: linea.localNombre || linea.localId, total: 0, lineas: [] };
      actual.total += Number(linea.importe) || 0;
      actual.lineas.push(linea);
      mapa.set(linea.localId, actual);
    }
    return [...mapa.values()];
  }, [prevision]);

  if (!puedeVer) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="lock-outline" size={32} color={SECUNDARIO} />
        <Text style={styles.avisoCentro}>No tienes permiso para ver los tramos.</Text>
      </View>
    );
  }

  const opcionesAmbito = [
    { id: GLOBAL, titulo: 'Todos los almacenes (global)' },
    ...almacenes.map((a) => ({ id: a.id, titulo: a.nombre })),
  ];

  return (
    <View style={styles.pantalla}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.cabecera}>
          <Text style={styles.migas}>
            <Text style={styles.migaLink} onPress={() => router.push('/compras')}>Compras</Text>
            {' › Pedidos a proveedores › MIA — Aprovisionamiento › '}
            <Text style={styles.migaActual}>Tramos</Text>
          </Text>
          <Text style={styles.nota}>El importe «hasta» no entra en el tramo; el siguiente empieza en ese importe.</Text>
          <View style={styles.filtro}>
            <SelectorDesplegable
              placeholder="Ámbito"
              icono="warehouse"
              compact
              opciones={opcionesAmbito}
              valorId={ambito}
              onSeleccionar={(id) => { void pedirCambioAmbito(id); }}
            />
          </View>
          {heredados && ambito !== GLOBAL ? (
            <Text style={styles.nota}>Este almacén usa los tramos globales. Si los cambias y guardas, pasarán a ser propios.</Text>
          ) : null}
          <View style={styles.guardarFila}>
            <Text style={styles.contador}>{sucio ? 'Cambios sin guardar' : 'Sin cambios pendientes'}</Text>
            {puedeEditar ? (
              <View style={[styles.acciones, isPhone && styles.accionesPila]}>
                {ambito !== GLOBAL && !heredados ? (
                  <Pressable
                    style={styles.quitarPropios}
                    disabled={guardando}
                    onPress={() => { void quitarPropios(); }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.quitarTexto}>Quitar tramos propios</Text>
                  </Pressable>
                ) : null}
                <BotonPrincipal
                  titulo="Guardar"
                  onPress={() => { void guardar(); }}
                  disabled={!sucio || guardando}
                  estado={guardando ? 'enviando' : 'idle'}
                />
              </View>
            ) : (
              <Text style={styles.soloLectura}>Solo lectura</Text>
            )}
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {aviso ? <Text style={styles.ok}>{aviso}</Text> : null}
        </View>

        {cargando ? (
          <ActivityIndicator color="#ec4899" style={{ marginTop: SPACING.xl }} />
        ) : (
          <TramosEditor
            filas={filas}
            errores={errores}
            puedeEditar={puedeEditar}
            enTarjetas={isPhone}
            onCambio={onCambio}
            onQuitarFila={onQuitarFila}
            onAnadir={onAnadir}
          />
        )}

        <View style={styles.simulador}>
          <Text style={styles.simuladorTitulo}>Simulador</Text>
          <Text style={styles.etiqueta}>Importe de prueba</Text>
          <TextInput
            value={importePrueba}
            onChangeText={setImportePrueba}
            placeholder="0"
            placeholderTextColor="#94a3b8"
            keyboardType="decimal-pad"
            style={styles.input}
          />
          {prueba ? <Text style={styles.resultado}>{prueba.texto}</Text> : null}

          <Text style={styles.simuladorTitulo}>Previsión del rango</Text>
          {puedeCalcular ? (
            <>
              <View style={styles.filtro}>
                <SelectorDesplegable
                  placeholder="Almacén"
                  icono="warehouse"
                  compact
                  opciones={almacenes.map((a) => ({ id: a.id, titulo: a.nombre }))}
                  valorId={almacenSim}
                  onSeleccionar={setAlmacenSim}
                />
              </View>
              <RangoFechas
                desdeIso={semanasDesde}
                hastaIso={semanasHasta}
                onChangeDesde={setSemanasDesde}
                onChangeHasta={setSemanasHasta}
                placeholderDesde="Semana desde"
                placeholderHasta="Semana hasta"
                fill
              />
              <BotonPrincipal
                titulo="Ver previsión"
                onPress={() => { void simular(); }}
                disabled={!almacenSim || !semanasDesde || !semanasHasta || simulando}
                estado={simulando ? 'enviando' : 'idle'}
              />
              {errorSim ? <Text style={styles.error}>{errorSim}</Text> : null}
              {prevision ? (
                <View style={styles.prevision}>
                  <Text style={styles.resultado}>
                    {euros(prevision.previsionImporte)}
                    {' · '}
                    {formatFecha(prevision.rangoDesde)} – {formatFecha(prevision.rangoHasta)}
                  </Text>
                  <Text style={styles.resultado}>
                    {prevision.multiplicador == null
                      ? 'Ningún tramo guardado cubre esta previsión'
                      : `Tramo guardado de ${euros(prevision.tramoDesde || 0)} ${textoTope(prevision.tramoHasta)} · multiplicador ${prevision.multiplicador}`}
                  </Text>
                  {prevision.aviso ? <Text style={styles.nota}>{prevision.aviso}</Text> : null}
                  {porLocal.map((local) => (
                    <View key={local.nombre} style={styles.local}>
                      <Text style={styles.localNombre}>{local.nombre} · {euros(local.total)}</Text>
                      {local.lineas.map((linea) => (
                        <Text key={`${linea.localId}-${linea.fecha}`} style={styles.dia}>
                          {formatFecha(linea.fecha)}
                          {' · comparable '}
                          {formatFecha(linea.fechaComparativa)}
                          {' · '}
                          {euros(linea.importe)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          ) : (
            <Text style={styles.nota}>Hace falta el permiso de calcular para ver la previsión del rango.</Text>
          )}
        </View>
      </ScrollView>
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  pantalla: { flex: 1, backgroundColor: '#f8fafc' },
  scroll: { paddingBottom: SPACING.xl },
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
  nota: { color: SECUNDARIO, fontSize: 13 },
  filtro: { minWidth: 220, maxWidth: 420 },
  guardarFila: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.md, flexWrap: 'wrap' },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  accionesPila: { flexDirection: 'column', alignItems: 'stretch' },
  contador: { color: SECUNDARIO, fontSize: 13, flex: 1 },
  soloLectura: { color: SECUNDARIO, fontSize: 13 },
  quitarPropios: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fecaca',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  quitarTexto: { color: '#b91c1c', fontWeight: '700' },
  error: { color: '#b91c1c', fontSize: 13 },
  ok: { color: '#047857', fontSize: 13 },
  simulador: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.md,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  simuladorTitulo: { color: TEXTO, fontWeight: '700', fontSize: 16, marginTop: SPACING.xs },
  etiqueta: { color: SECUNDARIO, fontSize: 12 },
  input: {
    minHeight: MIN_TOUCH,
    maxWidth: 220,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    color: TEXTO,
  },
  resultado: { color: TEXTO, fontSize: 14, fontWeight: '600' },
  prevision: { gap: SPACING.sm },
  local: { gap: 2 },
  localNombre: { color: TEXTO, fontWeight: '700' },
  dia: { color: SECUNDARIO, fontSize: 13 },
});
