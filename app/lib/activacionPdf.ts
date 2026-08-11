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

/** Rango vigencia en una línea (ASCII-safe para Helvetica). */
function vigenciaPdfInline(inicio: string, fin: string): string {
  return `${fechaEs(inicio)} -> ${fechaEs(fin)}`;
}

const MARGIN = 12;
const LINE_H = 3.8;
const MAX_SESIONES_VISIBLE = 9;

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y + needed > pageH - 10) {
    doc.addPage();
    return 14;
  }
  return y;
}

/** Texto largo completo; salta de página si hace falta (sin truncar). */
function longTextBlock(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxW: number,
  fontSize: number,
): number {
  doc.setFontSize(fontSize);
  doc.setFont('helvetica', 'normal');
  const lineH = fontSize >= 10 ? 4.4 : LINE_H;
  const lines = doc.splitTextToSize(text, maxW) as string[];
  for (const line of lines) {
    y = ensureSpace(doc, y, lineH + 1);
    doc.text(line, x, y);
    y += lineH;
  }
  return y;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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
  let y = 12;

  const estadoMeta = ESTADO_ACTIVACION_META[activacion.estado] ?? ESTADO_ACTIVACION_META.borrador;

  // 1. Eyebrow + badge estado
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text('IGP · Activación de marca', MARGIN, y);

  const badgeLabel = estadoMeta.label;
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  const badgePadX = 3;
  const badgeW = doc.getTextWidth(badgeLabel) + badgePadX * 2;
  const badgeH = 5.5;
  const badgeX = pageW - MARGIN - badgeW;
  const badgeY = y - 3.8;
  const [br, bg, bb] = hexToRgb(estadoMeta.bg);
  const [tr, tg, tb] = hexToRgb(estadoMeta.text);
  doc.setFillColor(br, bg, bb);
  doc.setDrawColor(br, bg, bb);
  doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 1.5, 1.5, 'F');
  doc.setTextColor(tr, tg, tb);
  doc.text(badgeLabel, badgeX + badgePadX, y);
  y += 7;

  // 2. Título = marca
  doc.setFontSize(19);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  const tituloLines = doc.splitTextToSize(val(activacion.marca), contentW) as string[];
  doc.text(tituloLines.slice(0, 2), MARGIN, y);
  y += tituloLines.length > 1 ? 13 : 8;

  // 3. Subtítulo = tipo
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(3, 105, 161);
  const tipoLines = doc.splitTextToSize(val(activacion.tipo_activacion), contentW) as string[];
  doc.text(tipoLines.slice(0, 2), MARGIN, y);
  y += tipoLines.length > 1 ? 9 : 5.5;

  // 4. Meta secundaria: código + productos
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text(`Código: ${val(activacion.codigo)}`, MARGIN, y);
  y += 4;
  const productoTxt = String(activacion.producto || '').trim();
  if (productoTxt) {
    const prodLines = doc.splitTextToSize(`Productos: ${productoTxt}`, contentW) as string[];
    doc.text(prodLines.slice(0, 2), MARGIN, y);
    y += prodLines.length > 1 ? 7 : 4.5;
  } else {
    y += 1.5;
  }

  // 5. Fila de 4 KPIs (vigencia, duración, ocasión, target) — compacta
  const kpiGap = 2.5;
  const kpiCount = 4;
  const kpiW = (contentW - kpiGap * (kpiCount - 1)) / kpiCount;
  const kpiPadX = 2.5;
  const kpiPadTop = 2.5;
  const kpiValueW = kpiW - kpiPadX * 2;
  const kpiLabelH = 3.2;
  const kpiValueLineH = 3.6;
  const vigValue = vigenciaPdfInline(activacion.vigencia_inicio, activacion.vigencia_fin);

  const kpis: { label: string; value: string; valueSize: number; maxLines?: number }[] = [
    {
      label: 'Vigencia',
      value: vigValue,
      valueSize: 8.5,
      maxLines: 2,
    },
    {
      label: 'Duración / sesión',
      value: activacion.duracion_horas ? `${activacion.duracion_horas} h` : '—',
      valueSize: 9.5,
    },
    {
      label: 'Ocasión',
      value: val(activacion.ocasion),
      valueSize: 8.5,
      maxLines: 2,
    },
    {
      label: 'Target',
      value: val(activacion.target_descripcion),
      valueSize: 8.5,
      maxLines: 2,
    },
  ];

  doc.setFont('helvetica', 'bold');
  const kpiLineCounts = kpis.map((k) => {
    doc.setFontSize(k.valueSize);
    const lines = doc.splitTextToSize(k.value, kpiValueW) as string[];
    return Math.min(lines.length, k.maxLines ?? 2);
  });
  const maxKpiLines = Math.max(...kpiLineCounts, 1);
  const kpiBoxH = Math.min(16, Math.max(14, kpiPadTop + kpiLabelH + maxKpiLines * kpiValueLineH + 2.5));

  y = ensureSpace(doc, y, kpiBoxH + 5);
  kpis.forEach((kpi, i) => {
    const x = MARGIN + i * (kpiW + kpiGap);
    doc.setDrawColor(186, 230, 253);
    doc.setFillColor(240, 249, 255);
    doc.setLineWidth(0.25);
    doc.roundedRect(x, y, kpiW, kpiBoxH, 1.8, 1.8, 'FD');

    doc.setFontSize(6);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(100, 116, 139);
    doc.text(kpi.label.toUpperCase(), x + kpiPadX, y + kpiPadTop);

    doc.setFontSize(kpi.valueSize);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    let lines = doc.splitTextToSize(kpi.value, kpiValueW) as string[];
    if (kpi.maxLines != null) lines = lines.slice(0, kpi.maxLines);
    doc.text(lines, x + kpiPadX, y + kpiPadTop + kpiLabelH);
  });
  y += kpiBoxH + 5;

  // 6. Sesiones (justo tras KPIs)
  const nSesiones = sesiones.length;
  const sesionesVisible = sesiones.slice(0, MAX_SESIONES_VISIBLE);
  const sesionesOcultas = Math.max(0, nSesiones - sesionesVisible.length);

  y = ensureSpace(doc, y, 14);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  if (nSesiones === 0) {
    doc.text('Sesiones', MARGIN, y);
    y += 5;
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text('Sin sesiones programadas', MARGIN, y);
    y += 7;
  } else {
    doc.text(`Sesiones (${nSesiones})`, MARGIN, y);
    y += 3;
    autoTable(doc, {
      startY: y,
      head: [['Local', 'Fecha', 'Horario', 'Dur.', 'Estado']],
      body: sesionesVisible.map((s) => {
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
        fontSize: 7.5,
        cellPadding: { top: 1.6, right: 1.5, bottom: 1.6, left: 1.5 },
        overflow: 'linebreak',
        valign: 'middle',
        textColor: [15, 23, 42],
      },
      headStyles: {
        fillColor: [14, 165, 233],
        textColor: 255,
        fontStyle: 'bold',
        fontSize: 7,
        cellPadding: { top: 1.8, right: 1.5, bottom: 1.8, left: 1.5 },
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 44 },
        1: { cellWidth: 24 },
        2: { cellWidth: 32 },
        3: { cellWidth: 14, halign: 'center' },
        4: { cellWidth: 28, halign: 'center' },
      },
      margin: { left: MARGIN, right: MARGIN },
    });
    y = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
    if (sesionesOcultas > 0) {
      y += 3.5;
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100, 116, 139);
      doc.text(`… y ${sesionesOcultas} más`, MARGIN, y);
      y += 4;
    } else {
      y += 6;
    }
  }

  // 7. Fila 50/50: Empresa y contacto | Equipo y materiales
  const halfGap = 2.2;
  const halfW = (contentW - halfGap) / 2;
  const boxPad = 2.8;
  const innerW = halfW - boxPad * 2;
  const halfColW = (innerW - 2) / 2;
  const titleH = 4.5;
  const fieldGapY = 3.5;
  const labelToValue = 3.2;

  const empresaFields: [string, string][] = [
    ['Empresa', val(activacion.empresa_nombre)],
    ['CIF', val(activacion.empresa_cif)],
    ['Promotor', val(activacion.promotor_nombre)],
    ['Teléfono', val(activacion.promotor_telefono)],
  ];

  doc.setFontSize(8);
  const empLineCounts = empresaFields.map(([, v]) => {
    const lines = doc.splitTextToSize(v, halfColW) as string[];
    return Math.max(Math.min(lines.length, 2), 1);
  });
  const empRow1H = labelToValue + empLineCounts[0] * 3.4;
  const empRow1Hb = labelToValue + empLineCounts[1] * 3.4;
  const empRow2H = labelToValue + empLineCounts[2] * 3.4;
  const empRow2Hb = labelToValue + empLineCounts[3] * 3.4;
  const empContentH =
    titleH + Math.max(empRow1H, empRow1Hb) + fieldGapY + Math.max(empRow2H, empRow2Hb);

  const equipoTxt = val(activacion.equipo_descripcion);
  const matText = activacion.materiales?.length ? activacion.materiales.join(', ') : '—';
  doc.setFontSize(8);
  const eqLines = doc.splitTextToSize(equipoTxt, innerW) as string[];
  const matLines = doc.splitTextToSize(matText, innerW) as string[];
  const eqSectionH = labelToValue + eqLines.length * 3.4;
  const matSectionH = labelToValue + matLines.length * 3.4;
  const eqContentH = titleH + eqSectionH + fieldGapY + matSectionH;

  const halfBoxH = Math.max(empContentH, eqContentH) + boxPad * 2;

  y = ensureSpace(doc, y, halfBoxH + 4);
  const leftX = MARGIN;
  const rightX = MARGIN + halfW + halfGap;

  // Izquierda: Empresa
  doc.setDrawColor(253, 230, 138);
  doc.setFillColor(254, 249, 195);
  doc.setLineWidth(0.3);
  doc.roundedRect(leftX, y, halfW, halfBoxH, 2, 2, 'FD');

  let ey = y + boxPad + 3;
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(113, 63, 18);
  doc.text('Empresa y contacto', leftX + boxPad, ey);
  ey += titleH;

  const drawEmpField = (label: string, value: string, x: number, startY: number, maxW: number): number => {
    doc.setFontSize(6);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(146, 64, 14);
    doc.text(label.toUpperCase(), x, startY);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(15, 23, 42);
    let lines = doc.splitTextToSize(value, maxW) as string[];
    lines = lines.slice(0, 2);
    doc.text(lines, x, startY + 3);
    return lines.length;
  };

  const r1a = drawEmpField(empresaFields[0][0], empresaFields[0][1], leftX + boxPad, ey, halfColW);
  const r1b = drawEmpField(
    empresaFields[1][0],
    empresaFields[1][1],
    leftX + boxPad + halfColW + 2,
    ey,
    halfColW,
  );
  ey += Math.max(r1a, r1b) * 3.4 + fieldGapY + 0.5;
  drawEmpField(empresaFields[2][0], empresaFields[2][1], leftX + boxPad, ey, halfColW);
  drawEmpField(
    empresaFields[3][0],
    empresaFields[3][1],
    leftX + boxPad + halfColW + 2,
    ey,
    halfColW,
  );

  // Derecha: Equipo y materiales
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(248, 250, 252);
  doc.setLineWidth(0.3);
  doc.roundedRect(rightX, y, halfW, halfBoxH, 2, 2, 'FD');

  let ry = y + boxPad + 3;
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text('Equipo y materiales', rightX + boxPad, ry);
  ry += titleH;

  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(100, 116, 139);
  doc.text('EQUIPO', rightX + boxPad, ry);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  doc.text(eqLines, rightX + boxPad, ry + 3);
  ry += labelToValue + eqLines.length * 3.4 + fieldGapY;

  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(100, 116, 139);
  doc.text('MATERIALES', rightX + boxPad, ry);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(51, 65, 85);
  doc.text(matLines, rightX + boxPad, ry + 3);

  y += halfBoxH + 5;

  // 8. Mecánica (completa, sin truncar; puede saltar de página)
  y = ensureSpace(doc, y, 14);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text('Mecánica', MARGIN, y);
  y += 5;
  doc.setTextColor(51, 65, 85);
  y = longTextBlock(doc, val(activacion.mecanica), MARGIN, y, contentW, 9.5);
  y += 5;

  // 9. Observaciones de pago (caja morado pastel; texto completo)
  if (activacion.pago_observaciones?.trim()) {
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    const pagoLines = doc.splitTextToSize(activacion.pago_observaciones, contentW - 6) as string[];
    const pagoLineH = 3.8;
    const pagoHeaderH = 11;
    const pagoPadBottom = 3;
    let lineIdx = 0;

    while (lineIdx < pagoLines.length) {
      const pageH = doc.internal.pageSize.getHeight();
      const avail = pageH - 10 - y;
      const minFirst = pagoHeaderH + pagoLineH + pagoPadBottom;
      if (avail < minFirst) {
        doc.addPage();
        y = 14;
      }

      const pageAvail = doc.internal.pageSize.getHeight() - 10 - y;
      const linesFit = Math.max(1, Math.floor((pageAvail - pagoHeaderH - pagoPadBottom) / pagoLineH));
      const chunk = pagoLines.slice(lineIdx, lineIdx + linesFit);
      const pagoBoxH = pagoHeaderH + chunk.length * pagoLineH + pagoPadBottom;

      doc.setDrawColor(216, 180, 254);
      doc.setFillColor(243, 232, 255);
      doc.setLineWidth(0.3);
      doc.roundedRect(MARGIN, y, contentW, pagoBoxH, 2, 2, 'FD');

      let py = y + 5;
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(91, 33, 182);
      doc.text(lineIdx === 0 ? 'Observaciones de pago' : 'Observaciones de pago (cont.)', MARGIN + 3, py);
      py += 5;
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(51, 65, 85);
      for (const line of chunk) {
        doc.text(line, MARGIN + 3, py);
        py += pagoLineH;
      }
      y += pagoBoxH + 3;
      lineIdx += chunk.length;
    }
  }

  // 10. Pie
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(148, 163, 184);
  doc.text(
    `Generado ${new Date().toLocaleString('es-ES')} · ${activacion.codigo}`,
    MARGIN,
    doc.internal.pageSize.getHeight() - 7,
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
