/**
 * Zona «Audio / transcripción» de la ficha de reunión: aviso de grabación,
 * subida por URL prefirmada (presign → PUT a S3 → procesar), importación de
 * texto (pegar o .txt) y lectura de `audio_*` / `pipeline_*`.
 *
 * Subir audio exige aviso; importar transcripción no.
 * En web usa `input type="file"`; en nativo, document picker.
 * El PUT a S3 va con `fetch` directo, igual que en adjuntos de tarea.
 */
import { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { SeccionFicha, type VarianteSeccionFicha } from './SeccionFicha';
import {
  ETIQUETA_ESTADO_AUDIO,
  ETIQUETA_ESTADO_PIPELINE,
  ETIQUETA_ORIGEN_AUDIO,
  capturaYaIniciada,
  pipelineEnVuelo,
} from '../../lib/tasksUi';
import { apiFetch, errorMessage } from '../../utils/api';
import { tamanoLegible } from '../../lib/banca';
import type {
  EstadoAudio,
  EstadoPipeline,
  OrigenAudio,
  Reunion,
} from '../../types/tasks';

/** Tope blando alineado con el default de `REUNIONES_MAX_AUDIO_MB` (API). */
const MAX_BYTES_AUDIO = 500 * 1024 * 1024;

/** Alineado con `MAX_CHARS` del endpoint de importar transcripción. */
const MAX_CHARS_TRANSCRIPCION = 500_000;

const ACCEPT_WEB = 'audio/*,.mp3,.m4a,.mp4,.wav,.ogg,.opus,.webm,.flac';
const ACCEPT_TXT_WEB = '.txt,text/plain';

const MIME_NATIVO = [
  'audio/*',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/flac',
] as const;

const MIME_TXT_NATIVO = ['text/plain', 'text/*'] as const;

const MIME_POR_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

function mimeDeNombre(nombre: string, declarado?: string | null): string {
  const limpio = (declarado || '').trim().toLowerCase();
  if (limpio && limpio !== 'application/octet-stream') return limpio;
  const ext = nombre.includes('.') ? `.${nombre.split('.').pop()!.toLowerCase()}` : '';
  return MIME_POR_EXTENSION[ext] || 'audio/mpeg';
}

function avisoAceptado(reunion: Reunion): boolean {
  const aviso = reunion.aviso_grabacion;
  return !!(aviso?.aceptado_en && aviso?.aceptado_por);
}

type FicheroAudio = {
  nombre: string;
  contentType: string;
  tamano: number;
  cuerpo: Blob | ArrayBuffer;
};

export function SeccionAudioReunion({
  idReunion,
  reunion,
  puedeEditar,
  onPedirAviso,
  onProcesado,
  variante = 'normal',
}: {
  idReunion: string;
  reunion: Reunion;
  puedeEditar: boolean;
  /** Abre el modal de aviso de grabación de la ficha. */
  onPedirAviso: () => void;
  /** Tras procesar audio o importar texto: refrescar la ficha. */
  onProcesado: (reunion?: Reunion) => void;
  variante?: VarianteSeccionFicha;
}) {
  const { isCompact } = useBreakpoint();
  const [subiendo, setSubiendo] = useState(false);
  const [faseSubida, setFaseSubida] = useState<string | null>(null);
  const [importando, setImportando] = useState(false);
  const [textoImport, setTextoImport] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tieneAviso = avisoAceptado(reunion);
  const yaIniciado = capturaYaIniciada(reunion);
  const ocupado = subiendo || importando;
  const puedeSubir = puedeEditar && tieneAviso && !yaIniciado;
  const puedeImportar = puedeEditar && !yaIniciado;

  const audioEstado = (reunion.audio_estado ?? 'ausente') as EstadoAudio;
  const pipelineEstado = reunion.pipeline_estado as EstadoPipeline | undefined;
  const origen = reunion.origen_audio as OrigenAudio | undefined;
  const esImportada = origen === 'transcripcion_importada';

  const subirAudio = useCallback(
    async (fichero: FicheroAudio) => {
      if (fichero.tamano > MAX_BYTES_AUDIO) {
        throw new Error(`El audio supera el máximo de 500 MB (${tamanoLegible(fichero.tamano)})`);
      }

      setFaseSubida('Preparando subida…');
      const presignRes = await apiFetch(
        `/api/reuniones/${encodeURIComponent(idReunion)}/audio/presign`,
        {
          method: 'POST',
          body: JSON.stringify({
            nombre: fichero.nombre,
            contentType: fichero.contentType,
            tamano: fichero.tamano,
          }),
        },
      );
      const presignData = (await presignRes.json().catch(() => ({}))) as {
        ok?: boolean;
        audio?: {
          s3_key: string;
          content_type: string;
          upload_url: string;
          expira_en_seg?: number;
        };
        error?: string;
      };
      if (!presignRes.ok || !presignData.audio?.upload_url || !presignData.audio.s3_key) {
        throw new Error(presignData.error || 'No se pudo preparar la subida del audio');
      }

      const contentTypeFirmado =
        (presignData.audio.content_type || '').trim() || fichero.contentType;
      setFaseSubida('Subiendo audio…');
      const putRes = await fetch(presignData.audio.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': contentTypeFirmado },
        body: fichero.cuerpo as BodyInit,
      });
      if (!putRes.ok) {
        throw new Error('No se pudo subir el audio al almacenamiento');
      }

      setFaseSubida('Confirmando procesado…');
      const procRes = await apiFetch(`/api/reuniones/${encodeURIComponent(idReunion)}/procesar`, {
        method: 'POST',
        body: JSON.stringify({ s3_key: presignData.audio.s3_key }),
      });
      const procData = (await procRes.json().catch(() => ({}))) as {
        ok?: boolean;
        ya_iniciado?: boolean;
        reunion?: Reunion;
        error?: string;
      };
      if (!procRes.ok) {
        throw new Error(procData.error || 'No se pudo iniciar el procesado del audio');
      }
      onProcesado(procData.reunion);
    },
    [idReunion, onProcesado],
  );

  const elegirYSubir = useCallback(async () => {
    if (!puedeSubir || ocupado) return;
    setError(null);

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPT_WEB;
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const pendiente: FicheroAudio = {
          nombre: file.name,
          contentType: mimeDeNombre(file.name, file.type),
          tamano: file.size,
          cuerpo: file,
        };
        setSubiendo(true);
        setFaseSubida(null);
        void subirAudio(pendiente)
          .catch((e) => {
            console.error('[reuniones] fallo al subir audio', e);
            setError(e instanceof Error ? e.message : 'No se pudo subir el audio');
          })
          .finally(() => {
            setSubiendo(false);
            setFaseSubida(null);
          });
      };
      input.click();
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [...MIME_NATIVO],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const nombre = asset.name || 'audio.m4a';
      const res = await fetch(asset.uri);
      const blob = await res.blob();
      setSubiendo(true);
      setFaseSubida(null);
      await subirAudio({
        nombre,
        contentType: mimeDeNombre(nombre, asset.mimeType || blob.type),
        tamano: asset.size ?? blob.size,
        cuerpo: blob,
      });
    } catch (e) {
      console.error('[reuniones] fallo al elegir o subir audio', e);
      setError(errorMessage(e, 'No se pudo abrir el selector de audio'));
    } finally {
      setSubiendo(false);
      setFaseSubida(null);
    }
  }, [puedeSubir, ocupado, subirAudio]);

  const cargarTextoDesdeArchivo = useCallback(async (texto: string, nombre?: string) => {
    const limpio = String(texto ?? '');
    if (!limpio.trim()) {
      setError('El fichero está vacío.');
      return;
    }
    if (limpio.length > MAX_CHARS_TRANSCRIPCION) {
      setError(
        `La transcripción supera el máximo de ${MAX_CHARS_TRANSCRIPCION.toLocaleString('es-ES')} caracteres` +
          (nombre ? ` (${nombre})` : ''),
      );
      return;
    }
    setError(null);
    setTextoImport(limpio);
  }, []);

  const elegirTxt = useCallback(async () => {
    if (!puedeImportar || ocupado) return;
    setError(null);

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPT_TXT_WEB;
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        void file
          .text()
          .then((t) => cargarTextoDesdeArchivo(t, file.name))
          .catch((e) => {
            console.error('[reuniones] fallo al leer .txt', e);
            setError('No se pudo leer el fichero de texto');
          });
      };
      input.click();
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [...MIME_TXT_NATIVO],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const res = await fetch(asset.uri);
      const texto = await res.text();
      await cargarTextoDesdeArchivo(texto, asset.name);
    } catch (e) {
      console.error('[reuniones] fallo al elegir .txt', e);
      setError(errorMessage(e, 'No se pudo abrir el selector de texto'));
    }
  }, [puedeImportar, ocupado, cargarTextoDesdeArchivo]);

  const importarTranscripcion = useCallback(async () => {
    if (!puedeImportar || ocupado) return;
    const texto = textoImport.trim();
    if (!texto) {
      setError('Pega o carga el texto de la transcripción.');
      return;
    }
    if (texto.length > MAX_CHARS_TRANSCRIPCION) {
      setError(
        `La transcripción supera el máximo de ${MAX_CHARS_TRANSCRIPCION.toLocaleString('es-ES')} caracteres`,
      );
      return;
    }

    setError(null);
    setImportando(true);
    try {
      const res = await apiFetch(
        `/api/reuniones/${encodeURIComponent(idReunion)}/transcripcion/importar`,
        {
          method: 'POST',
          body: JSON.stringify({ texto }),
          timeoutMs: 120000,
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        ya_iniciado?: boolean;
        reunion?: Reunion;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'No se pudo importar la transcripción');
      }
      setTextoImport('');
      onProcesado(data.reunion);
    } catch (e) {
      console.error('[reuniones] fallo al importar transcripción', e);
      setError(e instanceof Error ? e.message : 'No se pudo importar la transcripción');
    } finally {
      setImportando(false);
    }
  }, [puedeImportar, ocupado, textoImport, idReunion, onProcesado]);

  const enVuelo = pipelineEnVuelo(pipelineEstado);
  const etiquetaPipeline = pipelineEstado
    ? ETIQUETA_ESTADO_PIPELINE[pipelineEstado] ?? pipelineEstado
    : null;

  return (
    <SeccionFicha
      titulo="Audio / transcripción"
      icono="graphic-eq"
      variante={variante}
      accion={
        puedeSubir
          ? {
              etiqueta: subiendo ? 'Subiendo…' : 'Subir audio',
              icono: 'upload-file',
              onPress: () => void elegirYSubir(),
              deshabilitada: ocupado,
            }
          : undefined
      }
    >
      <View style={styles.bloque}>
        <View style={styles.filaEstado}>
          <MaterialIcons
            name={tieneAviso ? 'verified' : 'mic-off'}
            size={16}
            color={tieneAviso ? '#16a34a' : '#d97706'}
          />
          <Text style={styles.textoEstado}>
            {tieneAviso
              ? 'Aviso de grabación aceptado.'
              : 'Sin aviso de grabación: no se puede subir audio (sí importar texto).'}
          </Text>
        </View>

        {!tieneAviso && puedeEditar && !yaIniciado ? (
          <TouchableOpacity
            style={[styles.btnSecundario, isCompact && styles.btnTactil]}
            onPress={onPedirAviso}
            accessibilityLabel="Registrar aviso de grabación"
          >
            <MaterialIcons name="how-to-reg" size={16} color="#0ea5e9" />
            <Text style={styles.btnSecundarioTexto}>Registrar aviso</Text>
          </TouchableOpacity>
        ) : null}

        {!tieneAviso && !puedeEditar ? (
          <Text style={styles.ayuda}>
            Quien gestiona la reunión debe registrar el aviso antes de poder subir el audio.
          </Text>
        ) : null}

        {enVuelo ? (
          <View style={styles.bannerVivo}>
            <ActivityIndicator size="small" color="#0ea5e9" />
            <Text style={styles.bannerVivoTexto}>
              {etiquetaPipeline || 'Procesando…'}
            </Text>
          </View>
        ) : null}

        {yaIniciado && !enVuelo && pipelineEstado !== 'error' ? (
          <View style={styles.bannerInfo}>
            <MaterialIcons name="check-circle-outline" size={16} color="#0369a1" />
            <Text style={styles.bannerInfoTexto}>
              {esImportada
                ? 'Ya hay una transcripción importada; no se puede subir audio ni importar otra.'
                : 'Ya hay audio o transcripción en esta reunión; no se puede subir otro fichero ni importar texto.'}
            </Text>
          </View>
        ) : null}

        <View style={styles.datos}>
          <DatoEtiqueta
            etiqueta="Audio"
            valor={ETIQUETA_ESTADO_AUDIO[audioEstado] ?? audioEstado}
          />
          {origen ? (
            <DatoEtiqueta
              etiqueta="Origen"
              valor={ETIQUETA_ORIGEN_AUDIO[origen] ?? origen}
            />
          ) : null}
          {pipelineEstado ? (
            <DatoEtiqueta etiqueta="Procesado" valor={etiquetaPipeline || pipelineEstado} />
          ) : audioEstado === 'ausente' && !yaIniciado ? (
            <DatoEtiqueta etiqueta="Procesado" valor="Sin iniciar" />
          ) : null}
        </View>

        {pipelineEstado === 'error' ? (
          <View style={styles.bannerError}>
            <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
            <Text style={styles.bannerErrorTexto}>
              {reunion.pipeline_error_fase
                ? `Fase «${reunion.pipeline_error_fase}»: `
                : ''}
              {reunion.pipeline_error?.trim() || 'Error en el procesado.'}
            </Text>
          </View>
        ) : null}

        {puedeImportar ? (
          <View style={styles.bloqueImport}>
            <Text style={styles.importTitulo}>Importar transcripción</Text>
            <Text style={styles.ayuda}>
              Pega el texto o elige un fichero .txt. No hace falta el aviso de grabación.
            </Text>
            <TextInput
              style={[styles.inputTexto, isCompact && styles.inputTextoCompact]}
              value={textoImport}
              onChangeText={setTextoImport}
              placeholder="Pega aquí la transcripción…"
              placeholderTextColor="#94a3b8"
              multiline
              textAlignVertical="top"
              editable={!ocupado}
              accessibilityLabel="Texto de la transcripción"
            />
            <View style={[styles.filaAcciones, isCompact && styles.filaAccionesStack]}>
              <TouchableOpacity
                style={[styles.btnSecundario, isCompact && styles.btnTactil]}
                onPress={() => void elegirTxt()}
                disabled={ocupado}
                accessibilityLabel="Elegir fichero de texto"
              >
                <MaterialIcons name="description" size={16} color="#0ea5e9" />
                <Text style={styles.btnSecundarioTexto}>Elegir .txt</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.btnPrimario,
                  isCompact && styles.btnTactil,
                  (ocupado || !textoImport.trim()) && styles.btnDeshabilitado,
                ]}
                onPress={() => void importarTranscripcion()}
                disabled={ocupado || !textoImport.trim()}
                accessibilityLabel="Importar transcripción"
              >
                {importando ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <MaterialIcons name="upload" size={16} color="#ffffff" />
                )}
                <Text style={styles.btnPrimarioTexto}>
                  {importando ? 'Importando…' : 'Importar'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.privacidad}>
              Privacidad: el texto se enviará a un proveedor externo para generar el acta.
            </Text>
          </View>
        ) : null}

        {subiendo ? (
          <View style={styles.cargando}>
            <ActivityIndicator size="small" color="#0ea5e9" />
            <Text style={styles.cargandoTexto}>{faseSubida || 'Subiendo audio…'}</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {puedeSubir || (!yaIniciado && tieneAviso) ? (
          <Text style={styles.privacidad}>
            Privacidad: el audio se envía a un proveedor externo de STT para transcribirlo.
          </Text>
        ) : null}
      </View>
    </SeccionFicha>
  );
}

