import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
  ActivityIndicator,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  colors,
  fontFamily,
  fontSizes,
  inputCursorProps,
  inputCursorStyle,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../constants/theme';
import type { OpcionDesplegable } from './SelectorDesplegable';

type IconName = keyof typeof MaterialIcons.glyphMap;

type Props = {
  label?: string;
  placeholder?: string;
  icono?: IconName;
  opciones: OpcionDesplegable[];
  valorIds: string[];
  onChange: (ids: string[]) => void;
  tituloLista?: string;
  iconoLista?: IconName;
  loading?: boolean;
  disabled?: boolean;
  vacioTexto?: string;
  style?: StyleProp<ViewStyle>;
  buscador?: boolean;
  buscadorPlaceholder?: string;
  /** Trigger más bajo y tipografía reducida (formularios densos). */
  compact?: boolean;
  /**
   * Si se indica, el disparador es una pastilla con este texto (p. ej. «+ Local»)
   * y no resume la selección. La lista modal no cambia.
   */
  etiquetaBoton?: string;
  triggerStyle?: StyleProp<ViewStyle>;
};

/**
 * Selector desplegable con selección múltiple (checkboxes).
 * No cierra al pulsar una opción; usar el botón «Listo» o el overlay.
 */
export function SelectorDesplegableMulti({
  label,
  placeholder = 'Selecciona…',
  icono,
  opciones,
  valorIds,
  onChange,
  tituloLista,
  iconoLista,
  loading,
  disabled,
  vacioTexto = 'No hay opciones disponibles.',
  style,
  buscador,
  buscadorPlaceholder = 'Buscar…',
  compact = false,
  etiquetaBoton,
  triggerStyle,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filtro, setFiltro] = useState('');
  const seleccionSet = useMemo(() => new Set(valorIds), [valorIds]);
  const seleccionadas = useMemo(
    () => opciones.filter((o) => seleccionSet.has(o.id)),
    [opciones, seleccionSet],
  );

  const opcionesFiltradas = useMemo(() => {
    if (!buscador) return opciones;
    const q = filtro.trim().toLowerCase();
    if (!q) return opciones;
    return opciones.filter((o) =>
      `${o.titulo} ${o.subtitulo ?? ''}`.toLowerCase().includes(q),
    );
  }, [buscador, filtro, opciones]);

  const cerrar = () => {
    setOpen(false);
    setFiltro('');
  };

  const toggleOpcion = (id: string) => {
    if (seleccionSet.has(id)) {
      onChange(valorIds.filter((x) => x !== id));
    } else {
      onChange([...valorIds, id]);
    }
  };

  const resumen =
    seleccionadas.length === 0
      ? null
      : seleccionadas.length === 1
        ? seleccionadas[0].titulo
        : `${seleccionadas.length} seleccionados`;

  return (
    <View style={style}>
      {label ? <Text style={[styles.label, compact && styles.labelCompact]}>{label}</Text> : null}
      {etiquetaBoton ? (
        <TouchableOpacity
          style={[styles.botonAnadir, triggerStyle, open && styles.botonAnadirActivo, disabled && styles.triggerDisabled]}
          onPress={() => !disabled && setOpen(true)}
          activeOpacity={0.7}
          disabled={disabled}
          accessibilityLabel={etiquetaBoton}
        >
          {loading ? (
            <ActivityIndicator size="small" color={statusColors.info.text} />
          ) : (
            <MaterialIcons name="add" size={18} color={statusColors.info.text} />
          )}
          <Text style={styles.botonAnadirText}>{loading ? 'Cargando…' : etiquetaBoton}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[
            styles.trigger,
            compact && styles.triggerCompact,
            triggerStyle,
            open && styles.triggerActive,
            disabled && styles.triggerDisabled,
          ]}
          onPress={() => !disabled && setOpen(true)}
          activeOpacity={0.7}
          disabled={disabled}
        >
          {icono ? (
            <MaterialIcons name={icono} size={compact ? 14 : 16} color={seleccionadas.length > 0 ? colors.accent : colors.textMuted} />
          ) : null}
          <View style={styles.triggerTextWrap}>
            {loading ? (
              <Text style={[styles.placeholder, compact && styles.textCompact]}>Cargando…</Text>
            ) : resumen ? (
              <Text style={[styles.value, compact && styles.textCompact]} numberOfLines={1}>{resumen}</Text>
            ) : (
              <Text style={[styles.placeholder, compact && styles.textCompact]} numberOfLines={1}>{placeholder}</Text>
            )}
          </View>
          {seleccionadas.length > 1 ? (
            <View style={[styles.countBadge, compact && styles.countBadgeCompact]}>
              <Text style={[styles.countBadgeText, compact && styles.countBadgeTextCompact]}>{seleccionadas.length}</Text>
            </View>
          ) : null}
          <MaterialIcons name={open ? 'arrow-drop-up' : 'arrow-drop-down'} size={compact ? 20 : 22} color={colors.textMuted} />
        </TouchableOpacity>
      )}

      {open && (
        <Modal visible transparent animationType="fade" onRequestClose={cerrar}>
          <Pressable style={styles.overlay} onPress={cerrar}>
            <Pressable onPress={() => {}} style={styles.card}>
              {tituloLista ? (
                <View style={styles.header}>
                  {iconoLista ? <MaterialIcons name={iconoLista} size={15} color={colors.accent} /> : null}
                  <Text style={styles.headerText}>{tituloLista}</Text>
                  {valorIds.length > 0 ? (
                    <Text style={styles.headerCount}>{valorIds.length} sel.</Text>
                  ) : null}
                </View>
              ) : null}
              {buscador && !loading && opciones.length > 0 ? (
                <View style={styles.searchWrap}>
                  <MaterialIcons name="search" size={16} color={colors.textMuted} />
                  <TextInput
                    style={[styles.searchInput, Platform.OS === 'web' ? (inputCursorStyle as TextStyle) : null]}
                    value={filtro}
                    onChangeText={setFiltro}
                    placeholder={buscadorPlaceholder}
                    placeholderTextColor={colors.textMuted}
                    {...inputCursorProps}
                    autoCorrect={false}
                    autoFocus={Platform.OS === 'web'}
                  />
                  {filtro ? (
                    <TouchableOpacity onPress={() => setFiltro('')} hitSlop={{ top: SPACING.sm, bottom: SPACING.sm, left: SPACING.sm, right: SPACING.sm }}>
                      <MaterialIcons name="close" size={16} color={colors.textMuted} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
              {loading ? (
                <ActivityIndicator size="small" color={colors.accent} style={{ marginVertical: SPACING.xl }} />
              ) : opcionesFiltradas.length > 0 ? (
                <ScrollView style={styles.scroll} nestedScrollEnabled showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
                  {opcionesFiltradas.map((o) => {
                    const sel = seleccionSet.has(o.id);
                    return (
                      <TouchableOpacity
                        key={o.id}
                        style={[styles.row, sel && styles.rowSelected]}
                        onPress={() => toggleOpcion(o.id)}
                        activeOpacity={0.7}
                      >
                        <MaterialIcons
                          name={sel ? 'check-box' : 'check-box-outline-blank'}
                          size={20}
                          color={sel ? colors.accent : colors.textMuted}
                        />
                        {o.badge !== undefined ? (
                          <View style={[styles.badge, sel && styles.badgeSelected]}>
                            <Text style={[styles.badgeText, sel && styles.badgeTextSelected]}>{o.badge}</Text>
                          </View>
                        ) : o.icono ? (
                          <View style={[styles.iconBox, sel && styles.iconBoxSelected]}>
                            <MaterialIcons name={o.icono} size={16} color={sel ? colors.accent : colors.textMuted} />
                          </View>
                        ) : null}
                        <View style={styles.rowTextWrap}>
                          <Text style={[styles.rowTitle, sel && styles.rowTitleSelected]} numberOfLines={1}>
                            {o.titulo}
                          </Text>
                          {o.subtitulo ? (
                            <Text style={styles.rowSub} numberOfLines={1}>{o.subtitulo}</Text>
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              ) : opciones.length > 0 ? (
                <View style={styles.empty}>
                  <MaterialIcons name="search-off" size={28} color={colors.borderStrong} />
                  <Text style={styles.emptyText}>Sin resultados para «{filtro.trim()}».</Text>
                </View>
              ) : (
                <View style={styles.empty}>
                  <MaterialIcons name="inbox" size={28} color={colors.borderStrong} />
                  <Text style={styles.emptyText}>{vacioTexto}</Text>
                </View>
              )}
              <View style={styles.footer}>
                {valorIds.length > 0 ? (
                  <TouchableOpacity
                    style={styles.footerClearBtn}
                    onPress={() => onChange([])}
                  >
                    <Text style={styles.footerClearText}>Limpiar</Text>
                  </TouchableOpacity>
                ) : (
                  <View />
                )}
                <TouchableOpacity style={styles.footerOkBtn} onPress={cerrar}>
                  <Text style={styles.footerOkText}>Listo</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

/** Radio 8: entre `radius.sm` (6) y `radius.md` (10). No hay token. */
const RADIO_MEDIO = 8;
/** Borde cielo de la pastilla «añadir». No hay token. */
const CHIP_BORDE = '#bae6fd';
const CHIP_BORDE_ACTIVO = '#7dd3fc';

const styles = StyleSheet.create({
  label: {
    ...typography.etiqueta,
    marginBottom: SPACING.xs,
  },
  labelCompact: {
    marginBottom: 3,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: colors.bg,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: SPACING.sm,
    minHeight: 46,
  },
  triggerCompact: {
    minHeight: 34,
    paddingVertical: 5,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: 6,
  },
  triggerActive: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  triggerDisabled: { opacity: 0.6 },
  botonAnadir: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: CHIP_BORDE,
    borderRadius: radius.pill,
    paddingHorizontal: SPACING.md,
    minHeight: 36,
  },
  botonAnadirActivo: {
    backgroundColor: colors.accentMuted,
    borderColor: CHIP_BORDE_ACTIVO,
  },
  botonAnadirText: {
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[13],
    fontWeight: typography.titulo.fontWeight,
    color: statusColors.info.text,
  },
  triggerTextWrap: { flex: 1, minWidth: 0, overflow: 'hidden' },
  value: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[13],
    fontWeight: typography.subtitulo.fontWeight,
    color: colors.textStrong,
  },
  placeholder: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textMuted,
  },
  textCompact: { fontFamily: fontFamily.regular, fontSize: fontSizes[12] },
  countBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  countBadgeText: {
    fontFamily: fontFamily.bold,
    fontSize: typography.etiqueta.fontSize,
    fontWeight: typography.titulo.fontWeight,
    color: colors.surface,
  },
  countBadgeCompact: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: SPACING.xs,
  },
  countBadgeTextCompact: { fontSize: fontSizes.badge },
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    width: '100%',
    maxWidth: 420,
    maxHeight: '75%',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    ...(Platform.OS === 'web' && ({ boxShadow: '0 12px 32px rgba(0,0,0,0.18)' } as object)),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerText: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[12],
    fontWeight: typography.titulo.fontWeight,
    color: colors.textPrimary,
  },
  headerCount: {
    fontFamily: fontFamily.semibold,
    fontSize: typography.etiqueta.fontSize,
    fontWeight: typography.boton.fontWeight,
    color: colors.accent,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    margin: SPACING.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textStrong,
    paddingVertical: Platform.OS === 'web' ? 2 : 0,
  },
  scroll: { maxHeight: 360 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
  },
  rowSelected: { backgroundColor: colors.accentMuted },
  rowTextWrap: { flex: 1, minWidth: 0 },
  rowTitle: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[13],
    fontWeight: typography.nav.fontWeight,
    color: colors.textPrimary,
  },
  rowTitleSelected: {
    color: statusColors.info.text,
    fontFamily: fontFamily.bold,
    fontWeight: typography.titulo.fontWeight,
  },
  rowSub: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes.badge,
    color: colors.textMuted,
    marginTop: 1,
  },
  badge: {
    minWidth: 38,
    height: 32,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.xs,
    backgroundColor: colors.navActive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSelected: { backgroundColor: colors.accent },
  badgeText: {
    fontFamily: fontFamily.bold,
    fontSize: typography.etiqueta.fontSize,
    fontWeight: typography.titulo.fontWeight,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  badgeTextSelected: { color: colors.surface },
  iconBox: {
    width: 34,
    height: 34,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.navActive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBoxSelected: { backgroundColor: colors.accentMuted },
  empty: { alignItems: 'center', gap: SPACING.sm, paddingVertical: 28, paddingHorizontal: SPACING.lg },
  emptyText: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[12],
    color: colors.textMuted,
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  footerClearBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  footerClearText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[12],
    fontWeight: typography.boton.fontWeight,
    color: colors.textMuted,
  },
  footerOkBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIO_MEDIO,
  },
  footerOkText: {
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[12],
    fontWeight: typography.titulo.fontWeight,
    color: colors.surface,
  },
});
