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
          <MaterialIcons name={icon} size={16} color="#0ea5e9" />
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
        <MaterialIcons name={icon} size={15} color="#0ea5e9" />
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
            <MaterialIcons name="today" size={16} color="#0369a1" />
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
              <MaterialIcons name="warning-amber" size={15} color="#d97706" />
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
                  <MaterialIcons name="call" size={14} color="#0ea5e9" />
                  <Text style={styles.telBtnText}>Llamar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.telBtn, styles.telBtnWa]} onPress={whatsApp}>
                  <MaterialIcons name="chat" size={14} color="#16a34a" />
                  <Text style={[styles.telBtnText, { color: '#16a34a' }]}>WA</Text>
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
                <MaterialIcons name="insert-drive-file" size={15} color="#0ea5e9" />
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
              <MaterialIcons name="storefront" size={16} color="#0ea5e9" />
            </View>
            <Text style={styles.secCardTitle}>Sesiones ({sesiones.length})</Text>
          </View>
          {puedeGestionar && onGestionarSesiones ? (
            <TouchableOpacity style={styles.gestionarBtn} onPress={onGestionarSesiones}>
              <MaterialIcons name="edit-calendar" size={14} color="#fff" />
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
                      <MaterialIcons name="warning-amber" size={14} color="#d97706" style={{ marginRight: 4 }} />
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

export const activacionFichaStyles = StyleSheet.create({
  report: {
    width: '100%',
    maxWidth: 860,
    gap: 12,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  estadoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  estadoDot: { width: 7, height: 7, borderRadius: 4 },
  estadoText: { fontSize: 12, fontWeight: '700' },
  btnPdf: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  btnPdfText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  btnEditar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  btnEditarText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  btnDisabled: { opacity: 0.65 },
  volverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  volverText: { fontSize: 13, fontWeight: '600', color: '#475569' },
});

const styles = StyleSheet.create({
  ...activacionFichaStyles,
  tituloProducto: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0f172a',
    lineHeight: 32,
    marginTop: 4,
  },
  breadcrumb: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 6, gap: 2 },
  breadcrumbItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  breadcrumbSep: { fontSize: 12, color: '#cbd5e1' },
  breadcrumbText: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  breadcrumbMarca: { color: '#64748b', fontWeight: '500' },

  sesionHoyBanner: {
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    gap: 4,
  },
  sesionHoyHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sesionHoyTitulo: { fontSize: 12, fontWeight: '700', color: '#0369a1', flex: 1 },
  sesionHoyLocal: { fontSize: 14, fontWeight: '700', color: '#0f172a', marginTop: 2 },
  sesionHoyMeta: { fontSize: 12, color: '#64748b' },
  incidenciaBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    padding: 8,
    marginTop: 8,
  },
  incidenciaText: { flex: 1, fontSize: 12, color: '#92400e', lineHeight: 17 },

  kpiRow: { flexDirection: 'row', gap: 10, marginTop: 14, marginBottom: 4 },
  kpiRowStack: { flexDirection: 'column' },
  kpiCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    minWidth: 0,
    ...(Platform.OS === 'web' && ({ boxShadow: '0 1px 4px rgba(15,23,42,0.06)' } as object)),
  },
  kpiIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  kpiLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 },
  kpiValor: { fontSize: 13, fontWeight: '700', color: '#0f172a', marginTop: 3, lineHeight: 18 },

  secCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 14,
    ...(Platform.OS === 'web' && ({ boxShadow: '0 1px 4px rgba(15,23,42,0.06)' } as object)),
  },
  secCardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  secIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secCardTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  grid2: { flexDirection: 'row', gap: 16 },
  grid3: { flexDirection: 'row', gap: 10 },
  gridStack: { flexDirection: 'column', gap: 10 },

  campoInline: { flex: 1, minWidth: 0 },
  campoLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 },
  campoValor: { fontSize: 13, color: '#0f172a', marginTop: 3, lineHeight: 18, fontWeight: '500' },

  telBtns: { flexDirection: 'row', gap: 6, marginTop: 8 },
  telBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  telBtnWa: { borderColor: '#86efac', backgroundColor: '#f0fdf4' },
  telBtnText: { fontSize: 11, fontWeight: '600', color: '#0ea5e9' },

  bloqueCol: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 14,
    minWidth: 0,
    ...(Platform.OS === 'web' && ({ boxShadow: '0 1px 4px rgba(15,23,42,0.06)' } as object)),
  },
  bloqueColTitulo: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  bloqueColTexto: { fontSize: 13, color: '#334155', lineHeight: 20 },
  bloqueLargoTexto: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 22,
    width: '100%',
  },

  materialesWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  materialChip: {
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  materialText: { fontSize: 11, color: '#334155' },

  adjGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  adjChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: '100%',
  },
  adjNombre: { fontSize: 12, color: '#0ea5e9', fontWeight: '500', maxWidth: 220 },

  sesionesHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    flexWrap: 'wrap',
    gap: 8,
  },
  gestionarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  gestionarBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  sesionesVacio: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },

  tablaSesiones: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden' },
  tablaHead: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  th: { fontSize: 10, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  thLocal: { flex: 2, minWidth: 0 },
  thFecha: { width: 72 },
  thHora: { width: 90 },
  thDur: { width: 40, textAlign: 'center' },
  thEstado: { width: 92, textAlign: 'right' },
  tablaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  sesionDestacadaRow: { backgroundColor: '#f0f9ff' },
  td: { fontSize: 12, color: '#334155' },
  tdEstado: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },

  sesionCardMovil: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 4,
  },
  sesionCardLocal: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  sesionCardMeta: { fontSize: 12, color: '#64748b' },

  badgeMini: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  badgeMiniText: { fontSize: 10, fontWeight: '700' },
});
