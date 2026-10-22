import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  TextInput,
  Image,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import {
  puedeVerActuacionesPlanning,
  puedeEditarSeguimientoActuacion,
  puedeFirmarActuacion,
} from '../../lib/permisosModulos';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { formatId6 } from '../../utils/idFormat';
import { formatMoneda } from '../../utils/facturacion';
import { apiFetch } from '../../utils/api';
import { FirmaEnPantallaModal } from '../../components/FirmaEnPantallaModal';
import { buildFirmaFormData } from '../../utils/uploadFirmaPng';

type Actuacion = {
  id_actuacion: string;
  id_artista?: string;
  fecha?: string;
  hora_inicio?: string;
  hora_fin?: string;
  artista_nombre_snapshot?: string;
  local_nombre_snapshot?: string;
  id_local?: string;
  importe_previsto?: number | null;
  importe_final?: number | null;
  estado?: string;
  firma_artista_key?: string;
  fecha_firma?: string;
  observaciones?: string;
  valoracion?: number | null;
};

type LocalItem = { id_Locales?: string; nombre?: string; Nombre?: string };

type Artista = {
  id_artista: string;
  nombre_artistico?: string;
  componentes?: number;
  estilos_musicales?: string[];
  tipo_artista?: string[];
  telefono_contacto?: string;
  email_contacto?: string;
  observaciones?: string;
  valoracion_media?: number | null;
  valoracion_total?: number | null;
};