function DatoEtiqueta({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <View style={styles.dato}>
      <Text style={styles.datoEtiqueta}>{etiqueta}</Text>
      <Text style={styles.datoValor}>{valor}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bloque: { gap: 10 },
  filaEstado: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  textoEstado: { flex: 1, fontSize: 13, color: '#334155', lineHeight: 18 },
  ayuda: { fontSize: 12, color: '#94a3b8', lineHeight: 17 },
  bloqueImport: {
    gap: 8,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  importTitulo: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  inputTexto: {
    minHeight: 120,
    maxHeight: 240,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#0f172a',
    lineHeight: 18,
  },
  inputTextoCompact: { minHeight: 140 },
  filaAcciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  filaAccionesStack: { flexDirection: 'column', alignItems: 'stretch' },
  btnSecundario: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  btnPrimario: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  btnDeshabilitado: { opacity: 0.5 },
  btnTactil: { minHeight: MIN_TOUCH },
  btnSecundarioTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  btnPrimarioTexto: { fontSize: 12, fontWeight: '700', color: '#ffffff' },
  datos: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  dato: { minWidth: 120, gap: 2 },
  datoEtiqueta: { fontSize: 11, color: '#94a3b8', fontWeight: '500' },
  datoValor: { fontSize: 13, color: '#334155', fontWeight: '600' },
  bannerVivo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  bannerVivoTexto: { flex: 1, fontSize: 12, fontWeight: '600', color: '#0c4a6e', lineHeight: 17 },
  bannerInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  bannerInfoTexto: { flex: 1, fontSize: 12, color: '#0c4a6e', lineHeight: 17 },
  bannerError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  bannerErrorTexto: { flex: 1, fontSize: 12, color: '#991b1b', lineHeight: 17 },
  cargando: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  cargandoTexto: { fontSize: 12, color: '#64748b' },
  error: { fontSize: 12, color: '#ef4444', lineHeight: 17 },
  privacidad: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },
});
