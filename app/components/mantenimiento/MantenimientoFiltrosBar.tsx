import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { RangoFechas } from '../RangoFechas';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import {
  type ChipPeriodoMantenimiento,
  type ContadoresMantenimientoFiltros,
  ESTADOS_MANTENIMIENTO,
  detectarChipPeriodo,
  rangoChipPeriodo,
} from '../../lib/mantenimientoFiltros';

type LocalOption = { id: string; nombre: string };

type Props = {
  fechaDesde: string;
  fechaHasta: string;
  onFechaDesdeChange: (iso: string) => void;
  onFechaHastaChange: (iso: string) => void;
  chipPeriodo: ChipPeriodoMantenimiento;
  onChipPeriodoChange: (chip: ChipPeriodoMantenimiento) => void;
  localIds: string[];
  onLocalIdsChange: (ids: string[]) => void;
  locales: LocalOption[];
  estados: string[];
  onEstadosChange: (estados: string[]) => void;
  totalFiltrado?: number;
  totalSinFiltrar?: number;
  contadores?: ContadoresMantenimientoFiltros;
};

function ChipLabel({
  label,
  count,
  activo,
}: {
  label: string;
  count?: number;
  activo: boolean;
}) {
  return (
    <Text style={[styles.chipText, activo && styles.chipTextActive]}>
      {label}
      {count !== undefined ? (
        <Text style={[styles.chipCount, activo && styles.chipCountActive]}> {count}</Text>
      ) : null}
    </Text>
  );
}

function ChipLabelEstado({
  label,
  count,
  activo,
}: {
  label: string;
  count?: number;
  activo: boolean;
}) {
  return (
    <Text style={[styles.chipEstadoText, activo && styles.chipEstadoTextActive]}>
      {label}
      {count !== undefined ? (
        <Text style={[styles.chipEstadoCount, activo && styles.chipEstadoCountActive]}> {count}</Text>
      ) : null}
    </Text>
  );
}

const CHIPS_PERIODO: { id: Exclude<ChipPeriodoMantenimiento, null>; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'semana_pasada', label: 'Semana pasada' },
  { id: 'proxima_semana', label: 'Próxima semana' },
  { id: 'mes_curso', label: 'Mes en curso' },
  { id: 'anio_curso', label: 'Año en curso' },
];

