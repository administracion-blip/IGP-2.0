/**
 * Ficha técnica PDF de un escandallo (receta).
 * Los importes y textos llegan ya calculados desde el detalle; no se inventan.
 */

type jsPDF = import('jspdf').jsPDF;

export type FichaEscandalloLineaPdf = {
  producto: string;
  cantidadUd: string;
  merma: string;
  coste: string;
  compraContexto?: string;
};

export type FichaEscandalloPastilla = {
  texto: string;
  bg: string;
  fg: string;
};

export type FichaEscandalloDatos = {
  productoId: string;
  nombre: string;
  udRecetaLabel: string;
  activo: boolean;
  /** Data URL ya resuelto por el caller (`apiFetch` al binario). Sin foto → null. */
  imagenDataUrl: string | null;
  localNombre: string;
  almacenNombre: string;
  tarifaAgora: string;
  peso: string;
  volumen: string;
  unidades: string;
  costeTeorico: string;
  costePastilla: FichaEscandalloPastilla;
  precioVenta: string;
  margen: string | null;
  margenNeto: string | null;
  margenColores?: { bg: string; fg: string };
  lineas: FichaEscandalloLineaPdf[];
  totalCoste: string;
  notas: string[];
};

const MARGIN = 12;
const FOTO_MM = 52;
const COLOR_PRIMARY: [number, number, number] = [14, 165, 233];
const COLOR_SLATE: [number, number, number] = [15, 23, 42];
const COLOR_MUTED: [number, number, number] = [100, 116, 139];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function val(v: string | null | undefined): string {
  const s = String(v ?? '').trim();
  return s || '—';
}

function inicialesPlato(nombre: string, productoId: string): string {
  const parts = nombre.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  if (parts[0] && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
  const id = productoId.trim();
  if (id.length >= 2) return id.slice(0, 2).toUpperCase();
  return '—';
}

function formatoImagen(dataUrl: string): 'PNG' | 'JPEG' | 'WEBP' {
  if (dataUrl.startsWith('data:image/png')) return 'PNG';
  if (dataUrl.startsWith('data:image/webp')) return 'WEBP';
  return 'JPEG';
}

function ensureY(doc: jsPDF, y: number, needed: number): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y + needed > pageH - 14) {
    doc.addPage();
    return 14;
  }
  return y;
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;
}

function drawChip(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  opts?: { bg?: string; fg?: string; pastilla?: FichaEscandalloPastilla; nota?: string },
) {
  const bg = hexToRgb(opts?.bg ?? '#f8fafc');
  const fg = hexToRgb(opts?.fg ?? '#0f172a');
  doc.setFillColor(...bg);
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.25);
  doc.roundedRect(x, y, w, h, 1.6, 1.6, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(5.5);
  doc.setTextColor(...COLOR_MUTED);
  doc.text(label.toUpperCase(), x + 2.4, y + 4);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...fg);
  const valueLines = doc.splitTextToSize(value, w - 5) as string[];
  doc.text(valueLines.slice(0, 2), x + 2.4, y + 8.2);

  if (opts?.pastilla) {
    const [pbgR, pbgG, pbgB] = hexToRgb(opts.pastilla.bg);
    const [pfgR, pfgG, pfgB] = hexToRgb(opts.pastilla.fg);
    doc.setFontSize(6);
    doc.setFont('helvetica', 'bold');
    const pw = doc.getTextWidth(opts.pastilla.texto) + 3.2;
    const px = x + w - pw - 2;
    const py = y + 2.2;
    doc.setFillColor(pbgR, pbgG, pbgB);
    doc.roundedRect(px, py, pw, 4.2, 1.1, 1.1, 'F');
    doc.setTextColor(pfgR, pfgG, pfgB);
    doc.text(opts.pastilla.texto, px + 1.6, py + 3);
  }

  if (opts?.nota) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(...COLOR_MUTED);
    const notaLines = doc.splitTextToSize(opts.nota, w - 5) as string[];
    doc.text(notaLines.slice(0, 2), x + 2.4, y + h - 3.2);
  }
}

function addPiePaginas(doc: jsPDF, fechaHora: string): void {
  const total = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= total; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text(`Documento interno · no fiscal · ${fechaHora}`, MARGIN, pageH - 7);
    doc.text(`${i}/${total}`, pageW - MARGIN, pageH - 7, { align: 'right' });
  }
}

