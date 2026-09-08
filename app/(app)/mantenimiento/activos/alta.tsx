import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { valorEnLocal, type LocalItem } from '../LocalesContext';
import { SelectorDesplegable, type OpcionDesplegable } from '../../../components/SelectorDesplegable';
import { InputFecha } from '../../../components/InputFecha';
import { EscanerCodigo } from '../../../components/activos/EscanerCodigo';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';
import { colors, inputCursorProps, radius, statusColors, typography } from '../../../constants/theme';
import { apiFetch, errorMessage } from '../../../utils/api';
import { formatId6 } from '../../../utils/idFormat';
import { urlQrEtiqueta } from '../../../lib/activosEtiqueta';
import { modeloPideTalla, opcionesTallaDeModelo } from '../../../lib/activos';
import type { ActivoFicha, CategoriaActivo, ModeloActivo } from '../../../types/activos';

type LineaTalla = { talla: string; cantidad: string };

const LOTE_MAX = 50;
const ROSA_BG = '#fce7f3';
const ROSA_FG = '#be185d';
const ROSA_BORDE = '#f9a8d4';
const LINEA_TALLA_VACIA: LineaTalla = { talla: '', cantidad: '1' };

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || fallback);
  return data;
}

export default function ActivosAltaScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ modelo?: string }>();
  const modeloParam = typeof params.modelo === 'string' ? params.modelo : '';
  const { hasPermiso, user, localPermitido } = useAuth();
  const { shouldStackPanels, shouldStackToolbar } = useBreakpoint();
  const alcanceGlobal = user?.Rol === 'Administrador' || !user?.Locales?.length;

  const [modelos, setModelos] = useState<ModeloActivo[]>([]);
  const [categorias, setCategorias] = useState<CategoriaActivo[]>([]);
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [cargandoCat, setCargandoCat] = useState(true);
  const [modeloId, setModeloId] = useState(modeloParam);
  const [idLocal, setIdLocal] = useState('');
  const [lineasTalla, setLineasTalla] = useState<LineaTalla[]>([LINEA_TALLA_VACIA]);
  const [cantidad, setCantidad] = useState('1');
  const [fechaCompra, setFechaCompra] = useState('');
  const [coste, setCoste] = useState('');
  const [notas, setNotas] = useState('');

  const [series, setSeries] = useState<string[]>(['']);
  const [indice, setIndice] = useState(0);
  const [escaner, setEscaner] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelo = modelos.find((m) => m.modelo_id === modeloId);
  const categoria = categorias.find((c) => c.categoria_id === modelo?.categoria_id);
  const serializable = modelo?.es_serializable === true;
  const pideTalla = modeloPideTalla(modelo);
  const opcionesTalla = useMemo(
    () => opcionesTallaDeModelo(modelo).map((id) => ({ id, titulo: id })),
    [modelo],
  );

  const opcionesLocal: OpcionDesplegable[] = useMemo(
    () =>
      locales
        .map((l) => {
          const id = formatId6(valorEnLocal(l, 'id_Locales'));
          const nombre = String(valorEnLocal(l, 'nombre') || valorEnLocal(l, 'Nombre') || '').trim();
          return { id, titulo: nombre || id };
        })
        .filter((o) => o.id && o.id !== '000000')
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es', { sensitivity: 'base' })),
    [locales],
  );

  const localSel = opcionesLocal.find((o) => o.id === idLocal)?.titulo || '';

  const opcionesModelo: OpcionDesplegable[] = useMemo(
    () =>
      modelos.map((m) => ({
        id: m.modelo_id,
        titulo: [m.marca, m.nombre].filter(Boolean).join(' '),
        subtitulo: m.es_serializable
          ? 'Con número de serie'
          : modeloPideTalla(m)
            ? 'Por cantidad · con talla'
            : 'Por cantidad (lote)',
      })),
    [modelos],
  );

  useEffect(() => {
    if (idLocal || opcionesLocal.length === 0) return;
    const distribuidora = opcionesLocal.find((o) => o.titulo.trim().toLowerCase() === 'distribuidora');
    if (distribuidora) {
      setIdLocal(distribuidora.id);
      return;
    }
    if (opcionesLocal.length === 1 || !alcanceGlobal) setIdLocal(opcionesLocal[0].id);
  }, [opcionesLocal, idLocal, alcanceGlobal]);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/activos/modelos?soloActivos=1&limite=200').then((r) =>
        jsonOrThrow<{ modelos?: ModeloActivo[] }>(r, 'No se pudieron cargar los modelos'),
      ),
      apiFetch('/api/activos/categorias?soloActivas=1&limite=200').then((r) =>
        jsonOrThrow<{ categorias?: CategoriaActivo[] }>(r, 'No se pudieron cargar las categorías'),
      ),
      apiFetch('/api/locales?grupoParipe=1').then((r) =>
        jsonOrThrow<{ locales?: LocalItem[] }>(r, 'No se pudieron cargar los locales'),
      ),
    ])
      .then(([dm, dc, dl]) => {
        setModelos((dm.modelos || []).filter((m) => m.activo !== false));
        setCategorias((dc.categorias || []).filter((c) => c.activo !== false));
        setLocales(
          (dl.locales || []).filter((l) =>
            localPermitido(String(valorEnLocal(l, 'nombre') || valorEnLocal(l, 'Nombre') || '').trim()),
          ),
        );
      })
      .catch(() => {
        setModelos([]);
        setCategorias([]);
        setLocales([]);
      })
      .finally(() => setCargandoCat(false));
  }, [localPermitido]);

  const nPedido = pideTalla
    ? lineasTalla.reduce((acc, l) => acc + (parseInt(l.cantidad, 10) || 0), 0)
    : parseInt(cantidad, 10) || 0;
  const maxCantidad = serializable ? LOTE_MAX : 9999;
  const nSeries = serializable ? Math.max(1, nPedido) : 0;
  const resumenTallas = lineasTalla
    .filter((l) => l.talla && (parseInt(l.cantidad, 10) || 0) > 0)
    .map((l) => `${l.talla} ×${parseInt(l.cantidad, 10) || 0}`)
    .join(' · ');
  const tallasUsadas = new Set(lineasTalla.map((l) => l.talla).filter(Boolean));
  const quedanTallas = opcionesTalla.some((o) => !tallasUsadas.has(o.id));

  useEffect(() => {
    setLineasTalla([LINEA_TALLA_VACIA]);
  }, [modeloId]);

  useEffect(() => {
    if (!serializable) {
      setSeries([]);
      setIndice(0);
      return;
    }
    setSeries((prev) => Array.from({ length: nSeries }, (_, i) => prev[i] || ''));
    setIndice((i) => Math.min(i, Math.max(0, nSeries - 1)));
  }, [serializable, nSeries]);

  const ajustarCantidad = (delta: number) => {
    const actual = parseInt(cantidad, 10) || 1;
    setCantidad(String(Math.min(maxCantidad, Math.max(1, actual + delta))));
  };

  const setLineaTalla = (i: number, patch: Partial<LineaTalla>) => {
    setLineasTalla((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };

  const ajustarLineaTalla = (i: number, delta: number) => {
    setLineasTalla((prev) =>
      prev.map((l, j) => {
        if (j !== i) return l;
        const actual = parseInt(l.cantidad, 10) || 1;
        return { ...l, cantidad: String(Math.min(maxCantidad, Math.max(1, actual + delta))) };
      }),
    );
  };

  const quitarLineaTalla = (i: number) => {
    setLineasTalla((prev) => (prev.length <= 1 ? [LINEA_TALLA_VACIA] : prev.filter((_, j) => j !== i)));
  };

  const anadirLineaTalla = () => {
    if (!quedanTallas) return;
    setLineasTalla((prev) => [...prev, { ...LINEA_TALLA_VACIA }]);
  };

  const setSerieEn = (i: number, valor: string) => {
    setSeries((prev) => {
      const next = [...prev];
      next[i] = valor;
      return next;
    });
  };

  const alEscanear = (codigo: string) => {
    setSerieEn(indice, codigo);
    const siguiente = series.findIndex((s, i) => i !== indice && !s.trim());
    if (siguiente >= 0) setIndice(siguiente);
    else if (indice + 1 < nSeries) setIndice(indice + 1);
    setEscaner(false);
  };

  const guardar = () => {
    setError(null);
    if (!modeloId) {
      setError('Elige el modelo');
      return;
    }
    if (!idLocal) {
      setError('Elige el local');
      return;
    }
    if (nPedido < 1) {
      setError('La cantidad debe ser al menos 1');
      return;
    }
    if (serializable && nPedido > LOTE_MAX) {
      setError(`En un alta con número de serie puedes registrar como máximo ${LOTE_MAX} aparatos de una vez`);
      return;
    }
    if (pideTalla) {
      if (lineasTalla.some((l) => !l.talla)) {
        setError('Elige la talla en cada línea');
        return;
      }
      if (lineasTalla.some((l) => (parseInt(l.cantidad, 10) || 0) < 1)) {
        setError('La cantidad de cada talla debe ser al menos 1');
        return;
      }
    }
    void persistir(serializable ? series : []);
  };

  const persistir = async (unidadesSerie: string[]) => {
    setGuardando(true);
    setError(null);
    try {
      const comunes = {
        fecha_compra: fechaCompra || undefined,
        coste_adquisicion: coste.trim() ? Number(coste.replace(',', '.')) : undefined,
        notas: notas.trim() || undefined,
      };
      let creados: ActivoFicha[] = [];
      if (serializable && unidadesSerie.length > 1) {
        const res = await apiFetch('/api/activos/lote', {
          method: 'POST',
          timeoutMs: 120000,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelo_id: modeloId,
            id_local: idLocal,
            unidades: unidadesSerie.map((numero_serie) => ({ numero_serie: numero_serie || undefined })),
            comunes,
          }),
        });
        const data = await jsonOrThrow<{ activos?: ActivoFicha[] }>(res, 'No se pudieron dar de alta');
        creados = Array.isArray(data.activos) ? data.activos : [];
      } else if (pideTalla) {
        const res = await apiFetch('/api/activos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelo_id: modeloId,
            id_local: idLocal,
            lineas: lineasTalla.map((l) => ({ talla: l.talla, cantidad: parseInt(l.cantidad, 10) || 1 })),
            ...comunes,
          }),
        });
        const data = await jsonOrThrow<ActivoFicha & { activos?: ActivoFicha[] }>(res, 'No se pudo dar de alta');
        creados = Array.isArray(data.activos) ? data.activos : data.asset_id ? [data] : [];
      } else {
        const res = await apiFetch('/api/activos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modelo_id: modeloId,
            id_local: idLocal,
            cantidad: serializable ? 1 : nPedido,
            numero_serie: serializable ? unidadesSerie[0] || undefined : undefined,
            ...comunes,
          }),
        });
        creados = [await jsonOrThrow<ActivoFicha>(res, 'No se pudo dar de alta')];
      }
      const n = creados.length;
      const unico = n === 1 ? creados[0] : undefined;
      if (unico?.asset_id && hasPermiso('activos.ver')) {
        router.replace(`/mantenimiento/activos/listado?alta=1&sel=${encodeURIComponent(unico.asset_id)}` as never);
      } else if (hasPermiso('activos.ver')) {
        router.replace(`/mantenimiento/activos/listado?alta=${n}` as never);
      } else {
        router.replace('/mantenimiento/activos' as never);
      }
    } catch (e) {
      setError(errorMessage(e, 'No se pudo dar de alta'));
    } finally {
      setGuardando(false);
    }
  };

  if (!hasPermiso('activos.crear')) {
    return (
      <View style={styles.container}>
        <Text style={styles.vacio}>No tienes permiso para dar de alta activos.</Text>
      </View>
    );
  }

  const serieActual = series[indice] || '';
  const prefijo = (categoria?.prefijo_etiqueta || 'XXX').toUpperCase();
  const huecos = '·'.repeat(categoria?.digitos_correlativo || 4);
  const nombreModelo = modelo ? [modelo.marca, modelo.nombre].filter(Boolean).join(' ') : '';

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.topBar, shouldStackToolbar && styles.topBarStack]}>
        <View style={styles.topLeft}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} accessibilityLabel="Volver">
            <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>Dar de alta</Text>
          {modelo ? (
            <View style={[styles.chip, serializable ? styles.chipSerie : styles.chipLote]}>
              <Text style={[styles.chipTxt, serializable ? styles.chipSerieTxt : styles.chipLoteTxt]}>
                {serializable ? 'Con serie' : 'Lote'}
              </Text>
            </View>
          ) : null}
        </View>
        <TouchableOpacity
          style={[styles.cta, (guardando || cargandoCat) && styles.ctaOff]}
          onPress={guardar}
          disabled={guardando || cargandoCat}
        >
          {guardando ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>Guardar</Text>}
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <MaterialIcons name="error-outline" size={18} color={statusColors.danger.text} />
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : null}

      {cargandoCat ? (
        <View style={styles.centro}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
          <ScrollView
            style={styles.panelIzq}
            contentContainerStyle={styles.formContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <View style={[styles.camposFila, shouldStackPanels && styles.col]}>
              <View style={[styles.campo, { zIndex: 30 }]}>
                <SelectorDesplegable
                  label="Modelo"
                  icono="devices"
                  placeholder="Elige modelo"
                  tituloLista="Modelo"
                  opciones={opcionesModelo}
                  valorId={modeloId}
                    onSeleccionar={setModeloId}
                  buscador
                  vacioTexto="No hay modelos. Créalos en Catálogo."
                  vacioAccion={{
                    texto: 'Ir al catálogo',
                    onPress: () => router.push('/mantenimiento/activos/catalogo' as never),
                  }}
                />
              </View>
              <View style={[styles.campo, { zIndex: 20 }]}>
                  <SelectorDesplegable
                    label="Local"
                    icono="storefront"
                    placeholder="Elige local"
                    tituloLista="Local"
                    opciones={opcionesLocal}
                    valorId={idLocal}
                    onSeleccionar={setIdLocal}
                    buscador
                    buscadorPlaceholder="Buscar local…"
                    vacioTexto="No hay locales de sede Grupo Paripe."
                  />
              </View>
            </View>

            {pideTalla ? (
              <View style={styles.lineasTallaBox}>
                <Text style={styles.label}>Tallas</Text>
                {lineasTalla.map((linea, i) => {
                  const usadasOtras = new Set(
                    lineasTalla.filter((_, j) => j !== i).map((l) => l.talla).filter(Boolean),
                  );
                  return (
                    <View key={`talla-${i}`} style={styles.lineaTalla}>
                      <View style={styles.tallaChips}>
                        {opcionesTalla.map((o) => {
                          const on = linea.talla === o.id;
                          const ocupada = usadasOtras.has(o.id);
                          return (
                            <TouchableOpacity
                              key={o.id}
                              style={[
                                styles.tallaChip,
                                on && styles.tallaChipOn,
                                ocupada && styles.tallaChipOff,
                              ]}
                              onPress={() => {
                                if (ocupada) return;
                                setLineaTalla(i, { talla: on ? '' : o.id });
                              }}
                              disabled={ocupada}
                              accessibilityRole="button"
                              accessibilityState={{ selected: on, disabled: ocupada }}
                              accessibilityLabel={`Talla ${o.titulo}`}
                            >
                              <Text
                                style={[
                                  styles.tallaChipTxt,
                                  on && styles.tallaChipTxtOn,
                                  ocupada && styles.tallaChipTxtOff,
                                ]}
                              >
                                {o.titulo}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                      <Stepper
                        value={linea.cantidad}
                        onChange={(v) => setLineaTalla(i, { cantidad: v })}
                        onDelta={(d) => ajustarLineaTalla(i, d)}
                        min={1}
                        max={maxCantidad}
                      />
                      <TouchableOpacity
                        style={styles.lineaTallaQuitar}
                        onPress={() => quitarLineaTalla(i)}
                        accessibilityLabel="Quitar línea"
                      >
                        <MaterialIcons
                          name="close"
                          size={20}
                          color={lineasTalla.length <= 1 ? colors.textMuted : colors.textSecondary}
                        />
                      </TouchableOpacity>
                    </View>
                  );
                })}
                {quedanTallas ? (
                  <TouchableOpacity style={styles.addTallaBtn} onPress={anadirLineaTalla}>
                    <MaterialIcons name="add" size={18} color={colors.accentPressed} />
                    <Text style={styles.addTallaTxt}>Añadir línea</Text>
                  </TouchableOpacity>
                ) : null}
                {nPedido > 0 ? (
                  <Text style={styles.lineasTallaTotal}>{nPedido} ud. en total</Text>
                ) : null}
              </View>
            ) : null}

            <View style={[styles.camposFila, shouldStackPanels && styles.col]}>
              {pideTalla ? null : (
                <View style={styles.campoCantidad}>
                  <Text style={styles.label}>{serializable ? 'Aparatos' : 'Cantidad'}</Text>
                  <Stepper
                    value={cantidad}
                    onChange={setCantidad}
                    onDelta={ajustarCantidad}
                    min={1}
                    max={maxCantidad}
                  />
                </View>
              )}
              <View style={styles.campo}>
                <Text style={styles.label}>Fecha de compra</Text>
                <InputFecha
                  valueIso={fechaCompra}
                  onChangeIso={setFechaCompra}
                  placeholder="dd/mm/aaaa"
                  style={styles.input}
                />
              </View>
              <View style={styles.campo}>
                <Text style={styles.label}>Importe</Text>
                <TextInput
                  style={styles.input}
                  value={coste}
                  onChangeText={setCoste}
                  keyboardType="decimal-pad"
                  placeholder="0,00"
                  placeholderTextColor={colors.textMuted}
                  {...inputCursorProps}
                />
              </View>
            </View>

            <Text style={styles.label}>Notas</Text>
            <TextInput
              style={[styles.input, styles.notas]}
              value={notas}
              onChangeText={setNotas}
              multiline
              placeholder="Opcional"
              placeholderTextColor={colors.textMuted}
              {...inputCursorProps}
            />
          </ScrollView>

          <ScrollView
            style={styles.panelDer}
            contentContainerStyle={styles.previewContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            {!modelo ? (
              <View style={styles.vacioBox}>
                <MaterialIcons name="qr-code-2" size={36} color={colors.textMuted} />
                <Text style={styles.vacioTitulo}>Elige un modelo</Text>
                <Text style={styles.vacioTxt}>Aquí verás la etiqueta y, si aplica, las series.</Text>
              </View>
            ) : (
              <>
                {serializable ? (
                  <>
                    <View style={styles.serieFila}>
                      <TouchableOpacity style={styles.scanBtn} onPress={() => setEscaner(true)}>
                        <MaterialIcons name="qr-code-scanner" size={20} color="#fff" />
                        <Text style={styles.scanBtnTxt}>Escanear</Text>
                      </TouchableOpacity>
                      <TextInput
                        style={[styles.input, styles.serieInput]}
                        value={serieActual}
                        onChangeText={(t) => setSerieEn(indice, t)}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        placeholder={`S/N aparato ${indice + 1}`}
                        placeholderTextColor={colors.textMuted}
                        {...inputCursorProps}
                      />
                    </View>
                    <View style={styles.listaSeries}>
                      {series.map((s, i) => {
                        const activo = i === indice;
                        const lleno = Boolean(s.trim());
                        return (
                          <TouchableOpacity
                            key={`serie-${i}`}
                            style={[styles.serieItem, activo && styles.serieItemActivo]}
                            onPress={() => setIndice(i)}
                          >
                            <MaterialIcons
                              name={lleno ? 'check-circle' : activo ? 'radio-button-on' : 'radio-button-off'}
                              size={18}
                              color={lleno ? colors.success : activo ? colors.accent : colors.textMuted}
                            />
                            <Text style={styles.serieIdx}>{i + 1}</Text>
                            <Text style={[styles.serieVal, !lleno && styles.serieValVacio]} numberOfLines={1}>
                              {s.trim() || 'Pendiente'}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                ) : (
                  <Text style={styles.hint}>
                    Lote de {Math.max(nPedido, 1)} ud.
                    {resumenTallas ? ` (${resumenTallas})` : ''}
                    {localSel ? ` en ${localSel}` : ''}.
                  </Text>
                )}

                <MaquetaEtiqueta
                  prefijo={prefijo}
                  huecos={huecos}
                  modelo={nombreModelo}
                  local={localSel}
                  serie={serializable ? serieActual.trim() : ''}
                  talla={resumenTallas}
                  cantidad={!serializable ? Math.max(nPedido, 1) : undefined}
                  fotoUrl={modelo?.foto_url || null}
                  apilar={shouldStackPanels}
                />
              </>
            )}
          </ScrollView>
        </View>
      )}

      <EscanerCodigo visible={escaner} onClose={() => setEscaner(false)} onDetect={alEscanear} />
    </KeyboardAvoidingView>
  );
}

function MaquetaEtiqueta({
  prefijo,
  huecos,
  modelo,
  local,
  serie,
  talla,
  cantidad,
  fotoUrl,
  apilar,
}: {
  prefijo: string;
  huecos: string;
  modelo: string;
  local: string;
  serie: string;
  talla?: string;
  cantidad?: number;
  fotoUrl?: string | null;
  apilar?: boolean;
}) {
  const qr = urlQrEtiqueta(`${prefijo}-PREVIEW`, 140);
  const hayFoto = Boolean(fotoUrl);
  return (
    <View style={hayFoto ? [styles.maquetaFila, apilar && styles.maquetaFilaStack] : undefined}>
      {fotoUrl ? (
        <Image
          source={{ uri: fotoUrl }}
          style={[styles.maquetaFoto, apilar && styles.maquetaFotoStack]}
          resizeMode="contain"
        />
      ) : null}
      <View style={[styles.maqueta, hayFoto && !apilar && styles.maquetaAlLado]}>
        <Image source={{ uri: qr }} style={styles.maquetaQr} />
        <View style={{ flex: 1 }}>
          <Text style={styles.maquetaId}>
            {prefijo}-{huecos}
          </Text>
          {modelo ? (
            <Text style={styles.maquetaMod} numberOfLines={1}>
              {modelo}
            </Text>
          ) : null}
          {local ? (
            <Text style={styles.maquetaMeta} numberOfLines={1}>
              {local}
            </Text>
          ) : null}
          {talla ? (
            <Text style={styles.maquetaMeta} numberOfLines={2}>
              {talla.includes('×') ? talla : `Talla ${talla}`}
            </Text>
          ) : null}
          {serie ? (
            <Text style={styles.maquetaMeta} numberOfLines={1}>
              S/N {serie}
            </Text>
          ) : null}
          {cantidad != null ? <Text style={styles.maquetaMeta}>{cantidad} ud.</Text> : null}
          <Text style={styles.maquetaNota}>El número se asigna al guardar</Text>
        </View>
      </View>
    </View>
  );
}

function Stepper({
  value,
  onChange,
  onDelta,
  min,
  max,
}: {
  value: string;
  onChange: (v: string) => void;
  onDelta: (d: number) => void;
  min: number;
  max: number;
}) {
  const n = parseInt(value, 10) || 0;
  return (
    <View style={styles.stepper}>
      <TouchableOpacity
        style={[styles.stepBtn, n <= min && styles.stepBtnOff]}
        onPress={() => onDelta(-1)}
        disabled={n <= min}
        accessibilityLabel="Quitar uno"
      >
        <MaterialIcons name="remove" size={22} color={n <= min ? colors.textMuted : colors.accentPressed} />
      </TouchableOpacity>
      <TextInput
        style={styles.stepInput}
        value={value}
        onChangeText={(t) => onChange(t.replace(/[^\d]/g, ''))}
        keyboardType="number-pad"
        textAlign="center"
        selectTextOnFocus
        {...inputCursorProps}
      />
      <TouchableOpacity
        style={[styles.stepBtn, n >= max && styles.stepBtnOff]}
        onPress={() => onDelta(1)}
        disabled={n >= max}
        accessibilityLabel="Añadir uno"
      >
        <MaterialIcons name="add" size={22} color={n >= max ? colors.textMuted : colors.accentPressed} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 },
  topBarStack: { flexDirection: 'column', alignItems: 'stretch' },
  topLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  iconBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.titulo, color: '#0f172a' },
  vacio: { padding: 16, color: colors.textMuted },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: statusColors.danger.bg,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  error: { color: statusColors.danger.text, flex: 1, fontSize: 13 },
  split: { flex: 1, flexDirection: 'row', gap: 10, minHeight: 0 },
  splitStack: { flexDirection: 'column' },
  panelIzq: { flex: 0.42, minWidth: 280 },
  panelDer: {
    flex: 0.58,
    minWidth: 0,
    minHeight: 220,
    backgroundColor: colors.bgSubtle,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  formContent: { paddingBottom: 16, paddingRight: 10, gap: 12 },
  previewContent: { paddingVertical: 12, paddingLeft: 12, paddingRight: 16, flexGrow: 1 },
  camposFila: { flexDirection: 'row', gap: 10, zIndex: 10 },
  col: { flexDirection: 'column' },
  campo: { flex: 1, minWidth: 120, zIndex: 10 },
  campoCantidad: { width: 168, flexGrow: 0, flexShrink: 0, zIndex: 10 },
  lineasTallaBox: { gap: 8 },
  tallaChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, flex: 1, minWidth: 180 },
  tallaChip: {
    height: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tallaChipOn: {
    backgroundColor: ROSA_BG,
    borderColor: ROSA_BORDE,
  },
  tallaChipOff: { opacity: 0.35 },
  tallaChipTxt: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  tallaChipTxtOn: { color: ROSA_FG },
  tallaChipTxtOff: { color: colors.textMuted },
  lineaTalla: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  lineaTallaQuitar: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addTallaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 4,
  },
  addTallaTxt: { fontSize: 14, fontWeight: '700', color: colors.accentPressed },
  lineasTallaTotal: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  chipSerie: { backgroundColor: ROSA_BG },
  chipSerieTxt: { color: ROSA_FG },
  chipLote: { backgroundColor: colors.accentMuted },
  chipLoteTxt: { color: colors.accentPressed },
  chipTxt: { fontSize: 12, fontWeight: '700' },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.bgSubtle,
  },
  notas: { minHeight: 72, textAlignVertical: 'top', paddingTop: 10 },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 168,
    height: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
    overflow: 'hidden',
  },
  stepBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentMuted,
  },
  stepBtnOff: { opacity: 0.4 },
  stepInput: {
    flex: 1,
    minWidth: 56,
    height: MIN_TOUCH,
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
    textAlign: 'center',
    paddingHorizontal: 0,
  },
  hint: { fontSize: 13, color: colors.textSecondary, marginBottom: 12 },
  serieFila: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 8 },
  scanBtn: {
    height: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  scanBtnTxt: { color: '#fff', fontWeight: '700' },
  serieInput: { flex: 1, backgroundColor: colors.surface },
  listaSeries: { gap: 6, marginBottom: 12 },
  serieItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  serieItemActivo: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  serieIdx: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, width: 18 },
  serieVal: { flex: 1, fontSize: 14, color: '#0f172a', fontWeight: '600' },
  serieValVacio: { fontWeight: '400', color: colors.textMuted },
  vacioBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  vacioTitulo: { fontSize: 16, fontWeight: '600', color: colors.textPrimary, textAlign: 'center' },
  vacioTxt: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  maquetaFila: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
  },
  maquetaFilaStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  maquetaFoto: {
    width: 100,
    aspectRatio: 1,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
  },
  maquetaFotoStack: {
    width: '40%',
    maxWidth: 160,
    alignSelf: 'flex-start',
  },
  maquetaAlLado: { flex: 1 },
  maqueta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: '#0f172a',
    backgroundColor: '#fff',
  },
  maquetaQr: { width: 72, height: 72, backgroundColor: '#fff' },
  maquetaId: { fontSize: 18, fontWeight: '800', color: '#0f172a', letterSpacing: 0.4 },
  maquetaMod: { fontSize: 13, color: colors.textPrimary, marginTop: 3 },
  maquetaMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  maquetaNota: { fontSize: 11, color: colors.textMuted, marginTop: 6, fontWeight: '600' },
  cta: {
    height: MIN_TOUCH,
    paddingHorizontal: 16,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 120,
  },
  ctaOff: { opacity: 0.6 },
  ctaTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
