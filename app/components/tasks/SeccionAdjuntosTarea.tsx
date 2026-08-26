/**
 * Zona de adjuntos de una tarea: subida por URL prefirmada (presign → PUT a S3
 * → confirmar), abrir con URL firmada y borrar si se puede editar.
 *
 * En web usa un `input type="file"`; en nativo, `expo-document-picker`. El PUT
 * a S3 va con `fetch` directo, igual que en acuerdos.
 */
import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { SeccionFicha } from './SeccionFicha';
import { apiFetch, errorMessage } from '../../utils/api';
import { abrirEnlaceExterno } from '../../utils/enlaceExterno';
import { tamanoLegible } from '../../lib/banca';
import type { AdjuntoTarea } from '../../types/tasks';

const MAX_BYTES_ADJUNTO = 25 * 1024 * 1024;
const ACCEPT_WEB =
  '.pdf,.jpg,.jpeg,.png,.webp,.gif,.heic,.txt,.csv,.doc,.docx,.xls,.xlsx';
const MIME_NATIVO = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '*/*',
] as const;

const MIME_POR_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mimeDeNombre(nombre: string, declarado?: string | null): string {
  const limpio = (declarado || '').trim();
  if (limpio && limpio !== 'application/octet-stream') return limpio;
  const ext = nombre.includes('.') ? `.${nombre.split('.').pop()!.toLowerCase()}` : '';
  return MIME_POR_EXTENSION[ext] || 'application/octet-stream';
}

type FicheroPendiente = {
  nombre: string;
  contentType: string;
  tamano: number;
  cuerpo: Blob | ArrayBuffer;
};

