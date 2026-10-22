import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import { useMantenimientoLocales, valorEnLocal } from './LocalesContext';
import { InputFecha } from '../../components/InputFecha';
import { estiloCampoFechaCompacto } from '../../components/RangoFechas';
import { apiFetch } from '../../utils/api';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';

const AUTH_KEY = 'erp_user';

const ZONAS = ['barra', 'cocina', 'baños', 'almacén', 'sala', 'terraza', 'otros'] as const;
const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'] as const;

type Frecuencia = 'diaria' | 'semanal' | 'bisemanal' | 'mensual' | 'personalizada';
const FRECUENCIAS: { id: Frecuencia; label: string }[] = [
  { id: 'diaria', label: 'Diaria' },
  { id: 'semanal', label: 'Semanal' },
  { id: 'bisemanal', label: 'Bisemanal' },
  { id: 'mensual', label: 'Mensual' },
  { id: 'personalizada', label: 'Días concretos' },
];

const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] as const;

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDDMMYYYY(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function generarFechas(
  desde: string,
  hasta: string,
  frecuencia: Frecuencia,
  diasSemana: boolean[],
): string[] {
  if (!desde || !hasta) return [];
  const start = new Date(desde + 'T00:00:00');
  const end = new Date(hasta + 'T23:59:59');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];

  const fechas: string[] = [];
  const maxFechas = 500;

  if (frecuencia === 'personalizada') {
    let cur = new Date(start);
    while (cur <= end && fechas.length < maxFechas) {
      const dow = cur.getDay();
      const idx = dow === 0 ? 6 : dow - 1;
      if (diasSemana[idx]) fechas.push(toISODate(cur));
      cur = addDays(cur, 1);
    }
    return fechas;
  }

  const incremento =
    frecuencia === 'diaria' ? 1 :
    frecuencia === 'semanal' ? 7 :
    frecuencia === 'bisemanal' ? 14 : 0;

  if (frecuencia === 'mensual') {
    let cur = new Date(start);
    while (cur <= end && fechas.length < maxFechas) {
      fechas.push(toISODate(cur));
      cur = new Date(cur);
      cur.setMonth(cur.getMonth() + 1);
    }
    return fechas;
  }

  if (incremento > 0) {
    let cur = new Date(start);
    while (cur <= end && fechas.length < maxFechas) {
      fechas.push(toISODate(cur));
      cur = addDays(cur, incremento);
    }
  }

  return fechas;
}

