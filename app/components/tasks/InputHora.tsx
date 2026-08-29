/**
 * Selector compacto de hora (HH:mm) para reuniones.
 * Dos desplegables [HH ▼] : [mm ▼]. Vacío permitido. No usa fetch.
 */
import { useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';

const VACIO = '';
const HORAS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTOS_BASE = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55', '59'];

function parseHhmm(value: string): { hora: string; minuto: string } | null {
  const t = value.trim();
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return { hora: String(h).padStart(2, '0'), minuto: String(min).padStart(2, '0') };
}

function componer(hora: string, minuto: string): string {
  return `${hora}:${minuto}`;
}

export function InputHora({
  value,
  onChange,
  editable = true,
  compact = false,
}: {
  value: string;
  onChange: (hhmm: string) => void;
  editable?: boolean;
  compact?: boolean;
}) {
  const { isCompact } = useBreakpoint();
  const [abierto, setAbierto] = useState<'hora' | 'minuto' | null>(null);
  const parsed = parseHhmm(value);
  const tactil = compact && isCompact;

  const minutos = useMemo(() => {
    const extra = parsed?.minuto;
    if (extra && !MINUTOS_BASE.includes(extra)) {
      return [...MINUTOS_BASE, extra].sort((a, b) => Number(a) - Number(b));
    }
    return MINUTOS_BASE;
  }, [parsed?.minuto]);

  function elegirHora(hora: string) {
    if (hora === VACIO) {
      onChange('');
    } else {
      onChange(componer(hora, parsed?.minuto ?? '00'));
    }
    setAbierto(null);
  }

  function elegirMinuto(minuto: string) {
    onChange(componer(parsed?.hora ?? '00', minuto));
    setAbierto(null);
  }

  const altoCaja = tactil ? MIN_TOUCH : compact ? 32 : 38;

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={[
          styles.caja,
          { height: altoCaja, minHeight: altoCaja },
          abierto === 'hora' && styles.cajaActiva,
          !editable && styles.cajaOff,
        ]}
        onPress={() => editable && setAbierto('hora')}
        disabled={!editable}
        accessibilityRole="button"
        accessibilityLabel="Hora"
        accessibilityHint="Abre la lista de horas"
      >
        <Text style={parsed ? styles.valor : styles.placeholder} numberOfLines={1}>
          {parsed ? parsed.hora : '—'}
        </Text>
        <MaterialIcons name="arrow-drop-down" size={20} color="#64748b" />
      </TouchableOpacity>

      <Text style={styles.separador}>:</Text>

      <TouchableOpacity
        style={[
          styles.caja,
          { height: altoCaja, minHeight: altoCaja },
          abierto === 'minuto' && styles.cajaActiva,
          !editable && styles.cajaOff,
        ]}
        onPress={() => editable && setAbierto('minuto')}
        disabled={!editable}
        accessibilityRole="button"
        accessibilityLabel="Minuto"
        accessibilityHint="Abre la lista de minutos"
      >
        <Text style={parsed ? styles.valor : styles.placeholder} numberOfLines={1}>
          {parsed ? parsed.minuto : '—'}
        </Text>
        <MaterialIcons name="arrow-drop-down" size={20} color="#64748b" />
      </TouchableOpacity>

      <Modal
        visible={abierto != null}
        transparent
        animationType="fade"
        onRequestClose={() => setAbierto(null)}
      >
        <Pressable style={styles.overlay} onPress={() => setAbierto(null)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <View style={styles.header}>
              <Text style={styles.headerText}>{abierto === 'hora' ? 'Hora' : 'Minuto'}</Text>
            </View>
            <ScrollView
              style={styles.scroll}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {abierto === 'hora' ? (
                <View style={styles.grid}>
                  <TouchableOpacity
                    style={[styles.celda, styles.celdaAncha, !parsed && styles.celdaActiva, tactil && styles.celdaTactil]}
                    onPress={() => elegirHora(VACIO)}
                    accessibilityRole="button"
                    accessibilityLabel="Sin hora"
                  >
                    <Text style={[styles.celdaTexto, !parsed && styles.celdaTextoActivo]}>Sin hora</Text>
                  </TouchableOpacity>
                  {HORAS.map((h) => {
                    const activo = parsed?.hora === h;
                    return (
                      <TouchableOpacity
                        key={h}
                        style={[styles.celda, activo && styles.celdaActiva, tactil && styles.celdaTactil]}
                        onPress={() => elegirHora(h)}
                        accessibilityRole="button"
                        accessibilityLabel={`Hora ${h}`}
                      >
                        <Text style={[styles.celdaTexto, activo && styles.celdaTextoActivo]}>{h}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : (
                <View style={styles.grid}>
                  {minutos.map((m) => {
                    const activo = parsed?.minuto === m;
                    return (
                      <TouchableOpacity
                        key={m}
                        style={[styles.celda, activo && styles.celdaActiva, tactil && styles.celdaTactil]}
                        onPress={() => elegirMinuto(m)}
                        accessibilityRole="button"
                        accessibilityLabel={`Minuto ${m}`}
                      >
                        <Text style={[styles.celdaTexto, activo && styles.celdaTextoActivo]}>{m}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    minWidth: 0,
  },
  caja: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
  },
  cajaActiva: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  cajaOff: { opacity: 0.6 },
  valor: { fontSize: 13, fontWeight: '600', color: '#334155' },
  placeholder: { fontSize: 13, color: '#94a3b8' },
  separador: { fontSize: 15, fontWeight: '700', color: '#64748b', paddingHorizontal: 2 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    width: '100%',
    maxWidth: 320,
    maxHeight: '70%',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...(Platform.OS === 'web' ? ({ boxShadow: '0 12px 32px rgba(0,0,0,0.18)' } as object) : { elevation: 12 }),
  },
  header: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerText: { fontSize: 12, fontWeight: '700', color: '#334155' },
  scroll: { maxHeight: 320 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    padding: 12,
  },
  celda: {
    width: '22%',
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  celdaAncha: { width: '100%', flexGrow: 0 },
  celdaTactil: { minHeight: MIN_TOUCH },
  celdaActiva: { borderColor: '#0ea5e9', backgroundColor: '#e0f2fe' },
  celdaTexto: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  celdaTextoActivo: { color: '#0369a1' },
});
