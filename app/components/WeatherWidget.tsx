import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

const GRANADA_LAT = 37.1773;
const GRANADA_LON = -3.5986;
const OPEN_METEO_URL = `https://api.open-meteo.com/v1/forecast?latitude=${GRANADA_LAT}&longitude=${GRANADA_LON}&current=temperature_2m,precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Europe/Madrid&forecast_days=8`;

const WEATHER_CODE_MAP: Record<number, string> = {
  0: 'Despejado',
  1: 'Mayormente despejado',
  2: 'Parcialmente nublado',
  3: 'Nublado',
  45: 'Niebla',
  48: 'Niebla con escarcha',
  51: 'Llovizna ligera',
  53: 'Llovizna',
  55: 'Llovizna densa',
  61: 'Lluvia ligera',
  63: 'Lluvia',
  65: 'Lluvia fuerte',
  66: 'Lluvia helada ligera',
  67: 'Lluvia helada fuerte',
  71: 'Nieve ligera',
  73: 'Nieve',
  75: 'Nieve fuerte',
  77: 'Granizo',
  80: 'Chubascos ligeros',
  81: 'Chubascos',
  82: 'Chubascos fuertes',
  85: 'Nevadas ligeras',
  86: 'Nevadas fuertes',
  95: 'Tormenta',
  96: 'Tormenta con granizo',
  99: 'Tormenta fuerte con granizo',
};

function getWeatherLabel(code: number): string {
  return WEATHER_CODE_MAP[code] ?? 'Desconocido';
}

function getWeatherIcon(code: number): string {
  if (code === 0) return 'wb-sunny';
  if (code >= 1 && code <= 3) return 'cloud';
  if (code >= 45 && code <= 48) return 'foggy';
  if (code >= 51 && code <= 67) return 'water-drop';
  if (code >= 71 && code <= 77) return 'ac-unit';
  if (code >= 80 && code <= 82) return 'grain';
  if (code >= 85 && code <= 86) return 'ac-unit';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return 'cloud';
}

function formatDayLabel(dateStr: string, index: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayStart = new Date(d);
  dayStart.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dayStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Mañana';
  const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  return days[d.getDay()];
}

type WeatherData = {
  current: {
    temperature_2m: number;
    precipitation_probability: number | null;
    weather_code: number;
  };
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
    weather_code: number[];
  };
};

export default function WeatherWidget() {
  const [data, setData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(OPEN_METEO_URL)
      .then((res) => res.json())
      .then((json) => {
        if (json.error) {
          setError(json.reason || 'Error al cargar');
          return;
        }
        setData({
          current: {
            temperature_2m: json.current?.temperature_2m ?? 0,
            precipitation_probability: json.current?.precipitation_probability ?? null,
            weather_code: json.current?.weather_code ?? 0,
          },
          daily: {
            time: json.daily?.time ?? [],
            temperature_2m_max: json.daily?.temperature_2m_max ?? [],
            temperature_2m_min: json.daily?.temperature_2m_min ?? [],
            precipitation_probability_max: json.daily?.precipitation_probability_max ?? [],
            weather_code: json.daily?.weather_code ?? [],
          },
        });
      })
      .catch((err) => setError(err.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <View style={styles.widget}>
        <Text style={styles.title}>Tiempo en Granada</Text>
        <ActivityIndicator size="small" color="#7dd3fc" style={styles.loader} />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.widget}>
        <Text style={styles.title}>Tiempo en Granada</Text>
        <Text style={styles.error}>{error || 'Sin datos'}</Text>
      </View>
    );
  }

  const { current, daily } = data;

  return (
    <View style={styles.widget}>
      <Text style={styles.title}>Tiempo en Granada</Text>
      <View style={styles.todayRow}>
        <MaterialIcons name={getWeatherIcon(current.weather_code) as any} size={40} color="#7dd3fc" />
        <View style={styles.todayInfo}>
          <Text style={styles.todayTemp}>{Math.round(current.temperature_2m)}°</Text>
          <Text style={styles.todayLabel}>{getWeatherLabel(current.weather_code)}</Text>
          {current.precipitation_probability != null && current.precipitation_probability > 0 && (
            <Text style={styles.rainProb}>Lluvia {current.precipitation_probability}%</Text>
          )}
        </View>
      </View>
      <View style={styles.forecastList}>
        {daily.time.slice(0, 8).map((dateStr, i) => (
          <View key={dateStr} style={styles.forecastRow}>
            <Text style={styles.forecastDay}>{formatDayLabel(dateStr, i)}</Text>
            <MaterialIcons
              name={getWeatherIcon(daily.weather_code[i] ?? 0) as any}
              size={18}
              color="#94a3b8"
            />
            <Text style={styles.forecastTemp}>
              {Math.round(daily.temperature_2m_max[i] ?? 0)}° / {Math.round(daily.temperature_2m_min[i] ?? 0)}°
            </Text>
            {(daily.precipitation_probability_max[i] ?? 0) > 0 ? (
              <Text style={styles.forecastRain}>{daily.precipitation_probability_max[i]}%</Text>
            ) : (
              <Text style={styles.forecastRainEmpty}>—</Text>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  widget: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 14,
    minWidth: 260,
    alignSelf: 'stretch',
    overflow: 'hidden',
    ...(Platform.OS === 'web' && { boxShadow: '0 2px 8px rgba(15,23,42,0.3)' } as object),
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94a3b8',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
  },
  loader: { marginVertical: 12 },
  error: {
    fontSize: 12,
    color: '#fca5a5',
  },
  todayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'rgba(125,211,252,0.3)',
  },
  todayInfo: { marginLeft: 12 },
  todayTemp: {
    fontSize: 28,
    fontWeight: '700',
    color: '#7dd3fc',
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
  },
  todayLabel: {
    fontSize: 14,
    color: '#f8fafc',
    fontWeight: '500',
    marginTop: 2,
  },
  rainProb: {
    fontSize: 12,
    color: '#38bdf8',
    marginTop: 4,
    fontWeight: '600',
  },
  forecastList: { gap: 6 },
  forecastRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
    gap: 8,
  },
  forecastDay: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '600',
    minWidth: 52,
  },
  forecastTemp: {
    fontSize: 12,
    color: '#f8fafc',
    fontWeight: '600',
    flex: 1,
    textAlign: 'right',
    ...(Platform.OS === 'web' ? { fontFamily: '"Courier New", Courier, monospace' } as object : { fontFamily: 'monospace' }),
  },
  forecastRain: {
    fontSize: 11,
    color: '#38bdf8',
    fontWeight: '600',
    minWidth: 32,
    textAlign: 'right',
  },
  forecastRainEmpty: {
    fontSize: 11,
    color: '#64748b',
    minWidth: 32,
    textAlign: 'right',
  },
});