export default function RecurrentesScreen() {
  const router = useRouter();
  const { locales, loading: loadingLocales, error: localesError } = useMantenimientoLocales();
  const { width } = useBreakpoint();

  const [userId, setUserId] = useState('');
  const [localIdsSeleccionados, setLocalIdsSeleccionados] = useState<string[]>([]);
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [zona, setZona] = useState<(typeof ZONAS)[number]>('otros');
  const [prioridad, setPrioridad] = useState<(typeof PRIORIDADES)[number]>('media');
  const [titulo, setTitulo] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [frecuencia, setFrecuencia] = useState<Frecuencia>('semanal');
  const [diasSemana, setDiasSemana] = useState<boolean[]>([true, false, false, false, false, false, false]);
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ creados: number; total: number; errores: string[] } | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(AUTH_KEY).then((stored) => {
      if (!stored) return;
      try {
        const user = JSON.parse(stored) as { id_usuario?: string };
        setUserId(user.id_usuario ?? '');
      } catch { /* noop */ }
    });
  }, []);

  useEffect(() => {
    const hoy = new Date();
    setFechaDesde(toISODate(hoy));
    const tresMeses = new Date(hoy);
    tresMeses.setMonth(tresMeses.getMonth() + 3);
    setFechaHasta(toISODate(tresMeses));
  }, []);

  const toggleLocal = useCallback((id: string) => {
    setLocalIdsSeleccionados((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );
  }, []);

  const toggleDia = useCallback((idx: number) => {
    setDiasSemana((prev) => {
      const next = [...prev];
      next[idx] = !next[idx];
      return next;
    });
  }, []);

  const fechasGeneradas = useMemo(
    () => generarFechas(fechaDesde, fechaHasta, frecuencia, diasSemana),
    [fechaDesde, fechaHasta, frecuencia, diasSemana],
  );

  const totalRegistros = localIdsSeleccionados.length * fechasGeneradas.length;

  const handleEnviar = () => {
    if (localIdsSeleccionados.length === 0) return setError('Selecciona al menos un local');
    if (!titulo.trim()) return setError('El título es obligatorio');
    if (!ZONAS.includes(zona)) return setError('Selecciona una zona');
    if (fechasGeneradas.length === 0) return setError('No hay fechas generadas con la configuración actual');
    if (totalRegistros > 500) return setError('Máximo 500 registros por lote (reduce fechas o locales)');

    setError(null);
    setResultado(null);
    setEnviando(true);

    apiFetch('/api/mantenimiento/incidencias/lote', {
      method: 'POST',
      body: JSON.stringify({
        local_ids: localIdsSeleccionados,
        fechas_programadas: fechasGeneradas,
        zona,
        categoria: 'limpieza técnica',
        titulo: titulo.trim(),
        descripcion: descripcion.trim(),
        prioridad_reportada: prioridad,
        creado_por_id_usuario: userId || undefined,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setResultado({ creados: data.creados, total: data.total, errores: data.errores ?? [] });
        } else {
          setError(data.error ?? 'Error al crear lote');
        }
      })
      .catch((e) => setError(e.message ?? 'Error de conexión'))
      .finally(() => setEnviando(false));
  };

  // 540 px: ancho máximo de la ficha.
  const cardWidth = Math.min(width - 32, 540);

  return (
    <KeyboardAvoidingView
      style={styles.wrapper}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Reparaciones recurrentes</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {loadingLocales ? (
          <View style={[styles.formCard, styles.loadingWrap, { maxWidth: cardWidth }]}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.loadingText}>Cargando locales…</Text>
          </View>
        ) : localesError ? (
          <View style={[styles.formCard, styles.loadingWrap, { maxWidth: cardWidth }]}>
            <MaterialIcons name="error-outline" size={20} color={colors.danger} />
            <Text style={[styles.loadingText, { color: colors.danger }]}>{localesError}</Text>
          </View>
        ) : (
          <View style={[styles.formCard, { maxWidth: cardWidth }]}>
            {resultado ? (
              <View style={styles.successWrap}>
                <MaterialIcons name="check-circle" size={22} color={colors.success} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.successText}>
                    {resultado.creados} de {resultado.total} registros creados correctamente
                  </Text>
                  {resultado.errores.length > 0 && (
                    <Text style={styles.successSubtext}>
                      {resultado.errores.length} error(es): {resultado.errores.slice(0, 3).join('; ')}
                    </Text>
                  )}
                </View>
                <TouchableOpacity
                  style={styles.successCloseBtn}
                  onPress={() => router.replace('/mantenimiento/incidencias')}
                >
                  <Text style={styles.successCloseBtnText}>Volver</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {/* Locales (multi-select) */}
            <View style={[styles.field, { zIndex: 20 }]}>
              <Text style={styles.label}>
                Locales *{' '}
                <Text style={styles.labelHint}>
                  ({localIdsSeleccionados.length} seleccionado{localIdsSeleccionados.length !== 1 ? 's' : ''})
                </Text>
              </Text>
              <TouchableOpacity
                style={styles.dropdownTrigger}
                onPress={() => setLocalDropdownOpen((v) => !v)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.dropdownTriggerText, localIdsSeleccionados.length === 0 && styles.dropdownPlaceholder]}
                  numberOfLines={1}
                >
                  {localIdsSeleccionados.length === 0
                    ? 'Selecciona locales…'
                    : localIdsSeleccionados
                        .map((id) => {
                          const loc = locales.find((l) => (valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'id_locales')) === id);
                          return loc ? valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id : id;
                        })
                        .join(', ')}
                </Text>
                <MaterialIcons name={localDropdownOpen ? 'expand-less' : 'expand-more'} size={22} color={colors.textMuted} />
              </TouchableOpacity>
              {localDropdownOpen && (
                <View style={styles.dropdownList}>
                  <ScrollView style={styles.dropdownScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {locales.length === 0 ? (
                      <Text style={styles.emptyHint}>No hay locales disponibles.</Text>
                    ) : (
                      <>
                        <TouchableOpacity
                          style={styles.dropdownOptionAll}
                          onPress={() => {
                            const allIds = locales.map((l) => valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'id_locales') ?? '').filter(Boolean);
                            setLocalIdsSeleccionados((prev) =>
                              prev.length === allIds.length ? [] : allIds,
                            );
                          }}
                        >
                          <MaterialIcons
                            name={localIdsSeleccionados.length === locales.length ? 'check-box' : 'check-box-outline-blank'}
                            size={18}
                            color={colors.accent}
                          />
                          <Text style={styles.dropdownOptionTextAll}>Seleccionar todos</Text>
                        </TouchableOpacity>
                        {locales.map((loc) => {
                          const id = valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '';
                          const nombre = valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id;
                          const selected = localIdsSeleccionados.includes(id);
                          return (
                            <TouchableOpacity
                              key={id || nombre}
                              style={[styles.dropdownOption, selected && styles.dropdownOptionSelected]}
                              onPress={() => toggleLocal(id)}
                              activeOpacity={0.7}
                            >
                              <MaterialIcons
                                name={selected ? 'check-box' : 'check-box-outline-blank'}
                                size={18}
                                color={selected ? colors.accent : colors.textMuted}
                              />
                              <Text style={[styles.dropdownOptionText, selected && styles.dropdownOptionTextSelected]} numberOfLines={1}>
                                {nombre || id || '—'}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </>
                    )}
                  </ScrollView>
                </View>
              )}
            </View>

            {/* Título */}
            <View style={styles.field}>
              <Text style={styles.label}>Título *</Text>
              <TextInput
                style={styles.input}
                value={titulo}
                onChangeText={setTitulo}
                placeholder="Ej: Limpieza de aires acondicionados"
                placeholderTextColor={colors.textMuted}
              />
            </View>

            {/* Descripción */}
            <View style={styles.field}>
              <Text style={styles.label}>Descripción</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={descripcion}
                onChangeText={setDescripcion}
                placeholder="Detalles adicionales…"
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={3}
              />
            </View>

            {/* Zona + Prioridad en fila */}
            <View style={styles.twoColRow}>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={styles.label}>Zona *</Text>
                <View style={styles.selectWrap}>
                  {ZONAS.map((z) => (
                    <TouchableOpacity
                      key={z}
                      style={[styles.optionBtn, zona === z && styles.optionBtnSelected]}
                      onPress={() => setZona(z)}
                    >
                      <Text style={[styles.optionText, zona === z && styles.optionTextSelected]}>{z}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={styles.label}>Prioridad</Text>
                <View style={styles.selectWrap}>
                  {PRIORIDADES.map((p) => (
                    <TouchableOpacity
                      key={p}
                      style={[styles.optionBtn, prioridad === p && styles.optionBtnSelected]}
                      onPress={() => setPrioridad(p)}
                    >
                      <Text style={[styles.optionText, prioridad === p && styles.optionTextSelected]}>{p}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>

            {/* Programación */}
            <View style={styles.sectionHeader}>
              <MaterialIcons name="event-repeat" size={18} color={colors.accent} />
              <Text style={styles.sectionTitle}>Programación</Text>
            </View>

            {/* Rango de fechas */}
            <View style={styles.twoColRow}>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={styles.label}>Desde</Text>
                <InputFecha
                  compact
                  valueIso={fechaDesde}
                  onChangeIso={setFechaDesde}
                  placeholder="Desde"
                  style={estiloCampoFechaCompacto}
                />
              </View>
              <View style={[styles.field, { flex: 1 }]}>
                <Text style={styles.label}>Hasta</Text>
                <InputFecha
                  compact
                  valueIso={fechaHasta}
                  onChangeIso={setFechaHasta}
                  placeholder="Hasta"
                  style={estiloCampoFechaCompacto}
                />
              </View>
            </View>

            {/* Frecuencia */}
            <View style={styles.field}>
              <Text style={styles.label}>Frecuencia</Text>
              <View style={styles.selectWrap}>
                {FRECUENCIAS.map((f) => (
                  <TouchableOpacity
                    key={f.id}
                    style={[styles.optionBtn, frecuencia === f.id && styles.optionBtnSelected]}
                    onPress={() => setFrecuencia(f.id)}
                  >
                    <Text style={[styles.optionText, frecuencia === f.id && styles.optionTextSelected]}>{f.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Días de la semana (solo si es personalizada) */}
            {frecuencia === 'personalizada' && (
              <View style={styles.field}>
                <Text style={styles.label}>Días de la semana</Text>
                <View style={styles.diasRow}>
                  {DIAS_SEMANA.map((d, idx) => (
                    <TouchableOpacity
                      key={d}
                      style={[styles.diaBtn, diasSemana[idx] && styles.diaBtnSelected]}
                      onPress={() => toggleDia(idx)}
                    >
                      <Text style={[styles.diaText, diasSemana[idx] && styles.diaTextSelected]}>{d}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* Preview */}
            <View style={styles.previewCard}>
              <View style={styles.previewHeader}>
                <MaterialIcons name="preview" size={18} color={colors.textPrimary} />
                <Text style={styles.previewTitle}>Vista previa</Text>
              </View>
              <View style={styles.previewStats}>
                <View style={styles.previewStat}>
                  <Text style={styles.previewStatNum}>{localIdsSeleccionados.length}</Text>
                  <Text style={styles.previewStatLabel}>local{localIdsSeleccionados.length !== 1 ? 'es' : ''}</Text>
                </View>
                <Text style={styles.previewStatX}>×</Text>
                <View style={styles.previewStat}>
                  <Text style={styles.previewStatNum}>{fechasGeneradas.length}</Text>
                  <Text style={styles.previewStatLabel}>fecha{fechasGeneradas.length !== 1 ? 's' : ''}</Text>
                </View>
                <Text style={styles.previewStatX}>=</Text>
                <View style={styles.previewStat}>
                  <Text style={[styles.previewStatNum, totalRegistros > 500 && { color: colors.danger }]}>{totalRegistros}</Text>
                  <Text style={styles.previewStatLabel}>registro{totalRegistros !== 1 ? 's' : ''}</Text>
                </View>
              </View>
              {fechasGeneradas.length > 0 && (
                <View style={styles.previewDates}>
                  <Text style={styles.previewDatesTitle}>Fechas generadas:</Text>
                  <Text style={styles.previewDatesList} numberOfLines={4}>
                    {fechasGeneradas.slice(0, 12).map(formatDDMMYYYY).join('  ·  ')}
                    {fechasGeneradas.length > 12 ? `  … y ${fechasGeneradas.length - 12} más` : ''}
                  </Text>
                </View>
              )}
            </View>

            {error ? (
              <View style={styles.errorWrap}>
                <MaterialIcons name="error-outline" size={18} color={colors.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.buttonsRow}>
              <TouchableOpacity
                style={[styles.submitBtn, styles.cancelBtn]}
                onPress={() => router.replace('/mantenimiento/incidencias')}
                disabled={enviando}
              >
                <MaterialIcons name="cancel" size={20} color={colors.surface} />
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.submitBtn, styles.submitBtnPrimary, enviando && styles.submitBtnDisabled]}
                onPress={handleEnviar}
                disabled={enviando || totalRegistros === 0}
              >
                {enviando ? (
                  <ActivityIndicator size="small" color={colors.surface} />
                ) : (
                  <>
                    <MaterialIcons name="playlist-add-check" size={20} color={colors.surface} />
                    <Text style={styles.submitBtnText}>Crear {totalRegistros} registro{totalRegistros !== 1 ? 's' : ''}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: colors.surface },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.md, paddingHorizontal: SPACING.lg, gap: SPACING.sm },
  backBtn: { padding: SPACING.xs },
  title: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  scroll: { flex: 1 },
  scrollContent: { padding: SPACING.lg, paddingBottom: SPACING.xl, alignItems: 'center' },
  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, padding: SPACING.lg },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  formCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  successWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
    paddingHorizontal: 14,
    backgroundColor: statusColors.success.bg,
    borderRadius: RADIO_MEDIO,
    marginBottom: SPACING.md,
  },
  successText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.success },
  successSubtext: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary, marginTop: SPACING.xs },
  successCloseBtn: {
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    backgroundColor: colors.success,
    borderRadius: RADIO_MEDIO,
  },
  successCloseBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  field: { marginBottom: SPACING.lg },
  label: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: 6 },
  labelHint: { fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textMuted },
  twoColRow: { flexDirection: 'row', gap: SPACING.md },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.md,
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },
  dropdownTriggerText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary, flex: 1 },
  dropdownPlaceholder: { color: colors.textMuted },
  dropdownList: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    maxHeight: 240,
  },
  dropdownScroll: { maxHeight: 240 },
  dropdownOptionAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.accentMuted,
  },
  dropdownOptionTextAll: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dropdownOptionSelected: { backgroundColor: colors.accentMuted },
  dropdownOptionText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary, flex: 1 },
  dropdownOptionTextSelected: { color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  emptyHint: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, fontStyle: 'italic', padding: 14 },
  selectWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  optionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },
  optionBtnSelected: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  optionText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary },
  optionTextSelected: { color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    fontFamily: fontFamily.regular, fontSize: fontSizes[14],
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  textArea: { minHeight: 60, textAlignVertical: 'top' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: SPACING.md,
    marginTop: SPACING.xs,
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sectionTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  diasRow: { flexDirection: 'row', gap: 6 },
  // Círculo 42×42; el radio es la mitad del lado.
  diaBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  diaBtnSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  diaText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  diaTextSelected: { color: colors.surface },
  previewCard: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: SPACING.lg,
  },
  previewHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  previewTitle: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  previewStats: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.md, marginBottom: 10 },
  previewStat: { alignItems: 'center' },
  previewStatNum: { fontSize: fontSizes[24], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.accent, fontVariant: ['tabular-nums'] },
  previewStatLabel: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: colors.textMuted, marginTop: 2 },
  previewStatX: { fontSize: fontSizes[18], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textMuted },
  previewDates: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  previewDatesTitle: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },
  previewDatesList: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, lineHeight: 18 },
  errorWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: SPACING.md, padding: 10, backgroundColor: statusColors.danger.bg, borderRadius: RADIO_MEDIO },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger },
  buttonsRow: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.sm },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
    borderRadius: radius.md,
  },
  cancelBtn: { flex: 1, backgroundColor: colors.danger },
  cancelBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  submitBtnPrimary: { flex: 3, backgroundColor: colors.accent },
  submitBtnDisabled: { opacity: 0.7 },
  submitBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
});