export function MantenimientoFiltrosBar({
  fechaDesde,
  fechaHasta,
  onFechaDesdeChange,
  onFechaHastaChange,
  chipPeriodo,
  onChipPeriodoChange,
  localIds,
  onLocalIdsChange,
  locales,
  estados,
  onEstadosChange,
  totalFiltrado,
  totalSinFiltrar,
  contadores,
}: Props) {
  const { shouldStackToolbar, isCompact } = useBreakpoint();
  const [modalLocalesVisible, setModalLocalesVisible] = useState(false);
  const [draftLocalIds, setDraftLocalIds] = useState<string[]>([]);

  const aplicarChipPeriodo = useCallback(
    (chip: Exclude<ChipPeriodoMantenimiento, null>) => {
      const r = rangoChipPeriodo(chip);
      onChipPeriodoChange(chip);
      onFechaDesdeChange(r.desde);
      onFechaHastaChange(r.hasta);
    },
    [onChipPeriodoChange, onFechaDesdeChange, onFechaHastaChange],
  );

  const handleRangoChange = useCallback(
    (desde: string, hasta: string) => {
      onFechaDesdeChange(desde);
      onFechaHastaChange(hasta);
      onChipPeriodoChange(detectarChipPeriodo(desde, hasta));
    },
    [onFechaDesdeChange, onFechaHastaChange, onChipPeriodoChange],
  );

  const seleccionarTodosEstados = useCallback(() => {
    onEstadosChange([]);
  }, [onEstadosChange]);

  const toggleEstado = useCallback(
    (estado: string) => {
      if (estados.includes(estado)) {
        const next = estados.filter((e) => e !== estado);
        onEstadosChange(next);
      } else {
        onEstadosChange([...estados, estado]);
      }
    },
    [estados, onEstadosChange],
  );

  const todosEstadosActivos = estados.length === 0;

  const abrirModalLocales = useCallback(() => {
    setDraftLocalIds([...localIds]);
    setModalLocalesVisible(true);
  }, [localIds]);

  const toggleDraftLocal = useCallback((id: string) => {
    setDraftLocalIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const aplicarLocales = useCallback(() => {
    onLocalIdsChange([...draftLocalIds]);
    setModalLocalesVisible(false);
  }, [draftLocalIds, onLocalIdsChange]);

  const limpiarFiltros = useCallback(() => {
    aplicarChipPeriodo('todos');
    onLocalIdsChange([]);
    onEstadosChange([]);
  }, [aplicarChipPeriodo, onLocalIdsChange, onEstadosChange]);

  const hayFiltrosExtra =
    localIds.length > 0 ||
    estados.length > 0 ||
    (chipPeriodo !== 'todos' && chipPeriodo !== null);

  const resumenLocales = useMemo(() => {
    if (localIds.length === 0) return 'Todos los locales';
    if (localIds.length === 1) {
      const loc = locales.find((l) => l.id === localIds[0]);
      return loc?.nombre ?? '1 local';
    }
    return `${localIds.length} locales`;
  }, [localIds, locales]);

  return (
    <View style={styles.wrap}>
      <View style={[styles.row, shouldStackToolbar && styles.rowStack]}>
        <View style={[styles.rangoWrap, shouldStackToolbar && styles.rangoWrapStack]}>
          <RangoFechas
            desdeIso={fechaDesde}
            hastaIso={fechaHasta}
            onChangeDesde={(d) => handleRangoChange(d, fechaHasta)}
            onChangeHasta={(h) => handleRangoChange(fechaDesde, h)}
            fill={shouldStackToolbar}
          />
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
        {CHIPS_PERIODO.map((chip) => {
          const activo = chipPeriodo === chip.id;
          return (
            <TouchableOpacity
              key={chip.id}
              style={[styles.chip, activo && styles.chipActive]}
              onPress={() => aplicarChipPeriodo(chip.id)}
            >
              <ChipLabel
                label={chip.label}
                count={contadores?.porPeriodo[chip.id]}
                activo={activo}
              />
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={styles.chipLocales} onPress={abrirModalLocales}>
          <MaterialIcons name="store" size={14} color="#0ea5e9" />
          <Text style={styles.chipLocalesText}>{resumenLocales}</Text>
          <MaterialIcons name="arrow-drop-down" size={18} color="#64748b" />
        </TouchableOpacity>
        {hayFiltrosExtra && (
          <TouchableOpacity style={styles.chipLimpiar} onPress={limpiarFiltros}>
            <MaterialIcons name="filter-alt-off" size={14} color="#64748b" />
            <Text style={styles.chipLimpiarText}>Limpiar</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
        <TouchableOpacity
          style={[styles.chipEstado, todosEstadosActivos && styles.chipEstadoActive]}
          onPress={seleccionarTodosEstados}
        >
          <ChipLabelEstado
            label="Todos"
            count={contadores?.todosEstados}
            activo={todosEstadosActivos}
          />
        </TouchableOpacity>
        {ESTADOS_MANTENIMIENTO.map((estado) => {
          const activo = !todosEstadosActivos && estados.includes(estado);
          return (
            <TouchableOpacity
              key={estado}
              style={[styles.chipEstado, activo && styles.chipEstadoActive]}
              onPress={() => toggleEstado(estado)}
            >
              <ChipLabelEstado
                label={estado}
                count={contadores?.porEstado[estado]}
                activo={activo}
              />
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {totalFiltrado !== undefined && totalSinFiltrar !== undefined && totalFiltrado !== totalSinFiltrar && (
        <Text style={styles.resumenCount}>
          Mostrando {totalFiltrado} de {totalSinFiltrar} registros
        </Text>
      )}

      <Modal visible={modalLocalesVisible} transparent animationType="fade" onRequestClose={() => setModalLocalesVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModalLocalesVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={[styles.modalCard, isCompact && styles.modalCardCompact]}>
            <Text style={styles.modalTitle}>Filtrar por local</Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {locales.map((loc) => {
                const sel = draftLocalIds.includes(loc.id);
                return (
                  <TouchableOpacity key={loc.id} style={styles.modalLocalRow} onPress={() => toggleDraftLocal(loc.id)}>
                    <MaterialIcons
                      name={sel ? 'check-box' : 'check-box-outline-blank'}
                      size={22}
                      color={sel ? '#0ea5e9' : '#94a3b8'}
                    />
                    <Text style={styles.modalLocalText}>{loc.nombre}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.modalBtnSec}
                onPress={() => {
                  setDraftLocalIds([]);
                }}
              >
                <Text style={styles.modalBtnSecText}>Ninguno</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnSec} onPress={() => setModalLocalesVisible(false)}>
                <Text style={styles.modalBtnSecText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnPri} onPress={aplicarLocales}>
                <Text style={styles.modalBtnPriText}>Aplicar</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    marginBottom: 12,
    gap: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  rowStack: { flexDirection: 'column', alignItems: 'stretch' },
  rangoWrap: { flexShrink: 0 },
  rangoWrapStack: { width: '100%' },
  chipsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActive: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  chipText: { fontSize: 12, fontWeight: '500', color: '#64748b' },
  chipTextActive: { color: '#0369a1' },
  chipCount: { fontSize: 11, fontWeight: '700', color: '#94a3b8' },
  chipCountActive: { color: '#0284c7' },
  chipLocales: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  chipLocalesText: { fontSize: 12, fontWeight: '500', color: '#334155', maxWidth: 140 },
  chipLimpiar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  chipLimpiarText: { fontSize: 12, color: '#64748b' },
  chipEstado: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipEstadoActive: { backgroundColor: '#dbeafe', borderColor: '#3b82f6' },
  chipEstadoText: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  chipEstadoTextActive: { color: '#1d4ed8' },
  chipEstadoCount: { fontSize: 10, fontWeight: '700', color: '#94a3b8' },
  chipEstadoCountActive: { color: '#2563eb' },
  resumenCount: { fontSize: 12, color: '#64748b' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
  },
  modalCardCompact: { maxWidth: '100%' },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 12 },
  modalScroll: { maxHeight: 320 },
  modalLocalRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  modalLocalText: { fontSize: 14, color: '#334155', flex: 1 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  modalBtnSec: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  modalBtnSecText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  modalBtnPri: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  modalBtnPriText: { fontSize: 13, fontWeight: '600', color: '#fff' },
});
