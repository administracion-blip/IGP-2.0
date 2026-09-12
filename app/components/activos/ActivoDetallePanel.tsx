import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../contexts/AuthContext';
import { useMantenimientoLocales, valorEnLocal } from '../../(app)/mantenimiento/LocalesContext';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { EscanerCodigo } from './EscanerCodigo';
import { EtiquetaPreview } from './EtiquetaPreview';
import { useConfirmar } from '../../hooks/useConfirmar';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, inputCursorProps, radius, statusColors, typography } from '../../constants/theme';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatId6 } from '../../utils/idFormat';
import { formatCreadoEn, formatFecha } from '../../utils/formatFecha';
import { subirFotoActivo } from '../../lib/activosUpload';
import { imprimirEtiquetaEnNavegador, previewDesdeFicha } from '../../lib/activosEtiqueta';
import {
  colorEstadoActivo,
  labelEstadoActivo,
  labelEventoActivo,
  labelTipoFotoActivo,
  tallaDeActivo,
  TIPOS_FOTO_ACTIVO,
  TRANSICIONES_ACTIVO,
} from '../../lib/activos';
import { activoSePuedeEntregar, useCestaActivos } from '../../lib/activosCesta';
import { descargarActaEntregaPdf, nombreFicheroActaEntrega } from '../../lib/activosActa';
import type { ActivoFicha, EstadoActivo, EventoActivo, FotoActivo, PreviewEtiquetaActivo } from '../../types/activos';

const ROSA_BG = '#fce7f3';
const ROSA_FG = '#be185d';

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || fallback);
  return data;
}

function entregaIdDeEvento(ev: EventoActivo): string {
  const d = ev.despues || {};
  return String(d.entrega_id || '').trim();
}

type Props = {
  assetId: string | null;
  onActualizado?: (item: ActivoFicha) => void;
};

