import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { tasksUi } from '../constants/tasksUiTokens';
import { useBreakpoint } from '../hooks/useBreakpoint';

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

/** Nombres según glyphmaps/MaterialIcons.json (@expo/vector-icons), kebab-case */
function getWeatherIcon(code: number): React.ComponentProps<typeof MaterialIcons>['name'] {
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

function getWeatherIconColor(code: number): string {
  if (code <= 1) return '#f59e0b';
  if (code <= 3 || (code >= 45 && code <= 48)) return '#94a3b8';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '#38bdf8';
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '#7dd3fc';
  if (code >= 95) return '#7c3aed';
  return '#94a3b8';
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
  const { shouldStackPanels } = useBreakpoint();
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
      <View style={styles.widgetShell}>
        <View style={styles.widget}>
          <View style={styles.mainRow}>
            <Text style={styles.headline}>Tiempo · Granada</Text>
            <ActivityIndicator size="small" color={tasksUi.color.acento} style={styles.loaderInline} />
          </View>
        </View>
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.widgetShell}>
        <View style={styles.widget}>
          <View style={styles.mainRow}>
            <Text style={styles.headline}>Tiempo · Granada</Text>
            <Text style={styles.error}>{error || 'Sin datos'}</Text>
          </View>
        </View>
      </View>
    );
  }

  const { current, daily } = data;
  const apilar = shouldStackPanels;

  return (
    <View style={styles.widgetShell}>
      <View style={styles.widget}>
        <View style={[styles.mainRow, apilar && styles.mainRowApilado]}>
          <View style={styles.actualFila}>
            <View style={styles.headBlock}>
              <Text style={styles.headline}>Tiempo · Granada</Text>
            </View>

            <View style={styles.currentCluster}>
              <View style={styles.todayIconWrap}>
                <MaterialIcons
                  name={getWeatherIcon(current.weather_code)}
                  size={28}
                  color={getWeatherIconColor(current.weather_code)}
                />
              </View>
              <View style={styles.currentTexts}>
                <Text style={styles.todayTemp}>{Math.round(current.temperature_2m)}°</Text>
                <Text style={styles.todayLabel} numberOfLines={1}>
                  {getWeatherLabel(current.weather_code)}
                </Text>
                {current.precipitation_probability != null && current.precipitation_probability > 0 ? (
                  <Text style={styles.rainProb}>Lluvia {current.precipitation_probability}%</Text>
                ) : null}
              </View>
            </View>
          </View>

          {apilar ? null : <View style={styles.verticalRule} />}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.forecastScroll, apilar && styles.forecastScrollApilado]}
            contentContainerStyle={styles.forecastScrollContent}
          >
            {daily.time.slice(0, 8).map((dateStr, i) => {
              const rain = daily.precipitation_probability_max[i] ?? 0;
              return (
                <View key={dateStr} style={styles.dayChip}>
                  <Text style={styles.dayChipLabel}>{formatDayLabel(dateStr, i)}</Text>
                  <MaterialIcons
                    name={getWeatherIcon(daily.weather_code[i] ?? 0)}
                    size={20}
                    color={getWeatherIconColor(daily.weather_code[i] ?? 0)}
                  />
                  <Text style={styles.dayChipTemp}>
                    {Math.round(daily.temperature_2m_max[i] ?? 0)}° / {Math.round(daily.temperature_2m_min[i] ?? 0)}°
                  </Text>
                  {rain > 0 ? (
                    <Text style={styles.dayChipRain}>{rain}%</Text>
                  ) : (
                    <Text style={styles.dayChipRainEmpty}>—</Text>
                  )}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  widgetShell: {
    width: '100%',
    alignSelf: 'stretch',
    borderRadius: tasksUi.radius.contenedor,
  },
  widget: {
    backgroundColor: tasksUi.color.superficie,
    borderRadius: tasksUi.radius.contenedor,
    borderWidth: 1,
    borderColor: tasksUi.color.bordeSutil,
    paddingVertical: 10,
    paddingHorizontal: tasksUi.space[3],
    width: '100%',
    alignSelf: 'stretch',
    overflow: 'hidden',
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
  },
  mainRowApilado: {
    flexDirection: 'column',
    alignItems: 'stretch',
    minHeight: 0,
    gap: tasksUi.space[3],
  },
  actualFila: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  forecastScrollApilado: {
    flex: 0,
    width: '100%',
    alignSelf: 'stretch',
  },
  headBlock: {
    flexShrink: 0,
    marginRight: 10,
    justifyContent: 'center',
  },
  headline: {
    ...tasksUi.tipo.etiqueta,
  },
  loaderInline: { marginHorizontal: 10 },
  currentCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  todayIconWrap: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  currentTexts: {
    marginLeft: 8,
    maxWidth: 140,
    justifyContent: 'center',
  },
  todayTemp: {
    fontSize: 30,
    fontWeight: '600',
    lineHeight: 34,
    color: tasksUi.color.textoPrimario,
    ...tasksUi.tabularNums,
  },
  todayLabel: {
    ...tasksUi.tipo.etiqueta,
    color: tasksUi.color.textoSecundario,
    marginTop: 0,
  },
  rainProb: {
    ...tasksUi.tipo.micro,
    color: tasksUi.color.textoEnlace,
    marginTop: 2,
  },
  verticalRule: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    minHeight: 44,
    backgroundColor: tasksUi.color.bordeSutil,
    marginHorizontal: 10,
    flexShrink: 0,
  },
  forecastScroll: {
    flex: 1,
    minWidth: 0,
  },
  forecastScrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 4,
  },
  dayChip: {
    width: 64,
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 2,
    marginRight: tasksUi.space[4],
  },
  dayChipLabel: {
    ...tasksUi.tipo.etiqueta,
    marginBottom: 4,
  },
  dayChipTemp: {
    ...tasksUi.tipo.micro,
    color: tasksUi.color.textoSecundario,
    marginTop: 2,
    ...tasksUi.tabularNums,
  },
  dayChipRain: {
    ...tasksUi.tipo.micro,
    color: tasksUi.color.textoEnlace,
    marginTop: 2,
  },
  dayChipRainEmpty: {
    ...tasksUi.tipo.micro,
    marginTop: 2,
  },
  error: {
    ...tasksUi.tipo.etiqueta,
    color: tasksUi.color.peligro,
    flex: 1,
    marginLeft: 8,
  },
});
