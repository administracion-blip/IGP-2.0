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

export function exportRevisionFormasPagoPdf(_opts: PdfExportOptions): void {
  // PDF export solo disponible en web. En móvil es un no-op.
}
