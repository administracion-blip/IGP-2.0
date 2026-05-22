import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import { useLocalToast } from '../../components/Toast';
import { useMarketingLocales, valorEnLocal } from './LocalesContext';
import { formatId6 } from './lib/formatId6';
import { EstiloVisualImagenesEditor } from './components/EstiloVisualImagenesEditor';

const MAX_BRIEF = 1000;
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

export default function ConfigEstiloScreen() {
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const { locales } = useMarketingLocales();
  const { show: showToast, ToastView } = useLocalToast();
  const esGestor = hasPermiso('marketing.gestionar');
  const puedeAcceder = hasPermiso('marketing.proponer') || esGestor;

  const userLocalesNorm = useMemo(
    () => (user?.Locales ?? []).map((l) => formatId6(l)).filter(Boolean),
    [user?.Locales]
  );

  const localesElegibles = useMemo(() => {
    if (esGestor) return locales;
    return locales.filter((l) => {
      const id = formatId6(valorEnLocal(l, 'id_Locales'));
      return userLocalesNorm.includes(id);
    });
  }, [esGestor, locales, userLocalesNorm]);

  const [idLocal, setIdLocal] = useState('');
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [imagenKeys, setImagenKeys] = useState<string[]>([]);
  const [savedBrief, setSavedBrief] = useState('');
  const [savedKeys, setSavedKeys] = useState<string[]>([]);
  const [webUrl, setWebUrl] = useState('');
  const [savedWeb, setSavedWeb] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localesMap = useMemo(() => {
    const m: Record<string, string> = {};
    localesElegibles.forEach((l) => {
      const id = formatId6(valorEnLocal(l, 'id_Locales'));
      const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [localesElegibles]);

  // Si solo hay un local elegible, preselecciona.
  useEffect(() => {
    if (!idLocal && localesElegibles.length === 1) {
      const id = formatId6(valorEnLocal(localesElegibles[0], 'id_Locales'));
      if (id) setIdLocal(id);
    }
  }, [localesElegibles, idLocal]);

  // Carga brief e imágenes al cambiar de local.
  useEffect(() => {
    if (!idLocal) {
      setBrief('');
      setImagenKeys([]);
      setSavedBrief('');
      setSavedKeys([]);
      setWebUrl('');
      setSavedWeb('');
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch(`/api/marketing/locales/${idLocal}/estilo`)
      .then((res) => res.json())
      .then((data: { estilo_visual_brief?: string; estilo_visual_imagen_keys?: string[]; web?: string; error?: string }) => {
        if (data.error) {
          setError(data.error);
          setBrief('');
          setImagenKeys([]);
          setSavedBrief('');
          setSavedKeys([]);
          setWebUrl('');
          setSavedWeb('');
          return;
        }
        const b = data.estilo_visual_brief ?? '';
        const k = normalizarKeys(data.estilo_visual_imagen_keys);
        const w = String(data.web ?? '').slice(0, MAX_WEB_URL_CHARS);
        setBrief(b);
        setImagenKeys(k);
        setSavedBrief(b);
        setSavedKeys(k);
        setWebUrl(w);
        setSavedWeb(w);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [idLocal]);

  async function guardar() {
    if (!idLocal) return;
    if (brief.length > MAX_BRIEF) {
      setError(`Máximo ${MAX_BRIEF} caracteres.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/marketing/locales/${idLocal}/estilo`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estilo_visual_brief: brief, estilo_visual_imagen_keys: imagenKeys, web: webUrl.trim().slice(0, MAX_WEB_URL_CHARS) }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo guardar');
      setSavedBrief(brief);
      setSavedKeys([...imagenKeys]);
      const w = webUrl.trim().slice(0, MAX_WEB_URL_CHARS);
      setSavedWeb(w);
      setWebUrl(w);
      showToast('Guardado', 'Estilo visual actualizado.', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error desconocido';
      setError(msg);
      showToast('Error', msg, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!puedeAcceder) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
          </TouchableOpacity>
          <Text style={styles.title}>Estilo visual por local</Text>
        </View>
        <View style={styles.empty}>
          <MaterialIcons name="lock" size={32} color="#94a3b8" />
          <Text style={styles.emptyText}>
            Necesitas el permiso marketing.proponer o marketing.gestionar para editar la identidad del local.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <Text style={styles.title}>Estilo visual por local</Text>
      </View>

      <ScrollView contentContainerStyle={styles.form}>
        <Text style={styles.help}>
          Describe el estilo visual del local (paleta de colores, tipografía, ambiente, materiales,
          referencias, tono…). Puedes adjuntar hasta 3 imágenes de referencia y una{' '}
          <Text style={{ fontWeight: '700' }}>URL web</Text> del establecimiento para contextualizar prompts.
          Si tienes marketing.proponer, solo verás los locales que tienes asignados (los gestores ven todos).
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>Local</Text>
          <TouchableOpacity
            style={styles.dropdownTrigger}
            onPress={() => setLocalDropdownOpen((v) => !v)}
            activeOpacity={0.7}
            disabled={!esGestor && userLocalesNorm.length <= 1}
          >
            <Text style={[styles.dropdownText, !idLocal && styles.dropdownPlaceholder]} numberOfLines={1}>
              {idLocal ? localesMap[idLocal] ?? idLocal : 'Selecciona un local'}
            </Text>
            <MaterialIcons name={localDropdownOpen ? 'expand-less' : 'expand-more'} size={20} color="#64748b" />
          </TouchableOpacity>
          {localDropdownOpen && (
            <View style={styles.dropdownList}>
              <ScrollView style={styles.dropdownScroll} nestedScrollEnabled>
                {localesElegibles.map((l) => {
                  const id = formatId6(valorEnLocal(l, 'id_Locales'));
                  const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
                  const sel = id === idLocal;
                  return (
                    <TouchableOpacity
                      key={id || nombre}
                      style={[styles.dropdownOption, sel && styles.dropdownOptionSelected]}
                      onPress={() => {
                        setIdLocal(id);
                        setLocalDropdownOpen(false);
                      }}
                    >
                      <Text style={[styles.dropdownOptionText, sel && styles.dropdownOptionTextSelected]} numberOfLines={1}>
                        {nombre || id}
                      </Text>
                      {sel && <MaterialIcons name="check" size={18} color="#0ea5e9" />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          )}
        </View>

        {idLocal && (
          <>
            {loading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator size="small" color="#0ea5e9" />
              </View>
            ) : (
              <>
                <EstiloVisualImagenesEditor
                  keys={imagenKeys}
                  onKeysChange={setImagenKeys}
                  puedeEditar
                  showToast={showToast}
                />
                <View style={styles.field}>
                  <Text style={styles.label}>Web del local</Text>
                  <Text style={styles.fieldSub}>URL pública (https://…) para referencia de marca y contenido.</Text>
                  <TextInput
                    style={styles.input}
                    value={webUrl}
                    onChangeText={(t) => setWebUrl(t.slice(0, MAX_WEB_URL_CHARS))}
                    placeholder="https://ejemplo.com"
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                </View>
                <View style={styles.field}>
                  <View style={styles.labelRow}>
                    <Text style={styles.label}>Estilo visual brief</Text>
                    <Text style={[styles.charCount, brief.length > MAX_BRIEF && styles.charCountOver]}>
                      {brief.length} / {MAX_BRIEF}
                    </Text>
                  </View>
                  <TextInput
                    style={[styles.input, styles.textarea]}
                    value={brief}
                    onChangeText={setBrief}
                    multiline
                    placeholder="Local hostelero acogedor, paleta cálida (mostaza, terracota, beige), iluminación tenue tipo bistró, tipografía serif moderna, ambiente urbano-mediterráneo…"
                    placeholderTextColor="#94a3b8"
                    maxLength={MAX_BRIEF + 200}
                  />
                </View>
              </>
            )}
          </>
        )}

        {error && (
          <View style={styles.errorBox}>
            <MaterialIcons name="error-outline" size={18} color="#f87171" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {idLocal && !loading && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                (saving ||
                  brief.length > MAX_BRIEF ||
                  (brief === savedBrief &&
                  keysIgual(imagenKeys, savedKeys) &&
                  webUrl.trim() === savedWeb.trim())) &&
                  styles.disabled,
              ]}
              onPress={guardar}
              disabled={
                saving ||
                brief.length > MAX_BRIEF ||
                (brief === savedBrief && keysIgual(imagenKeys, savedKeys) && webUrl.trim() === savedWeb.trim())
              }
              activeOpacity={0.7}
            >
              {saving ? <ActivityIndicator color="#fff" /> : <MaterialIcons name="save" size={20} color="#fff" />}
              <Text style={styles.primaryBtnText}>{saving ? 'Guardando…' : 'Guardar estilo'}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
      {ToastView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  headerBtn: { padding: 6 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  form: { padding: 16, gap: 16 },
  help: { fontSize: 13, color: '#64748b', lineHeight: 19 },
  field: { gap: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 12, fontWeight: '600', color: '#475569' },
  fieldSub: { fontSize: 11, color: '#64748b', lineHeight: 15 },
  charCount: { fontSize: 11, color: '#64748b' },
  charCountOver: { color: '#dc2626', fontWeight: '600' },
  input: {
    fontSize: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: '#334155',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  textarea: { minHeight: 200, textAlignVertical: 'top' },
  loadingBox: { paddingVertical: 24, alignItems: 'center' },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  dropdownText: { fontSize: 14, color: '#334155', flex: 1 },
  dropdownPlaceholder: { color: '#94a3b8' },
  dropdownList: { marginTop: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff', maxHeight: 240 },
  dropdownScroll: { maxHeight: 240 },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  dropdownOptionSelected: { backgroundColor: '#f0f9ff' },
  dropdownOptionText: { fontSize: 14, color: '#334155', flex: 1 },
  dropdownOptionTextSelected: { color: '#0ea5e9', fontWeight: '500' },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8 },
  errorText: { fontSize: 12, color: '#dc2626', flex: 1 },
  actions: { flexDirection: 'row', gap: 10 },
  primaryBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, backgroundColor: '#0ea5e9', borderRadius: 10 },
  primaryBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  empty: { paddingVertical: 32, alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 13, color: '#64748b' },
  disabled: { opacity: 0.6 },
});
