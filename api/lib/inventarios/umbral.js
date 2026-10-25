/**
 * Porcentaje de diferencia que pinta el semáforo de la revisión.
 * Vive en Igp_Ajustes. No hay un valor por defecto: hasta que alguien lo guarda,
 * la revisión enseña los números sin color.
 */

import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { errorInventario } from './claves.js';

const PK = 'INVENTARIO';
const SK = 'UMBRAL';

function porcentajeDe(raw) {
  if (raw === undefined) throw errorInventario('porcentaje es obligatorio');
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw errorInventario('El porcentaje debe ser un número ≥ 0');
  return n;
}

export async function leerUmbral() {
  const r = await docClient.send(new GetCommand({
    TableName: tables.ajustes,
    Key: { PK, SK },
  }));
  const n = r.Item?.porcentaje;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return { porcentaje: null };
  return { porcentaje: n };
}

export async function guardarUmbral(raw, usuario) {
  const porcentaje = porcentajeDe(raw);
  if (porcentaje == null) {
    await docClient.send(new DeleteCommand({
      TableName: tables.ajustes,
      Key: { PK, SK },
    }));
    return { porcentaje: null };
  }
  await docClient.send(new PutCommand({
    TableName: tables.ajustes,
    Item: {
      PK,
      SK,
      porcentaje,
      actualizadoEn: new Date().toISOString(),
      actualizadoPor: usuario || '',
    },
  }));
  return { porcentaje };
}
