import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { EmailChipsInput } from '../../components/EmailChipsInput';
import { CashflowLineasEditor, type LineaEditable } from '../../components/CashflowLineasEditor';
import { CashflowReciboPreview } from '../../components/CashflowReciboPreview';
import { CollapsibleSection } from '../../components/CollapsibleSection';
import { cashflowCampoFechaStyle, cashflowFormStyles } from '../../constants/cashflowFormStyles';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';
import { formatId6 } from '../../utils/idFormat';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import {
  type CashflowCategoria,
  type CashflowDestinoCobro,
  type CashflowTipo,
  importeTotalLineas,
  CATEGORIA_CASHFLOW_LABEL,
} from '../../types/cashflow';

type LocalItem = {
  id_Locales?: string | number;
  nombre?: string;
  Nombre?: string;
  empresa?: string;
  Empresa?: string;
};

type EmpresaItem = {
  id_empresa?: string;
  Nombre?: string;
  Cif?: string;
  Email?: string;
  Telefono?: string;
};

type ArtistaItem = {
  id_artista: string;
  nombre_artistico?: string;
  telefono_contacto?: string;
  email_contacto?: string;
};

type EmpleadoItem = {
  employee_id?: string | number;
  full_name?: string;
  identifier?: string;
  email?: string;
  phone_number?: string;
};

const CATEGORIAS: { id: CashflowCategoria; label: string }[] = [
  { id: 'actuacion', label: CATEGORIA_CASHFLOW_LABEL.actuacion },
  { id: 'proveedor', label: CATEGORIA_CASHFLOW_LABEL.proveedor },
  { id: 'staff', label: CATEGORIA_CASHFLOW_LABEL.staff },
  { id: 'evento', label: CATEGORIA_CASHFLOW_LABEL.evento },
  { id: 'otros', label: CATEGORIA_CASHFLOW_LABEL.otros },
];

function nuevaLinea(): LineaEditable {
  return { id: `ln-${Date.now()}`, descripcion: '', importe: 0 };
}

function normEmpresa(s: string): string {
  return String(s || '').trim().toLowerCase();
}

