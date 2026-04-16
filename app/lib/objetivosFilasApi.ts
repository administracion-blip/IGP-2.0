/**
 * Misma lógica que la comparativa diaria en Cajas → Objetivos (Agora + festivos).
 * Centralizada para reutilizar en Actuaciones (previsión = TotalFacturadoComparativa).
 */

export type FestivoReg = {
  PK?: string;
  FechaComparativa?: string;
  Festivo?: boolean;
  NombreFestivo?: string;
};

export type FilaObjetivo = {
  Fecha: string;
  FechaComparacion: string;
  Festivo: boolean;
  NombreFestivo: string;
  TotalFacturadoReal: number;
  TotalFacturadoComparativa: number;
  Desvio: number;
  DesvioPct: number | null;
};

export function fechaComparacion(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00');
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

export async function obtenerFilasObjetivos(
  apiBaseUrl: string,
  workplaceId: string,
  fechaInicio: string,
  fechaFin: string,
): Promise<FilaObjetivo[]> {
  const [totalsRealRes, festivosRes] = await Promise.all([
    fetch(
      `${apiBaseUrl}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${fechaInicio}&dateTo=${fechaFin}`,
    ),
    fetch(`${apiBaseUrl}/api/gestion-festivos`),
  ]);
  const totalsRealData = await totalsRealRes.json();
  const festivosData = await festivosRes.json();
  const totalsReal: Record<string, number> = totalsRealData.totals ?? {};
  const festivosList: FestivoReg[] = Array.isArray(festivosData.registros) ? festivosData.registros : [];
  const festivosByFecha = Object.fromEntries(
    festivosList
      .filter((f) => f.PK || f.FechaComparativa)
      .map((f) => [String(f.PK ?? f.FechaComparativa ?? '').slice(0, 10), f]),
  );

  let minComp = '';
  let maxComp = '';
  const d = new Date(fechaInicio + 'T12:00:00');
  const end = new Date(fechaFin + 'T12:00:00');
  const fechaToComp: Record<string, string> = {};
  while (d <= end) {
    const fecha = d.toISOString().slice(0, 10);
    const festivo = festivosByFecha[fecha];
    const fechaComp =
      festivo?.FechaComparativa && /^\d{4}-\d{2}-\d{2}$/.test(String(festivo.FechaComparativa).slice(0, 10))
        ? String(festivo.FechaComparativa).slice(0, 10)
        : fechaComparacion(fecha);
    fechaToComp[fecha] = fechaComp;
    if (!minComp || fechaComp < minComp) minComp = fechaComp;
    if (!maxComp || fechaComp > maxComp) maxComp = fechaComp;
    d.setDate(d.getDate() + 1);
  }

  const totalsCompRes = await fetch(
    `${apiBaseUrl}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${minComp}&dateTo=${maxComp}`,
  );
  const totalsCompData = await totalsCompRes.json();
  const totalsComp: Record<string, number> = totalsCompData.totals ?? {};

  const filas: FilaObjetivo[] = [];
  const d2 = new Date(fechaInicio + 'T12:00:00');
  const end2 = new Date(fechaFin + 'T12:00:00');
  while (d2 <= end2) {
    const fecha = d2.toISOString().slice(0, 10);
    const fechaComp = fechaToComp[fecha];
    const real = totalsReal[fecha] ?? 0;
    const comp = totalsComp[fechaComp] ?? 0;
    const festivo = festivosByFecha[fecha];
    const esFestivo = String(festivo?.Festivo).toLowerCase() === 'true';
    const nombreFestivo = String(festivo?.NombreFestivo ?? '').trim();
    const desvio = real - comp;
    const desvioPct = comp === 0 ? null : real / comp - 1;
    filas.push({
      Fecha: fecha,
      FechaComparacion: fechaComp,
      Festivo: esFestivo,
      NombreFestivo: nombreFestivo,
      TotalFacturadoReal: real,
      TotalFacturadoComparativa: comp,
      Desvio: desvio,
      DesvioPct: desvioPct,
    });
    d2.setDate(d2.getDate() + 1);
  }
  return filas;
}
