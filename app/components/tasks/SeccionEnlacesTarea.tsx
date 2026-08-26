/**
 * Zona de enlaces externos de una tarea: añadir URL, ver captura (miniatura /
 * precio / estado) y recapturar o borrar si `permisos_fila.editar`.
 *
 * Tras crear o recapturar, el padre debe reconsultar la ficha a los pocos
 * segundos: la captura sigue en servidor y este bloque solo pinta lo que llega.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Platform,
  Alert,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { SeccionFicha } from './SeccionFicha';
import { estilosFormTasks as form } from './estilosTasks';
import { apiFetch, errorMessage } from '../../utils/api';
import { abrirEnlaceExterno, normalizarUrlExterna } from '../../utils/enlaceExterno';
import type { EnlaceTarea } from '../../types/tasks';

function formatoPrecio(precio?: number, moneda?: string): string | null {
  if (precio == null || !Number.isFinite(Number(precio))) return null;
  const mon = (moneda || 'EUR').trim() || 'EUR';
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: mon }).format(Number(precio));
  } catch {
    return `${Number(precio)} ${mon}`;
  }
}

function hostDeUrl(url: string, urlHost?: string): string {
  const host = (urlHost || '').trim();
  if (host) return host;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function SeccionEnlacesTarea({
  idTarea,
  enlaces,
  puedeEditar,
  onEnlacesCambiados,
  onPedirRefrescoCaptura,
}: {
  idTarea: string;
  enlaces: EnlaceTarea[];
  puedeEditar: boolean;
  /** Actualiza la lista en el padre (añadir / quitar / sustituir un enlace). */
  onEnlacesCambiados: (siguiente: EnlaceTarea[]) => void;
  /** Programa una reconsulta suave de la ficha tras dejar un enlace en `pendiente`. */
  onPedirRefrescoCaptura: () => void;
}) {
  const { isCompact } = useBreakpoint();
  const [urlNueva, setUrlNueva] = useState('');
  const [enCurso, setEnCurso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [miniaturas, setMiniaturas] = useState<Record<string, string>>({});
  const miniaturasPedidas = useRef(new Set<string>());

  const lista = enlaces ?? [];

  useEffect(() => {
    let cancelado = false;
    for (const enlace of lista) {
      if (enlace.captura_estado !== 'ok' || !enlace.imagen_s3_key) continue;
      if (miniaturasPedidas.current.has(enlace.id_enlace)) continue;
      miniaturasPedidas.current.add(enlace.id_enlace);
      void (async () => {
        try {
          const res = await apiFetch(
            `/api/tareas/${encodeURIComponent(idTarea)}/enlaces/${encodeURIComponent(enlace.id_enlace)}/imagen`,
          );
          const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
          if (cancelado) {
            miniaturasPedidas.current.delete(enlace.id_enlace);
            return;
          }
          if (!res.ok || !data.url) {
            miniaturasPedidas.current.delete(enlace.id_enlace);
            return;
          }
          setMiniaturas((prev) => ({ ...prev, [enlace.id_enlace]: data.url as string }));
        } catch {
          // El endpoint de imagen puede no estar desplegado todavía: sin miniatura.
          miniaturasPedidas.current.delete(enlace.id_enlace);
        }
      })();
    }
    return () => {
      cancelado = true;
    };
  }, [lista, idTarea]);

  const anadir = useCallback(async () => {
    const url = normalizarUrlExterna(urlNueva);
    if (!url) {
      setError('Pega una URL http:// o https:// válida');
      return;
    }
    setEnCurso('nuevo');
    setError(null);
    try {
      const res = await apiFetch(`/api/tareas/${encodeURIComponent(idTarea)}/enlaces`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      const data = (await res.json().catch(() => ({}))) as { enlace?: EnlaceTarea; error?: string };
      if (!res.ok || !data.enlace) {
        setError(data.error || 'No se pudo añadir el enlace');
        return;
      }
      onEnlacesCambiados([...lista, data.enlace]);
      setUrlNueva('');
      if (data.enlace.captura_estado === 'pendiente') onPedirRefrescoCaptura();
    } catch (e) {
      console.error('[tasks] fallo al añadir enlace', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setEnCurso(null);
    }
  }, [urlNueva, idTarea, lista, onEnlacesCambiados, onPedirRefrescoCaptura]);

  const recapturar = useCallback(
    async (enlaceId: string) => {
      setEnCurso(enlaceId);
      setError(null);
      try {
        const res = await apiFetch(
          `/api/tareas/${encodeURIComponent(idTarea)}/enlaces/${encodeURIComponent(enlaceId)}/recapturar`,
          { method: 'POST' },
        );
        const data = (await res.json().catch(() => ({}))) as { enlace?: EnlaceTarea; error?: string };
        if (!res.ok || !data.enlace) {
          setError(data.error || 'No se pudo recapturar el enlace');
          return;
        }
        miniaturasPedidas.current.delete(enlaceId);
        setMiniaturas((prev) => {
          const { [enlaceId]: _quitada, ...resto } = prev;
          return resto;
        });
        onEnlacesCambiados(lista.map((e) => (e.id_enlace === enlaceId ? data.enlace! : e)));
        if (data.enlace.captura_estado === 'pendiente') onPedirRefrescoCaptura();
      } catch (e) {
        console.error('[tasks] fallo al recapturar enlace', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setEnCurso(null);
      }
    },
    [idTarea, lista, onEnlacesCambiados, onPedirRefrescoCaptura],
  );

  const borrar = useCallback(
    async (enlaceId: string) => {
      const confirmar = async () => {
        setEnCurso(enlaceId);
        setError(null);
        try {
          const res = await apiFetch(
            `/api/tareas/${encodeURIComponent(idTarea)}/enlaces/${encodeURIComponent(enlaceId)}`,
            { method: 'DELETE' },
          );
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) {
            setError(data.error || 'No se pudo borrar el enlace');
            return;
          }
          onEnlacesCambiados(lista.filter((e) => e.id_enlace !== enlaceId));
          setMiniaturas((prev) => {
            const { [enlaceId]: _quitada, ...resto } = prev;
            return resto;
          });
        } catch (e) {
          console.error('[tasks] fallo al borrar enlace', e);
          setError(errorMessage(e, 'No se pudo conectar con el servidor'));
        } finally {
          setEnCurso(null);
        }
      };

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        if (!window.confirm('¿Borrar este enlace?')) return;
        await confirmar();
        return;
      }
      Alert.alert('Borrar enlace', '¿Borrar este enlace?', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Borrar', style: 'destructive', onPress: () => void confirmar() },
      ]);
    },
    [idTarea, lista, onEnlacesCambiados],
  );

  const abrir = useCallback(async (url: string) => {
    const res = await abrirEnlaceExterno(url);
    if (!res.ok) setError(res.error);
  }, []);

  return (
    <SeccionFicha
      titulo="Enlaces"
      icono="link"
      contador={lista.length > 0 ? lista.length : undefined}
    >
      <View style={styles.lista}>
        {lista.map((enlace) => {
          const precio = formatoPrecio(enlace.precio, enlace.moneda);
          const titulo = enlace.titulo?.trim() || hostDeUrl(enlace.url, enlace.url_host);
          const host = hostDeUrl(enlace.url, enlace.url_host);
          const mini = miniaturas[enlace.id_enlace];
          const ocupado = enCurso === enlace.id_enlace;

          return (
            <View key={enlace.id_enlace} style={styles.tarjeta}>
              <TouchableOpacity
                style={styles.tarjetaCuerpo}
                onPress={() => void abrir(enlace.url)}
                accessibilityLabel={`Abrir enlace ${titulo}`}
              >
                {enlace.captura_estado === 'ok' && mini ? (
                  <Image source={{ uri: mini }} style={styles.mini} resizeMode="cover" />
                ) : (
                  <View style={styles.miniPlaceholder}>
                    {enlace.captura_estado === 'pendiente' ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <MaterialIcons
                        name={enlace.captura_estado === 'fallida' ? 'broken-image' : 'language'}
                        size={22}
                        color="#94a3b8"
                      />
                    )}
                  </View>
                )}
                <View style={styles.tarjetaTexto}>
                  <Text style={styles.titulo} numberOfLines={2}>
                    {titulo}
                  </Text>
                  <Text style={styles.host} numberOfLines={1}>
                    {host}
                  </Text>
                  {precio ? <Text style={styles.precio}>{precio}</Text> : null}
                  {enlace.captura_estado === 'pendiente' ? (
                    <Text style={styles.estadoPendiente}>Capturando…</Text>
                  ) : null}
                  {enlace.captura_estado === 'fallida' ? (
                    <Text style={styles.estadoFallida} numberOfLines={3}>
                      {enlace.captura_error?.trim() || 'No se pudo capturar el enlace'}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>

              <View style={styles.tarjetaAcciones}>
                {puedeEditar ? (
                  <TouchableOpacity
                    style={[styles.recapturarBtn, isCompact && styles.recapturarBtnTactil]}
                    onPress={() => void recapturar(enlace.id_enlace)}
                    disabled={ocupado}
                    accessibilityLabel="Recapturar"
                  >
                    {ocupado ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <>
                        <MaterialIcons name="refresh" size={14} color="#0ea5e9" />
                        <Text style={styles.recapturarTexto}>Recapturar</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : null}
                {puedeEditar ? (
                  <TouchableOpacity
                    style={[styles.iconoBtn, isCompact && styles.iconoBtnTactil]}
                    onPress={() => void borrar(enlace.id_enlace)}
                    disabled={ocupado}
                    accessibilityLabel="Borrar enlace"
                  >
                    <MaterialIcons name="delete-outline" size={16} color="#d97706" />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          );
        })}

        {lista.length === 0 ? (
          <Text style={styles.vacio}>
            {puedeEditar
              ? 'Pega un enlace de producto o referencia para capturarlo.'
              : 'No hay enlaces en esta tarea.'}
          </Text>
        ) : null}

        {puedeEditar ? (
          <View style={styles.filaNuevo}>
            <TextInput
              style={[form.input, styles.inputUrl]}
              value={urlNueva}
              onChangeText={setUrlNueva}
              placeholder="https://…"
              placeholderTextColor="#94a3b8"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={enCurso !== 'nuevo'}
              onSubmitEditing={() => void anadir()}
              returnKeyType="done"
            />
            <TouchableOpacity
              style={[styles.primarioBtn, isCompact && styles.primarioBtnTactil]}
              onPress={() => void anadir()}
              disabled={enCurso === 'nuevo' || !urlNueva.trim()}
            >
              {enCurso === 'nuevo' ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <MaterialIcons name="add" size={16} color="#ffffff" />
                  <Text style={styles.primarioTexto}>Añadir</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </SeccionFicha>
  );
}

const styles = StyleSheet.create({
  lista: { gap: 8 },
  vacio: { fontSize: 12, color: '#94a3b8', lineHeight: 18 },
  tarjeta: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  tarjetaCuerpo: { flex: 1, flexDirection: 'row', gap: 10, minWidth: 0 },
  mini: { width: 56, height: 56, borderRadius: 8, backgroundColor: '#e2e8f0' },
  miniPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tarjetaTexto: { flex: 1, minWidth: 0, gap: 2 },
  titulo: { fontSize: 13, fontWeight: '600', color: '#334155', lineHeight: 18 },
  host: { fontSize: 11, color: '#94a3b8' },
  precio: { fontSize: 12, fontWeight: '700', color: '#0f172a', marginTop: 2 },
  estadoPendiente: { fontSize: 11, fontWeight: '600', color: '#0ea5e9', marginTop: 2 },
  estadoFallida: { fontSize: 11, color: '#b45309', marginTop: 2, lineHeight: 15 },
  tarjetaAcciones: { flexDirection: 'column', gap: 4, alignItems: 'flex-end' },
  iconoBtn: {
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  iconoBtnTactil: {
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recapturarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  recapturarBtnTactil: { minHeight: MIN_TOUCH },
  recapturarTexto: { fontSize: 11, fontWeight: '600', color: '#0ea5e9' },
  filaNuevo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputUrl: { flex: 1 },
  primarioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  primarioBtnTactil: { minHeight: MIN_TOUCH },
  primarioTexto: { fontSize: 13, fontWeight: '700', color: '#ffffff' },
  error: { fontSize: 12, color: '#ef4444', lineHeight: 17 },
});