export function SeccionAdjuntosTarea({
  idTarea,
  adjuntos,
  puedeEditar,
  onAdjuntosCambiados,
}: {
  idTarea: string;
  adjuntos: AdjuntoTarea[];
  puedeEditar: boolean;
  onAdjuntosCambiados: (siguiente: AdjuntoTarea[]) => void;
}) {
  const { isCompact } = useBreakpoint();
  const [subiendo, setSubiendo] = useState(false);
  const [enCurso, setEnCurso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lista = adjuntos ?? [];

  const subirUno = useCallback(
    async (fichero: FicheroPendiente) => {
      if (fichero.tamano > MAX_BYTES_ADJUNTO) {
        throw new Error(`«${fichero.nombre}» supera el máximo de 25 MB`);
      }
      const presignRes = await apiFetch(`/api/tareas/${encodeURIComponent(idTarea)}/adjuntos/presign`, {
        method: 'POST',
        body: JSON.stringify({
          nombre: fichero.nombre,
          content_type: fichero.contentType,
          tamano: fichero.tamano,
        }),
      });
      const presignData = (await presignRes.json().catch(() => ({}))) as {
        adjunto?: {
          id_adjunto: string;
          s3_key: string;
          nombre: string;
          content_type: string;
          upload_url: string;
        };
        error?: string;
      };
      if (!presignRes.ok || !presignData.adjunto?.upload_url || !presignData.adjunto.s3_key) {
        throw new Error(presignData.error || `No se pudo preparar la subida de «${fichero.nombre}»`);
      }

      const contentTypeFirmado =
        (presignData.adjunto.content_type || '').trim() || fichero.contentType;
      const putRes = await fetch(presignData.adjunto.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': contentTypeFirmado },
        body: fichero.cuerpo as BodyInit,
      });
      if (!putRes.ok) {
        throw new Error(`No se pudo subir «${fichero.nombre}» al almacenamiento`);
      }

      const confRes = await apiFetch(`/api/tareas/${encodeURIComponent(idTarea)}/adjuntos/confirmar`, {
        method: 'POST',
        body: JSON.stringify({
          s3_key: presignData.adjunto.s3_key,
          nombre: fichero.nombre,
        }),
      });
      const confData = (await confRes.json().catch(() => ({}))) as {
        adjunto?: AdjuntoTarea;
        error?: string;
      };
      if (!confRes.ok || !confData.adjunto) {
        throw new Error(confData.error || `No se pudo confirmar «${fichero.nombre}»`);
      }
      return confData.adjunto;
    },
    [idTarea],
  );

  const procesarFicheros = useCallback(
    async (ficheros: FicheroPendiente[]) => {
      if (ficheros.length === 0) return;
      setSubiendo(true);
      setError(null);
      const anadidos: AdjuntoTarea[] = [];
      const fallos: string[] = [];
      try {
        for (const fichero of ficheros) {
          try {
            anadidos.push(await subirUno(fichero));
          } catch (e) {
            fallos.push(e instanceof Error ? e.message : `Error con «${fichero.nombre}»`);
          }
        }
        if (anadidos.length > 0) {
          onAdjuntosCambiados([...lista, ...anadidos]);
        }
        if (fallos.length > 0) {
          setError(fallos.join('\n'));
        }
      } finally {
        setSubiendo(false);
      }
    },
    [lista, onAdjuntosCambiados, subirUno],
  );

  const adjuntar = useCallback(async () => {
    setError(null);
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = ACCEPT_WEB;
      input.onchange = () => {
        const files = input.files;
        if (!files || files.length === 0) return;
        const pendientes: FicheroPendiente[] = [];
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          pendientes.push({
            nombre: file.name,
            contentType: mimeDeNombre(file.name, file.type),
            tamano: file.size,
            cuerpo: file,
          });
        }
        void procesarFicheros(pendientes);
      };
      input.click();
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [...MIME_NATIVO],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const pendientes: FicheroPendiente[] = [];
      for (const asset of result.assets) {
        const nombre = asset.name || 'adjunto';
        const res = await fetch(asset.uri);
        const blob = await res.blob();
        pendientes.push({
          nombre,
          contentType: mimeDeNombre(nombre, asset.mimeType || blob.type),
          tamano: asset.size ?? blob.size,
          cuerpo: blob,
        });
      }
      await procesarFicheros(pendientes);
    } catch (e) {
      console.error('[tasks] fallo al elegir adjunto', e);
      setError(errorMessage(e, 'No se pudo abrir el selector de archivos'));
    }
  }, [procesarFicheros]);

  const abrir = useCallback(
    async (adjuntoId: string) => {
      setEnCurso(adjuntoId);
      setError(null);
      try {
        const res = await apiFetch(
          `/api/tareas/${encodeURIComponent(idTarea)}/adjuntos/${encodeURIComponent(adjuntoId)}/url`,
        );
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) {
          setError(data.error || 'No se pudo obtener el enlace del adjunto');
          return;
        }
        const abierto = await abrirEnlaceExterno(data.url);
        if (!abierto.ok) setError(abierto.error);
      } catch (e) {
        console.error('[tasks] fallo al abrir adjunto', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setEnCurso(null);
      }
    },
    [idTarea],
  );

  const borrar = useCallback(
    async (adjuntoId: string) => {
      const confirmar = async () => {
        setEnCurso(adjuntoId);
        setError(null);
        try {
          const res = await apiFetch(
            `/api/tareas/${encodeURIComponent(idTarea)}/adjuntos/${encodeURIComponent(adjuntoId)}`,
            { method: 'DELETE' },
          );
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) {
            setError(data.error || 'No se pudo borrar el adjunto');
            return;
          }
          onAdjuntosCambiados(lista.filter((a) => a.id_adjunto !== adjuntoId));
        } catch (e) {
          console.error('[tasks] fallo al borrar adjunto', e);
          setError(errorMessage(e, 'No se pudo conectar con el servidor'));
        } finally {
          setEnCurso(null);
        }
      };

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        if (!window.confirm('¿Borrar este adjunto?')) return;
        await confirmar();
        return;
      }
      Alert.alert('Borrar adjunto', '¿Borrar este adjunto?', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Borrar', style: 'destructive', onPress: () => void confirmar() },
      ]);
    },
    [idTarea, lista, onAdjuntosCambiados],
  );

  return (
    <SeccionFicha
      titulo="Adjuntos"
      icono="attach-file"
      contador={lista.length > 0 ? lista.length : undefined}
      accion={
        puedeEditar
          ? {
              etiqueta: subiendo ? 'Subiendo…' : 'Adjuntar',
              icono: 'upload-file',
              onPress: () => void adjuntar(),
              deshabilitada: subiendo,
            }
          : undefined
      }
    >
      <View style={styles.lista}>
        {lista.length === 0 ? (
          <Text style={styles.vacio}>No hay archivos adjuntos.</Text>
        ) : (
          lista.map((adj) => {
            const ocupado = enCurso === adj.id_adjunto || subiendo;
            return (
              <View key={adj.id_adjunto} style={styles.fila}>
                <TouchableOpacity
                  style={styles.filaCuerpo}
                  onPress={() => void abrir(adj.id_adjunto)}
                  disabled={enCurso === adj.id_adjunto}
                  accessibilityLabel={`Abrir ${adj.nombre}`}
                >
                  <MaterialIcons name="insert-drive-file" size={18} color="#0ea5e9" />
                  <View style={styles.filaTexto}>
                    <Text style={styles.nombre} numberOfLines={2}>
                      {adj.nombre}
                    </Text>
                    <Text style={styles.meta}>{tamanoLegible(adj.tamano)}</Text>
                  </View>
                  {enCurso === adj.id_adjunto ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <MaterialIcons name="open-in-new" size={16} color="#94a3b8" />
                  )}
                </TouchableOpacity>
                {puedeEditar ? (
                  <TouchableOpacity
                    style={[styles.iconoBtn, isCompact && styles.iconoBtnTactil]}
                    onPress={() => void borrar(adj.id_adjunto)}
                    disabled={ocupado}
                    accessibilityLabel="Borrar adjunto"
                  >
                    <MaterialIcons name="delete-outline" size={16} color="#d97706" />
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </SeccionFicha>
  );
}

const styles = StyleSheet.create({
  lista: { gap: 6 },
  vacio: { fontSize: 12, color: '#94a3b8', lineHeight: 18 },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    paddingVertical: 4,
  },
  filaCuerpo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    paddingVertical: 4,
  },
  filaTexto: { flex: 1, minWidth: 0 },
  nombre: { fontSize: 13, fontWeight: '600', color: '#0ea5e9', lineHeight: 18 },
  meta: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  iconoBtn: {
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  iconoBtnTactil: {
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: { fontSize: 12, color: '#ef4444', lineHeight: 17, marginTop: 4 },
});
