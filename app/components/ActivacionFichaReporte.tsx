import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../constants/theme';
import { buildWhatsAppUrl } from '../lib/activaciones';
import {
  type Activacion,
  type ActivacionAdjunto,
  type ActivacionSesion,
  ESTADO_ACTIVACION_META,
  ESTADO_SESION_META,
  sesionCruzaMedianoche,
} from '../types/activaciones';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

export function fechaEsActivacion(iso: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '—');
}

function val(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
}

function SecCard({
  icon,
  titulo,
  children,
}: {
  icon: IconName;
  titulo: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.secCard}>
      <View style={styles.secCardHead}>
        <View style={styles.secIconWrap}>
          <MaterialIcons name={icon} size={16} color={colors.accent} />
        </View>
        <Text style={styles.secCardTitle}>{titulo}</Text>
      </View>
      {children}
    </View>
  );
}

function CampoInline({ label, valor }: { label: string; valor?: string | number }) {
  return (
    <View style={styles.campoInline}>
      <Text style={styles.campoLabel}>{label}</Text>
      <Text style={styles.campoValor}>{val(valor)}</Text>
    </View>
  );
}

function KpiCard({ icon, label, valor }: { icon: IconName; label: string; valor: string }) {
  return (
    <View style={styles.kpiCard}>
      <View style={styles.kpiIconWrap}>
        <MaterialIcons name={icon} size={15} color={colors.accent} />
      </View>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValor} numberOfLines={2}>
        {valor}
      </Text>
    </View>
  );
}

