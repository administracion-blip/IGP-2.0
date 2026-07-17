import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { InputFecha } from '../../components/InputFecha';
import { CollapsibleSection } from '../../components/CollapsibleSection';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatId6 } from '../../utils/idFormat';

type OpcionParam = { valor: string; etiqueta: string };

type ParametroDef = {
  nombre: string;
  tipo: 'fecha' | 'local' | 'texto' | 'numero' | 'opcion';
  requerido?: boolean;
  etiqueta?: string;
  defecto?: string | number;
  opciones?: OpcionParam[];
};

type Fuente = {
  clave: string;
  nombre: string;
  descripcion: string;
  permiso: string;
  parametros: ParametroDef[];
};

type Informe = {
  informeId: string;
  fuente: string;
  parametros: Record<string, unknown>;
  promptId?: string;
  promptNombre?: string;
  resumen: string | null;
  datosJson?: unknown;
  modelo?: string | null;
  costeTokens?: { prompt: number; completion: number };
  generadoPorNombre?: string;
  generadoEn: string;
};

type Plantilla = {
  promptId: string;
  nombre: string;
  instrucciones: string;
  esDefault?: boolean;
  deCodigo?: boolean;
};

type LocalItem = { id_Locales?: string | number; nombre?: string; Nombre?: string };

