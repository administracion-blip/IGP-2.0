import { createElement } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Platform,
  type ImageStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { MantenimientoCronometroFila } from './MantenimientoCronometroFila';

export type MantenimientoIncidenciaCardProps = {
  titulo: string;
  descripcion?: string;
  categoria?: string;
  zona?: string;
  prioridadColor: string;
  prioridadLabel: string;
  fotos: string[];
  reparado: boolean;
  /** Si false, no se muestra el botón marcar reparado (p. ej. sin programar). */
  puedeReparar?: boolean;
  fechaCompletada?: string;
  /** Total de la valoración (con IVA); si viene, se muestra junto al estado. */
  valoracionTotal?: number | null;
  marcando: boolean;
  /** Segundos de trabajo de los tramos ya cerrados. */
  trabajoSegundos?: number;
  /** ISO de inicio del tramo abierto; vacío si el cronómetro está parado. */
  trabajoEnCursoDesde?: string;
  /** Petición de cronómetro en vuelo: bloquea el botón. */
  trabajoOcupado?: boolean;
  /** Si no se pasan, la tarjeta no muestra el cronómetro. */
  onIniciarTrabajo?: () => void;
  onFinalizarTrabajo?: () => void;
  onReparar: () => void;
  onVerDetalle?: () => void;
  onFotoPress: (uri: string) => void;
  resolverUriFoto: (uri: string) => string;
  formatearFecha?: (iso: string) => string;
};