function BloqueCol({ titulo, texto, chips }: { titulo: string; texto?: string; chips?: string[] }) {
  return (
    <View style={styles.bloqueCol}>
      <Text style={styles.bloqueColTitulo}>{titulo}</Text>
      {chips?.length ? (
        <View style={styles.materialesWrap}>
          {chips.map((m, idx) => (
            <View key={`${m}-${idx}`} style={styles.materialChip}>
              <Text style={styles.materialText}>{m}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.bloqueColTexto}>{texto || '—'}</Text>
      )}
    </View>
  );
}

export type ActivacionFichaReporteProps = {
  activacion: Activacion;
  sesiones: ActivacionSesion[];
  adjuntos?: ActivacionAdjunto[];
  /** Resalta la fila de la sesión del día en la tabla. */
  sesionDestacadaId?: string;
  topBar?: ReactNode;
  footer?: ReactNode;
  puedeGestionar?: boolean;
  onGestionarSesiones?: () => void;
};

export function ActivacionFichaReporte({
  activacion,
  sesiones,
  adjuntos = [],
  sesionDestacadaId,
  topBar,
  footer,
  puedeGestionar = false,
  onGestionarSesiones,
}: ActivacionFichaReporteProps) {
  const { shouldStackPanels } = useBreakpoint();
  const grid2 = shouldStackPanels ? styles.gridStack : styles.grid2;
  const breadcrumb = [activacion.marca, activacion.codigo, activacion.tipo_activacion].filter(Boolean);
  const sesionDestacada = sesionDestacadaId
    ? sesiones.find((s) => s.id_sesion === sesionDestacadaId)
    : undefined;

  const llamar = () => {
    if (!activacion.promotor_telefono) return;
    Linking.openURL(`tel:${activacion.promotor_telefono.replace(/[\s\-()]/g, '')}`).catch(() => {});
  };

  const whatsApp = () => {
    Linking.openURL(buildWhatsAppUrl(activacion)).catch(() => {});
  };

  return (
    <View style={styles.report}>
      {topBar}

      <Text style={styles.tituloProducto}>{activacion.producto}</Text>
      <View style={styles.breadcrumb}>
        {breadcrumb.map((part, i) => (
          <View key={`${part}-${i}`} style={styles.breadcrumbItem}>
            {i > 0 ? <Text style={styles.breadcrumbSep}>›</Text> : null}
            <Text style={[styles.breadcrumbText, i === 0 && styles.breadcrumbMarca]}>{part}</Text>
          </View>
        ))}
      </View>

      {sesionDestacada ? (
        <View style={styles.sesionHoyBanner}>
          <View style={styles.sesionHoyHead}>
            <MaterialIcons name="today" size={16} color={statusColors.info.text} />
            <Text style={styles.sesionHoyTitulo}>Sesión de hoy</Text>
            <View
              style={[
                styles.badgeMini,
                {
                  backgroundColor:
                    (ESTADO_SESION_META[sesionDestacada.estado_sesion] ?? ESTADO_SESION_META.programada).bg,
                },
              ]}
            >
              <Text
                style={[
                  styles.badgeMiniText,
                  {
                    color:
                      (ESTADO_SESION_META[sesionDestacada.estado_sesion] ?? ESTADO_SESION_META.programada).text,
                  },
                ]}
              >
                {(ESTADO_SESION_META[sesionDestacada.estado_sesion] ?? ESTADO_SESION_META.programada).label}
              </Text>
            </View>
          </View>
          <Text style={styles.sesionHoyLocal}>{sesionDestacada.local_nombre || sesionDestacada.id_local}</Text>
          <Text style={styles.sesionHoyMeta}>
            {fechaEsActivacion(sesionDestacada.fecha)} · {sesionDestacada.hora_inicio}–{sesionDestacada.hora_fin}
            {sesionCruzaMedianoche(sesionDestacada) ? ' (hasta madrugada)' : ''}
            {activacion.duracion_horas ? ` · ${activacion.duracion_horas} h` : ''}
          </Text>
          {sesionDestacada.incidencia ? (
            <View style={styles.incidenciaBox}>
              <MaterialIcons name="warning-amber" size={15} color={colors.warning} />
              <Text style={styles.incidenciaText}>{sesionDestacada.incidencia}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={[styles.kpiRow, shouldStackPanels && styles.kpiRowStack]}>
        <KpiCard
          icon="date-range"
          label="Vigencia"
          valor={`${fechaEsActivacion(activacion.vigencia_inicio)} → ${fechaEsActivacion(activacion.vigencia_fin)}`}
        />
        <KpiCard
          icon="schedule"
          label="Duración / sesión"
          valor={activacion.duracion_horas ? `${activacion.duracion_horas} h` : '—'}
        />
        <KpiCard icon="event" label="Sesiones" valor={String(sesiones.length)} />
        <KpiCard icon="groups" label="Target" valor={val(activacion.target_descripcion)} />
      </View>

      <SecCard icon="business" titulo="Empresa y contacto">
        <View style={grid2}>
          <CampoInline label="Empresa" valor={activacion.empresa_nombre} />
          <CampoInline label="CIF" valor={activacion.empresa_cif} />
        </View>
        <View style={[grid2, { marginTop: 10 }]}>
          <CampoInline label="Promotor" valor={activacion.promotor_nombre} />
          <View style={styles.campoInline}>
            <Text style={styles.campoLabel}>Teléfono</Text>
            <Text style={styles.campoValor}>{val(activacion.promotor_telefono)}</Text>
            {activacion.promotor_telefono ? (
              <View style={styles.telBtns}>
                <TouchableOpacity style={styles.telBtn} onPress={llamar}>
                  <MaterialIcons name="call" size={14} color={colors.accent} />
                  <Text style={styles.telBtnText}>Llamar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.telBtn, styles.telBtnWa]} onPress={whatsApp}>
                  <MaterialIcons name="chat" size={14} color={colors.success} />
                  <Text style={[styles.telBtnText, { color: colors.success }]}>WA</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>
      </SecCard>

      <SecCard icon="calendar-today" titulo="Vigencia y sesión">
        <View style={grid2}>
          <CampoInline
            label="Vigencia"
            valor={`${fechaEsActivacion(activacion.vigencia_inicio)} → ${fechaEsActivacion(activacion.vigencia_fin)}`}
          />
          <CampoInline
            label="Duración / sesión"
            valor={activacion.duracion_horas ? `${activacion.duracion_horas} h` : ''}
          />
        </View>
        <View style={[grid2, { marginTop: 10 }]}>
          <CampoInline label="Ocasión" valor={activacion.ocasion} />
          <CampoInline label="Target" valor={activacion.target_descripcion} />
        </View>
      </SecCard>

      <SecCard icon="description" titulo="Mecánica">
        <Text style={styles.bloqueLargoTexto}>{val(activacion.mecanica)}</Text>
      </SecCard>

      <View style={grid2}>
        <BloqueCol titulo="Equipo" texto={activacion.equipo_descripcion} />
        <BloqueCol titulo="Materiales" chips={activacion.materiales} />
      </View>

      <SecCard icon="payments" titulo="Observaciones de pago">
        <Text style={styles.bloqueLargoTexto}>{val(activacion.pago_observaciones)}</Text>
      </SecCard>

      {adjuntos.length > 0 ? (
        <SecCard icon="attach-file" titulo="Documentos adjuntos">
          <View style={styles.adjGrid}>
            {adjuntos.map((adj) => (
              <TouchableOpacity
                key={adj.id}
                style={styles.adjChip}
                onPress={() => adj.url && Linking.openURL(adj.url).catch(() => {})}
              >
                <MaterialIcons name="insert-drive-file" size={15} color={colors.accent} />
                <Text style={styles.adjNombre} numberOfLines={1}>
                  {adj.nombre}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </SecCard>
      ) : null}

      <View style={styles.secCard}>
        <View style={styles.sesionesHead}>
          <View style={styles.secCardHead}>
            <View style={styles.secIconWrap}>
              <MaterialIcons name="storefront" size={16} color={colors.accent} />
            </View>
            <Text style={styles.secCardTitle}>Sesiones ({sesiones.length})</Text>
          </View>
          {puedeGestionar && onGestionarSesiones ? (
            <TouchableOpacity style={styles.gestionarBtn} onPress={onGestionarSesiones}>
              <MaterialIcons name="edit-calendar" size={14} color={colors.surface} />
              <Text style={styles.gestionarBtnText}>Gestionar</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {sesiones.length === 0 ? (
          <Text style={styles.sesionesVacio}>No hay sesiones programadas.</Text>
        ) : (
          <View style={styles.tablaSesiones}>
            {!shouldStackPanels ? (
              <View style={styles.tablaHead}>
                <Text style={[styles.th, styles.thLocal]}>Local</Text>
                <Text style={[styles.th, styles.thFecha]}>Fecha</Text>
                <Text style={[styles.th, styles.thHora]}>Horario</Text>
                <Text style={[styles.th, styles.thDur]}>Dur.</Text>
                <Text style={[styles.th, styles.thEstado]}>Estado</Text>
              </View>
            ) : null}
            {sesiones.map((s) => {
              const sm = ESTADO_SESION_META[s.estado_sesion] ?? ESTADO_SESION_META.programada;
              const destacada = s.id_sesion === sesionDestacadaId;
              if (shouldStackPanels) {
                return (
                  <View
                    key={s.id_sesion}
                    style={[styles.sesionCardMovil, destacada && styles.sesionDestacadaRow]}
                  >
                    <Text style={styles.sesionCardLocal}>{s.local_nombre || s.id_local}</Text>
                    <Text style={styles.sesionCardMeta}>
                      {fechaEsActivacion(s.fecha)} · {s.hora_inicio}–{s.hora_fin}
                      {sesionCruzaMedianoche(s) ? ' (+1)' : ''}
                      {activacion.duracion_horas ? ` · ${activacion.duracion_horas} h` : ''}
                    </Text>
                    <View style={[styles.badgeMini, { backgroundColor: sm.bg, alignSelf: 'flex-start' }]}>
                      <Text style={[styles.badgeMiniText, { color: sm.text }]}>{sm.label}</Text>
                    </View>
                  </View>
                );
              }
              return (
                <View key={s.id_sesion} style={[styles.tablaRow, destacada && styles.sesionDestacadaRow]}>
                  <Text style={[styles.td, styles.thLocal]} numberOfLines={1}>
                    {s.local_nombre || s.id_local}
                  </Text>
                  <Text style={[styles.td, styles.thFecha]}>{fechaEsActivacion(s.fecha)}</Text>
                  <Text style={[styles.td, styles.thHora]}>
                    {s.hora_inicio}–{s.hora_fin}
                    {sesionCruzaMedianoche(s) ? ' (+1)' : ''}
                  </Text>
                  <Text style={[styles.td, styles.thDur]}>
                    {activacion.duracion_horas ? `${activacion.duracion_horas} h` : '—'}
                  </Text>
                  <View style={[styles.thEstado, styles.tdEstado]}>
                    {s.incidencia ? (
                      <MaterialIcons name="warning-amber" size={14} color={colors.warning} style={{ marginRight: SPACING.xs }} />
                    ) : null}
                    <View style={[styles.badgeMini, { backgroundColor: sm.bg }]}>
                      <Text style={[styles.badgeMiniText, { color: sm.text }]}>{sm.label}</Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {footer}
    </View>
  );
}

export function ActivacionEstadoBadge({ activacion }: { activacion: Activacion }) {
  const meta = ESTADO_ACTIVACION_META[activacion.estado] ?? ESTADO_ACTIVACION_META.borrador;
  return (
    <View style={[styles.estadoBadge, { backgroundColor: meta.bg }]}>
      <View style={[styles.estadoDot, { backgroundColor: meta.text }]} />
      <Text style={[styles.estadoText, { color: meta.text }]}>{meta.label}</Text>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

export const activacionFichaStyles = StyleSheet.create({
  report: {
    width: '100%',
    maxWidth: 860,
    gap: SPACING.md,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' },
  /** Pastilla 20 px; radius.xl es 16. */
  estadoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  estadoDot: { width: 7, height: 7, borderRadius: 4 },
  estadoText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  btnPdf: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: colors.surface,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.md,
    paddingVertical: 7,
  },
  btnPdfText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },
  btnEditar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.accent,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  btnEditarText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
  btnDisabled: { opacity: 0.65 },
  volverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: 6,
    paddingHorizontal: SPACING.xs,
  },
  volverText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
});

const styles = StyleSheet.create({
  ...activacionFichaStyles,
  /** 26 px: entre fontSizes[24] y fontSizes[30]. */
  tituloProducto: {
    fontSize: 26,
    fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight,
    color: colors.textStrong,
    lineHeight: 32,
    marginTop: SPACING.xs,
  },
  breadcrumb: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 6, gap: 2 },
  breadcrumbItem: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  breadcrumbSep: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.borderStrong },
  breadcrumbText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  breadcrumbMarca: { color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },

  sesionHoyBanner: {
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: radius.md,
    padding: SPACING.md,
    marginTop: SPACING.sm,
    gap: SPACING.xs,
  },
  sesionHoyHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sesionHoyTitulo: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, flex: 1 },
  sesionHoyLocal: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginTop: 2 },
  sesionHoyMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  incidenciaBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: statusColors.warning.bg,
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: RADIO_MEDIO,
    padding: SPACING.sm,
    marginTop: SPACING.sm,
  },
  incidenciaText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: '#92400e', lineHeight: 17 },

  kpiRow: { flexDirection: 'row', gap: 10, marginTop: 14, marginBottom: SPACING.xs },
  kpiRowStack: { flexDirection: 'column' },
  kpiCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: SPACING.md,
    minWidth: 0,
    ...(Platform.OS === 'web' && ({ boxShadow: '0 1px 4px rgba(15,23,42,0.06)' } as object)),
  },
  kpiIconWrap: {
    width: 28,
    height: 28,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  kpiLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 },
  kpiValor: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginTop: 3, lineHeight: 18 },

  secCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
    ...(Platform.OS === 'web' && ({ boxShadow: '0 1px 4px rgba(15,23,42,0.06)' } as object)),
  },
  secCardHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.md },
  secIconWrap: {
    width: 30,
    height: 30,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secCardTitle: {
    fontSize: typography.etiqueta.fontSize,
    fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  grid2: { flexDirection: 'row', gap: SPACING.lg },
  grid3: { flexDirection: 'row', gap: 10 },
  gridStack: { flexDirection: 'column', gap: 10 },

  campoInline: { flex: 1, minWidth: 0 },
  campoLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 },
  campoValor: { fontSize: fontSizes[13], color: colors.textStrong, marginTop: 3, lineHeight: 18, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },

  telBtns: { flexDirection: 'row', gap: 6, marginTop: SPACING.sm },
  telBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: colors.accentMuted,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  telBtnWa: { borderColor: '#86efac', backgroundColor: '#f0fdf4' },
  telBtnText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },

  bloqueCol: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
    minWidth: 0,
    ...(Platform.OS === 'web' && ({ boxShadow: '0 1px 4px rgba(15,23,42,0.06)' } as object)),
  },
  bloqueColTitulo: {
    fontSize: typography.etiqueta.fontSize,
    fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: SPACING.sm,
  },
  bloqueColTexto: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, lineHeight: 20 },
  bloqueLargoTexto: {
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    color: colors.textPrimary,
    lineHeight: 22,
    width: '100%',
  },

  materialesWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  materialChip: {
    backgroundColor: colors.navActive,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  materialText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary },

  adjGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  adjChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: '100%',
  },
  adjNombre: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, maxWidth: 220 },

  sesionesHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  gestionarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: colors.accent,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.md,
    paddingVertical: 6,
  },
  gestionarBtnText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  sesionesVacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, fontStyle: 'italic' },

  tablaSesiones: { borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, overflow: 'hidden' },
  tablaHead: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  th: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase' },
  thLocal: { flex: 2, minWidth: 0 },
  thFecha: { width: 72 },
  thHora: { width: 90 },
  thDur: { width: 40, textAlign: 'center' },
  thEstado: { width: 92, textAlign: 'right' },
  tablaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
  },
  sesionDestacadaRow: { backgroundColor: colors.accentMuted },
  td: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary },
  tdEstado: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },

  sesionCardMovil: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
    gap: SPACING.xs,
  },
  sesionCardLocal: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong },
  sesionCardMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },

  badgeMini: { borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 3 },
  badgeMiniText: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
});
