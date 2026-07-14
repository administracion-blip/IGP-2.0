import type { Activacion, ActivacionSesion } from '../types/activaciones';
import { ESTADO_ACTIVACION_META, ESTADO_SESION_META } from '../types/activaciones';
import type { jsPDF } from 'jspdf';

function fechaEs(iso: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '—');
}

function val(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
}

/** Rango de fechas en dos líneas (evita desbordes y caracteres raros en PDF). */
function vigenciaPdf(inicio: string, fin: string): string {
  return `${fechaEs(inicio)}\na ${fechaEs(fin)}`;
}

function vigenciaPdfInline(inicio: string, fin: string): string {
  return `${fechaEs(inicio)} a ${fechaEs(fin)}`;
}

const MARGIN = 14;
const LINE_H = 4.2;

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y + needed > pageH - 12) {
    doc.addPage();
    return 16;
  }
  return y;
}

function textBlock(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxW: number,
  fontSize = 10,
  maxLines?: number,
): { y: number; lines: string[] } {
  doc.setFontSize(fontSize);
  let lines = doc.splitTextToSize(text, maxW) as string[];
  if (maxLines != null) lines = lines.slice(0, maxLines);
  doc.text(lines, x, y);
  return { y: y + lines.length * LINE_H, lines };
}

/** Texto largo a ancho completo con salto de página automático. */
function longTextBlock(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxW: number,
  fontSize = 9,
): number {
  doc.setFontSize(fontSize);
  doc.setFont('helvetica', 'normal');
  const pageH = doc.internal.pageSize.getHeight();
  const lines = doc.splitTextToSize(text, maxW) as string[];
  for (const line of lines) {
    if (y > pageH - 14) {
      doc.addPage();
      y = 16;
    }
    doc.text(line, x, y);
    y += LINE_H;
  }
  return y;
}

