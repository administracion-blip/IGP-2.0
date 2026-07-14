export function buildTextoResumenObjetivos(opts: {
  tituloPeriodo: string;
  fechaHastaLabel: string;
  totales: {
    sumRealHastaAyer: number;
    sumCompHastaAyer: number;
    desvioPctHastaAyer: number | null;
  };
  locales: Array<{
    nombre: string;
    sumRealHastaAyer: number;
    sumCompHastaAyer: number;
    desvioPctHastaAyer: number | null;
  }>;
}): string {
  const formatMoneda = (n: number) =>
    new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(n);

  const formatPctTicker = (n: number | null) => {
    if (n == null) return '—';
    const pct = n * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  };

  const desvio = opts.totales.sumRealHastaAyer - opts.totales.sumCompHastaAyer;
  const lines: string[] = [
    `Objetivos — ${opts.tituloPeriodo}`,
    `Acumulado hasta ${opts.fechaHastaLabel}`,
    '',
    `Facturado: ${formatMoneda(opts.totales.sumRealHastaAyer)}`,
    `Comparativa: ${formatMoneda(opts.totales.sumCompHastaAyer)}`,
    `Desvío: ${formatMoneda(desvio)} (${formatPctTicker(opts.totales.desvioPctHastaAyer)})`,
    '',
    'Por local:',
  ];

  const sorted = [...opts.locales].sort((a, b) => {
    const cmp = (b.desvioPctHastaAyer ?? -999) - (a.desvioPctHastaAyer ?? -999);
    if (cmp !== 0) return cmp;
    return a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });
  });

  for (const loc of sorted) {
    lines.push(`• ${loc.nombre.trim() || '—'}: ${formatMoneda(loc.sumRealHastaAyer)} · ${formatPctTicker(loc.desvioPctHastaAyer)}`);
  }

  return lines.join('\n');
}
