import { bbvaFitFormato } from './formatos/bbvaFit.js';

const FORMATOS = {
  [bbvaFitFormato.clave]: bbvaFitFormato,
};

export function getFormatoRemesa(clave) {
  return FORMATOS[clave] || null;
}

export function listarFormatosRemesa() {
  return Object.values(FORMATOS).map((f) => ({ clave: f.clave, nombre: f.nombre }));
}

export async function generarFicheroRemesa(remesa) {
  const formato = getFormatoRemesa(remesa.banco || 'BBVA_FIT');
  if (!formato) {
    throw Object.assign(
      new Error('El formato bancario de la remesa no está soportado; revisa el banco configurado en la remesa'),
      { status: 422 },
    );
  }
  return formato.generar(remesa);
}