function FotoTouchable({
  uri,
  style,
  onPress,
  accessibilityLabel,
}: {
  uri: string;
  style: ImageStyle | ImageStyle[];
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const flat = StyleSheet.flatten(style);
  const w = flat.width;
  const h = flat.height;

  const content =
    Platform.OS === 'web' ? (
      createElement('img', {
        src: uri,
        alt: accessibilityLabel,
        style: {
          width: w ?? '100%',
          height: h ?? 88,
          objectFit: 'cover',
          display: 'block',
          borderRadius: flat.borderRadius ?? 6,
          backgroundColor: '#e2e8f0',
        },
        onClick: (e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          onPress();
        },
      })
    ) : (
      <Image source={{ uri }} style={style} resizeMode="cover" />
    );

  if (Platform.OS === 'web') {
    return createElement(
      'div',
      {
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
        style: {
          display: 'flex',
          alignSelf: 'stretch',
          width: '100%',
          overflow: 'hidden',
          borderRadius: 6,
          cursor: 'pointer',
        },
        role: 'button',
        'aria-label': accessibilityLabel,
      },
      content,
    );
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityLabel={accessibilityLabel}
    >
      {content}
    </TouchableOpacity>
  );
}

function BloqueFotos({
  fotos,
  resolverUriFoto,
  onFotoPress,
}: {
  fotos: string[];
  resolverUriFoto: (uri: string) => string;
  onFotoPress: (uri: string) => void;
}) {
  if (fotos.length === 0) return null;

  const heroUri = resolverUriFoto(fotos[0]);
  const extra = fotos.slice(1, 3);

  return (
    <View style={styles.fotosBlock}>
      <View style={styles.fotoHeroWrap}>
        <FotoTouchable
          uri={heroUri}
          style={styles.fotoHero as ImageStyle}
          onPress={() => onFotoPress(heroUri)}
          accessibilityLabel="Ampliar foto principal"
        />
      </View>
      {extra.length > 0 ? (
        <View style={styles.fotosExtraRow}>
          {extra.map((raw, i) => {
            const uri = resolverUriFoto(raw);
            return (
              <View key={`${uri}-${i}`} style={styles.fotoExtraWrap}>
                <FotoTouchable
                  uri={uri}
                  style={styles.fotoExtra as ImageStyle}
                  onPress={() => onFotoPress(uri)}
                  accessibilityLabel="Ampliar foto"
                />
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** Item plano de incidencia (sin caja interior): franja de prioridad + contenido. */
export function MantenimientoIncidenciaCard({
  titulo,
  descripcion,
  categoria,
  zona,
  prioridadColor,
  prioridadLabel,
  fotos,
  reparado,
  puedeReparar = false,
  fechaCompletada,
  valoracionTotal,
  marcando,
  trabajoSegundos,
  trabajoEnCursoDesde,
  trabajoOcupado = false,
  onIniciarTrabajo,
  onFinalizarTrabajo,
  onReparar,
  onVerDetalle,
  onFotoPress,
  resolverUriFoto,
  formatearFecha = (iso) => iso,
}: MantenimientoIncidenciaCardProps) {
  const metaParts = [categoria, zona].filter((x) => x && x !== '—');
  const totalTxt =
    valoracionTotal != null && Number.isFinite(valoracionTotal)
      ? `${valoracionTotal.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
      : '';

  const mostrarCronometro =
    !reparado && puedeReparar && Boolean(onIniciarTrabajo || onFinalizarTrabajo);

  return (
    <View style={styles.item}>
      <View style={[styles.priorityStripe, { backgroundColor: prioridadColor }]} />
      <View style={styles.itemBody}>
        <View style={styles.titleRow}>
          <Text style={styles.itemTitle} numberOfLines={2}>
            {titulo || '—'}
          </Text>
          <Text style={[styles.prioridadLabel, { color: prioridadColor }]} numberOfLines={1}>
            {prioridadLabel}
          </Text>
        </View>

        {fotos.length > 0 ? <View style={styles.titlePhotoDivider} /> : null}

        <BloqueFotos fotos={fotos} resolverUriFoto={resolverUriFoto} onFotoPress={onFotoPress} />

        {descripcion ? (
          <Text style={styles.itemDesc} numberOfLines={2}>
            {descripcion}
          </Text>
        ) : null}

        {metaParts.length > 0 ? (
          <Text style={styles.itemMeta} numberOfLines={1}>
            {metaParts.join(' · ')}
          </Text>
        ) : null}

        {mostrarCronometro ? (
          <MantenimientoCronometroFila
            segundosAcumulados={trabajoSegundos}
            enCursoDesde={trabajoEnCursoDesde}
            ocupado={trabajoOcupado}
            onIniciar={onIniciarTrabajo}
            onFinalizar={onFinalizarTrabajo}
          />
        ) : null}

        {(reparado || puedeReparar || onVerDetalle) ? (
          <View style={[styles.actionsRow, !reparado && !puedeReparar && styles.actionsRowSoloVer]}>
            {reparado ? (
              <View style={[styles.reparadoRow, styles.actionsMain]}>
                <MaterialIcons name="check-circle" size={14} color="#0f766e" />
                <Text style={styles.reparadoText} numberOfLines={1}>
                  {totalTxt
                    ? `Valorado · ${totalTxt}`
                    : `Reparado ${fechaCompletada ? formatearFecha(fechaCompletada) : ''}`}
                </Text>
              </View>
            ) : puedeReparar ? (
              <TouchableOpacity
                onPress={onReparar}
                disabled={marcando}
                style={[styles.repararBtn, styles.actionsMain]}
                activeOpacity={0.7}
              >
                {marcando ? (
                  <ActivityIndicator size="small" color="#0f766e" />
                ) : (
                  <>
                    <MaterialIcons name="build" size={15} color="#0f766e" />
                    <Text style={styles.repararBtnText}>Marcar reparado</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}
            {onVerDetalle ? (
              <TouchableOpacity
                onPress={onVerDetalle}
                style={styles.verDetalleBtn}
                activeOpacity={0.7}
                accessibilityLabel="Ver detalle de la reparación"
              >
                <MaterialIcons name="visibility" size={18} color="#475569" />
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    minWidth: 0,
  },
  priorityStripe: {
    width: 4,
    flexShrink: 0,
    borderRadius: 2,
    marginVertical: 2,
  },
  itemBody: {
    flex: 1,
    paddingLeft: 8,
    gap: 5,
    minWidth: 0,
  },
  fotosBlock: {
    gap: 4,
    marginBottom: 2,
    alignSelf: 'stretch',
    width: '100%',
  },
  fotoHeroWrap: {
    width: '100%',
    alignSelf: 'stretch',
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#e2e8f0',
  },
  fotoHero: {
    width: '100%',
    height: 88,
    borderRadius: 6,
    backgroundColor: '#e2e8f0',
  },
  fotosExtraRow: {
    flexDirection: 'row',
    gap: 4,
  },
  fotoExtraWrap: {
    borderRadius: 6,
    overflow: 'hidden',
  },
  fotoExtra: {
    width: 44,
    height: 44,
    borderRadius: 6,
    backgroundColor: '#e2e8f0',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingBottom: 1,
  },
  titlePhotoDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#cbd5e1',
    alignSelf: 'stretch',
    marginTop: 4,
    marginBottom: 6,
    opacity: 0.85,
  },
  itemTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    minWidth: 0,
  },
  prioridadLabel: {
    fontSize: 9,
    fontWeight: '800',
    textTransform: 'uppercase',
    flexShrink: 0,
    maxWidth: 56,
  },
  itemDesc: {
    fontSize: 10,
    color: '#64748b',
    lineHeight: 14,
  },
  itemMeta: {
    fontSize: 9,
    color: '#94a3b8',
  },
  reparadoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    minWidth: 0,
  },
  reparadoText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#0d9488',
    flex: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  actionsRowSoloVer: {
    justifyContent: 'flex-end',
  },
  actionsMain: {
    flex: 1,
    minWidth: 0,
  },
  repararBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#f0fdfa',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#99f6e4',
  },
  verDetalleBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexShrink: 0,
  },
  repararBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0f766e',
  },
});