function num(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hoyIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysIso(iso: string, delta: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function formatFechaLargaEs(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const meses = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const d = new Date(iso + 'T12:00:00');
  const dayName = dias[d.getDay()] ?? '';
  const cap = dayName ? dayName.charAt(0).toUpperCase() + dayName.slice(1) : '';
  return `${cap}, ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

function minutosHoraInicio(hora: string | undefined): number {
  const s = String(hora ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 24 * 60 + 999;
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return hh * 60 + mm;
}

function importeMusico(a: Actuacion): number {
  if (a.importe_final != null && !Number.isNaN(Number(a.importe_final))) return num(a.importe_final);
  return num(a.importe_previsto);
}

/** Dígitos para enlace de WhatsApp (asume España si no hay prefijo). */
function telParaWhatsapp(tel: string): string {
  const digits = String(tel || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('34')) return digits;
  if (digits.length === 9) return `34${digits}`;
  return digits;
}

export default function PlanningActuacionesScreen() {
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const { shouldStackPanels } = useBreakpoint();
  const puedeVer = puedeVerActuacionesPlanning(hasPermiso);
  const puedeEditarSeguimiento = puedeEditarSeguimientoActuacion(hasPermiso);
  const puedeFirmar = puedeFirmarActuacion(hasPermiso);

  const [diaSeleccionado, setDiaSeleccionado] = useState<string>(() => fechaJornadaNegocioIso());
  const [actuaciones, setActuaciones] = useState<Actuacion[]>([]);
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [artista, setArtista] = useState<Artista | null>(null);
  const [artistaImg, setArtistaImg] = useState<string | null>(null);
  const [loadingArtista, setLoadingArtista] = useState(false);

  const [obsDraft, setObsDraft] = useState('');
  const [valoracionDraft, setValoracionDraft] = useState(0);
  const [guardando, setGuardando] = useState(false);

  const [modalFirma, setModalFirma] = useState(false);
  const [firmaSubiendo, setFirmaSubiendo] = useState(false);
  const [confirmCerrar, setConfirmCerrar] = useState(false);

  const diaRef = useRef(diaSeleccionado);
  diaRef.current = diaSeleccionado;

  const esAdminOSinRestriccion = useMemo(
    () => user?.Rol === 'Administrador' || !user?.Locales || user.Locales.length === 0,
    [user],
  );

  const idsLocalesPermitidos = useMemo(() => {
    if (esAdminOSinRestriccion) return null; // null = sin filtro (todos)
    const permitidosLower = new Set((user?.Locales ?? []).map((l) => l.toLowerCase()));
    return locales
      .filter((l) => permitidosLower.has(String(l.nombre ?? l.Nombre ?? '').toLowerCase()))
      .map((l) => formatId6(String(l.id_Locales ?? '')))
      .filter(Boolean);
  }, [esAdminOSinRestriccion, locales, user]);

  const cargarLocales = useCallback(() => {
    apiFetch('/api/locales?minimal=1')
      .then((r) => r.json())
      .then((d: { locales?: LocalItem[] }) => setLocales(Array.isArray(d.locales) ? d.locales : []))
      .catch(() => setLocales([]));
  }, []);

  const cargarActuaciones = useCallback(
    async (fecha: string) => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams();
      qs.set('fechaDesde', fecha);
      qs.set('fechaHasta', fecha);
      if (idsLocalesPermitidos != null) {
        if (idsLocalesPermitidos.length === 0) {
          setActuaciones([]);
          setLoading(false);
          return;
        }
        qs.set('id_locales', idsLocalesPermitidos.join(','));
      }
      try {
        const r = await apiFetch(`/api/actuaciones?${qs.toString()}`);
        const d = await r.json();
        if (d.error) setError(d.error);
        setActuaciones(Array.isArray(d.actuaciones) ? d.actuaciones : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error de red');
        setActuaciones([]);
      } finally {
        setLoading(false);
      }
    },
    [idsLocalesPermitidos],
  );

  useFocusEffect(
    useCallback(() => {
      cargarLocales();
    }, [cargarLocales]),
  );

  useEffect(() => {
    void cargarActuaciones(diaSeleccionado);
  }, [diaSeleccionado, cargarActuaciones]);

  const agrupado = useMemo(() => {
    const map = new Map<string, { idKey: string; nombreLocal: string; acts: Actuacion[] }>();
    for (const a of actuaciones) {
      const idKey = formatId6(String(a.id_local ?? ''));
      const nombreLocal = (a.local_nombre_snapshot?.trim() || idKey || 'Local').toString();
      if (!map.has(idKey || '_')) {
        map.set(idKey || '_', { idKey: idKey || '_', nombreLocal, acts: [] });
      }
      map.get(idKey || '_')!.acts.push(a);
    }
    const list = [...map.values()];
    list.sort((a, b) => a.nombreLocal.localeCompare(b.nombreLocal, 'es', { sensitivity: 'base' }));
    for (const g of list) {
      g.acts.sort((x, y) => minutosHoraInicio(x.hora_inicio) - minutosHoraInicio(y.hora_inicio));
    }
    return list;
  }, [actuaciones]);

  const totalDia = useMemo(
    () => actuaciones.reduce((s, a) => s + importeMusico(a), 0),
    [actuaciones],
  );
  const pendientesFirma = useMemo(
    () => actuaciones.filter((a) => !a.firma_artista_key?.trim()).length,
    [actuaciones],
  );

  const detalle = useMemo(
    () => actuaciones.find((a) => a.id_actuacion === detalleId) ?? null,
    [actuaciones, detalleId],
  );

  const esFutura = detalle ? String(detalle.fecha ?? '') > hoyIsoLocal() : false;
  const hayCambios = detalle
    ? obsDraft !== (detalle.observaciones ?? '') || valoracionDraft !== num(detalle.valoracion)
    : false;

  const abrirDetalle = useCallback(async (a: Actuacion) => {
    setDetalleId(a.id_actuacion);
    setObsDraft(a.observaciones ?? '');
    setValoracionDraft(num(a.valoracion));
    setArtista(null);
    setArtistaImg(null);
    const idArt = String(a.id_artista ?? '').trim();
    if (!idArt) return;
    setLoadingArtista(true);
    try {
      const [rArt, rImg] = await Promise.all([
        apiFetch(`/api/artistas/${idArt}`),
        apiFetch(`/api/artistas/${idArt}/imagen-url`),
      ]);
      const dArt = await rArt.json();
      const dImg = await rImg.json().catch(() => ({ url: null }));
      setArtista(dArt.artista ?? null);
      setArtistaImg(dImg?.url ?? null);
    } catch {
      setArtista(null);
    } finally {
      setLoadingArtista(false);
    }
  }, []);

  const cerrarDetalle = useCallback(() => {
    if (hayCambios) {
      setConfirmCerrar(true);
      return;
    }
    setDetalleId(null);
  }, [hayCambios]);

  const guardarSeguimiento = useCallback(async () => {
    if (!detalle) return;
    setGuardando(true);
    try {
      const r = await apiFetch(`/api/actuaciones/item/${detalle.id_actuacion}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          observaciones: obsDraft,
          valoracion: valoracionDraft > 0 ? valoracionDraft : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'No se pudo guardar');
        return;
      }
      setActuaciones((prev) =>
        prev.map((a) => (a.id_actuacion === detalle.id_actuacion ? { ...a, ...d.actuacion } : a)),
      );
      // Refrescar media del artista para mostrarla actualizada.
      const idArt = String(detalle.id_artista ?? '').trim();
      if (idArt) {
        apiFetch(`/api/artistas/${idArt}`)
          .then((rr) => rr.json())
          .then((dd) => setArtista(dd.artista ?? null))
          .catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setGuardando(false);
    }
  }, [detalle, obsDraft, valoracionDraft]);

  const enviarFirma = useCallback(
    async (base64Raw: string) => {
      if (!detalle) return;
      setFirmaSubiendo(true);
      try {
        const formData = await buildFirmaFormData(base64Raw);
        const r = await apiFetch(`/api/actuaciones/item/${detalle.id_actuacion}/firma`, {
          method: 'POST',
          body: formData,
        });
        const d = await r.json();
        if (!r.ok) {
          setError(d.error || 'No se pudo guardar la firma');
          return;
        }
        setActuaciones((prev) =>
          prev.map((a) => (a.id_actuacion === detalle.id_actuacion ? { ...a, ...d.actuacion } : a)),
        );
        setModalFirma(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error de red');
      } finally {
        setFirmaSubiendo(false);
      }
    },
    [detalle],
  );

  /** Contenido del detalle (cabecera + cuerpo + pie) para la ventana flotante. */
  function renderDetalleCard() {
    return (
      <>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle} numberOfLines={1}>
            {detalle?.artista_nombre_snapshot?.trim() || 'Actuación'}
          </Text>
          <TouchableOpacity onPress={cerrarDetalle} hitSlop={12} style={styles.cerrarIconBtn}>
            <MaterialIcons name="close" size={24} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.modalBody}>
          <View style={styles.infoBox}>
            <View style={styles.infoRow}>
              <MaterialIcons name="event" size={18} color={colors.textMuted} />
              <Text style={styles.infoText}>
                {detalle ? formatFechaLargaEs(String(detalle.fecha ?? '')) : ''} · {detalle?.hora_inicio || '—'}
                {detalle?.hora_fin ? `–${detalle.hora_fin}` : ''}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <MaterialIcons name="place" size={18} color={colors.textMuted} />
              <Text style={styles.infoText}>{detalle?.local_nombre_snapshot || '—'}</Text>
            </View>
            <View style={styles.infoRow}>
              <MaterialIcons name="payments" size={18} color={colors.textMuted} />
              <Text style={styles.infoText}>{formatMoneda(importeMusico(detalle ?? {} as Actuacion))}</Text>
            </View>
          </View>

          <Text style={styles.seccionLabel}>Músico</Text>
          {loadingArtista ? (
            <ActivityIndicator color={colors.accent} style={{ marginVertical: 10 }} />
          ) : (
            <View style={styles.musicoBox}>
              {artistaImg ? (
                <Image source={{ uri: artistaImg }} style={styles.musicoFoto} />
              ) : (
                <View style={[styles.musicoFoto, styles.musicoFotoVacia]}>
                  <MaterialIcons name="person" size={36} color={colors.textMuted} />
                </View>
              )}
              <View style={styles.musicoDatos}>
                <Text style={styles.musicoNombre}>{artista?.nombre_artistico || detalle?.artista_nombre_snapshot || '—'}</Text>
                {artista?.componentes ? (
                  <Text style={styles.musicoMeta}>{artista.componentes} componente(s)</Text>
                ) : null}
                {artista?.estilos_musicales?.length ? (
                  <Text style={styles.musicoMeta}>{artista.estilos_musicales.join(', ')}</Text>
                ) : null}
                {artista?.valoracion_media != null ? (
                  <View style={styles.mediaRow}>
                    <MaterialIcons name="star" size={15} color="#f59e0b" />
                    <Text style={styles.mediaText}>
                      Media {artista.valoracion_media.toFixed(1)} ({artista.valoracion_total ?? 0})
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          )}

          {(artista?.telefono_contacto || artista?.email_contacto) ? (
            <View style={styles.contactoRow}>
              {artista?.telefono_contacto ? (
                <>
                  <TouchableOpacity
                    style={styles.contactoBtn}
                    onPress={() => Linking.openURL(`tel:${artista.telefono_contacto}`)}
                  >
                    <MaterialIcons name="call" size={20} color={statusColors.info.text} />
                    <Text style={styles.contactoBtnText}>Llamar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.contactoBtn}
                    onPress={() => Linking.openURL(`https://wa.me/${telParaWhatsapp(artista.telefono_contacto!)}`)}
                  >
                    <MaterialIcons name="chat" size={20} color={colors.success} />
                    <Text style={styles.contactoBtnText}>WhatsApp</Text>
                  </TouchableOpacity>
                </>
              ) : null}
              {artista?.email_contacto ? (
                <TouchableOpacity
                  style={styles.contactoBtn}
                  onPress={() => Linking.openURL(`mailto:${artista.email_contacto}`)}
                >
                  <MaterialIcons name="mail" size={20} color={colors.textMuted} />
                  <Text style={styles.contactoBtnText}>Email</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.seccionLabel}>Firma</Text>
          {detalle?.firma_artista_key?.trim() ? (
            <View style={styles.firmaOkRow}>
              <MaterialIcons name="verified" size={18} color={colors.success} />
              <Text style={styles.firmaOkText}>Actuación firmada</Text>
            </View>
          ) : null}
          <TouchableOpacity
            style={[styles.firmaBtn, (esFutura || !puedeFirmar) && styles.btnDisabled]}
            disabled={esFutura || !puedeFirmar}
            onPress={() => setModalFirma(true)}
          >
            <MaterialIcons name="draw" size={24} color={esFutura ? colors.textMuted : colors.surface} />
            <Text style={[styles.firmaBtnText, esFutura && styles.firmaBtnTextDisabled]}>
              {detalle?.firma_artista_key?.trim() ? 'Volver a firmar' : 'Firmar actuación'}
            </Text>
          </TouchableOpacity>
          {esFutura ? (
            <Text style={styles.hint}>La firma solo está disponible el día de la actuación o después.</Text>
          ) : null}

          <Text style={styles.seccionLabel}>Valoración</Text>
          <View style={styles.estrellasRow}>
            {[1, 2, 3, 4, 5].map((n) => (
              <TouchableOpacity
                key={n}
                onPress={() => puedeEditarSeguimiento && setValoracionDraft((prev) => (prev === n ? 0 : n))}
                hitSlop={8}
                style={styles.estrellaBtn}
                disabled={!puedeEditarSeguimiento}
              >
                <MaterialIcons
                  name={n <= valoracionDraft ? 'star' : 'star-border'}
                  size={40}
                  color={n <= valoracionDraft ? '#f59e0b' : colors.borderStrong}
                />
              </TouchableOpacity>
            ))}
            {valoracionDraft > 0 ? (
              <Text style={styles.estrellasValor}>{valoracionDraft}/5</Text>
            ) : null}
          </View>

          <Text style={styles.seccionLabel}>Observaciones</Text>
          <TextInput
            style={styles.obsInput}
            value={obsDraft}
            onChangeText={setObsDraft}
            placeholder="Notas sobre la actuación…"
            placeholderTextColor={colors.textMuted}
            multiline
            editable={puedeEditarSeguimiento}
          />
        </ScrollView>

        <View style={styles.modalFooter}>
          <TouchableOpacity style={styles.cancelarBtn} onPress={cerrarDetalle} disabled={guardando}>
            <Text style={styles.cancelarBtnText}>Cerrar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.guardarBtn, (!puedeEditarSeguimiento || !hayCambios || guardando) && styles.btnDisabled]}
            onPress={guardarSeguimiento}
            disabled={!puedeEditarSeguimiento || !hayCambios || guardando}
          >
            {guardando ? (
              <ActivityIndicator color={colors.surface} size="small" />
            ) : (
              <Text style={styles.guardarBtnText}>Guardar</Text>
            )}
          </TouchableOpacity>
        </View>
      </>
    );
  }

  const listaSection = (
    loading ? (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
      </View>
    ) : (
      <ScrollView style={styles.lista} contentContainerStyle={styles.listaContent}>
        {agrupado.length === 0 ? (
          <Text style={styles.vacia}>No hay actuaciones este día.</Text>
        ) : (
          agrupado.map((grupo) => (
            <View key={grupo.idKey} style={styles.bloqueLocal}>
              <View style={styles.localHeader}>
                <MaterialIcons name="place" size={18} color={colors.accent} />
                <Text style={styles.localNombre} numberOfLines={1}>
                  {grupo.nombreLocal.toUpperCase()}
                </Text>
                <View style={styles.localCountBadge}>
                  <Text style={styles.localCountText}>{grupo.acts.length}</Text>
                </View>
              </View>
              {grupo.acts.map((a) => {
                const art = a.artista_nombre_snapshot?.trim() || '—';
                const inicial = art.charAt(0).toUpperCase() || '?';
                const firmada = !!a.firma_artista_key?.trim();
                const valorada = num(a.valoracion) > 0;
                const conObs = !!a.observaciones?.trim();
                return (
                  <TouchableOpacity
                    key={a.id_actuacion}
                    style={styles.fila}
                    onPress={() => abrirDetalle(a)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.filaHora}>{a.hora_inicio?.trim() || '—'}</Text>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{inicial}</Text>
                    </View>
                    <View style={styles.filaTextos}>
                      <Text style={styles.filaArtista} numberOfLines={1}>{art}</Text>
                      <View style={styles.badgesRow}>
                        <MaterialIcons
                          name={firmada ? 'check-circle' : 'radio-button-unchecked'}
                          size={15}
                          color={firmada ? colors.success : colors.borderStrong}
                        />
                        <Text style={styles.badgeMini}>{firmada ? 'Firmada' : 'Sin firmar'}</Text>
                        {valorada ? (
                          <>
                            <MaterialIcons name="star" size={15} color="#f59e0b" />
                            <Text style={styles.badgeMini}>{num(a.valoracion)}</Text>
                          </>
                        ) : null}
                        {conObs ? <MaterialIcons name="sticky-note-2" size={15} color={colors.textMuted} /> : null}
                      </View>
                    </View>
                    <Text style={styles.filaImporte}>{formatMoneda(importeMusico(a))}</Text>
                    <MaterialIcons name="chevron-right" size={22} color={colors.borderStrong} />
                  </TouchableOpacity>
                );
              })}
            </View>
          ))
        )}
      </ScrollView>
    )
  );

  return (
    <View style={styles.outer}>
      {!puedeVer ? (
        <View style={styles.emptyBox}>
          <MaterialIcons name="lock-outline" size={28} color={colors.textMuted} />
          <Text style={styles.emptyText}>No tienes permiso para ver las actuaciones del día.</Text>
        </View>
      ) : (
        <>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/planning-dia' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Actuaciones del día</Text>
          <Text style={styles.subtitle}>Músicos que actúan, firma y valoración</Text>
        </View>
      </View>

      <View style={styles.fechaNav}>
        <TouchableOpacity
          onPress={() => setDiaSeleccionado((d) => addDaysIso(d, -1))}
          style={styles.fechaNavBtn}
        >
          <MaterialIcons name="chevron-left" size={30} color={colors.accent} />
        </TouchableOpacity>
        <View style={styles.fechaNavCenter}>
          <Text style={styles.fechaNavTitulo} numberOfLines={2}>
            {formatFechaLargaEs(diaSeleccionado)}
          </Text>
          <TouchableOpacity onPress={() => setDiaSeleccionado(fechaJornadaNegocioIso())} style={styles.hoyLink}>
            <Text style={styles.hoyLinkText}>Hoy</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={() => setDiaSeleccionado((d) => addDaysIso(d, 1))}
          style={styles.fechaNavBtn}
        >
          <MaterialIcons name="chevron-right" size={30} color={colors.accent} />
        </TouchableOpacity>
      </View>

      <View style={styles.resumenRow}>
        <View style={styles.resumenChip}>
          <MaterialIcons name="mic" size={16} color={statusColors.info.text} />
          <Text style={styles.resumenChipText}>{actuaciones.length} actuación(es)</Text>
        </View>
        {pendientesFirma > 0 ? (
          <View style={[styles.resumenChip, styles.resumenChipWarn]}>
            <MaterialIcons name="draw" size={16} color={statusColors.warning.text} />
            <Text style={[styles.resumenChipText, styles.resumenChipTextWarn]}>
              {pendientesFirma} sin firmar
            </Text>
          </View>
        ) : null}
        <View style={[styles.resumenChip, styles.resumenChipTotal]}>
          <Text style={styles.resumenChipText}>Total músicos: {formatMoneda(totalDia)}</Text>
        </View>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {listaSection}

      <Modal visible={!!detalleId} transparent animationType="fade" onRequestClose={cerrarDetalle}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, shouldStackPanels && styles.modalCardFull]}>
            {renderDetalleCard()}
          </View>
        </View>
      </Modal>

      <FirmaEnPantallaModal
        visible={modalFirma}
        uploading={firmaSubiendo}
        onClose={() => { if (!firmaSubiendo) setModalFirma(false); }}
        onConfirm={(base64) => void enviarFirma(base64)}
      />

      {/* Aviso de cambios sin guardar */}
      <Modal visible={confirmCerrar} transparent animationType="fade" onRequestClose={() => setConfirmCerrar(false)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Cambios sin guardar</Text>
            <Text style={styles.confirmText}>Tienes cambios sin guardar en esta actuación. ¿Salir sin guardar?</Text>
            <View style={styles.confirmBtns}>
              <TouchableOpacity style={styles.cancelarBtn} onPress={() => setConfirmCerrar(false)}>
                <Text style={styles.cancelarBtnText}>Seguir editando</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.salirBtn}
                onPress={() => { setConfirmCerrar(false); setDetalleId(null); }}
              >
                <Text style={styles.salirBtnText}>Salir</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
        </>
      )}
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;
/** Entre radius.lg (12) y radius.xl (16). */
const RADIO_TARJETA = 14;

