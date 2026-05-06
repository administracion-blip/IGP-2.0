import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export type PdfExportOptions = {
  headers: string[];
  rows: string[][];
  totalsRow: string[];
  moneyColIndexes: number[];
  meta: string[];
  title: string;
  filename: string;
  landscape: boolean;
};

export function exportRevisionFormasPagoPdf(opts: PdfExportOptions): void {
  const {
    headers,
    rows,
    totalsRow,
    moneyColIndexes,
    meta,
    title,
    filename,
    landscape,
  } = opts;

  const doc = new jsPDF({
    orientation: landscape ? 'landscape' : 'portrait',
    unit: 'pt',
    format: 'a4',
  });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 28;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(30, 41, 59);
  doc.text(title, marginX, 36);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  meta.forEach((line, idx) => doc.text(line, marginX, 54 + idx * 12));

  const columnStyles: Record<number, { halign: 'right' }> = {};
  for (const i of moneyColIndexes) columnStyles[i] = { halign: 'right' };

  autoTable(doc, {
    head: [headers],
    body: rows,
    foot: [totalsRow],
    startY: 54 + meta.length * 12 + 8,
    margin: { left: marginX, right: marginX },
    styles: { fontSize: 7, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold', halign: 'left' },
    footStyles: { fillColor: [241, 245, 249], textColor: 30, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles,
    tableWidth: pageWidth - marginX * 2,
    didDrawPage: (data: { pageNumber: number }) => {
      const pageCount = (doc.internal as unknown as {
        getNumberOfPages: () => number;
      }).getNumberOfPages();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `Página ${data.pageNumber} de ${pageCount}`,
        pageWidth - marginX,
        doc.internal.pageSize.getHeight() - 12,
        { align: 'right' },
      );
    },
  });

  doc.save(filename);
}
