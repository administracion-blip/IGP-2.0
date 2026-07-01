import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { apiFetch, errorMessage } from './utils/api';
import { emailValido } from './utils/validation';

export default function RecuperarPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviado, setEnviado] = useState(false);

  async function handleSubmit() {
    setError(null);
    if (!email.trim()) {
      setError('Introduce tu email');
      return;
    }
    if (!emailValido(email)) {
      setError('El email debe contener @');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
        timeoutMs: 15000,
      });
      let data: { ok?: boolean; message?: string; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        // Respuesta sin cuerpo JSON: seguimos con mensaje genérico si fue OK.
      }
      if (!res.ok) {
        setError(data.error || 'No se pudo procesar la solicitud');
        return;
      }
      setEnviado(true);
    } catch (e) {
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Recuperar contraseña</Text>

        {enviado ? (
          <>
            <Text style={styles.info}>
              Si el email está registrado, recibirás un correo con instrucciones para
              restablecer tu contraseña. Revisa también la carpeta de spam.
            </Text>
            <TouchableOpacity style={styles.button} onPress={() => router.replace('/login')}>
              <Text style={styles.buttonText}>Volver al inicio de sesión</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.subtitle}>
              Introduce tu email y te enviaremos un enlace para elegir una nueva contraseña.
            </Text>

            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor="#888"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              editable={!loading}
              onSubmitEditing={handleSubmit}
            />

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleSubmit}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Enviar enlace</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => router.replace('/login')}
              disabled={loading}
              style={styles.backLink}
            >
              <Text style={styles.backText}>Volver al inicio de sesión</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f8fafc',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 16,
  },
  info: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  input: {
    backgroundColor: '#334155',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    color: '#f8fafc',
    marginBottom: 10,
  },
  button: {
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  errorText: {
    color: '#f87171',
    fontSize: 13,
    marginBottom: 8,
    textAlign: 'center',
  },
  backLink: {
    marginTop: 14,
    alignSelf: 'center',
    paddingVertical: 6,
  },
  backText: {
    color: '#38bdf8',
    fontSize: 13,
    textAlign: 'center',
  },
});
