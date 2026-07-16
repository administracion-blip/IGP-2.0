/** Convierte importe EUR a texto en español (simplificado, hasta millones). */
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const DIEZ = [
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
];
const DECENAS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function letraHasta999(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  let out = '';
  const c = Math.floor(n / 100);
  const rest = n % 100;
  if (c > 0) out += CENTENAS[c];
  if (rest > 0) {
    if (out) out += ' ';
    if (rest < 10) out += UNIDADES[rest];
    else if (rest < 20) out += DIEZ[rest - 10];
    else {
      const d = Math.floor(rest / 10);
      const u = rest % 10;
      if (rest === 20) out += 'veinte';
      else if (d === 2 && u > 0) out += `veinti${UNIDADES[u]}`;
      else {
        out += DECENAS[d];
        if (u > 0) out += ` y ${UNIDADES[u]}`;
      }
    }
  }
  return out;
}

function letraEntero(n) {
  if (n === 0) return 'cero';
  if (n === 1) return 'un';
  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (millones > 0) {
    parts.push(millones === 1 ? 'un millón' : `${letraHasta999(millones)} millones`);
  }
  if (miles > 0) {
    parts.push(miles === 1 ? 'mil' : `${letraHasta999(miles)} mil`);
  }
  if (rest > 0) parts.push(letraHasta999(rest));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function importeLetraEur(importe) {
  const n = Math.round((Number(importe) || 0) * 100);
  const euros = Math.floor(n / 100);
  const cents = n % 100;
  let s = letraEntero(euros);
  s += euros === 1 ? ' euro' : ' euros';
  if (cents > 0) {
    s += ` con ${cents === 1 ? 'un céntimo' : `${letraEntero(cents)} céntimos`}`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}
