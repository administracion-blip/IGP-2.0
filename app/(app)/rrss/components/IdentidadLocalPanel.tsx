import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../../../utils/api';
import type { ToastType } from '../../../components/Toast';
import { EstiloVisualImagenesEditor } from './EstiloVisualImagenesEditor';

const MAX_CHARS = 1000;
const MAX_WEB_URL_CHARS = 2048;

function normalizarKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    const k = String(x ?? '').trim();
    if (k && !out.includes(k)) out.push(k);
    if (out.length >= 3) break;
  }
  return out;
}

function keysIgual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export type IdentidadLocalPanelProps = {
  /** id_local normalizado (6 dígitos) o cadena vacía para ocultar */
  idLocal: string;
  nombreLocal?: string;
  /** true si puede guardar (gestor marketing o usuario con ese local asignado) */
  puedeEditar: boolean;
  showToast: (titulo: string, msg: string, tipo?: ToastType) => void;
  /** Tras guardar, refrescar lista de locales en el padre */
  onGuardado?: () => void;
};

/**
 * Identidad visual del local: brief, imágenes de referencia y URL web (`igp_Locales`).
 */
export function IdentidadLocalPanel({
  idLocal,
  nombreLocal,
  puedeEditar,
  showToast,
  onGuardado,
}: IdentidadLocalPanelProps) {
  const [texto, setTexto] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [web, setWeb] = useState('');
  const [guardadoBrief, setGuardadoBrief] = useState('');
  const [guardadoKeys, setGuardadoKeys] = useState<string[]>([]);
  const [guardadoWeb, setGuardadoWeb] = useState('');
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!idLocal) {
      setTexto('');
      setKeys([]);
      setWeb('');
      setGuardadoBrief('');
      setGuardadoKeys([]);
      setGuardadoWeb('');
      return;
    }
    let cancelled = false;
    setCargando(true);
    apiFetch(`/api/marketing/locales/${idLocal}/estilo`)
      .then((res) => res.json())
      .then(
        (data: {
          estilo_visual_brief?: string;
          estilo_visual_imagen_keys?: string[];
          web?: string;
          error?: string;
        }) => {
          if (cancelled) return;
          if (data.error) {
            setTexto('');
            setKeys([]);
            setWeb('');
            setGuardadoBrief('');
            setGuardadoKeys([]);
            setGuardadoWeb('');
            return;
          }
          const b = String(data.estilo_visual_brief ?? '').slice(0, MAX_CHARS);
          const k = normalizarKeys(data.estilo_visual_imagen_keys);
          const w = String(data.web ?? '').slice(0, MAX_WEB_URL_CHARS);
          setTexto(b);
          setKeys(k);
          setWeb(w);
          setGuardadoBrief(b);
          setGuardadoKeys(k);
          setGuardadoWeb(w);
        },
      )
      .catch(() => {
        if (!cancelled) {
          setTexto('');
          setKeys([]);
          setWeb('');
          setGuardadoBrief('');
          setGuardadoKeys([]);
          setGuardadoWeb('');
        }
      })
      .finally(() => {
        if (!cancelled) setCargando(false);
      });
    return () => {
      cancelled = true;
    };
  }, [idLocal]);

  async function guardar() {
    if (!idLocal || !puedeEditar) return;
    setGuardando(true);
    try {
      const body = {
        estilo_visual_brief: texto.trim().slice(0, MAX_CHARS),
        estilo_visual_imagen_keys: keys,
        web: web.trim().slice(0, MAX_WEB_URL_CHARS),
      };
      const res = await apiFetch(`/api/marketing/locales/${idLocal}/estilo`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string; web?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo guardar');
      const b = texto.trim().slice(0, MAX_CHARS);
      const k = normalizarKeys(keys);
      const w = String(data.web ?? web.trim()).slice(0, MAX_WEB_URL_CHARS);
      setGuardadoBrief(b);
      setGuardadoKeys(k);
      setGuardadoWeb(w);
      setWeb(w);
      setKeys(k);
      showToast('Identidad visual', 'Guardado correctamente.', 'success');
      onGuardado?.();
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error desconocido', 'error');
    } finally {
      setGuardando(false);
    }
  }

  async function abrirWeb(url: string) {
    const u = url.trim();
    if (!u) return;
    try {
      const ok = await Linking.canOpenURL(u);
      if (ok) await Linking.openURL(u);
      else showToast('Web', 'No se puede abrir esta URL.', 'warning');
    } catch {
      showToast('Web', 'No se pudo abrir el enlace.', 'warning');
    }
  }

  if (!idLocal) return null;

  const tituloLocal = nombreLocal?.trim() || `Local ${idLocal}`;
  const hayCambios =
    puedeEditar &&
    (texto.trim() !== guardadoBrief.trim() ||
      !keysIgual(keys, guardadoKeys) ||
      web.trim() !== guardadoWeb.trim());

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <MaterialIcons name="palette" size={20} color="#0369a1" />
        <View style={styles.headerText}>
          <Text style={styles.title}>Identidad visual del local</Text>
          <Text style={styles.subtitle}>{tituloLocal}</Text>
        </View>
      </View>
      <Text style={styles.hint}>
        Describe paleta, tipografía y ambiente; adjunta referencias y la web oficial para contextualizar prompts de marketing.
      </Text>

      {cargando ? (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color="#0ea5e9" />
          <Text style={styles.loadingText}>Cargando identidad…</Text>
        </View>
      ) : puedeEditar ? (
        <>
          <EstiloVisualImagenesEditor keys={keys} onKeysChange={setKeys} puedeEditar showToast={showToast} />
          <View style={styles.fieldGap}>
            <Text style={styles.fieldLabel}>Web del local</Text>
            <Text style={styles.fieldHint}>URL pública (https://…) para tono de marca y copy.</Text>
            <TextInput
              style={styles.input}
              value={web}
              onChangeText={(t) => setWeb(t.slice(0, MAX_WEB_URL_CHARS))}
              placeholder="https://ejemplo.com"
              placeholderTextColor="#94a3b8"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
          <TextInput
            style={[styles.input, styles.textarea]}
            value={texto}
            onChangeText={(t) => setTexto(t.slice(0, MAX_CHARS))}
            multiline
            placeholder="Ej.: Paleta cálida terracota y beige, tipografía serif moderna, ambiente bistró urbano…"
            placeholderTextColor="#94a3b8"
          />
          <View style={styles.footerRow}>
            <Text style={[styles.counter, texto.length > MAX_CHARS && styles.counterWarn]}>
              {texto.length}/{MAX_CHARS}
            </Text>
            <TouchableOpacity
              style={[styles.saveBtn, (!hayCambios || guardando) && styles.saveBtnDisabled]}
              onPress={guardar}
              disabled={!hayCambios || guardando}
            >
              {guardando ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialIcons name="save" size={18} color="#fff" />
              )}
              <Text style={styles.saveBtnText}>Guardar</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <EstiloVisualImagenesEditor keys={keys} onKeysChange={() => {}} puedeEditar={false} showToast={showToast} />
          {web.trim() ? (
            <TouchableOpacity style={styles.webReadonlyRow} onPress={() => abrirWeb(web)} activeOpacity={0.7}>
              <MaterialIcons name="language" size={18} color="#0369a1" />
              <Text style={styles.webReadonlyLink} numberOfLines={2}>
                {web.trim()}
              </Text>
              <MaterialIcons name="open-in-new" size={18} color="#0369a1" />
            </TouchableOpacity>
          ) : (
            <Text style={styles.readonlyMuted}>Sin web configurada.</Text>
          )}
          <View style={styles.readonly}>
            <Text style={styles.readonlyText}>{texto.trim() ? texto : 'Sin identidad visual definida.'}</Text>
            <Text style={styles.readonlyNote}>No tienes permiso para editar este campo.</Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#f0f9ff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bae6fd',
    padding: 12,
    gap: 8,
    marginBottom: 12,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headerText: { flex: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: '700', color: '#0c4a6e' },
  subtitle: { fontSize: 12, color: '#0369a1' },
  hint: { fontSize: 11, color: '#475569', lineHeight: 16 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  loadingText: { fontSize: 12, color: '#64748b' },
  fieldGap: { gap: 4 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#475569' },
  fieldHint: { fontSize: 11, color: '#64748b', lineHeight: 15 },
  input: {
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  textarea: { minHeight: 100, textAlignVertical: 'top' },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  counter: { fontSize: 11, color: '#64748b' },
  counterWarn: { color: '#dc2626', fontWeight: '600' },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  webReadonlyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  webReadonlyLink: { flex: 1, fontSize: 13, color: '#0369a1', textDecorationLine: 'underline' },
  readonlyMuted: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  readonly: {
    padding: 10,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 6,
  },
  readonlyText: { fontSize: 13, color: '#334155', lineHeight: 18 },
  readonlyNote: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic' },
});