const styles = StyleSheet.create({
  outer: { flex: 1, padding: SPACING.md, backgroundColor: colors.border },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  backBtn: {
    width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: radius.md, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border,
  },
  title: { fontSize: fontSizes[20], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, marginTop: 2 },
  fechaNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radius.lg, paddingHorizontal: 6, paddingVertical: SPACING.xs,
    borderWidth: 1, borderColor: colors.border, marginBottom: SPACING.sm,
  },
  fechaNavBtn: {
    width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  fechaNavCenter: { flex: 1, alignItems: 'center', minWidth: 0 },
  fechaNavTitulo: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary, textAlign: 'center' },
  hoyLink: { marginTop: 2, paddingVertical: 2, paddingHorizontal: 8 },
  hoyLinkText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  resumenRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.sm },
  resumenChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentMuted, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.md,
  },
  resumenChipWarn: { backgroundColor: statusColors.warning.bg },
  resumenChipTotal: { backgroundColor: statusColors.success.bg },
  resumenChipText: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text },
  resumenChipTextWarn: { color: statusColors.warning.text },
  error: { color: statusColors.danger.text, fontFamily: fontFamily.regular, fontSize: fontSizes[12], marginBottom: 6 },
  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingVertical: 40 },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center' },
  loading: { paddingVertical: 30, alignItems: 'center' },

  lista: { flex: 1, minHeight: 0 },
  listaContent: { paddingBottom: 16 },
  vacia: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, fontStyle: 'italic', paddingVertical: SPACING.lg, textAlign: 'center' },
  bloqueLocal: {
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: 10, marginBottom: 10,
  },
  localHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  localNombre: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text, flex: 1 },
  localCountBadge: {
    backgroundColor: colors.accentMuted,
    borderRadius: radius.md,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  localCountText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text },
  fila: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: SPACING.md, paddingHorizontal: 6,
    borderTopWidth: 1, borderTopColor: colors.navActive, borderRadius: RADIO_MEDIO, minHeight: MIN_TOUCH + 14,
  },
  filaHora: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.accent, width: 48, flexShrink: 0, fontVariant: ['tabular-nums'] },
  /** Círculo 40×40; radius.xl es 16. */
  avatar: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentMuted,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  avatarText: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.info.text },
  filaTextos: { flex: 1, minWidth: 0 },
  filaArtista: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong },
  badgesRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: 3 },
  badgeMini: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },
  filaImporte: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, flexShrink: 0, fontVariant: ['tabular-nums'] },

  /** Más oscuro que colors.overlay. */
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: SPACING.md },
  modalCard: {
    backgroundColor: colors.surface, borderRadius: radius.xl, maxWidth: 540, width: '100%',
    alignSelf: 'center', maxHeight: '90%', overflow: 'hidden',
  },
  modalCardFull: { maxWidth: '100%', maxHeight: '94%' },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: SPACING.md, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  /** 17 px: entre fontSizes[16] y fontSizes[18]. */
  modalTitle: { fontSize: 17, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, flex: 1, marginRight: SPACING.sm },
  cerrarIconBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  modalBody: { padding: 14, gap: SPACING.xs },
  infoBox: { backgroundColor: colors.bg, borderRadius: radius.md, padding: 10, gap: SPACING.sm, marginBottom: 6 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  infoText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, flex: 1 },
  seccionLabel: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, marginTop: 14, marginBottom: 6, textTransform: 'uppercase' },
  musicoBox: { flexDirection: 'row', gap: SPACING.md, alignItems: 'center' },
  musicoFoto: { width: 72, height: 72, borderRadius: radius.lg, backgroundColor: colors.border },
  musicoFotoVacia: { alignItems: 'center', justifyContent: 'center' },
  musicoDatos: { flex: 1, minWidth: 0 },
  musicoNombre: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  musicoMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, marginTop: 1 },
  mediaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: 3 },
  mediaText: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.warning.text },
  contactoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: 10 },
  contactoBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.navActive,
    paddingHorizontal: 14, borderRadius: radius.md, minHeight: MIN_TOUCH,
  },
  contactoBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  firmaOkRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: SPACING.sm },
  firmaOkText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.success },
  firmaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.accent, borderRadius: radius.lg, minHeight: MIN_TOUCH + 26, paddingHorizontal: SPACING.lg,
  },
  /** 17 px: entre fontSizes[16] y fontSizes[18]. */
  firmaBtnText: { fontSize: 17, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
  firmaBtnTextDisabled: { color: colors.textMuted },
  btnDisabled: { backgroundColor: colors.border },
  hint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontStyle: 'italic', marginTop: 6 },
  estrellasRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  estrellaBtn: { padding: 2 },
  estrellasValor: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: statusColors.warning.text, marginLeft: SPACING.sm },
  obsInput: {
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, padding: 10,
    minHeight: 90, fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textStrong, textAlignVertical: 'top',
  },
  modalFooter: {
    flexDirection: 'row', gap: 10, padding: SPACING.md, borderTopWidth: 1, borderTopColor: colors.border,
  },
  cancelarBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.borderStrong, minHeight: MIN_TOUCH + 4,
  },
  cancelarBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  guardarBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
    backgroundColor: colors.success, minHeight: MIN_TOUCH + 4,
  },
  guardarBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
  /** Más oscuro que colors.overlay. */
  confirmOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: SPACING.xl },
  confirmCard: { backgroundColor: colors.surface, borderRadius: RADIO_TARJETA, padding: 18, maxWidth: 380, width: '100%', alignSelf: 'center' },
  confirmTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, marginBottom: SPACING.sm },
  confirmText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, marginBottom: SPACING.lg },
  confirmBtns: { flexDirection: 'row', gap: 10 },
  salirBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
    backgroundColor: colors.danger, minHeight: MIN_TOUCH + 4,
  },
  salirBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
});