/** Genera PDF de la ficha de activación (formato informe A4). */
export async function generarPdfActivacion(
  activacion: Activacion,
  sesiones: ActivacionSesion[],
): Promise<jsPDF> {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const contentW = pageW - MARGIN * 2;
  let y = 16;

  const estadoMeta = ESTADO_ACTIVACION_META[activacion.estado] ?? ESTADO_ACTIVACION_META.borrador;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text('IGP · Activación de marca', MARGIN, y);
  doc.setTextColor(60);
  doc.text(estadoMeta.label, pageW - MARGIN, y, { align: 'right' });
  y += 8;

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  const tituloLines = doc.splitTextToSize(val(activacion.producto), contentW) as string[];
  doc.text(tituloLines.slice(0, 2), MARGIN, y);
  y += tituloLines.length > 1 ? 12 : 8;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(3, 105, 161);
  const crumb = [activacion.marca, activacion.codigo, activacion.tipo_activacion]
    .filter(Boolean)
    .join('  >  ');
  const crumbLines = doc.splitTextToSize(crumb || '—', contentW) as string[];
  doc.text(crumbLines.slice(0, 2), MARGIN, y);
  y += crumbLines.length > 1 ? 10 : 7;

  // --- KPIs con altura dinámica ---
  const kpiGap = 3;
  const kpiCount = 4;
  const kpiW = (contentW - kpiGap * (kpiCount - 1)) / kpiCount;
  const kpiPadX = 3;
  const kpiPadTop = 5;
  const kpiValueW = kpiW - kpiPadX * 2;

  const kpis: { label: string; value: string; valueSize: number; maxLines?: number }[] = [
    {
      label: 'Vigencia',
      value: vigenciaPdf(activacion.vigencia_inicio, activacion.vigencia_fin),
      valueSize: 7.5,
      maxLines: 2,
    },
    {
      label: 'Duración / sesión',
      value: activacion.duracion_horas ? `${activacion.duracion_horas} h` : '—',
      valueSize: 9,
    },
    { label: 'Sesiones', value: String(sesiones.length), valueSize: 9 },
    {
      label: 'Target',
      value: val(activacion.target_descripcion),
      valueSize: 7.5,
      maxLines: 3,
    },
  ];

  doc.setFont('helvetica', 'bold');
  const kpiLineCounts = kpis.map((k) => {
    doc.setFontSize(k.valueSize);
    const lines = doc.splitTextToSize(k.value, kpiValueW) as string[];
    return Math.min(lines.length, k.maxLines ?? 2);
  });
  const maxKpiLines = Math.max(...kpiLineCounts, 1);
  const kpiBoxH = kpiPadTop + 4 + maxKpiLines * LINE_H + 3;

  kpis.forEach((kpi, i) => {
    const x = MARGIN + i * (kpiW + kpiGap);
    doc.setDrawColor(186, 230, 253);
    doc.setFillColor(248, 250, 252);
    doc.setLineWidth(0.2);
    doc.roundedRect(x, y, kpiW, kpiBoxH, 2, 2, 'FD');

    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(148, 163, 184);
    doc.text(kpi.label.toUpperCase(), x + kpiPadX, y + kpiPadTop);

    doc.setFontSize(kpi.valueSize);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    let lines = doc.splitTextToSize(kpi.value, kpiValueW) as string[];
    if (kpi.maxLines != null) lines = lines.slice(0, kpi.maxLines);
    doc.text(lines, x + kpiPadX, y + kpiPadTop + 5);
  });
  y += kpiBoxH + 8;

  const seccion = (titulo: string) => {
    y = ensureSpace(doc, y, 14);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(100, 116, 139);
    doc.text(titulo.toUpperCase(), MARGIN, y);
    y += 6;
  };

  const colW = contentW / 2 - 4;

  const fila2 = (a: [string, string], b: [string, string]) => {
    y = ensureSpace(doc, y, 20);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(148, 163, 184);
    doc.text(a[0].toUpperCase(), MARGIN, y);
    doc.text(b[0].toUpperCase(), MARGIN + contentW / 2, y);
    y += 4;

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(15, 23, 42);
    doc.setFontSize(9);
    const aLines = doc.splitTextToSize(a[1], colW) as string[];
    const bLines = doc.splitTextToSize(b[1], colW) as string[];
    const rows = Math.max(aLines.length, bLines.length, 1);
    for (let i = 0; i < rows; i++) {
      if (aLines[i]) doc.text(aLines[i], MARGIN, y + i * LINE_H);
      if (bLines[i]) doc.text(bLines[i], MARGIN + contentW / 2, y + i * LINE_H);
    }
    y += rows * LINE_H + 6;
  };

  seccion('Empresa y contacto');
  fila2(['Empresa', val(activacion.empresa_nombre)], ['CIF', val(activacion.empresa_cif)]);
  fila2(['Promotor', val(activacion.promotor_nombre)], ['Teléfono', val(activacion.promotor_telefono)]);

  seccion('Vigencia y sesión');
  fila2(
    ['Vigencia', vigenciaPdfInline(activacion.vigencia_inicio, activacion.vigencia_fin)],
    ['Duración / sesión', activacion.duracion_horas ? `${activacion.duracion_horas} h` : '—'],
  );
  fila2(['Ocasión', val(activacion.ocasion)], ['Target', val(activacion.target_descripcion)]);

  seccion('Mecánica');
  y = ensureSpace(doc, y, 20);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  y = longTextBlock(doc, val(activacion.mecanica), MARGIN, y, contentW, 9.5);
  y += 6;

  seccion('Equipo y materiales');
  y = ensureSpace(doc, y, 16);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(148, 163, 184);
  doc.text('EQUIPO', MARGIN, y);
  doc.text('MATERIALES', MARGIN + contentW / 2, y);
  y += 4;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  doc.setFontSize(9);
  const eqLines = doc.splitTextToSize(val(activacion.equipo_descripcion), colW) as string[];
  const matText = activacion.materiales?.length ? activacion.materiales.join(', ') : '—';
  const matLines = doc.splitTextToSize(matText, colW) as string[];
  const eqMatRows = Math.max(eqLines.length, matLines.length, 1);
  for (let i = 0; i < eqMatRows; i++) {
    y = ensureSpace(doc, y, LINE_H + 2);
    if (eqLines[i]) doc.text(eqLines[i], MARGIN, y);
    if (matLines[i]) doc.text(matLines[i], MARGIN + contentW / 2, y);
    y += LINE_H;
  }
  y += 4;

  if (activacion.pago_observaciones?.trim()) {
    seccion('Observaciones de pago');
    y = ensureSpace(doc, y, 16);
    y = longTextBlock(doc, activacion.pago_observaciones, MARGIN, y, contentW, 9);
    y += 4;
  }

  if (sesiones.length > 0) {
    y = ensureSpace(doc, y, 20);
    seccion(`Sesiones (${sesiones.length})`);
    autoTable(doc, {
      startY: y,
      head: [['Local', 'Fecha', 'Horario', 'Dur.', 'Estado']],
      body: sesiones.map((s) => {
        const sm = ESTADO_SESION_META[s.estado_sesion] ?? ESTADO_SESION_META.programada;
        const hora =
          s.hora_fin && s.hora_inicio && s.hora_fin < s.hora_inicio
            ? `${s.hora_inicio}-${s.hora_fin} (+1)`
            : `${s.hora_inicio || ''}-${s.hora_fin || ''}`;
        return [
          s.local_nombre || s.id_local || '—',
          fechaEs(s.fecha),
          hora,
          activacion.duracion_horas ? `${activacion.duracion_horas} h` : '—',
          sm.label,
        ];
      }),
      theme: 'grid',
      styles: {
        fontSize: 8,
        cellPadding: { top: 2.5, right: 2, bottom: 2.5, left: 2 },
        overflow: 'linebreak',
        valign: 'middle',
      },
      headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold', fontSize: 7.5 },
      columnStyles: {
        0: { cellWidth: 42 },
        1: { cellWidth: 24 },
        2: { cellWidth: 32 },
        3: { cellWidth: 14, halign: 'center' },
        4: { cellWidth: 28, halign: 'center' },
      },
      margin: { left: MARGIN, right: MARGIN },
    });
  }

  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(148, 163, 184);
  doc.text(
    `Generado ${new Date().toLocaleString('es-ES')} · ${activacion.codigo}`,
    MARGIN,
    doc.internal.pageSize.getHeight() - 8,
  );

  return doc;
}

export async function descargarPdfActivacion(
  activacion: Activacion,
  sesiones: ActivacionSesion[],
): Promise<void> {
  const doc = await generarPdfActivacion(activacion, sesiones);
  const safeName = (activacion.codigo || 'activacion').replace(/[^\w\-]+/g, '_');
  doc.save(`activacion-${safeName}.pdf`);
}
