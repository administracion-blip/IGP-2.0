import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  Image,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { StepperUnidades } from './StepperUnidades';
import { useMantenimientoLocales, valorEnLocal } from '../../(app)/mantenimiento/LocalesContext';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, radius, statusColors, typography } from '../../constants/theme';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatId6 } from '../../utils/idFormat';
import { ICONS, ICON_SIZE } from '../../constants/icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { lineaSinLocalFactura, useCestaActivos, type LineaCestaActivo } from '../../lib/activosCesta';

type EmpleadoOpt = { employee_id: string; full_name?: string; first_name?: string; last_name?: string; active?: boolean };

function nombreEmpleado(e: EmpleadoOpt): string {
  return String(e.full_name || [e.first_name, e.last_name].filter(Boolean).join(' ') || e.employee_id).trim();
}

type Props = {
  visible: boolean;
  onClose: () => void;
  onEntregado: () => void;
};

export function CestaEntregaModal({ visible, onClose, onEntregado }: Props) {
  const { shouldStackPanels } = useBreakpoint();
  const { confirmar: pedirConfirmacion, ConfirmarView } = useConfirmar();
  const { lineas, unidades, grupos, quitar, setCantidad, setLocalImputado, vaciar } = useCestaActivos();
  const { locales } = useMantenimientoLocales();
  const [empleados, setEmpleados] = useState<EmpleadoOpt[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [entregando, setEntregando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    apiFetch('/api/personal/employees')
      .then(async (r) => {
        const data = (await r.json()) as { employees?: EmpleadoOpt[]; error?: string };
        if (!r.ok) throw new Error(data.error || 'No se pudo cargar Personal');
        setEmpleados((data.employees || []).filter((e) => e.active !== false));
      })
      .catch((e) => {
        setEmpleados([]);
        setError(errorMessage(e, 'No se pudieron cargar los trabajadores'));
      });
  }, [visible]);

  const opcionesEmpleado: OpcionDesplegable[] = useMemo(
    () => empleados.map((e) => ({ id: String(e.employee_id), titulo: nombreEmpleado(e) })),
    [empleados],
  );

  const opcionesLocal: OpcionDesplegable[] = useMemo(
    () =>
      locales
        .map((l) => {
          const id = formatId6(valorEnLocal(l, 'id_Locales'));
          const nombre = String(valorEnLocal(l, 'nombre') || valorEnLocal(l, 'Nombre') || '').trim();
          return { id, titulo: nombre || id };
        })
        .filter((o) => o.id && o.id !== '000000'),
    [locales],
  );

  const nombreLocal = (id: string) => opcionesLocal.find((o) => o.id === formatId6(id))?.titulo || id;
  const faltaLocal = lineas.some(lineaSinLocalFactura);

  const entregarCesta = async () => {
    setError(null);
    if (!employeeId) {
      setError('Elige el trabajador que recibe');
      return;
    }
    if (!lineas.length) {
      setError('Añade al menos una prenda a la cesta');
      return;
    }
    if (lineas.some(lineaSinLocalFactura)) {
      setError('Indica el local a facturar en todas las prendas');
      return;
    }
    const nombre = opcionesEmpleado.find((o) => o.id === employeeId)?.titulo || 'este trabajador';
    const localesFactura = grupos.map((g) => g.local_imputado_nombre).join(', ');
    const ok = await pedirConfirmacion(
      'Confirmar entrega',
      `Vas a entregar ${unidades === 1 ? '1 prenda' : `${unidades} prendas`} a ${nombre}${
        grupos.length > 1 ? ` (se factura a ${localesFactura})` : ''
      }.`,
      { confirmarLabel: 'Entregar' },
    );
    if (!ok) return;
    setEntregando(true);
    try {
      const res = await apiFetch('/api/activos/entregas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: employeeId,
          lineas: lineas.map((l) => ({
            asset_id: l.asset_id,
            cantidad: l.granularidad === 'lote' ? l.cantidad : 1,
            local_imputado_id: l.local_imputado_id,
          })),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo entregar');
      vaciar();
      setEmployeeId('');
      onEntregado();
      onClose();
    } catch (e) {
      setError(errorMessage(e, 'No se pudo entregar'));
    } finally {
      setEntregando(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => !entregando && onClose()}>
      <Pressable style={styles.fondo} onPress={() => !entregando && onClose()}>
        <Pressable
          style={[styles.caja, shouldStackPanels && styles.cajaFull]}
          onPress={(e) => e.stopPropagation()}
        >
          <Text style={styles.titulo}>Cesta de entrega</Text>
          <Text style={styles.sub}>
            {unidades === 0
              ? 'Añade prendas del almacén. Pueden ser de varios locales; el trabajador las recibe juntas.'
              : unidades === 1
                ? '1 prenda, agrupada por el local al que se factura.'
                : `${unidades} prendas, agrupadas por el local al que se factura.`}
          </Text>

          <View style={{ zIndex: 30, marginBottom: 12 }}>
            <SelectorDesplegable
              label="Trabajador que recibe"
              icono="badge"
              placeholder="Elige trabajador"
              tituloLista="Trabajador"
              opciones={opcionesEmpleado}
              valorId={employeeId}
              onSeleccionar={setEmployeeId}
              buscador
              buscadorPlaceholder="Buscar por nombre…"
              vacioTexto="No hay empleados. Sincroniza Personal."
            />
          </View>

          <ScrollView
            style={styles.lista}
            contentContainerStyle={styles.listaContent}
            keyboardShouldPersistTaps="handled"
          >
            {lineas.length === 0 ? (
              <Text style={styles.vacio}>La cesta está vacía.</Text>
            ) : (
              grupos.map((grupo) => (
                <View key={grupo.local_imputado_id} style={styles.grupo}>
                  <Text style={styles.grupoTitulo}>
                    {grupo.local_imputado_id === '—'
                      ? 'Elige el local a facturar'
                      : `Se factura a ${grupo.local_imputado_nombre}`}
                    {grupo.unidades === 1 ? ' · 1 ud.' : ` · ${grupo.unidades} ud.`}
                  </Text>
                  {grupo.lineas.map((l) => (
                    <LineaCesta
                      key={l.asset_id}
                      linea={l}
                      opcionesLocal={opcionesLocal}
                      onQuitar={() => quitar(l.asset_id)}
                      onCantidad={(n) => setCantidad(l.asset_id, n)}
                      onLocalImputado={(id) => setLocalImputado(l.asset_id, id, nombreLocal(id))}
                    />
                  ))}
                </View>
              ))
            )}
          </ScrollView>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.acciones}>
            <TouchableOpacity style={styles.cancel} onPress={onClose} disabled={entregando}>
              <Text style={styles.cancelTxt}>Cerrar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cta, (entregando || !lineas.length || faltaLocal) && { opacity: 0.6 }]}
              onPress={() => void entregarCesta()}
              disabled={entregando || !lineas.length || faltaLocal}
            >
              {entregando ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.ctaTxt}>Entregar</Text>
              )}
            </TouchableOpacity>
          </View>
          {ConfirmarView}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function LineaCesta({
  linea,
  opcionesLocal,
  onQuitar,
  onCantidad,
  onLocalImputado,
}: {
  linea: LineaCestaActivo;
  opcionesLocal: OpcionDesplegable[];
  onQuitar: () => void;
  onCantidad: (n: number) => void;
  onLocalImputado: (id: string) => void;
}) {
  const titulo = [linea.marca, linea.nombre_modelo].filter(Boolean).join(' ');
  return (
    <View style={styles.fila}>
      <View style={styles.filaTop}>
        {linea.foto_url ? (
          <Image source={{ uri: linea.foto_url }} style={styles.foto} />
        ) : (
          <View style={[styles.foto, styles.fotoVacia]}>
            <MaterialIcons name="image" size={18} color={colors.textMuted} />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.etiqueta}>{linea.etiqueta_legible}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {titulo}
            {linea.talla ? ` · ${linea.talla}` : ''}
          </Text>
          <Text style={styles.origen} numberOfLines={1}>
            Sale de {linea.local_nombre || linea.id_local}
          </Text>
        </View>
        {linea.granularidad === 'lote' ? (
          <StepperUnidades valor={linea.cantidad} min={1} max={linea.max} onChange={onCantidad} />
        ) : (
          <Text style={styles.ud}>1 ud.</Text>
        )}
        <TouchableOpacity style={styles.quitar} onPress={onQuitar} accessibilityLabel="Quitar de la cesta">
          <MaterialIcons name={ICONS.delete} size={ICON_SIZE} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
      <SelectorDesplegable
        compact
        label="Se factura a *"
        icono="storefront"
        placeholder="Local a facturar"
        tituloLista="Local a facturar"
        opciones={opcionesLocal}
        valorId={linea.local_imputado_id || undefined}
        onSeleccionar={onLocalImputado}
        buscador
        buscadorPlaceholder="Buscar local…"
        vacioTexto="No tienes locales disponibles."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fondo: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  caja: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 16,
    maxHeight: '88%',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
    flexShrink: 1,
  },
  cajaFull: {
    maxWidth: '100%',
    maxHeight: '100%',
    height: '100%',
    borderRadius: 0,
    flex: 1,
  },
  titulo: { ...typography.titulo, color: '#0f172a', marginBottom: 4 },
  sub: { fontSize: 13, color: colors.textSecondary, marginBottom: 12 },
  vacio: { fontSize: 13, color: colors.textMuted, paddingVertical: 16 },
  lista: { flexGrow: 1, flexShrink: 1, minHeight: 80, marginBottom: 8 },
  listaContent: { flexGrow: 0 },
  grupo: { marginBottom: 12 },
  grupoTitulo: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  fila: {
    gap: 8,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
  },
  filaTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  foto: { width: 40, height: 40, borderRadius: 8, backgroundColor: colors.surface },
  fotoVacia: { alignItems: 'center', justifyContent: 'center' },
  etiqueta: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  meta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  origen: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  ud: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  quitar: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  error: { color: statusColors.danger.text, marginBottom: 8, fontSize: 13 },
  acciones: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  cancel: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelTxt: { fontWeight: '700', color: colors.textSecondary },
  cta: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaTxt: { color: '#fff', fontWeight: '700' },
});