function BtnGuardar({
  onCrearYFirmar,
  onDejarPendiente,
  saving,
  accionGuardado,
  compact,
}: {
  onCrearYFirmar: () => void;
  onDejarPendiente: () => void;
  saving: boolean;
  accionGuardado: 'firma' | 'lista' | null;
  compact?: boolean;
}) {
  return (
    <View style={[styles.accionesGuardar, compact && styles.accionesGuardarCompact]}>
      <TouchableOpacity
        style={[styles.btnPendiente, compact && styles.btnPendienteCompact]}
        onPress={onDejarPendiente}
        disabled={saving}
      >
        {saving && accionGuardado === 'lista' ? (
          <ActivityIndicator color={colors.textPrimary} size="small" />
        ) : (
          <Text style={styles.btnPendienteText} numberOfLines={compact ? 1 : 2}>
            {compact ? 'Dejar pendiente' : 'Dejar pendiente de firma'}
          </Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.btnGuardar, compact && styles.btnGuardarCompact]}
        onPress={onCrearYFirmar}
        disabled={saving}
      >
        {saving && accionGuardado === 'firma' ? (
          <ActivityIndicator color={colors.surface} size="small" />
        ) : (
          <>
            {compact ? <MaterialIcons name="draw" size={18} color={colors.surface} /> : null}
            <Text style={styles.btnGuardarText}>
              {compact ? 'Crear y firmar' : 'Crear y continuar a firma'}
            </Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

export default function CashflowNuevoScreen() {
  const router = useRouter();
  const { hasPermiso, localPermitido, user } = useAuth();
  const { shouldStackPanels, isDesktop } = useBreakpoint();
  const splitView = isDesktop && !shouldStackPanels;

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [empresas, setEmpresas] = useState<EmpresaItem[]>([]);
  const [artistas, setArtistas] = useState<ArtistaItem[]>([]);
  const [empleados, setEmpleados] = useState<EmpleadoItem[]>([]);
  const [loadingMaestros, setLoadingMaestros] = useState(true);

  const [tipo, setTipo] = useState<CashflowTipo>('pago');
  const [localId, setLocalId] = useState('');
  const [fecha, setFecha] = useState(() => fechaJornadaNegocioIso());
  const [categoria, setCategoria] = useState<CashflowCategoria>('otros');
  const [lineas, setLineas] = useState<LineaEditable[]>(() => [nuevaLinea()]);
  const [contraparteNombre, setContraparteNombre] = useState('');
  const [contraparteNif, setContraparteNif] = useState('');
  const [contraparteTelefono, setContraparteTelefono] = useState('');
  const [contraparteRefId, setContraparteRefId] = useState('');
  const [destinoCobro, setDestinoCobro] = useState<CashflowDestinoCobro>('banco');
  const [emailsCopia, setEmailsCopia] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [accionGuardado, setAccionGuardado] = useState<'firma' | 'lista' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const puedeValidar = hasPermiso('cashflow.validar');
  const puedeArtistas = hasPermiso('actuaciones.ver');

  const localesPermitidos = useMemo(
    () =>
      locales
        .map((l) => ({
          id: formatId6(l.id_Locales),
          nombre: String(l.nombre ?? l.Nombre ?? '').trim(),
          empresaNombre: String(l.empresa ?? l.Empresa ?? '').trim(),
        }))
        .filter((l) => l.nombre && localPermitido(l.nombre))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [locales, localPermitido],
  );

  const localSeleccionado = useMemo(
    () => localesPermitidos.find((l) => l.id === localId) ?? null,
    [localesPermitidos, localId],
  );

  const empresaLocal = useMemo(() => {
    const nom = localSeleccionado?.empresaNombre;
    if (!nom) return null;
    return empresas.find((e) => normEmpresa(e.Nombre) === normEmpresa(nom)) ?? { Nombre: nom };
  }, [localSeleccionado, empresas]);

  const importeTotal = useMemo(() => importeTotalLineas(lineas), [lineas]);

  const lineasPreview = useMemo(
    () => lineas.filter((l) => l.descripcion.trim() && l.importe > 0).map(({ descripcion, importe }) => ({ descripcion, importe })),
    [lineas],
  );

  useEffect(() => {
    setLoadingMaestros(true);
    Promise.all([
      apiFetch('/api/locales').then((r) => r.json()),
      apiFetch('/api/empresas').then((r) => r.json()),
      puedeArtistas ? apiFetch('/api/artistas').then((r) => r.json()) : Promise.resolve({ artistas: [] }),
      apiFetch('/api/personal/employees').then((r) => r.json()),
    ])
      .then(([loc, emp, art, pers]) => {
        setLocales(Array.isArray(loc.locales) ? loc.locales : []);
        setEmpresas(Array.isArray(emp.empresas) ? emp.empresas : []);
        setArtistas(Array.isArray(art.artistas) ? art.artistas : []);
        setEmpleados(Array.isArray(pers.employees) ? pers.employees : []);
      })
      .catch(() => {})
      .finally(() => setLoadingMaestros(false));
  }, [puedeArtistas]);

  useEffect(() => {
    if (!localId && localesPermitidos.length === 1) {
      setLocalId(localesPermitidos[0].id);
    }
  }, [localId, localesPermitidos]);

  useEffect(() => {
    setContraparteRefId('');
    setContraparteNombre('');
    setContraparteNif('');
    setContraparteTelefono('');
  }, [categoria]);

  function seleccionarProveedor(id: string) {
    setContraparteRefId(id);
    const emp = empresas.find((e) => String(e.id_empresa) === id);
    if (!emp) return;
    setContraparteNombre(String(emp.Nombre ?? '').trim());
    setContraparteNif(String(emp.Cif ?? '').trim());
    setContraparteTelefono(String(emp.Telefono ?? '').trim());
  }

  function seleccionarArtista(id: string) {
    setContraparteRefId(id);
    const a = artistas.find((x) => x.id_artista === id);
    if (!a) return;
    setContraparteNombre(String(a.nombre_artistico ?? '').trim());
    setContraparteNif('');
    setContraparteTelefono(String(a.telefono_contacto ?? '').trim());
  }

  function seleccionarEmpleado(id: string) {
    setContraparteRefId(id);
    const e = empleados.find((x) => String(x.employee_id) === id);
    if (!e) return;
    setContraparteNombre(String(e.full_name ?? '').trim());
    setContraparteNif(String(e.identifier ?? '').trim());
    setContraparteTelefono(String(e.phone_number ?? '').trim());
  }

  if (!hasPermiso('cashflow.registrar')) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para registrar movimientos.</Text>
      </View>
    );
  }

  async function crearMovimiento(destino: 'firma' | 'lista') {
    setError(null);
    if (!localId) {
      setError('Selecciona un local');
      return;
    }
    const lineasValidas = lineas.filter((l) => l.descripcion.trim() && l.importe > 0);
    if (lineasValidas.length === 0) {
      setError('Añade al menos una línea con descripción e importe');
      return;
    }
    if (importeTotal <= 0) {
      setError('El importe total debe ser mayor que cero');
      return;
    }
    if (!contraparteNombre.trim()) {
      setError('El nombre de la contraparte es obligatorio');
      return;
    }
    if (tipo === 'pago' && !contraparteNif.trim()) {
      setError('El NIF/CIF es obligatorio en pagos');
      return;
    }

    let contraparteRef: { tipo: string; id: string } | undefined;
    if (contraparteRefId) {
      if (categoria === 'proveedor') contraparteRef = { tipo: 'empresa', id: contraparteRefId };
      else if (categoria === 'actuacion') contraparteRef = { tipo: 'artista', id: contraparteRefId };
      else if (categoria === 'staff') contraparteRef = { tipo: 'empleado', id: contraparteRefId };
    }

    setSaving(true);
    setAccionGuardado(destino);
    try {
      const body = {
        tipo,
        localId,
        fecha,
        importe: importeTotal,
        categoria,
        lineas: lineasValidas.map(({ descripcion, importe }) => ({ descripcion: descripcion.trim(), importe })),
        contraparte: {
          nombre: contraparteNombre.trim(),
          nif: contraparteNif.trim() || undefined,
          telefono: contraparteTelefono.trim() || undefined,
        },
        contraparteRef,
        destinoCobro: tipo === 'cobro' ? destinoCobro : undefined,
        emailsCopia,
      };
      const r = await apiFetch('/api/cashflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo crear el movimiento');
      const id = d.movimiento?.movimientoId;
      if (destino === 'firma' && id) router.replace(`/cashflow/${id}` as never);
      else router.replace('/cashflow' as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
      setAccionGuardado(null);
    }
  }

  function guardarYFirmar() {
    void crearMovimiento('firma');
  }

  function dejarPendienteDeFirma() {
    void crearMovimiento('lista');
  }

  const previewPanel = (
    <CashflowReciboPreview
      tipo={tipo}
      fecha={fecha}
      empresaNombre={empresaLocal?.Nombre || localSeleccionado?.empresaNombre}
      empresaCif={empresaLocal?.Cif}
      localNombre={localSeleccionado?.nombre}
      categoria={categoria}
      lineas={lineasPreview}
      importeTotal={importeTotal}
      contraparteNombre={contraparteNombre}
      contraparteNif={contraparteNif}
      creadoPorNombre={user?.Nombre}
    />
  );

  const formContent = (
    <>
      {loadingMaestros ? <ActivityIndicator color={colors.accent} style={{ marginVertical: SPACING.md }} /> : null}

      <View style={styles.formCard}>
        <View style={styles.tipoRow}>
          {(['pago', 'cobro'] as CashflowTipo[]).map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.tipoBtn, tipo === t && (t === 'pago' ? styles.tipoBtnPago : styles.tipoBtnCobro)]}
              onPress={() => setTipo(t)}
            >
              <MaterialIcons
                name={t === 'pago' ? 'arrow-upward' : 'arrow-downward'}
                size={16}
                color={tipo === t ? colors.surface : colors.textMuted}
              />
              <Text style={[styles.tipoBtnText, tipo === t && styles.tipoBtnTextActivo]}>
                {t === 'pago' ? 'Pago' : 'Cobro'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.grid2}>
          <View style={styles.field}>
            <Text style={styles.label}>Local *</Text>
            <SelectorDesplegable
              icono="store"
              iconoLista="store"
              tituloLista="Local"
              placeholder="Seleccionar local"
              buscador
              valorId={localId}
              opciones={localesPermitidos.map((l) => ({
                id: l.id,
                titulo: l.nombre,
                subtitulo: l.empresaNombre || `ID ${l.id}`,
                icono: 'store' as const,
              }))}
              onSeleccionar={setLocalId}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Fecha jornada *</Text>
            <InputFecha
              valueIso={fecha}
              onChangeIso={setFecha}
              placeholder="dd/mm/aaaa"
              style={cashflowCampoFechaStyle}
            />
          </View>
        </View>

        {localSeleccionado ? (
          <View style={styles.empresaInline}>
            <MaterialIcons name="business" size={16} color={statusColors.info.text} />
            <Text style={styles.empresaInlineText} numberOfLines={1}>
              {empresaLocal?.Nombre || localSeleccionado.empresaNombre}
              {empresaLocal?.Cif ? ` · CIF ${empresaLocal.Cif}` : ''}
            </Text>
          </View>
        ) : null}

        <View style={styles.divider} />

        <View style={styles.grid2}>
          <View style={styles.field}>
            <Text style={styles.label}>Categoría *</Text>
            <SelectorDesplegable
              icono="category"
              iconoLista="category"
              tituloLista="Categoría"
              placeholder="Categoría"
              valorId={categoria}
              opciones={CATEGORIAS.map((c) => ({ id: c.id, titulo: c.label, icono: 'label' as const }))}
              onSeleccionar={(id) => setCategoria(id as CashflowCategoria)}
            />
          </View>
          {categoria === 'proveedor' ? (
            <View style={styles.field}>
              <Text style={styles.label}>Proveedor</Text>
              <SelectorDesplegable
                icono="business"
                iconoLista="business"
                tituloLista="Proveedor"
                placeholder="Buscar…"
                buscador
                valorId={contraparteRefId}
                opciones={empresas.map((e) => ({
                  id: String(e.id_empresa ?? ''),
                  titulo: String(e.Nombre ?? '—'),
                  subtitulo: e.Cif ? `CIF ${e.Cif}` : undefined,
                  icono: 'business' as const,
                }))}
                onSeleccionar={seleccionarProveedor}
              />
            </View>
          ) : categoria === 'actuacion' && puedeArtistas ? (
            <View style={styles.field}>
              <Text style={styles.label}>Artista</Text>
              <SelectorDesplegable
                icono="mic"
                iconoLista="mic"
                tituloLista="Artista"
                placeholder="Buscar…"
                buscador
                valorId={contraparteRefId}
                opciones={artistas.map((a) => ({
                  id: a.id_artista,
                  titulo: String(a.nombre_artistico ?? '—'),
                  icono: 'mic' as const,
                }))}
                onSeleccionar={seleccionarArtista}
              />
            </View>
          ) : categoria === 'staff' ? (
            <View style={styles.field}>
              <Text style={styles.label}>Empleado</Text>
              <SelectorDesplegable
                icono="badge"
                iconoLista="badge"
                tituloLista="Empleado"
                placeholder="Buscar…"
                buscador
                valorId={contraparteRefId}
                opciones={empleados.map((e) => ({
                  id: String(e.employee_id ?? ''),
                  titulo: String(e.full_name ?? '—'),
                  subtitulo: e.identifier ? `ID ${e.identifier}` : undefined,
                  icono: 'person' as const,
                }))}
                onSeleccionar={seleccionarEmpleado}
              />
            </View>
          ) : (
            <View style={styles.field} />
          )}
        </View>

        <View style={styles.grid2}>
          <View style={styles.field}>
            <Text style={styles.label}>Nombre contraparte *</Text>
            <TextInput
              style={cashflowFormStyles.campo}
              value={contraparteNombre}
              onChangeText={setContraparteNombre}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>
              NIF/CIF {tipo === 'pago' ? '*' : ''}
              {categoria === 'actuacion' ? ' (manual)' : ''}
            </Text>
            <TextInput
              style={cashflowFormStyles.campo}
              value={contraparteNif}
              onChangeText={setContraparteNif}
              autoCapitalize="characters"
            />
          </View>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Teléfono</Text>
          <TextInput
            style={cashflowFormStyles.campo}
            value={contraparteTelefono}
            onChangeText={setContraparteTelefono}
            keyboardType="phone-pad"
          />
        </View>

        <View style={styles.divider} />

        <CashflowLineasEditor lineas={lineas} onChange={setLineas} tipo={tipo} />

        {tipo === 'cobro' ? (
          <CollapsibleSection title="Destino del cobro" defaultOpen={false}>
            <SelectorDesplegable
              icono="account-balance"
              iconoLista="account-balance"
              tituloLista="Destino"
              placeholder="Destino"
              valorId={destinoCobro}
              opciones={[
                { id: 'banco', titulo: 'Ingresar en banco', icono: 'account-balance' as const },
                ...(puedeValidar
                  ? [{ id: 'reparto_socios', titulo: 'Reparto entre socios', icono: 'groups' as const }]
                  : []),
              ]}
              onSeleccionar={(id) => setDestinoCobro(id as CashflowDestinoCobro)}
            />
          </CollapsibleSection>
        ) : null}

        <CollapsibleSection title="Emails en copia" defaultOpen={false}>
          <EmailChipsInput
            emails={emailsCopia}
            onChange={setEmailsCopia}
            placeholder="email@empresa.com"
            hint="Tab, Enter o coma para añadir."
          />
        </CollapsibleSection>
      </View>

      {error ? (
        <View style={styles.errBox}>
          <MaterialIcons name="error-outline" size={18} color={colors.danger} />
          <Text style={styles.errText}>{error}</Text>
        </View>
      ) : null}

      {!splitView ? (
        <BtnGuardar
          onCrearYFirmar={guardarYFirmar}
          onDejarPendiente={dejarPendienteDeFirma}
          saving={saving}
          accionGuardado={accionGuardado}
        />
      ) : null}
    </>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>Nuevo movimiento</Text>
          <Text style={styles.subtitle}>Efectivo fuera del TPV</Text>
        </View>
        {splitView ? (
          <BtnGuardar
            onCrearYFirmar={guardarYFirmar}
            onDejarPendiente={dejarPendienteDeFirma}
            saving={saving}
            accionGuardado={accionGuardado}
            compact
          />
        ) : null}
      </View>

      <View style={[styles.main, splitView && styles.mainSplit]}>
        <ScrollView
          style={splitView ? styles.formColumn : undefined}
          contentContainerStyle={[
            styles.formScrollContent,
            splitView && styles.formScrollContentSplit,
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {formContent}
        </ScrollView>

        {splitView ? (
          <View style={styles.previewColumn}>{previewPanel}</View>
        ) : (
          <View style={styles.previewStacked}>{previewPanel}</View>
        )}
      </View>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerText: { flex: 1, minWidth: 0 },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  main: { flex: 1 },
  mainSplit: {
    flexDirection: 'row',
    padding: SPACING.lg,
    gap: SPACING.lg,
    maxWidth: 1440,
    width: '100%',
    alignSelf: 'center',
  },
  formColumn: { flex: 1, minWidth: 0, maxWidth: 640 },
  formScrollContent: { padding: SPACING.lg, paddingBottom: 32 },
  formScrollContentSplit: { padding: 0, paddingBottom: SPACING.xl },
  previewColumn: {
    flex: 1,
    minWidth: 320,
    maxWidth: 520,
    ...(Platform.OS === 'web' ? ({ position: 'sticky', top: 0, alignSelf: 'flex-start', maxHeight: 'calc(100vh - 80px)' } as object) : {}),
  },
  previewStacked: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.xl, maxHeight: 480 },
  formCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  tipoRow: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.md },
  tipoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  tipoBtnPago: { backgroundColor: colors.danger, borderColor: colors.danger },
  tipoBtnCobro: { backgroundColor: colors.success, borderColor: colors.success },
  tipoBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  tipoBtnTextActivo: { color: colors.surface },
  grid2: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 140, marginBottom: SPACING.sm },
  label: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase' },
  empresaInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
    paddingVertical: 4,
  },
  empresaInlineText: { flex: 1, fontSize: fontSizes[12], color: statusColors.info.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  divider: { height: 1, backgroundColor: colors.navActive, marginVertical: 10 },
  errBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    padding: 10,
    backgroundColor: statusColors.danger.bg,
    borderRadius: RADIO_MEDIO,
    marginTop: 10,
  },
  errText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.danger.text },
  accionesGuardar: {
    flexDirection: 'column-reverse',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  accionesGuardarCompact: {
    flexDirection: 'row',
    marginTop: 0,
    flexShrink: 1,
    gap: SPACING.sm,
  },
  btnPendiente: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: SPACING.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  btnPendienteCompact: {
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    flexShrink: 1,
  },
  btnPendienteText: { color: colors.textPrimary, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[14], textAlign: 'center' },
  btnGuardar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: SPACING.lg,
  },
  btnGuardarCompact: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexShrink: 0,
  },
  btnGuardarText: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[14] },
  errorText: { padding: SPACING.lg, color: statusColors.danger.text },
});
