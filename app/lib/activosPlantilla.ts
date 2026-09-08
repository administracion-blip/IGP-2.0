export const CUERPO_PLANTILLA_DEFAULT = `<p><b>Acta de entrega de material</b></p>
<p>Fecha: {{fecha}}<br>Local: {{local}}<br>Trabajador que recibe: {{trabajador}}<br>Quien entrega: {{entregado_por}}</p>
<p><b>Material:</b></p>
<p>{{items}}</p>
<p>Declaro haber recibido el material relacionado y me comprometo a su uso y custodia conforme a las normas del grupo.</p>
<p>Firma: {{firma}}</p>`;

export const HUECOS_PLANTILLA = [
  { clave: 'fecha', label: 'Fecha' },
  { clave: 'local', label: 'Local' },
  { clave: 'trabajador', label: 'Trabajador' },
  { clave: 'entregado_por', label: 'Quien entrega' },
  { clave: 'items', label: 'Material' },
  { clave: 'firma', label: 'Firma' },
] as const;

export const DATOS_PREVIEW_PLANTILLA: Record<string, string> = {
  fecha: '07/09/2026',
  local: 'Paripe',
  trabajador: 'María García',
  entregado_por: 'Almacén central',
  items: 'CAMI-00018 · Camiseta · Talla M · 5 ud.<br>PDA-00012 · Sunmi L2K · S/N ABC123',
  firma: '(pendiente de firma)',
};

const TAGS_OK = new Set(['p', 'br', 'div', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'span', 'h2', 'h3']);

export function sanitizarHtmlPlantilla(html: string): string {
  let out = String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
  out = out.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (m, tag: string, attrs: string) => {
    const t = tag.toLowerCase();
    if (!TAGS_OK.has(t)) return '';
    if (t === 'br') return '<br>';
    if (m.startsWith('</')) return `</${t}>`;
    if (t === 'span') {
      const color = attrs.match(/color\s*:\s*([^;"]+)/i);
      const size = attrs.match(/font-size\s*:\s*([^;"]+)/i);
      const bits = [
        color ? `color:${color[1].trim().slice(0, 24)}` : '',
        size ? `font-size:${size[1].trim().slice(0, 12)}` : '',
      ].filter(Boolean);
      return bits.length ? `<span style="${bits.join(';')}">` : '<span>';
    }
    return `<${t}>`;
  });
  return out;
}

export function cuerpoAHtml(cuerpo: string): string {
  const s = String(cuerpo || '').trim();
  if (!s) return CUERPO_PLANTILLA_DEFAULT;
  if (/<[a-z][\s\S]*>/i.test(s)) return sanitizarHtmlPlantilla(s);
  return sanitizarHtmlPlantilla(`<p>${s.replace(/\n/g, '<br>')}</p>`);
}

export function renderCuerpoPlantilla(
  cuerpo: string,
  datos: Record<string, string> = DATOS_PREVIEW_PLANTILLA,
): string {
  let out = cuerpoAHtml(cuerpo);
  for (const [clave, valor] of Object.entries(datos)) {
    out = out.split(`{{${clave}}}`).join(valor == null ? '' : String(valor));
  }
  return out;
}
