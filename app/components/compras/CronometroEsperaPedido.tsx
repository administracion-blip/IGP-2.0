import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

const UMBRAL_ROJO_MS = 5 * 60 * 1000;

type Props = {
  enviadoEn: string;
  completadoEn?: string | null;
  estado: string;
};

export function parseIsoMs(iso: string | number | undefined | null): number | null {
  const s = String(iso ?? '').trim();
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

/** `HH:mm` en hora de España. `null` si el ISO no es válido. */
export function horaEnvioLocal(enviadoEn: string | number | undefined | null): string | null {
  const ms = parseIsoMs(enviadoEn);
  if (ms == null) return null;
  return new Date(ms).toLocaleTimeString('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Cronómetro de espera desde `EnviadoEn`. El tick vive aquí para no
 * re-renderizar la lista entera cada segundo.
 */
export function CronometroEsperaPedido({ enviadoEn, completadoEn, estado }: Props) {
  const inicio = parseIsoMs(enviadoEn);
  const vivo = inicio != null && (estado === 'Enviado' || estado === 'Pendiente');
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    if (!vivo) return undefined;
    const id = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(id);
  }, [vivo]);

  if (inicio == null) return null;

  let fin: number | null = null;
  if (estado === 'Completado') {
    fin = parseIsoMs(completadoEn);
  } else if (vivo) {
    fin = ahora;
  }
  if (fin == null) return null;

  const elapsed = fin - inicio;
  const texto = formatElapsed(elapsed);

  return (
    <Text
      style={[styles.crono, elapsed >= UMBRAL_ROJO_MS && styles.cronoRojo]}
      accessibilityLabel={`Tiempo de espera ${texto}`}
    >
      {texto}
    </Text>
  );
}

const styles = StyleSheet.create({
  crono: {
    fontSize: 13,
    fontWeight: '700',
    color: '#475569',
    fontVariant: ['tabular-nums'],
  },
  cronoRojo: { color: '#dc2626' },
});
