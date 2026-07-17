import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { apiFetch, errorMessage } from '../../utils/api';

type Ajustes = {
  modelo: string;
  temperatura: number;
  maxEjecucionesHora: number;
  maxDatosJsonChars: number;
};

export default function AjustesIaScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeEditar = hasPermiso('ia.ajustes');

  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [iaDisponible, setIaDisponible] = useState(true);
  const [modelosSugeridos, setModelosSugeridos] = useState<string[]>([]);
  const [modelo, setModelo] = useState('');
  const [temperatura, setTemperatura] = useState('0.2');
  const [maxEjec, setMaxEjec] = useState('10');
  const [maxChars, setMaxChars] = useState('60000');
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiFetch('/api/ia/ajustes')
      .then((r) => r.json())
      .then((d) => {
        const a: Ajustes | undefined = d.ajustes;
        if (a) {
          setModelo(a.modelo || '');
          setTemperatura(String(a.temperatura ?? 0.2));
          setMaxEjec(String(a.maxEjecucionesHora ?? 10));
          setMaxChars(String(a.maxDatosJsonChars ?? 60000));
        }
        setModelosSugeridos(Array.isArray(d.modelosSugeridos) ? d.modelosSugeridos : []);
        setIaDisponible(d.iaDisponible !== false);
      })
      .catch((e) => setError(errorMessage(e, 'No se pudieron cargar los ajustes')))
      .finally(() => setLoading(false));
  }, []);

  async function guardar() {
    setGuardando(true);
    setError(null);
    setOkMsg(null);
    try {
      const body = {
        modelo: modelo.trim(),
        temperatura: Number(temperatura.replace(',', '.')),
        maxEjecucionesHora: Number(maxEjec),
        maxDatosJsonChars: Number(maxChars),
      };
      const r = await apiFetch('/api/ia/ajustes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudieron guardar los ajustes');
      const a: Ajustes = d.ajustes;
      setModelo(a.modelo);
      setTemperatura(String(a.temperatura));
      setMaxEjec(String(a.maxEjecucionesHora));
      setMaxChars(String(a.maxDatosJsonChars));
      setOkMsg('Ajustes guardados correctamente');
    } catch (e) {
      setError(errorMessage(e, 'Error al guardar'));
    } finally {
      setGuardando(false);
    }
  }

  if (!puedeEditar) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para modificar los ajustes de la IA.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.formMax}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <MaterialIcons name="arrow-back" size={22} color="#334155" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Ajustes de la IA</Text>
              <Text style={styles.subtitle}>Modelo y límites de los Informes IA</Text>
            </View>
          </View>

          {!iaDisponible ? (
            <View style={styles.avisoBox}>
              <MaterialIcons name="info-outline" size={18} color="#b45309" />
              <Text style={styles.avisoText}>
                La IA no está configurada en el servidor (falta la clave). Los ajustes se guardan igualmente
                y se aplicarán cuando se active.
              </Text>
            </View>
          ) : null}

          {loading ? (
            <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 24 }} />
          ) : (
            <>
              <View style={styles.field}>
                <Text style={styles.label}>Modelo</Text>
                <SelectorDesplegable
                  icono="memory"
                  iconoLista="memory"
                  tituloLista="Modelo"
                  placeholder="Selecciona un modelo"
                  valorId={modelo}
                  opciones={modelosSugeridos.map((m) => ({ id: m, titulo: m, icono: 'memory' as const }))}
                  onSeleccionar={setModelo}
                />
                <Text style={styles.hint}>
                  Modelos más grandes redactan mejor pero cuestan más. Recomendado: gpt-4o-mini.
                </Text>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Temperatura (0–1)</Text>
                <TextInput
                  style={styles.input}
                  value={temperatura}
                  onChangeText={(t) => setTemperatura(t.replace(/[^0-9.,]/g, ''))}
                  keyboardType="decimal-pad"
                  placeholder="0.2"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.hint}>Más baja = más literal y consistente. Más alta = más creativa.</Text>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Máx. informes por usuario y hora</Text>
                <TextInput
                  style={styles.input}
                  value={maxEjec}
                  onChangeText={(t) => setMaxEjec(t.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  placeholder="10"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.hint}>Límite anti-abuso y de coste (entre 1 y 100).</Text>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>Máx. tamaño de datos (caracteres)</Text>
                <TextInput
                  style={styles.input}
                  value={maxChars}
                  onChangeText={(t) => setMaxChars(t.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  placeholder="60000"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.hint}>Si el JSON de una fuente supera este tamaño, no se envía a la IA (entre 1.000 y 200.000).</Text>
              </View>

              {error ? (
                <View style={styles.errBox}>
                  <MaterialIcons name="error-outline" size={18} color="#dc2626" />
                  <Text style={styles.errText}>{error}</Text>
                </View>
              ) : null}
              {okMsg ? (
                <View style={styles.okBox}>
                  <MaterialIcons name="check-circle" size={18} color="#16a34a" />
                  <Text style={styles.okText}>{okMsg}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[styles.btnGuardar, guardando && styles.btnGuardarDisabled]}
                onPress={guardar}
                disabled={guardando}
              >
                {guardando ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <MaterialIcons name="save" size={18} color="#fff" />
                    <Text style={styles.btnGuardarText}>Guardar ajustes</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          )}

          <View style={{ height: 32 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  scrollContent: { padding: 16, alignItems: 'center' },
  formMax: { width: '100%', maxWidth: 640 },
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
  field: { marginBottom: 16 },
  label: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase' },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1e293b',
  },
  hint: { fontSize: 12, color: '#94a3b8', marginTop: 4 },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8, marginBottom: 12 },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  okBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#f0fdf4', borderRadius: 8, marginBottom: 12 },
  okText: { flex: 1, fontSize: 12, color: '#15803d' },
  btnGuardar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingVertical: 14,
  },
  btnGuardarDisabled: { opacity: 0.6 },
  btnGuardarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  errorText: { padding: 16, color: '#b91c1c' },
});