export function ActivoDetallePanel({ assetId, onActualizado }: Props) {
  const { hasPermiso } = useAuth();
  const { locales } = useMantenimientoLocales();
  const { confirmar, ConfirmarView } = useConfirmar();
  const { shouldStackToolbar } = useBreakpoint();

  const [item, setItem] = useState<ActivoFicha | null>(null);
  const [preview, setPreview] = useState<PreviewEtiquetaActivo | null>(null);
  const [eventos, setEventos] = useState<EventoActivo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accion, setAccion] = useState(false);
  const [historialAbierto, setHistorialAbierto] = useState(false);
  const [descargandoActaId, setDescargandoActaId] = useState<string | null>(null);
  const [errorActa, setErrorActa] = useState<{ id: string; msg: string } | null>(null);

  const [modalTraslado, setModalTraslado] = useState(false);
  const [localDestino, setLocalDestino] = useState('');
  const [cantidadTraslado, setCantidadTraslado] = useState('');
  const [modalEstado, setModalEstado] = useState(false);
  const [modalSerie, setModalSerie] = useState(false);
  const [nuevaSerie, setNuevaSerie] = useState('');
  const [escaner, setEscaner] = useState(false);
  const [tipoFoto, setTipoFoto] = useState<FotoActivo['tipo']>('general');
  const [fotoAmpliada, setFotoAmpliada] = useState<string | null>(null);

  const puedeEditar = hasPermiso('activos.editar');
  const puedeFotos = hasPermiso('activos.crear') || puedeEditar;
  const { enCesta, anadir } = useCestaActivos();
  const puedeBorrar = hasPermiso('activos.borrar');

  const opcionesLocal: OpcionDesplegable[] = useMemo(
    () =>
      locales
        .map((l) => {
          const id = formatId6(valorEnLocal(l, 'id_Locales'));
          const nombre = String(valorEnLocal(l, 'nombre') || valorEnLocal(l, 'Nombre') || '').trim();
          return { id, titulo: nombre || id };
        })
        .filter((o) => o.id && o.id !== '000000' && o.id !== item?.id_local),
    [locales, item?.id_local],
  );

  const destinosEstado = useMemo(() => {
    if (!item) return [];
    return (TRANSICIONES_ACTIVO[item.estado] || []).filter((e) => {
      if (e === 'baja' || e === 'asignado') return false;
      if (item.estado === 'asignado' && e !== 'perdido') return false;
      return true;
    });
  }, [item]);

  const onActRef = useRef(onActualizado);
  onActRef.current = onActualizado;

  const cargar = useCallback(
    async (silencioso = false) => {
      if (!assetId || !hasPermiso('activos.ver')) {
        setItem(null);
        setPreview(null);
        setEventos([]);
        return;
      }
      if (!silencioso) setLoading(true);
      setError(null);
      try {
        const [rf, re] = await Promise.all([
          apiFetch(`/api/activos/${encodeURIComponent(assetId)}`),
          apiFetch(`/api/activos/${encodeURIComponent(assetId)}/eventos?limite=50`),
        ]);
        const ficha = await jsonOrThrow<ActivoFicha>(rf, 'No se pudo cargar el activo');
        const ev = await jsonOrThrow<{ eventos?: EventoActivo[] }>(re, 'No se pudo cargar el historial');
        setItem(ficha);
        setEventos(Array.isArray(ev.eventos) ? ev.eventos : []);
        let pre = previewDesdeFicha(ficha);
        if (hasPermiso('activos.editar')) {
          try {
            const rp = await apiFetch('/api/activos/etiquetas/preview', {
              method: 'POST',
              body: JSON.stringify({ asset_ids: [assetId] }),
            });
            const dp = await jsonOrThrow<{ etiquetas?: PreviewEtiquetaActivo[] }>(
              rp,
              'No se pudo cargar la etiqueta',
            );
            if (dp.etiquetas?.[0]) pre = dp.etiquetas[0];
          } catch {
            /* se usa la previsualización local */
          }
        }
        setPreview(pre);
        onActRef.current?.(ficha);
      } catch (e) {
        setError(errorMessage(e, 'No se pudo cargar el activo'));
        if (!silencioso) setItem(null);
      } finally {
        if (!silencioso) setLoading(false);
      }
    },
    [assetId, hasPermiso],
  );

  useEffect(() => {
    setHistorialAbierto(false);
    setErrorActa(null);
    setDescargandoActaId(null);
    void cargar();
  }, [cargar]);

  const aplicar = async (fn: () => Promise<void>) => {
    setAccion(true);
    setError(null);
    try {
      await fn();
      await cargar(true);
    } catch (e) {
      setError(errorMessage(e, 'No se pudo completar la acción'));
    } finally {
      setAccion(false);
    }
  };

  const trasladar = () =>
    aplicar(async () => {
      if (!assetId || !localDestino) throw new Error('Elige el local de destino');
      const body: Record<string, unknown> = { id_local: localDestino };
      if (item?.granularidad === 'lote' && cantidadTraslado.trim()) {
        body.cantidad = Number(cantidadTraslado);
      }
      const res = await apiFetch(`/api/activos/${encodeURIComponent(assetId)}/traslado`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await jsonOrThrow(res, 'No se pudo trasladar');
      setModalTraslado(false);
      setLocalDestino('');
      setCantidadTraslado('');
    });

  const cambiarEstado = async (estado: EstadoActivo) => {
    if (estado === 'perdido') {
      const ok = await confirmar(
        'Marcar como perdido',
        `«${item?.etiqueta_legible || 'Este activo'}» dejará de estar operativo hasta que se recupere.`,
        { confirmarLabel: 'Marcar perdido', variant: 'danger' },
      );
      if (!ok) return;
    }
    await aplicar(async () => {
      if (!assetId) return;
      const path =
        estado === 'baja'
          ? `/api/activos/${encodeURIComponent(assetId)}/baja`
          : estado === 'perdido'
            ? `/api/activos/${encodeURIComponent(assetId)}/perdido`
            : `/api/activos/${encodeURIComponent(assetId)}/estado`;
      const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(estado === 'baja' || estado === 'perdido' ? {} : { estado }),
      });
      await jsonOrThrow(res, 'No se pudo cambiar el estado');
      setModalEstado(false);
    });
  };

  const sustituirSerie = () =>
    aplicar(async () => {
      if (!assetId || !nuevaSerie.trim()) throw new Error('Indica el nuevo número de serie');
      const res = await apiFetch(`/api/activos/${encodeURIComponent(assetId)}/sustitucion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero_serie: nuevaSerie.trim() }),
      });
      await jsonOrThrow(res, 'No se pudo sustituir el número de serie');
      setModalSerie(false);
      setNuevaSerie('');
    });

  const imprimirEtiqueta = async () => {
    if (!assetId || !preview) return;
    const abierta = imprimirEtiquetaEnNavegador({
      ...preview,
      ya_impresa: item?.etiqueta_impresa === true || preview.ya_impresa,
    });
    if (!abierta) {
      setError('No se pudo abrir la impresión. Permite las ventanas emergentes y reintenta.');
      return;
    }
    const ok = await confirmar(
      '¿Se ha impreso la etiqueta?',
      `Se marcará «${preview.etiqueta_legible}» como impresa.`,
      { confirmarLabel: 'Marcar impresa' },
    );
    if (!ok) return;
    await aplicar(async () => {
      const res = await apiFetch('/api/activos/etiquetas/impresa', {
        method: 'POST',
        body: JSON.stringify({ asset_ids: [assetId] }),
      });
      await jsonOrThrow(res, 'No se pudo marcar como impresa');
    });
  };

  const anadirFoto = async () => {
    if (!assetId) return;
    try {
      const cam = await ImagePicker.requestCameraPermissionsAsync();
      const result =
        cam.status === 'granted'
          ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const asset = result.assets[0];
      setAccion(true);
      setError(null);
      await subirFotoActivo(assetId, tipoFoto, asset.uri, asset.mimeType || 'image/jpeg');
      await cargar(true);
    } catch (e) {
      setError(errorMessage(e, 'No se pudo subir la foto'));
    } finally {
      setAccion(false);
    }
  };

  const descargarJustificante = async (ev: EventoActivo) => {
    const entregaId = entregaIdDeEvento(ev);
    if (!assetId || !entregaId) return;
    setDescargandoActaId(ev.evento_id);
    setErrorActa(null);
    try {
      const res = await apiFetch(
        `/api/activos/${encodeURIComponent(assetId)}/entregas/${encodeURIComponent(entregaId)}/acta`,
      );
      const data = await jsonOrThrow<{ url?: string; entrega_id?: string; error?: string }>(
        res,
        'No se pudo obtener el justificante',
      );
      if (!data.url) throw new Error('No hay justificante para esta entrega');
      await descargarActaEntregaPdf(data.url, nombreFicheroActaEntrega(data.entrega_id || entregaId));
    } catch (e) {
      setErrorActa({ id: ev.evento_id, msg: errorMessage(e, 'No se pudo descargar el justificante') });
    } finally {
      setDescargandoActaId(null);
    }
  };

  const borrarFoto = async (foto: FotoActivo) => {
    if (!assetId) return;
    const ok = await confirmar('Quitar foto', `Se eliminará la ${labelTipoFotoActivo(foto.tipo).toLowerCase()}.`, {
      confirmarLabel: 'Quitar',
      variant: 'danger',
    });
    if (!ok) return;
    await aplicar(async () => {
      const res = await apiFetch(
        `/api/activos/${encodeURIComponent(assetId)}/fotos/${encodeURIComponent(foto.foto_id)}`,
        { method: 'DELETE' },
      );
      await jsonOrThrow(res, 'No se pudo quitar la foto');
    });
  };

  if (!assetId) {
    return (
      <View style={styles.vacioPanel}>
        <MaterialIcons name="touch-app" size={36} color={colors.textMuted} />
        <Text style={styles.vacioTitulo}>Elige un activo</Text>
        <Text style={styles.vacioTxt}>Pulsa una fila de la izquierda para ver el detalle y las acciones.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.centro}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (error && !item) {
    return (
      <View style={styles.centro}>
        <Text style={styles.error}>{error}</Text>
        <TouchableOpacity style={styles.retry} onPress={() => void cargar()}>
          <Text style={styles.retryTxt}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!item) return null;

  const tono = colorEstadoActivo(item.estado);
  const titulo = [item.marca, item.nombre_modelo].filter(Boolean).join(' ');

  return (
    <View style={styles.wrap}>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.cabecera}>
          <View style={{ flex: 1 }}>
            <Text style={styles.etiqueta}>{item.etiqueta_legible}</Text>
            <Text style={styles.modelo} numberOfLines={1}>
              {titulo || 'Sin modelo'}
              {tallaDeActivo(item) ? ` · ${tallaDeActivo(item)}` : ''}
              {item.granularidad === 'lote' && item.cantidad != null ? ` · ${item.cantidad} ud.` : ''}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: tono.bg }]}>
            <Text style={[styles.badgeTxt, { color: tono.text }]}>{labelEstadoActivo(item.estado)}</Text>
          </View>
        </View>

        {puedeEditar && item.estado !== 'baja' ? (
          <View style={styles.acciones}>
            {activoSePuedeEntregar(item) ? (
              <Accion
                icon={enCesta(item.asset_id) ? 'shopping-cart' : 'add-shopping-cart'}
                label={enCesta(item.asset_id) ? 'En la cesta' : 'Añadir a entrega'}
                onPress={() => {
                  if (!enCesta(item.asset_id)) anadir(item);
                }}
              />
            ) : null}
            {item.custodio_id ? null : (
              <Accion icon="swap-horiz" label="Trasladar" onPress={() => setModalTraslado(true)} />
            )}
            <Accion icon="flag" label="Estado" onPress={() => setModalEstado(true)} />
            {item.granularidad === 'unidad' ? (
              <Accion icon="sync" label="Sustituir serie" onPress={() => setModalSerie(true)} />
            ) : null}
            {puedeBorrar ? (
              <Accion
                icon="delete-outline"
                label="Baja"
                peligro
                onPress={async () => {
                  const ok = await confirmar(
                    'Dar de baja',
                    `«${item.etiqueta_legible}» dejará de estar en inventario.`,
                    { confirmarLabel: 'Dar de baja', variant: 'danger' },
                  );
                  if (ok) void cambiarEstado('baja');
                }}
              />
            ) : null}
          </View>
        ) : null}

        {preview ? (
          <EtiquetaPreview
            etiqueta={{ ...preview, ya_impresa: item.etiqueta_impresa === true || preview.ya_impresa }}
            puedeImprimir={puedeEditar}
            imprimiendo={accion}
            onImprimir={() => void imprimirEtiqueta()}
          />
        ) : null}

        <View style={styles.card}>
          <Fila label="Local" valor={item.local_nombre || item.id_local} />
          {item.custodio_nombre ? <Fila label="Entregado a" valor={item.custodio_nombre} /> : null}
          {tallaDeActivo(item) ? <Fila label="Talla" valor={tallaDeActivo(item)} /> : null}
          <View style={styles.fila}>
            <Text style={styles.filaLab}>Nº de serie</Text>
            {item.numero_serie ? (
              <View style={styles.serieChip}>
                <Text style={styles.serieChipTxt}>{item.numero_serie}</Text>
              </View>
            ) : (
              <Text style={styles.filaVal}>Sin serie</Text>
            )}
          </View>
          <Fila label="Compra" valor={formatFecha(item.fecha_compra)} />
          {item.coste_adquisicion != null ? <Fila label="Coste" valor={`${item.coste_adquisicion} €`} /> : null}
          {item.notas ? <Fila label="Notas" valor={item.notas} /> : null}
        </View>

        <Text style={styles.bloqueTitulo}>Fotos</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fotosRow}>
          {(item.fotos || []).map((f) => (
            <View key={f.foto_id} style={styles.fotoBox}>
              {f.url ? (
                <TouchableOpacity onPress={() => setFotoAmpliada(f.url || null)}>
                  <Image source={{ uri: f.url }} style={styles.foto} />
                </TouchableOpacity>
              ) : (
                <View style={[styles.foto, styles.fotoVacia]}>
                  <MaterialIcons name="image" size={22} color={colors.textMuted} />
                </View>
              )}
              <Text style={styles.fotoTipo}>{labelTipoFotoActivo(f.tipo)}</Text>
              {puedeEditar && f.foto_id !== 'modelo' ? (
                <TouchableOpacity onPress={() => void borrarFoto(f)} style={styles.fotoDel}>
                  <MaterialIcons name="close" size={16} color={statusColors.danger.text} />
                </TouchableOpacity>
              ) : null}
            </View>
          ))}
          {!(item.fotos || []).length ? (
            <Text style={styles.hint}>Añade una foto general y, si hay, la placa de serie.</Text>
          ) : null}
        </ScrollView>
        {puedeFotos ? (
          <View style={[styles.fotoAcciones, shouldStackToolbar && styles.fotoAccionesStack]}>
            <View style={{ flex: 1 }}>
              <SelectorDesplegable
                label="Tipo de foto"
                icono="photo-camera"
                opciones={TIPOS_FOTO_ACTIVO.map((t) => ({ id: t.id, titulo: t.label }))}
                valorId={tipoFoto}
                onSeleccionar={(id) => setTipoFoto(id as FotoActivo['tipo'])}
              />
            </View>
            <TouchableOpacity style={styles.fotoBtn} onPress={() => void anadirFoto()} disabled={accion}>
              <MaterialIcons name="add-a-photo" size={20} color="#fff" />
              <Text style={styles.fotoBtnTxt}>Añadir</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <TouchableOpacity
          style={styles.histToggle}
          onPress={() => setHistorialAbierto((v) => !v)}
          accessibilityRole="button"
        >
          <MaterialIcons
            name={historialAbierto ? 'expand-less' : 'expand-more'}
            size={22}
            color={colors.accentPressed}
          />
          <Text style={styles.histToggleTxt}>
            Historial{eventos.length ? ` · ${eventos.length}` : ''}
          </Text>
        </TouchableOpacity>
        {historialAbierto ? (
          eventos.length === 0 ? (
            <Text style={styles.hint}>Aún no hay movimientos.</Text>
          ) : (
            eventos.map((ev) => (
              <View key={ev.evento_id} style={styles.evento}>
                <View style={styles.eventoPunto} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.eventoTipo}>{labelEventoActivo(ev.tipo)}</Text>
                  <Text style={styles.eventoMeta}>
                    {formatCreadoEn(ev.creado_en)}
                    {ev.usuario_nombre ? ` · ${ev.usuario_nombre}` : ''}
                  </Text>
                  {ev.notas ? <Text style={styles.eventoNotas}>{ev.notas}</Text> : null}
                  <TextoCambio ev={ev} />
                  {ev.tipo === 'entrega' && entregaIdDeEvento(ev) ? (
                    <>
                      <TouchableOpacity
                        style={styles.btnJustificante}
                        onPress={() => void descargarJustificante(ev)}
                        disabled={descargandoActaId === ev.evento_id}
                        accessibilityRole="button"
                        accessibilityLabel="Descargar justificante"
                      >
                        {descargandoActaId === ev.evento_id ? (
                          <ActivityIndicator size="small" color={colors.accentPressed} />
                        ) : (
                          <MaterialIcons name="download" size={18} color={colors.accentPressed} />
                        )}
                        <Text style={styles.btnJustificanteTxt}>Descargar justificante</Text>
                      </TouchableOpacity>
                      {errorActa?.id === ev.evento_id ? (
                        <Text style={styles.error}>{errorActa.msg}</Text>
                      ) : null}
                    </>
                  ) : null}
                </View>
              </View>
            ))
          )
        ) : null}
      </ScrollView>

      <Modal visible={modalTraslado} transparent animationType="fade" onRequestClose={() => setModalTraslado(false)}>
        <Pressable style={styles.overlay} onPress={() => setModalTraslado(false)}>
          <Pressable style={[styles.sheet, styles.sheetTraslado]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitulo}>Trasladar</Text>
            <SelectorDesplegable
              label="Local destino"
              icono="storefront"
              opciones={opcionesLocal}
              valorId={localDestino}
              onSeleccionar={setLocalDestino}
            />
            {item.granularidad === 'lote' ? (
              <>
                <Text style={styles.label}>Cantidad (vacío = todas)</Text>
                <TextInput
                  style={styles.input}
                  value={cantidadTraslado}
                  onChangeText={setCantidadTraslado}
                  keyboardType="number-pad"
                  placeholder={`Máx. ${item.cantidad ?? ''}`}
                  placeholderTextColor={colors.textMuted}
                  {...inputCursorProps}
                />
              </>
            ) : null}
            <TouchableOpacity style={styles.cta} onPress={() => void trasladar()} disabled={accion || !localDestino}>
              {accion ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>Trasladar</Text>}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={modalEstado} transparent animationType="fade" onRequestClose={() => setModalEstado(false)}>
        <Pressable style={styles.overlay} onPress={() => setModalEstado(false)}>
          <Pressable style={[styles.sheet, styles.sheetEstado]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitulo}>Nuevo estado</Text>
            {destinosEstado.map((e) => (
              <TouchableOpacity
                key={e}
                style={styles.estadoOpt}
                onPress={() => void cambiarEstado(e)}
                disabled={accion}
              >
                <Text style={{ color: colorEstadoActivo(e).text, fontWeight: '600' }}>{labelEstadoActivo(e)}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={modalSerie} transparent animationType="fade" onRequestClose={() => setModalSerie(false)}>
        <Pressable style={styles.overlay} onPress={() => setModalSerie(false)}>
          <Pressable style={[styles.sheet, styles.sheetTraslado]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitulo}>Sustituir serie</Text>
            <Text style={styles.hint}>La etiqueta IGP no cambia.</Text>
            <TouchableOpacity style={styles.scanMini} onPress={() => setEscaner(true)}>
              <MaterialIcons name="qr-code-scanner" size={20} color="#fff" />
              <Text style={styles.ctaTxt}>Escanear</Text>
            </TouchableOpacity>
            <TextInput
              style={styles.input}
              value={nuevaSerie}
              onChangeText={setNuevaSerie}
              autoCapitalize="characters"
              placeholder="Nuevo S/N"
              placeholderTextColor={colors.textMuted}
              {...inputCursorProps}
            />
            <TouchableOpacity
              style={styles.cta}
              onPress={() => void sustituirSerie()}
              disabled={accion || !nuevaSerie.trim()}
            >
              {accion ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>Guardar</Text>}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!fotoAmpliada} transparent animationType="fade" onRequestClose={() => setFotoAmpliada(null)}>
        <Pressable style={styles.overlayOscuro} onPress={() => setFotoAmpliada(null)}>
          {fotoAmpliada ? <Image source={{ uri: fotoAmpliada }} style={styles.fotoGrande} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>

      <EscanerCodigo
        visible={escaner}
        onClose={() => setEscaner(false)}
        onDetect={(codigo) => {
          setNuevaSerie(codigo);
          setEscaner(false);
        }}
      />
      {ConfirmarView}
    </View>
  );
}

function Fila({ label, valor }: { label: string; valor: string }) {
  return (
    <View style={styles.fila}>
      <Text style={styles.filaLab}>{label}</Text>
      <Text style={styles.filaVal}>{valor}</Text>
    </View>
  );
}

function Accion({
  icon,
  label,
  onPress,
  peligro,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  onPress: () => void;
  peligro?: boolean;
}) {
  return (
    <TouchableOpacity style={[styles.accion, peligro && styles.accionPeligro]} onPress={onPress}>
      <MaterialIcons name={icon} size={18} color={peligro ? statusColors.danger.text : colors.accentPressed} />
      <Text style={[styles.accionTxt, peligro && { color: statusColors.danger.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function TextoCambio({ ev }: { ev: EventoActivo }) {
  const partes: string[] = [];
  const antes = ev.antes || {};
  const despues = ev.despues || {};
  if (despues.local_nombre && antes.local_nombre) {
    partes.push(`${String(antes.local_nombre)} → ${String(despues.local_nombre)}`);
  }
  if (despues.estado && antes.estado) {
    partes.push(`${labelEstadoActivo(String(antes.estado))} → ${labelEstadoActivo(String(despues.estado))}`);
  }
  if (despues.numero_serie != null) {
    partes.push(`Serie: ${String(antes.numero_serie || '—')} → ${String(despues.numero_serie || '—')}`);
  }
  if (despues.etiqueta_legible) partes.push(`Etiqueta ${String(despues.etiqueta_legible)}`);
  if (despues.cantidad != null && antes.cantidad != null) {
    partes.push(`Cantidad ${String(antes.cantidad)} → ${String(despues.cantidad)}`);
  }
  if (!partes.length) return null;
  return <Text style={styles.eventoCambio}>{partes.join(' · ')}</Text>;
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  body: { paddingBottom: 24, paddingRight: 16, paddingLeft: 2, gap: 4 },
  vacioPanel: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  vacioTitulo: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  vacioTxt: { fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  error: { color: statusColors.danger.text, marginBottom: 10 },
  retry: { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: colors.accentMuted, borderRadius: radius.md },
  retryTxt: { color: colors.accentPressed, fontWeight: '600' },
  cabecera: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  etiqueta: { ...typography.subtitulo, color: '#0f172a' },
  modelo: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  badge: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  badgeTxt: { fontSize: 12, fontWeight: '700' },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  accion: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bgSubtle,
  },
  accionPeligro: { borderColor: '#fecaca', backgroundColor: '#fef2f2' },
  accionTxt: { color: colors.accentPressed, fontWeight: '600', fontSize: 13 },
  card: {
    backgroundColor: colors.bgSubtle,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 12,
  },
  fila: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 5 },
  filaLab: { fontSize: 13, color: colors.textSecondary },
  filaVal: { fontSize: 13, fontWeight: '600', color: '#0f172a', flexShrink: 1, textAlign: 'right' },
  serieChip: {
    backgroundColor: ROSA_BG,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  serieChipTxt: { fontSize: 12, fontWeight: '700', color: ROSA_FG },
  bloqueTitulo: { fontSize: 14, fontWeight: '700', color: '#0f172a', marginTop: 4, marginBottom: 8 },
  hint: { fontSize: 13, color: colors.textSecondary, marginBottom: 8 },
  fotosRow: { gap: 10, paddingBottom: 8, alignItems: 'flex-start' },
  fotoBox: { width: 120, position: 'relative' },
  foto: { width: 120, height: 90, borderRadius: radius.md, backgroundColor: colors.border },
  fotoVacia: { alignItems: 'center', justifyContent: 'center' },
  fotoTipo: { fontSize: 11, color: colors.textSecondary, marginTop: 4 },
  fotoDel: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fotoAcciones: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, zIndex: 8, marginBottom: 8 },
  fotoAccionesStack: { flexDirection: 'column', alignItems: 'stretch' },
  fotoBtn: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fotoBtnTxt: { color: '#fff', fontWeight: '700' },
  histToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  histToggleTxt: { color: colors.accentPressed, fontWeight: '700' },
  evento: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  eventoPunto: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, marginTop: 5 },
  eventoTipo: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  eventoMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  eventoNotas: { fontSize: 13, color: colors.textPrimary, marginTop: 4 },
  eventoCambio: { fontSize: 13, color: colors.textSecondary, marginTop: 4 },
  btnJustificante: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgSubtle,
  },
  btnJustificanteTxt: { color: colors.accentPressed, fontWeight: '600', fontSize: 13 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  overlayOscuro: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  sheet: { backgroundColor: '#fff', borderRadius: radius.md, padding: 16, gap: 10, width: '100%' },
  sheetEstado: { maxWidth: 280 },
  sheetTraslado: { maxWidth: 360 },
  sheetTitulo: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  label: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    fontSize: 15,
    color: colors.textPrimary,
    backgroundColor: colors.bgSubtle,
  },
  cta: {
    minHeight: MIN_TOUCH,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaTxt: { color: '#fff', fontWeight: '700' },
  scanMini: {
    minHeight: MIN_TOUCH,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  estadoOpt: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  fotoGrande: { width: '100%', height: '80%' },
});
