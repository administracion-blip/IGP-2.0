/**
 * Texto de las actas de entrega. HTML limpio + huecos {{clave}}.
 */

export const CUERPO_PLANTILLA_DEFAULT = `<p><b>Acta de entrega de material</b></p>
<p>Fecha: {{fecha}}<br>Local: {{local}}<br>Trabajador que recibe: {{trabajador}}<br>Quien entrega: {{entregado_por}}</p>
<p><b>Material:</b></p>
<p>{{items}}</p>
<p>Declaro haber recibido el material relacionado y me comprometo a su uso y custodia conforme a las normas del grupo.</p>
<p>Firma: {{firma}}</p>`;

export const DATOS_PREVIEW_PLANTILLA = {
  fecha: '07/09/2026',
  local: 'Paripe',
  trabajador: 'María García',
  entregado_por: 'Almacén central',
  items: 'CAMI-00018 · Camiseta · Talla M · 5 ud.<br>PDA-00012 · Sunmi L2K · S/N ABC123',
  firma: '(pendiente de firma)',
  categoria: 'Camiseta',
};

const TAGS_OK = new Set(['p', 'br', 'div', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'span', 'h2', 'h3']);

export function sanitizarHtmlPlantilla(html) {
  let out = String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
  out = out.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (m, tag, attrs) => {
    const t = String(tag).toLowerCase();
    if (!TAGS_OK.has(t)) return '';
    if (t === 'br') return '<br>';
    if (m.startsWith('</')) return `</${t}>`;
    if (t === 'span') {
      const color = String(attrs || '').match(/color\s*:\s*([^;"]+)/i);
      const size = String(attrs || '').match(/font-size\s*:\s*([^;"]+)/i);
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

export function renderCuerpoPlantilla(cuerpo, datos = {}) {
  let out = sanitizarHtmlPlantilla(String(cuerpo || ''));
  if (out && !/<[a-z][\s\S]*>/i.test(String(cuerpo || ''))) {
    out = sanitizarHtmlPlantilla(`<p>${String(cuerpo).replace(/\n/g, '<br>')}</p>`);
  }
  for (const [clave, valor] of Object.entries(datos)) {
    out = out.split(`{{${clave}}}`).join(valor == null ? '' : String(valor));
  }
  return out;
}
