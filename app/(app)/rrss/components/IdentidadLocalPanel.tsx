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
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../../constants/theme';
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
        <MaterialIcons name="palette" size={20} color={statusColors.info.text} />
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
          <ActivityIndicator size="small" color={colors.accent} />
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
              placeholderTextColor={colors.textMuted}
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
            placeholderTextColor={colors.textMuted}
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
                <ActivityIndicator size="small" color={colors.surface} />
              ) : (
                <MaterialIcons name="save" size={18} color={colors.surface} />
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
              <MaterialIcons name="language" size={18} color={statusColors.info.text} />
              <Text style={styles.webReadonlyLink} numberOfLines={2}>
                {web.trim()}
              </Text>
              <MaterialIcons name="open-in-new" size={18} color={statusColors.info.text} />
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

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  // Borde cielo; no es colors.border.
  wrap: {
    backgroundColor: colors.accentMuted,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#bae6fd',
    padding: SPACING.md,
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headerText: { flex: 1, gap: 2 },
  // Azul oscuro del título; no es colors.textStrong.
  title: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: '#0c4a6e' },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.info.text },
  hint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary, lineHeight: 16 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.md },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  fieldGap: { gap: SPACING.xs },
  fieldLabel: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  fieldHint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, lineHeight: 15 },
  input: {
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: 10,
    paddingVertical: SPACING.sm,
  },
  textarea: { minHeight: 100, textAlignVertical: 'top' },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  counter: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },
  counterWarn: { color: colors.danger, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 14,
    borderRadius: RADIO_MEDIO,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  webReadonlyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    padding: 10,
    backgroundColor: colors.surface,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  webReadonlyLink: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: statusColors.info.text, textDecorationLine: 'underline' },
  readonlyMuted: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, fontStyle: 'italic' },
  readonly: {
    padding: 10,
    backgroundColor: colors.surface,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  readonlyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, lineHeight: 18 },
  readonlyNote: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontStyle: 'italic' },
});
