/**
 * Previsión de ventas por franjas: cálculo puro (sin Dynamo ni Ágora).
 *
 * La previsión de un día es la venta real por hora de su fecha comparativa
 * agrupada en las franjas de una plantilla (Igp_FranjasHorarias).
 */

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function esFechaIso(valor) {
  if (!RE_FECHA.test(String(valor ?? ''))) return false;
  const [y, m, d] = String(valor).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function minutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/** Franja válida de una plantilla: `desde`/`hasta` en HH:MM. */
export function esFranjaValida(franja) {
  return RE_HHMM.test(String(franja?.desde ?? '')) && RE_HHMM.test(String(franja?.hasta ?? ''));
}

/**
 * Horas del reloj (0-23) que cubre una franja: cada hora pertenece a la franja que
 * contiene su minuto :00. Un `desde` en HH:01 cuenta como HH:00 (18:01 → 18), así
 * franjas encadenadas tipo 18:00/18:01 no pierden la hora; con 13:00–16:30 y
 * 16:31–20:00 la hora 16 queda solo en la primera. Fin exclusivo. Si `hasta` <= `desde`
 * la franja cruza la medianoche (21:01–00:00 → 21, 22, 23).
 */
export function horasDeFranja(franja) {
  if (!esFranjaValida(franja)) return [];
  const desde = minutos(franja.desde);
  const ini = Math.ceil((desde % 60 === 1 ? desde - 1 : desde) / 60);
  const fin = Math.ceil(minutos(franja.hasta) / 60);
  const horas = [];
  if (fin > ini) {
    for (let h = ini; h < fin; h += 1) horas.push(h);
  } else {
    for (let h = ini; h < 24; h += 1) horas.push(h);
    for (let h = 0; h < fin; h += 1) horas.push(h);
  }
  return horas;
}

/** Duración en horas usada para el personal sugerido (horas de reloj cubiertas). */
export function horasDuracion(franja) {
  return horasDeFranja(franja).length;
}

export function sumarFranja(porHora, franja) {
  const mapa = porHora && typeof porHora === 'object' ? porHora : {};
  let total = 0;
  for (const h of horasDeFranja(franja)) total += Number(mapa[String(h)]) || 0;
  return total;
}

/** 'Etiqueta (HH:MM–HH:MM)' o 'HH:MM–HH:MM'. */
export function labelFranja(franja) {
  const rango = `${franja.desde}–${franja.hasta}`;
  const etiqueta = String(franja?.etiqueta ?? '').trim();
  return etiqueta ? `${etiqueta} (${rango})` : rango;
}

/** Franjas válidas de una plantilla con su label y horas. */
export function prepararFranjas(franjas) {
  return (Array.isArray(franjas) ? franjas : [])
    .filter(esFranjaValida)
    .map((f) => {
      const etiqueta = String(f.etiqueta ?? '').trim();
      return {
        desde: f.desde,
        hasta: f.hasta,
        etiqueta,
        label: labelFranja(f),
        horas: horasDuracion(f),
      };
    });
}

/** Mismo día un año antes (29/02 → 01/03), igual que `fechaComparacion` de objetivoMensual. */
export function fechaAnioAnterior(fecha) {
  const [y, m, d] = String(fecha).split('-').map(Number);
  return new Date(Date.UTC(y - 1, m - 1, d)).toISOString().slice(0, 10);
}

export function esFestivoMarcado(registro) {
  return registro?.Festivo === true || registro?.Festivo === 'true';
}

/**
 * Fecha comparativa de un día: `FechaComparativa` del registro de festivos si es
 * ISO válida; si no, el mismo día del año anterior.
 *
 * @param {string} fecha YYYY-MM-DD
 * @param {object|null|undefined} festivo registro { FechaComparativa, Festivo, NombreFestivo }
 */
export function resolverFechaComparativa(fecha, festivo) {
  const fcRaw = festivo?.FechaComparativa != null ? String(festivo.FechaComparativa).slice(0, 10) : '';
  const deFestivo = esFechaIso(fcRaw);
  return {
    fechaComparativa: deFestivo ? fcRaw : fechaAnioAnterior(fecha),
    origenComparativa: deFestivo ? 'festivo' : 'anio_anterior',
    festivo: esFestivoMarcado(festivo) ? { nombre: String(festivo.NombreFestivo ?? '').trim() } : null,
  };
}

/** Personas sugeridas para cubrir `importe` con `objetivo` €/empleado/hora durante `horas`. */
export function personalSugerido(importe, objetivo, horas) {
  const imp = Number(importe) || 0;
  const obj = Number(objetivo) || 0;
  const h = Number(horas) || 0;
  if (!(imp > 0) || !(obj > 0) || !(h > 0)) return 0;
  return Math.ceil(imp / (obj * h));
}

function desvio(real, previsto) {
  return previsto > 0 && real != null ? round4(real / previsto - 1) : null;
}

/**
 * Un día de un local.
 *
 * @param {{
 *   fecha: string, hoyJornada: string, franjas: ReturnType<typeof prepararFranjas>,
 *   objetivo: number, comparativa: ReturnType<typeof resolverFechaComparativa>,
 *   nombreFestivoComparativa: string|null,
 *   datoComparativa: object|undefined, datoReal: object|undefined,
 * }} p  `dato*` como los devuelve `obtenerVentasHora`.
 */
export function calcularDia(p) {
  const { fecha, hoyJornada, franjas, objetivo, comparativa, nombreFestivoComparativa } = p;
  const pasado = fecha < hoyJornada;

  let motivo = null;
  const comp = p.datoComparativa;
  if (comparativa.fechaComparativa >= fecha) motivo = 'comparativa_no_anterior';
  else if (!comp || comp.pendiente) motivo = 'pendiente';
  else if (comp.error) motivo = 'error_agora';
  else if (!(Number(comp.totalDia) > 0)) motivo = 'sin_ventas';
  const valida = motivo == null;

  const real = p.datoReal;
  const hayReal = pasado && real && !real.pendiente && !real.error && !real.noCerrado;

  const celdas = franjas.map((f) => {
    const previsto = valida ? round2(sumarFranja(comp.porHora, f)) : 0;
    const realFranja = hayReal ? round2(sumarFranja(real.porHora, f)) : null;
    return {
      previsto,
      personal: personalSugerido(previsto, objetivo, f.horas),
      real: realFranja,
      desvioPct: desvio(realFranja, previsto),
    };
  });

  const totalPrevisto = round2(celdas.reduce((s, c) => s + c.previsto, 0));
  const totalReal = hayReal ? round2(celdas.reduce((s, c) => s + c.real, 0)) : null;
  const fuera = valida ? round2(Number(comp.totalDia) - totalPrevisto) : 0;

  return {
    fecha,
    pasado,
    fechaComparativa: comparativa.fechaComparativa,
    origenComparativa: comparativa.origenComparativa,
    festivo: comparativa.festivo,
    nombreFestivoComparativa: nombreFestivoComparativa || null,
    valida,
    motivo,
    celdas,
    totalPrevisto,
    totalReal,
    desvioPct: desvio(totalReal, totalPrevisto),
    fueraDeFranjas: Math.abs(fuera) < 0.01 ? 0 : fuera,
  };
}

/**
 * KPIs de un local. Venta real y desvío solo sobre días pasados válidos con real,
 * para comparar lo mismo con lo mismo.
 */
export function construirKpis(dias, franjas) {
  let ventaPrevista = 0;
  let ventaRealPasados = 0;
  let previstoPasados = 0;
  let hayRealPasados = false;
  const porFranja = franjas.map(() => 0);
  let diaMasFuerte = null;
  let picoPersonal = null;

  for (const d of dias) {
    if (!d.valida) continue;
    ventaPrevista += d.totalPrevisto;
    if (d.pasado && d.totalReal != null) {
      hayRealPasados = true;
      ventaRealPasados += d.totalReal;
      previstoPasados += d.totalPrevisto;
    }
    if (d.totalPrevisto > 0 && (!diaMasFuerte || d.totalPrevisto > diaMasFuerte.importe)) {
      diaMasFuerte = { fecha: d.fecha, importe: d.totalPrevisto };
    }
    d.celdas.forEach((c, i) => {
      porFranja[i] += c.previsto;
      if (c.personal > 0 && (!picoPersonal || c.personal > picoPersonal.personas)) {
        picoPersonal = { fecha: d.fecha, label: franjas[i].label, personas: c.personal };
      }
    });
  }

  let franjaMasFuerte = null;
  porFranja.forEach((importe, i) => {
    if (importe > 0 && (!franjaMasFuerte || importe > franjaMasFuerte.importe)) {
      franjaMasFuerte = { label: franjas[i].label, importe: round2(importe) };
    }
  });

  const realTotal = hayRealPasados ? round2(ventaRealPasados) : null;
  return {
    ventaPrevista: round2(ventaPrevista),
    ventaRealPasados: realTotal,
    desvioPct: desvio(realTotal, round2(previstoPasados)),
    franjaMasFuerte,
    diaMasFuerte,
    picoPersonal,
  };
}

/** Días ISO entre `desde` y `hasta` (inclusive). */
export function diasEntre(desde, hasta) {
  if (!esFechaIso(desde) || !esFechaIso(hasta) || desde > hasta) return [];
  const out = [];
  const cursor = new Date(`${desde}T12:00:00Z`);
  const fin = new Date(`${hasta}T12:00:00Z`);
  while (cursor <= fin) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Suma `n` días a una fecha ISO. */
export function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
