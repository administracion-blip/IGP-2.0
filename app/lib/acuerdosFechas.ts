/** Tiempo hasta/desde la fecha fin de un acuerdo (misma lógica en listado y detalle). */
export function calcTiempoRestante(fechaFin: string): { texto: string; vencido: boolean } {
  if (!fechaFin) return { texto: 'Sin fecha fin', vencido: false };
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const fin = new Date(fechaFin + 'T00:00:00');
  if (isNaN(fin.getTime())) return { texto: 'Fecha inválida', vencido: false };

  const diff = fin.getTime() - hoy.getTime();
  const vencido = diff < 0;

  const desde = vencido ? fin : hoy;
  const hasta = vencido ? hoy : fin;
  let meses = (hasta.getFullYear() - desde.getFullYear()) * 12 + (hasta.getMonth() - desde.getMonth());
  let dias = hasta.getDate() - desde.getDate();
  if (dias < 0) {
    meses -= 1;
    const mesAnterior = new Date(hasta.getFullYear(), hasta.getMonth(), 0);
    dias += mesAnterior.getDate();
  }

  let texto = '';
  if (meses > 0 && dias > 0) texto = `${meses} ${meses === 1 ? 'mes' : 'meses'} y ${dias} ${dias === 1 ? 'día' : 'días'}`;
  else if (meses > 0) texto = `${meses} ${meses === 1 ? 'mes' : 'meses'}`;
  else if (dias > 0) texto = `${dias} ${dias === 1 ? 'día' : 'días'}`;
  else return { texto: 'Finaliza hoy', vencido: false };

  return { texto: vencido ? `Vencido hace ${texto}` : `Quedan ${texto}`, vencido };
}