export async function generarFichaEscandalloPdf(datos: FichaEscandalloDatos): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const contentW = pageW - MARGIN * 2;
  const fechaHora = new Date().toLocaleString('es-ES');
  let y = 12;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR_MUTED);
  doc.text('IGP · ESCANDALLO', MARGIN, y);
  doc.text(fechaHora, pageW - MARGIN, y, { align: 'right' });
  y += 5.5;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...COLOR_SLATE);
  doc.text('Ficha técnica de receta', MARGIN, y);
  y += 8;

  const fotoX = MARGIN;
  const fotoY = y;
  let fotoOk = false;
  if (datos.imagenDataUrl) {
    try {
      doc.addImage(
        datos.imagenDataUrl,
        formatoImagen(datos.imagenDataUrl),
        fotoX,
        fotoY,
        FOTO_MM,
        FOTO_MM,
      );
      fotoOk = true;
    } catch {
      fotoOk = false;
    }
  }
  if (!fotoOk) {
    doc.setFillColor(226, 232, 240);
    doc.setDrawColor(203, 213, 225);
    doc.roundedRect(fotoX, fotoY, FOTO_MM, FOTO_MM, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(...COLOR_MUTED);
    const ini = inicialesPlato(datos.nombre, datos.productoId);
    doc.text(ini, fotoX + FOTO_MM / 2, fotoY + FOTO_MM / 2 + 2, { align: 'center' });
  }

  const textX = MARGIN + FOTO_MM + 6;
  const textW = contentW - FOTO_MM - 6;
  let ty = fotoY + 6;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...COLOR_SLATE);
  const nombreLines = doc.splitTextToSize(val(datos.nombre), textW) as string[];
  doc.text(nombreLines.slice(0, 2), textX, ty);
  ty += nombreLines.length > 1 ? 14 : 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR_MUTED);
  const meta1 = [
    datos.productoId ? `ID ${datos.productoId}` : '—',
    datos.udRecetaLabel || '—',
    datos.activo ? 'Activo' : 'Inactivo',
  ].join(' · ');
  doc.text(meta1, textX, ty);
  ty += 5;

  const meta2 = [val(datos.localNombre), val(datos.almacenNombre), val(datos.tarifaAgora)].join(' · ');
  const meta2Lines = doc.splitTextToSize(meta2, textW) as string[];
  doc.text(meta2Lines.slice(0, 2), textX, ty);

  y = fotoY + FOTO_MM + 8;

  const chipH = 18;
  const chipGap = 2.4;
  const row1 = 4;
  const chipW1 = (contentW - chipGap * (row1 - 1)) / row1;
  y = ensureY(doc, y, chipH * 2 + 8);

  drawChip(doc, MARGIN, y, chipW1, chipH, 'Peso', datos.peso);
  drawChip(doc, MARGIN + chipW1 + chipGap, y, chipW1, chipH, 'Volumen', datos.volumen);
  drawChip(doc, MARGIN + (chipW1 + chipGap) * 2, y, chipW1, chipH, 'Unidades', datos.unidades);
  drawChip(doc, MARGIN + (chipW1 + chipGap) * 3, y, chipW1, chipH, 'Coste teórico', datos.costeTeorico, {
    pastilla: datos.costePastilla,
  });
  y += chipH + chipGap;

  const row2 = datos.margen ? 2 : 1;
  const chipW2 = (contentW - chipGap * (row2 - 1)) / row2;
  drawChip(doc, MARGIN, y, chipW2, chipH + (datos.margenNeto ? 4 : 0), 'P. venta', datos.precioVenta);
  if (datos.margen) {
    drawChip(
      doc,
      MARGIN + chipW2 + chipGap,
      y,
      chipW2,
      chipH + (datos.margenNeto ? 4 : 0),
      'Margen',
      datos.margen,
      {
        bg: datos.margenColores?.bg,
        fg: datos.margenColores?.fg,
        nota: datos.margenNeto ?? undefined,
      },
    );
  }
  y += chipH + (datos.margenNeto ? 4 : 0) + 8;

  const nIng = datos.lineas.length;
  y = ensureY(doc, y, 16);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR_SLATE);
  doc.text(`Ingredientes (${nIng})`, MARGIN, y);
  y += 3;

  if (nIng === 0) {
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...COLOR_MUTED);
    doc.text('Esta receta no tiene ingredientes.', MARGIN, y);
    y += 8;
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN, bottom: 16 },
      head: [['#', 'Producto', 'Cant. + ud', 'Merma', 'Coste']],
      body: datos.lineas.map((ln, i) => [
        String(i + 1),
        ln.compraContexto ? `${ln.producto}\n${ln.compraContexto}` : ln.producto,
        ln.cantidadUd,
        ln.merma,
        ln.coste,
      ]),
      theme: 'grid',
      styles: {
        font: 'helvetica',
        fontSize: 7.5,
        cellPadding: { top: 1.8, right: 1.6, bottom: 1.8, left: 1.6 },
        overflow: 'linebreak',
        valign: 'middle',
        textColor: COLOR_SLATE,
      },
      headStyles: {
        fillColor: COLOR_PRIMARY,
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 7,
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 10, halign: 'center' },
        1: { cellWidth: 'auto' },
        2: { cellWidth: 28, halign: 'right' },
        3: { cellWidth: 18, halign: 'right' },
        4: { cellWidth: 26, halign: 'right' },
      },
    });
    y = lastTableY(doc, y + 20) + 6;
  }

  y = ensureY(doc, y, 10);
  doc.setFillColor(240, 249, 255);
  doc.setDrawColor(...COLOR_PRIMARY);
  doc.setLineWidth(0.3);
  doc.roundedRect(MARGIN, y, contentW, 9, 1.6, 1.6, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR_SLATE);
  doc.text('Total coste receta', MARGIN + 3, y + 6);
  doc.setTextColor(...COLOR_PRIMARY);
  doc.text(datos.totalCoste, pageW - MARGIN - 3, y + 6, { align: 'right' });
  y += 14;

  if (datos.notas.length > 0) {
    y = ensureY(doc, y, 12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR_SLATE);
    doc.text('Notas', MARGIN, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR_MUTED);
    for (const nota of datos.notas) {
      const lines = doc.splitTextToSize(`• ${nota}`, contentW) as string[];
      for (const line of lines) {
        y = ensureY(doc, y, 5);
        doc.text(line, MARGIN, y);
        y += 4;
      }
    }
  }

  addPiePaginas(doc, fechaHora);
  return doc;
}

export async function descargarFichaEscandalloPdf(datos: FichaEscandalloDatos): Promise<void> {
  const doc = await generarFichaEscandalloPdf(datos);
  const safe = String(datos.productoId || 'receta').replace(/[^\w\-]+/g, '_') || 'receta';
  doc.save(`ficha-escandallo-${safe}.pdf`);
}