function fechaHora(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function InformesIaScreen() {
  const router = useRouter();
  const { fuente: fuenteParam } = useLocalSearchParams<{ fuente?: string }>();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackPanels } = useBreakpoint();

  const [fuentes, setFuentes] = useState<Fuente[]>([]);
  const [iaDisponible, setIaDisponible] = useState(true);
  const [fuenteClave, setFuenteClave] = useState('');
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
  const [plantillas, setPlantillas] = useState<Plantilla[]>([]);
  const [promptId, setPromptId] = useState('default');

  const [loadingFuentes, setLoadingFuentes] = useState(true);
  const [generando, setGenerando] = useState(false);
  const [informe, setInforme] = useState<Informe | null>(null);
  const [historial, setHistorial] = useState<Informe[]>([]);
  const [error, setError] = useState<string | null>(null);

  const puedeVer = hasPermiso('ia.informes');
  const puedeGestionar = hasPermiso('ia.prompts_gestionar');
  const puedeAjustes = hasPermiso('ia.ajustes');

  const fuente = useMemo(
    () => fuentes.find((f) => f.clave === fuenteClave) || null,
    [fuentes, fuenteClave],
  );

  const localesPermitidos = useMemo(
    () =>
      locales
        .map((l) => ({ id: formatId6(l.id_Locales), nombre: String(l.nombre ?? l.Nombre ?? '').trim() }))
        .filter((l) => l.nombre && localPermitido(l.nombre))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [locales, localPermitido],
  );

  useEffect(() => {
    setLoadingFuentes(true);
    apiFetch('/api/ia/fuentes')
      .then((r) => r.json())
      .then((d) => {
        const list: Fuente[] = Array.isArray(d.fuentes) ? d.fuentes : [];
        setFuentes(list);
        setIaDisponible(d.iaDisponible !== false);
        const preseleccion = typeof fuenteParam === 'string' ? fuenteParam : '';
        if (preseleccion && list.some((f) => f.clave === preseleccion)) {
          setFuenteClave(preseleccion);
        } else if (list.length === 1) {
          setFuenteClave(list[0].clave);
        }
      })
      .catch((e) => setError(errorMessage(e, 'No se pudieron cargar las fuentes')))
      .finally(() => setLoadingFuentes(false));
  }, [fuenteParam]);

  useEffect(() => {
    apiFetch('/api/locales')
      .then((r) => r.json())
      .then((d) => setLocales(Array.isArray(d.locales) ? d.locales : []))
      .catch(() => setLocales([]));
  }, []);

  const cargarHistorial = useCallback((clave: string) => {
    if (!clave) return;
    apiFetch(`/api/ia/informes?fuente=${encodeURIComponent(clave)}`)
      .then((r) => r.json())
      .then((d) => setHistorial(Array.isArray(d.informes) ? d.informes : []))
      .catch(() => setHistorial([]));
  }, []);

  const cargarPlantillas = useCallback((clave: string) => {
    if (!clave) return;
    apiFetch(`/api/ia/prompts?fuente=${encodeURIComponent(clave)}`)
      .then((r) => r.json())
      .then((d) => {
        const list: Plantilla[] = Array.isArray(d.plantillas) ? d.plantillas : [];
        setPlantillas(list);
        const porDefecto = list.find((p) => p.esDefault) || list[0];
        setPromptId(porDefecto ? porDefecto.promptId : 'default');
      })
      .catch(() => {
        setPlantillas([]);
        setPromptId('default');
      });
  }, []);

  useEffect(() => {
    setInforme(null);
    setError(null);
    const defs = fuentes.find((f) => f.clave === fuenteClave)?.parametros || [];
    const inicial: Record<string, string> = {};
    for (const p of defs) {
      if (p.defecto != null) inicial[p.nombre] = String(p.defecto);
    }
    setParams(inicial);
    if (fuenteClave) {
      cargarHistorial(fuenteClave);
      cargarPlantillas(fuenteClave);
    } else {
      setHistorial([]);
      setPlantillas([]);
      setPromptId('default');
    }
  }, [fuenteClave, fuentes, cargarHistorial, cargarPlantillas]);

  async function generar(force = false) {
    if (!fuente) {
      setError('Selecciona una fuente');
      return;
    }
    for (const p of fuente.parametros) {
      if (p.requerido && !params[p.nombre]) {
        setError(`Falta el parámetro: ${p.etiqueta || p.nombre}`);
        return;
      }
    }
    setGenerando(true);
    setError(null);
    try {
      const r = await apiFetch('/api/ia/informes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fuente: fuente.clave, parametros: params, promptId, force }),
        timeoutMs: 120_000,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo generar el informe');
      setInforme(d.informe as Informe);
      cargarHistorial(fuente.clave);
    } catch (e) {
      setError(errorMessage(e, 'Error al generar el informe'));
    } finally {
      setGenerando(false);
    }
  }

  async function abrirInforme(id: string) {
    if (!fuente) return;
    setError(null);
    try {
      const r = await apiFetch(`/api/ia/informes/${encodeURIComponent(id)}?fuente=${encodeURIComponent(fuente.clave)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo abrir el informe');
      setInforme(d.informe as Informe);
    } catch (e) {
      setError(errorMessage(e, 'Error al abrir el informe'));
    }
  }

  if (!puedeVer) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para ver Informes IA.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.formMax}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
              <MaterialIcons name="arrow-back" size={22} color="#334155" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Informes IA</Text>
              <Text style={styles.subtitle}>Resúmenes redactados sobre cifras deterministas</Text>
            </View>
            {puedeGestionar ? (
              <TouchableOpacity
                style={styles.gestionBtn}
                onPress={() => router.push('/informes-ia/plantillas' as never)}
              >
                <MaterialIcons name="tune" size={18} color="#0369a1" />
                <Text style={styles.gestionText}>Plantillas</Text>
              </TouchableOpacity>
            ) : null}
            {puedeAjustes ? (
              <TouchableOpacity
                style={styles.gestionBtn}
                onPress={() => router.push('/informes-ia/ajustes' as never)}
              >
                <MaterialIcons name="settings" size={18} color="#0369a1" />
                <Text style={styles.gestionText}>Ajustes</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {!iaDisponible ? (
            <View style={styles.avisoBox}>
              <MaterialIcons name="info-outline" size={18} color="#b45309" />
              <Text style={styles.avisoText}>
                La IA no está configurada en el servidor. Verás los datos en modo tabla, sin redacción.
              </Text>
            </View>
          ) : null}

          {loadingFuentes ? (
            <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 16 }} />
          ) : fuentes.length === 0 ? (
            <Text style={styles.hint}>No tienes fuentes de informe disponibles.</Text>
          ) : (
            <>
              <View style={[styles.panelRow, shouldStackPanels && styles.panelCol]}>
                <View style={styles.field}>
                  <Text style={styles.label}>Fuente</Text>
                  <SelectorDesplegable
                    icono="insights"
                    iconoLista="insights"
                    tituloLista="Fuente de datos"
                    placeholder="Selecciona una fuente"
                    valorId={fuenteClave}
                    opciones={fuentes.map((f) => ({
                      id: f.clave,
                      titulo: f.nombre,
                      subtitulo: f.descripcion,
                      icono: 'insights' as const,
                    }))}
                    onSeleccionar={setFuenteClave}
                  />
                </View>

                {fuente?.parametros.map((p) => (
                  <View key={p.nombre} style={styles.field}>
                    <Text style={styles.label}>
                      {p.etiqueta || p.nombre}
                      {p.requerido ? ' *' : ''}
                    </Text>
                    {p.tipo === 'local' ? (
                      <SelectorDesplegable
                        icono="store"
                        iconoLista="store"
                        tituloLista="Local"
                        placeholder="Todos mis locales"
                        buscador
                        buscadorPlaceholder="Buscar local…"
                        valorId={params[p.nombre] || ''}
                        opciones={[
                          { id: '', titulo: 'Todos mis locales', icono: 'apps' as const },
                          ...localesPermitidos.map((l) => ({
                            id: l.id,
                            titulo: l.nombre,
                            subtitulo: `ID ${l.id}`,
                            icono: 'store' as const,
                          })),
                        ]}
                        onSeleccionar={(id) => setParams((prev) => ({ ...prev, [p.nombre]: id }))}
                      />
                    ) : p.tipo === 'fecha' ? (
                      <InputFecha
                        valueIso={params[p.nombre] || ''}
                        onChangeIso={(iso) => setParams((prev) => ({ ...prev, [p.nombre]: iso }))}
                        placeholder="dd/mm/aaaa"
                      />
                    ) : p.tipo === 'opcion' ? (
                      <SelectorDesplegable
                        icono="tune"
                        iconoLista="tune"
                        tituloLista={p.etiqueta || p.nombre}
                        placeholder="Selecciona una opción"
                        valorId={params[p.nombre] || ''}
                        opciones={(p.opciones || []).map((o) => ({
                          id: o.valor,
                          titulo: o.etiqueta,
                          icono: 'tune' as const,
                        }))}
                        onSeleccionar={(id) => setParams((prev) => ({ ...prev, [p.nombre]: id }))}
                      />
                    ) : p.tipo === 'numero' ? (
                      <TextInput
                        style={styles.numInput}
                        value={params[p.nombre] || ''}
                        onChangeText={(t) =>
                          setParams((prev) => ({ ...prev, [p.nombre]: t.replace(/[^0-9]/g, '') }))
                        }
                        keyboardType="number-pad"
                        placeholder={p.defecto != null ? String(p.defecto) : ''}
                        placeholderTextColor="#94a3b8"
                      />
                    ) : (
                      <TextInput
                        style={styles.numInput}
                        value={params[p.nombre] || ''}
                        onChangeText={(t) => setParams((prev) => ({ ...prev, [p.nombre]: t }))}
                        placeholder={p.etiqueta || p.nombre}
                        placeholderTextColor="#94a3b8"
                      />
                    )}
                  </View>
                ))}

                {fuente ? (
                  <View style={styles.field}>
                    <Text style={styles.label}>Plantilla de redacción</Text>
                    <SelectorDesplegable
                      icono="article"
                      iconoLista="article"
                      tituloLista="Plantilla"
                      placeholder="Plantilla"
                      valorId={promptId}
                      opciones={plantillas.map((p) => ({
                        id: p.promptId,
                        titulo: p.nombre,
                        subtitulo: p.deCodigo ? 'Por defecto (código)' : p.esDefault ? 'Predeterminada' : undefined,
                        icono: 'article' as const,
                      }))}
                      onSeleccionar={setPromptId}
                    />
                  </View>
                ) : null}
              </View>

              <TouchableOpacity
                style={[styles.btnGenerar, (generando || !fuente) && styles.btnGenerarDisabled]}
                onPress={() => generar(false)}
                disabled={generando || !fuente}
              >
                {generando ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <MaterialIcons name="auto-awesome" size={18} color="#fff" />
                    <Text style={styles.btnGenerarText}>Ejecutar informe</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )}

          {error ? (
            <View style={styles.errBox}>
              <MaterialIcons name="error-outline" size={18} color="#dc2626" />
              <Text style={styles.errText}>{error}</Text>
            </View>
          ) : null}

          {informe ? (
            <View style={styles.resultCard}>
              <View style={styles.resultHead}>
                <MaterialIcons name="description" size={18} color="#0369a1" />
                <Text style={styles.resultTitle}>Informe</Text>
                <TouchableOpacity onPress={() => generar(true)} disabled={generando} style={styles.regenerarBtn}>
                  <MaterialIcons name="refresh" size={16} color="#0369a1" />
                  <Text style={styles.regenerarText}>Regenerar</Text>
                </TouchableOpacity>
              </View>

              {informe.resumen ? (
                <Text style={styles.resumen}>{informe.resumen}</Text>
              ) : (
                <Text style={styles.hint}>
                  Sin redacción (IA no configurada). Consulta los datos abajo.
                </Text>
              )}

              <CollapsibleSection title="Ver datos" defaultOpen={!informe.resumen}>
                <Text style={styles.jsonText}>{JSON.stringify(informe.datosJson ?? {}, null, 2)}</Text>
              </CollapsibleSection>

              <Text style={styles.meta}>
                {informe.modelo ? `Modelo ${informe.modelo} · ` : ''}
                {informe.costeTokens
                  ? `${informe.costeTokens.prompt + informe.costeTokens.completion} tokens · `
                  : ''}
                {fechaHora(informe.generadoEn)}
              </Text>
            </View>
          ) : null}

          {historial.length > 0 ? (
            <View style={styles.histBlock}>
              <Text style={styles.sectionLabel}>Informes anteriores</Text>
              {historial.map((h) => (
                <TouchableOpacity key={h.informeId} style={styles.histRow} onPress={() => abrirInforme(h.informeId)}>
                  <MaterialIcons name="history" size={16} color="#64748b" />
                  <Text style={styles.histText} numberOfLines={1}>
                    {fechaHora(h.generadoEn)}
                    {h.generadoPorNombre ? ` · ${h.generadoPorNombre}` : ''}
                  </Text>
                  <MaterialIcons name="chevron-right" size={18} color="#cbd5e1" />
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          <View style={{ height: 32 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  scrollContent: { padding: 16, alignItems: 'center' },
  formMax: { width: '100%', maxWidth: 900 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  gestionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#e0f2fe',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  gestionText: { fontSize: 13, color: '#0369a1', fontWeight: '600' },
  avisoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    marginBottom: 12,
  },
  avisoText: { flex: 1, fontSize: 12, color: '#92400e' },
  panelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  panelCol: { flexDirection: 'column' },
  field: { flexGrow: 1, minWidth: 200, marginBottom: 4 },
  label: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase' },
  numInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1e293b',
  },
  btnGenerar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingVertical: 14,
    marginBottom: 12,
  },
  btnGenerarDisabled: { opacity: 0.6 },
  btnGenerarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8, marginBottom: 12 },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  hint: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', marginVertical: 8 },
  resultCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginBottom: 14,
  },
  resultHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  resultTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: '#334155' },
  regenerarBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  regenerarText: { fontSize: 12, color: '#0369a1', fontWeight: '600' },
  resumen: { fontSize: 14, color: '#1e293b', lineHeight: 21, marginBottom: 10 },
  jsonText: {
    fontSize: 11,
    color: '#334155',
    fontFamily: 'monospace',
    backgroundColor: '#f1f5f9',
    borderRadius: 6,
    padding: 10,
  },
  meta: { fontSize: 11, color: '#94a3b8', marginTop: 10 },
  histBlock: { marginTop: 4 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  histText: { flex: 1, fontSize: 12, color: '#475569' },
  errorText: { padding: 16, color: '#b91c1c' },
});
