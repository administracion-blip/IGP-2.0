import { useEffect, useMemo, useRef, useState } from 'react';
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
  type ViewStyle,
  type TextStyle,
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

type IconName = keyof typeof MaterialIcons.glyphMap;

export type OpcionDesplegable = {
  id: string;
  titulo: string;
  subtitulo?: string;
  /** Texto corto para el badge cuadrado de la izquierda (ej. "Lun"). */
  badge?: string;
  /** Color de fondo del badge. Si viene, el texto va en blanco. */
  badgeColor?: string;
  /** Icono por opción (alternativa al badge). */
  icono?: IconName;
};

type Props = {
  label?: string;
  placeholder?: string;
  /** Icono del trigger (se tiñe de azul cuando hay selección). */
  icono?: IconName;
  opciones: OpcionDesplegable[];
  valorId?: string | null;
  onSeleccionar: (id: string) => void;
  tituloLista?: string;
  iconoLista?: IconName;
  loading?: boolean;
  disabled?: boolean;
  vacioTexto?: string;
  vacioAccion?: { texto: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
  /** Trigger más bajo para toolbars y filtros en línea con chips. */
  compact?: boolean;
  /** Oculta el icono izquierdo del trigger (solo texto + chevron, estilo filtro toolbar). */
  sinIconoTrigger?: boolean;
  /** Estilo extra del trigger (p. ej. coherente con desplegable «Local»). */
  triggerStyle?: StyleProp<ViewStyle>;
  /** Estilo del texto valor/placeholder en el trigger. */
  triggerTextStyle?: StyleProp<TextStyle>;
  /** Muestra un campo de búsqueda en la cabecera de la lista (filtra por título y subtítulo). */
  buscador?: boolean;
  buscadorPlaceholder?: string;
  /**
   * Tras filtrar, limita filas renderizadas. Si hay más, muestra pie
   * «Escribe para acotar (mostrando N de M)».
   */
  limiteResultados?: number;
  /**
   * Con buscador: si el filtro tiene menos de N caracteres, no lista el catálogo
   * completo (evita pintar miles de filas). Muestra mensaje o solo la opción
   * seleccionada si hay `valorId`.
   */
  minCharsBusqueda?: number;
  /**
   * Id para cadena Tab en web (`data-esc-campo`). El trigger queda focusable.
   */
  webCampoId?: string;
  /**
   * Solo web. Si el modal está abierto y el foco está en el buscador, Tab
   * (sin Shift) confirma la única opción visible (como un clic). Con 0
   * resultados no selecciona. No altera el Tab nativo si no se activa.
   */
  tabConfirmaPrimero?: boolean;
};

/**
 * Selector desplegable estándar de IGP-2.0.
 * Trigger con icono + etiqueta + valor/subtítulo y estado activo, y lista flotante
 * con cabecera, badge/icono por opción y check en el seleccionado.
 */
export function SelectorDesplegable({
  label,
  placeholder = 'Selecciona…',
  icono,
  opciones,
  valorId,
  onSeleccionar,
  tituloLista,
  iconoLista,
  loading,
  disabled,
  vacioTexto = 'No hay opciones disponibles.',
  vacioAccion,
  style,
  compact = false,
  sinIconoTrigger = false,
  triggerStyle,
  triggerTextStyle,
  buscador,
  buscadorPlaceholder = 'Buscar…',
  limiteResultados,
  minCharsBusqueda,
  webCampoId,
  tabConfirmaPrimero = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filtro, setFiltro] = useState('');
  const seleccionada = opciones.find((o) => o.id === valorId) ?? null;

  const { opcionesVisibles, pendienteMinChars, mensajePie } = useMemo(() => {
    const q = filtro.trim();
    const qLower = q.toLowerCase();
    const minChars = buscador && minCharsBusqueda != null && minCharsBusqueda > 0
      ? minCharsBusqueda
      : 0;
    const necesitaMinChars = minChars > 0 && q.length < minChars;

    if (necesitaMinChars) {
      const soloSel =
        valorId && seleccionada
          ? [seleccionada]
          : valorId
            ? opciones.filter((o) => o.id === valorId).slice(0, 1)
            : [];
      return {
        opcionesVisibles: soloSel,
        pendienteMinChars: true as const,
        mensajePie: null as string | null,
      };
    }

    let filtradas = opciones;
    if (buscador && qLower) {
      filtradas = opciones.filter((o) =>
        `${o.titulo} ${o.subtitulo ?? ''}`.toLowerCase().includes(qLower),
      );
    }

    const total = filtradas.length;
    const limite =
      limiteResultados != null && limiteResultados > 0 ? limiteResultados : null;
    const visibles = limite != null ? filtradas.slice(0, limite) : filtradas;
    const pie =
      limite != null && total > visibles.length
        ? `Escribe para acotar (mostrando ${visibles.length} de ${total})`
        : null;

    return {
      opcionesVisibles: visibles,
      pendienteMinChars: false as const,
      mensajePie: pie,
    };
  }, [buscador, filtro, opciones, limiteResultados, minCharsBusqueda, valorId, seleccionada]);

  const tabStateRef = useRef({ opcionesVisibles, onSeleccionar });
  tabStateRef.current = { opcionesVisibles, onSeleccionar };

  const cerrar = () => {
    setOpen(false);
    setFiltro('');
  };

  const aplicarTabConfirma = (e: {
    key?: string;
    shiftKey?: boolean;
    nativeEvent?: { key?: string; shiftKey?: boolean };
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    const key = e.nativeEvent?.key ?? e.key ?? '';
    const shift = e.nativeEvent?.shiftKey ?? e.shiftKey ?? false;
    if (key !== 'Tab' || shift) return false;
    const { opcionesVisibles: visibles, onSeleccionar: sel } = tabStateRef.current;
    if (visibles.length === 1) {
      e.preventDefault?.();
      e.stopPropagation?.();
      sel(visibles[0].id);
      cerrar();
      return true;
    }
    if (visibles.length === 0) {
      e.preventDefault?.();
      e.stopPropagation?.();
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (Platform.OS !== 'web' || !tabConfirmaPrimero || !open) return;
    const handler = (e: KeyboardEvent) => {
      aplicarTabConfirma(e);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [tabConfirmaPrimero, open]);

  return (
    <View style={style}>
      {label ? <Text style={[styles.label, compact && styles.labelCompact]}>{label}</Text> : null}
      <TouchableOpacity
        style={[
          styles.trigger,
          compact && !sinIconoTrigger && styles.triggerCompact,
          sinIconoTrigger && styles.triggerToolbar,
          triggerStyle,
          open && styles.triggerActive,
          disabled && styles.triggerDisabled,
        ]}
        onPress={() => !disabled && setOpen(true)}
        activeOpacity={0.7}
        disabled={disabled}
        {...(Platform.OS === 'web' && webCampoId
          ? ({
              dataSet: { escCampo: webCampoId },
              tabIndex: disabled ? -1 : 0,
              focusable: !disabled,
            } as object)
          : {})}
      >
        {icono && !sinIconoTrigger ? (
          <MaterialIcons name={icono} size={compact ? 14 : 16} color={seleccionada ? colors.accent : colors.textMuted} />
        ) : null}
        <View style={styles.triggerTextWrap}>
          {loading ? (
            <Text style={[styles.placeholder, compact && styles.textCompact, sinIconoTrigger && styles.textToolbar, triggerTextStyle]}>Cargando…</Text>
          ) : seleccionada ? (
            <>
              <Text style={[styles.value, compact && styles.textCompact, sinIconoTrigger && styles.textToolbar, triggerTextStyle]} numberOfLines={1}>{seleccionada.titulo}</Text>
              {seleccionada.subtitulo && !compact ? (
                <Text style={styles.sub} numberOfLines={1}>{seleccionada.subtitulo}</Text>
              ) : null}
            </>
          ) : (
            <Text style={[styles.placeholder, compact && styles.textCompact, sinIconoTrigger && styles.textToolbar, triggerTextStyle]} numberOfLines={1}>{placeholder}</Text>
          )}
        </View>
        <MaterialIcons
          name={sinIconoTrigger ? (open ? 'expand-less' : 'expand-more') : (open ? 'arrow-drop-up' : 'arrow-drop-down')}
          size={sinIconoTrigger ? 20 : (compact ? 20 : 22)}
          color={colors.textMuted}
        />
      </TouchableOpacity>

      {open && (
        <Modal visible transparent animationType="fade" onRequestClose={cerrar}>
          <Pressable style={styles.overlay} onPress={cerrar}>
            <Pressable onPress={() => {}} style={styles.card}>
              {tituloLista ? (
                <View style={styles.header}>
                  {iconoLista ? <MaterialIcons name={iconoLista} size={15} color={colors.accent} /> : null}
                  <Text style={styles.headerText}>{tituloLista}</Text>
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
                    {...(Platform.OS === 'web' && tabConfirmaPrimero
                      ? ({ onKeyDown: aplicarTabConfirma } as object)
                      : {})}
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
              ) : pendienteMinChars && opcionesVisibles.length === 0 ? (
                <View style={styles.empty}>
                  <MaterialIcons name="keyboard" size={28} color={colors.borderStrong} />
                  <Text style={styles.emptyText}>
                    {`Escribe al menos ${minCharsBusqueda} caracteres para buscar…`}
                  </Text>
                </View>
              ) : opcionesVisibles.length > 0 ? (
                <ScrollView style={styles.scroll} nestedScrollEnabled showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
                  {pendienteMinChars ? (
                    <Text style={styles.hintMinChars}>
                      {`Escribe al menos ${minCharsBusqueda} caracteres para buscar más…`}
                    </Text>
                  ) : null}
                  {opcionesVisibles.map((o) => {
                    const sel = o.id === valorId;
                    return (
                      <TouchableOpacity
                        key={o.id}
                        style={[styles.row, sel && styles.rowSelected]}
                        onPress={() => { onSeleccionar(o.id); cerrar(); }}
                        activeOpacity={0.7}
                      >
                        {o.badge !== undefined ? (
                          <View style={[styles.badge, o.badgeColor ? { backgroundColor: o.badgeColor } : sel && styles.badgeSelected]}>
                            <Text style={[styles.badgeText, (o.badgeColor || sel) && styles.badgeTextSelected]}>{o.badge}</Text>
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
                        {sel ? <MaterialIcons name="check-circle" size={18} color={colors.accent} /> : null}
                      </TouchableOpacity>
                    );
                  })}
                  {mensajePie ? (
                    <Text style={styles.pieLimite}>{mensajePie}</Text>
                  ) : null}
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
                  {vacioAccion ? (
                    <TouchableOpacity
                      style={styles.emptyBtn}
                      onPress={() => { cerrar(); vacioAccion.onPress(); }}
                    >
                      <MaterialIcons name="add" size={15} color={colors.surface} />
                      <Text style={styles.emptyBtnText}>{vacioAccion.texto}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              )}
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

/** Radio 8: entre `radius.sm` (6) y `radius.md` (10). No hay token. */
const RADIO_MEDIO = 8;

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
    minHeight: 30,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    gap: 6,
  },
  triggerToolbar: {
    minHeight: 0,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 0,
  },
  textToolbar: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[12],
    fontWeight: typography.cuerpo.fontWeight,
    color: colors.textPrimary,
  },
  triggerActive: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  triggerDisabled: { opacity: 0.6 },
  triggerTextWrap: { flex: 1, minWidth: 0, overflow: 'hidden' },
  value: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[13],
    fontWeight: typography.subtitulo.fontWeight,
    color: colors.textStrong,
    ...(Platform.OS === 'web' ? ({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as object) : {}),
  },
  sub: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes.badge,
    color: colors.textMuted,
    marginTop: 1,
    ...(Platform.OS === 'web' ? ({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as object) : {}),
  },
  placeholder: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    color: colors.textMuted,
  },
  textCompact: {
    fontFamily: fontFamily.medium,
    fontSize: typography.etiqueta.fontSize,
    fontWeight: typography.nav.fontWeight,
  },
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
    maxWidth: 380,
    maxHeight: '70%',
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
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[12],
    fontWeight: typography.titulo.fontWeight,
    color: colors.textPrimary,
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
  scroll: { maxHeight: 320 },
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
  hintMinChars: {
    fontFamily: fontFamily.regular,
    fontSize: typography.etiqueta.fontSize,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  pieLimite: {
    fontFamily: fontFamily.regular,
    fontSize: typography.etiqueta.fontSize,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.navActive,
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: colors.accent,
    paddingHorizontal: 14,
    paddingVertical: SPACING.sm,
    borderRadius: RADIO_MEDIO,
    marginTop: SPACING.xs,
  },
  emptyBtnText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[12],
    fontWeight: typography.boton.fontWeight,
    color: colors.surface,
  },
});
