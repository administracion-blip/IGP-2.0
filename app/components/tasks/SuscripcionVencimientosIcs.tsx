/**
 * Genera/rota el token del feed ICS de vencimientos y muestra la URL una vez
 * para que el usuario la pegue en su calendario.
 *
 * Flujo en dos pasos: aviso de rotación → confirmar «Generar o renovar» → POST.
 */
import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { API_BASE_URL } from '../../utils/apiBaseUrl';
import { apiFetch, errorMessage } from '../../utils/api';
import { copyToClipboard } from '../../utils/clipboard';

type Paso = 'confirmar' | 'generando' | 'resultado';

function construirUrlDesdeToken(token: string): string {
  const base = API_BASE_URL.replace(/\/$/, '');
  return `${base}/api/tasks/vencimientos.ics?token=${encodeURIComponent(token)}`;
}

function extraerUrlFeed(data: Record<string, unknown>): string | null {
  for (const clave of ['url', 'feed_url', 'feedUrl', 'ics_url', 'icsUrl'] as const) {
    const v = data[clave];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const token =
    (typeof data.token === 'string' && data.token) ||
    (typeof data.ics_token === 'string' && data.ics_token) ||
    null;
  if (token) return construirUrlDesdeToken(token);
  return null;
}

type Props = {
  /** Estilo táctil más alto en compacto. */
  compacto?: boolean;
};

export function SuscripcionVencimientosIcs({ compacto }: Props) {
  const [visible, setVisible] = useState(false);
  const [paso, setPaso] = useState<Paso>('confirmar');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const abrir = () => {
    setVisible(true);
    setPaso('confirmar');
    setUrl(null);
    setError(null);
    setCopiado(false);
  };

  const cerrar = () => {
    setVisible(false);
    setPaso('confirmar');
    setUrl(null);
    setError(null);
    setCopiado(false);
  };

  const generar = useCallback(async () => {
    setPaso('generando');
    setError(null);
    setUrl(null);
    setCopiado(false);
    try {
      const res = await apiFetch('/api/tasks/vencimientos/token', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(
          typeof data.error === 'string' && data.error
            ? data.error
            : 'No se pudo generar el enlace del calendario',
        );
        setPaso('resultado');
        return;
      }
      const feed = extraerUrlFeed(data);
      if (!feed) {
        setError('El servidor no devolvió la URL del feed. Inténtalo de nuevo más tarde.');
        setPaso('resultado');
        return;
      }
      setUrl(feed);
      setPaso('resultado');
    } catch (e) {
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      setPaso('resultado');
    }
  }, []);

  const copiar = async () => {
    if (!url) return;
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } else {
      setError('No se pudo copiar al portapapeles');
    }
  };

  return (
    <>
      <TouchableOpacity
        style={[styles.trigger, compacto && styles.triggerTactil]}
        onPress={abrir}
        accessibilityLabel="Suscribir vencimientos al calendario"
      >
        <MaterialIcons name="event-available" size={18} color="#0369a1" />
        <Text style={styles.triggerTexto} numberOfLines={1}>
          {compacto ? 'Calendario' : 'Suscribir vencimientos'}
        </Text>
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={cerrar}>
        <Pressable style={styles.overlay} onPress={cerrar}>
          <Pressable
            style={[styles.card, Platform.OS !== 'web' && styles.cardNativo]}
            onPress={() => {}}
          >
            <View style={styles.header}>
              <Text style={styles.titulo}>Añadir a mi calendario</Text>
              <TouchableOpacity
                onPress={cerrar}
                style={styles.cerrar}
                accessibilityLabel="Cerrar"
              >
                <MaterialIcons name="close" size={20} color="#64748b" />
              </TouchableOpacity>
            </View>

            <View style={styles.body}>
              {paso === 'confirmar' ? (
                <>
                  <View style={styles.aviso}>
                    <MaterialIcons name="warning-amber" size={20} color="#b45309" />
                    <Text style={styles.avisoTexto}>
                      Se generará un enlace nuevo para suscribir tus vencimientos. Si ya
                      tenías uno en tu calendario, esa URL anterior dejará de funcionar.
                      Quien tenga el enlace verá tus vencimientos de tareas.
                    </Text>
                  </View>
                  <Text style={styles.pieHint}>
                    En Google Calendar, Outlook o Apple Calendar: suscribirse a un
                    calendario por URL. No hace falta abrir el archivo .ics en el
                    navegador.
                  </Text>
                  <View style={styles.acciones}>
                    <TouchableOpacity
                      style={styles.cancelarBtn}
                      onPress={cerrar}
                      accessibilityLabel="Cancelar"
                    >
                      <Text style={styles.cancelarTexto}>Cancelar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.primarioBtn}
                      onPress={() => void generar()}
                      accessibilityLabel="Generar o renovar enlace"
                    >
                      <MaterialIcons name="autorenew" size={18} color="#ffffff" />
                      <Text style={styles.primarioTexto}>Generar o renovar</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}

              {paso === 'generando' ? (
                <View style={styles.centro}>
                  <ActivityIndicator size="large" color="#0ea5e9" />
                  <Text style={styles.hint}>Generando enlace…</Text>
                </View>
              ) : null}

              {paso === 'resultado' && error && !url ? (
                <View style={styles.centro}>
                  <MaterialIcons name="error-outline" size={28} color="#ef4444" />
                  <Text style={styles.errorTexto}>{error}</Text>
                  <View style={styles.acciones}>
                    <TouchableOpacity style={styles.cancelarBtn} onPress={cerrar}>
                      <Text style={styles.cancelarTexto}>Cerrar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.primarioBtn}
                      onPress={() => void generar()}
                      accessibilityLabel="Reintentar"
                    >
                      <Text style={styles.primarioTexto}>Reintentar</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}

              {paso === 'resultado' && url ? (
                <>
                  <View style={[styles.aviso, styles.avisoOk]}>
                    <MaterialIcons name="info-outline" size={20} color="#0369a1" />
                    <Text style={[styles.avisoTexto, styles.avisoInfo]}>
                      Guarda esta URL ahora: solo se muestra una vez. La anterior, si
                      existía, ya no es válida.
                    </Text>
                  </View>

                  <Text style={styles.label}>URL del feed (cópiala una vez)</Text>
                  <View style={styles.urlBox}>
                    <Text style={styles.urlTexto} selectable>
                      {url}
                    </Text>
                  </View>

                  {error ? <Text style={styles.errorPie}>{error}</Text> : null}

                  <TouchableOpacity
                    style={styles.copiarBtn}
                    onPress={() => void copiar()}
                    accessibilityLabel="Copiar URL"
                  >
                    <MaterialIcons
                      name={copiado ? 'check' : 'content-copy'}
                      size={18}
                      color="#ffffff"
                    />
                    <Text style={styles.copiarTexto}>
                      {copiado ? 'Copiada' : 'Copiar URL'}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#e0f2fe',
  },
  triggerTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 14 },
  triggerTexto: { fontSize: 13, fontWeight: '700', color: '#0369a1' },

  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardNativo: {
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  titulo: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  cerrar: {
    minWidth: MIN_TOUCH - 4,
    minHeight: MIN_TOUCH - 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { padding: 20, gap: 12 },
  centro: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  hint: { fontSize: 13, color: '#64748b' },
  aviso: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  avisoTexto: { flex: 1, fontSize: 13, color: '#92400e', lineHeight: 19 },
  avisoOk: { backgroundColor: '#e0f2fe', borderColor: '#bae6fd' },
  avisoInfo: { color: '#0c4a6e' },
  label: { fontSize: 12, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  urlBox: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  urlTexto: {
    fontSize: 12,
    color: '#334155',
    lineHeight: 18,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  acciones: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  cancelarBtn: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelarTexto: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  primarioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#0ea5e9',
  },
  primarioTexto: { fontSize: 14, fontWeight: '700', color: '#ffffff' },
  copiarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: MIN_TOUCH,
    borderRadius: 10,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 16,
  },
  copiarTexto: { fontSize: 14, fontWeight: '700', color: '#ffffff' },
  pieHint: { fontSize: 12, color: '#64748b', lineHeight: 17 },
  errorTexto: { fontSize: 13, color: '#ef4444', textAlign: 'center' },
  errorPie: { fontSize: 12, color: '#ef4444' },
});
