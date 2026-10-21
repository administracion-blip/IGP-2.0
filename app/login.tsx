import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { saveToken } from './utils/authToken';
import { emailValido } from './utils/validation';
import { fetchImagenApp } from './lib/personalizacion';
import { apiFetch } from './utils/api';
import { API_BASE_URL } from './utils/apiBaseUrl';
import { Boton } from './components/ui/Boton';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  shadow,
  typography,
  MIN_TOUCH,
  SPACING,
} from './constants/theme';

const AUTH_KEY = 'erp_user';
// `API_BASE_URL` se conserva solo para los mensajes de error que muestran
// la URL al usuario; las llamadas reales pasan por `apiFetch`.
const API_URL = API_BASE_URL;

/** Anillo exterior: cyan → violeta → rosa (mismo espíritu que el icono de perfil). */
const LOGO_RING_COLORS = ['#33CCFF', '#9988FF', '#FF66CC'] as const;

export type UserSession = {
  id_usuario: string;
  email: string;
  Nombre: string;
  Rol?: string;
  Locales?: string[];
};

type LoginResponse = {
  error?: string;
  user?: UserSession;
  token?: string;
};

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imagenApp, setImagenApp] = useState<string | null>(null);

  useEffect(() => {
    fetchImagenApp(API_URL).then(setImagenApp);
  }, []);

  async function handleLogin() {
    setError(null);
    if (!email.trim() || !password) {
      setError('Introduce email y Password');
      return;
    }
    if (!emailValido(email)) {
      setError('El email debe contener @');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
        timeoutMs: 15000,
      });
      let data: LoginResponse;
      try {
        data = await res.json();
      } catch {
        setError(`Respuesta inválida del servidor (${res.status})`);
        return;
      }
      if (!res.ok) {
        setError(data.error || 'Credenciales incorrectas');
        return;
      }
      if (!data.user) {
        setError('La respuesta de login no incluye usuario');
        return;
      }
      await AsyncStorage.setItem(AUTH_KEY, JSON.stringify(data.user));
      if (data.token) await saveToken(data.token);
      router.replace('/(app)');
    } catch (e) {
      const msg =
        Platform.OS === 'web'
          ? `No se pudo conectar con ${API_URL}. ¿Está el API en marcha? (npm run dev)`
          : `No se pudo conectar con ${API_URL}. ¿Está el API en marcha? En móvil usa la IP de tu PC (ej. http://192.168.1.x:3002).`;
      setError(msg);
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
        {imagenApp ? (
          <LinearGradient
            colors={[...LOGO_RING_COLORS]}
            locations={[0, 0.5, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.logoRingGradient}
          >
            <View style={styles.logoLoginWrap}>
              <Image
                source={{ uri: imagenApp }}
                style={styles.logoLoginImage}
                resizeMode="contain"
                accessibilityLabel="Logo"
              />
            </View>
          </LinearGradient>
        ) : null}
        <Text style={styles.title}>Grupo Paripé</Text>
        <Text style={styles.subtitle}>Iniciar sesión</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.textMuted}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          editable={!loading}
        />

        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}

        <View style={styles.entrar}>
          <Boton titulo="Entrar" onPress={handleLogin} cargando={loading} />
        </View>

        <TouchableOpacity
          onPress={() => router.push('/recuperar-password')}
          disabled={loading}
          style={styles.forgotLink}
        >
          <Text style={styles.forgotText}>¿Has olvidado tu contraseña?</Text>
        </TouchableOpacity>

        <Text style={styles.poweredBy}>Powered by Tabolize</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xl,
    padding: SPACING.xl,
    width: '100%',
    /** Ancho de la tarjeta de acceso; no se repite en otras pantallas. */
    maxWidth: 400,
    alignSelf: 'center',
    ...shadow.card,
  },
  /** Anillo con gradiente; el padding es el grosor del aro. Medidas de un solo uso. */
  logoRingGradient: {
    width: 124,
    height: 124,
    borderRadius: 62,
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: SPACING.md,
    overflow: 'hidden',
  },
  /** Círculo interior: el padding reduce solo el área de la imagen, no el aro exterior. */
  logoLoginWrap: {
    width: 112,
    height: 112,
    borderRadius: 56,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    padding: SPACING.md,
  },
  logoLoginImage: {
    width: '100%',
    height: '100%',
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[24],
    fontWeight: typography.titulo.fontWeight,
    color: colors.textStrong,
    textAlign: 'center',
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  input: {
    minHeight: MIN_TOUCH,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: SPACING.md,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
    color: colors.textStrong,
    marginBottom: SPACING.sm,
  },
  entrar: { marginTop: SPACING.xs },
  errorText: {
    color: colors.danger,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[13],
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  forgotLink: {
    marginTop: SPACING.md,
    alignSelf: 'center',
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  forgotText: {
    color: colors.accentPressed,
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[13],
    textAlign: 'center',
  },
  poweredBy: {
    marginTop: SPACING.xl,
    alignSelf: 'center',
    fontFamily: fontFamily.regular,
    fontSize: typography.etiqueta.fontSize,
    color: colors.textMuted,
    textAlign: 'center',
    letterSpacing: typography.etiqueta.letterSpacing,
  },
});
