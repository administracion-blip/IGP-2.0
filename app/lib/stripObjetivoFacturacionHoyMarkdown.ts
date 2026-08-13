/**
 * Recorta del markdown IA el subapartado «Qué tenemos que facturar hoy»
 * para no duplicarlo con el recuadro estructurado de `objetivoFacturacionHoy`.
 *
 * Acepta ## / ### / negrita / línea suelta (con o sin emoji).
 * Corta hasta el siguiente heading `## ` (no `###`) o fin de texto.
 */
export function stripObjetivoFacturacionHoyMarkdown(texto: string | null | undefined): string {
  const raw = String(texto ?? '');
  if (!raw.trim()) return raw;

  const lines = raw.split(/\r?\n/);
  const startRe =
    /^(?:#{2,3}\s*)?(?:\*\*)?(?:[🎯📊✅\uFE0F\u200D]\s*)*qué tenemos que facturar hoy/i;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return raw;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }

  return [...lines.slice(0, start), ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
