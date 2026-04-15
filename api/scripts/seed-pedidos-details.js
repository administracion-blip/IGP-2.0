#!/usr/bin/env node
/**
 * Inserta detalles de ejemplo en Igp_PedidosDetails para el pedido PED-AAAA-00001 (año actual).
 * Uso: node api/scripts/seed-pedidos-details.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_PEDIDOS_DETAILS || 'Igp_PedidosDetails';
const region = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

const lineasEjemplo = [
  { ProductId: '1', ProductoNombre: 'Producto ejemplo 1', Cantidad: 10, PrecioUnitario: 1.5, TotalLinea: 15 },
  { ProductId: '2', ProductoNombre: 'Producto ejemplo 2', Cantidad: 5, PrecioUnitario: 2.0, TotalLinea: 10 },
];

async function run() {
  const año = new Date().toISOString().slice(0, 4);
  const pedidoId = `PED-${año}-00001`;
  console.log('Tabla:', tableName);
  console.log('Insertando detalles para pedido', pedidoId, '...');

  for (let i = 0; i < lineasEjemplo.length; i++) {
    const linea = lineasEjemplo[i];
    const item = {
      PedidoId: pedidoId,
      LineaIndex: String(i),
      ProductId: linea.ProductId,
      ProductoNombre: linea.ProductoNombre,
      Cantidad: linea.Cantidad,
      PrecioUnitario: linea.PrecioUnitario,
      TotalLinea: linea.TotalLinea,
    };
    await docClient.send(new PutCommand({ TableName: tableName, Item: item }));
    console.log('  Línea', i, ':', linea.ProductoNombre, 'x', linea.Cantidad);
  }

  console.log('✓', lineasEjemplo.length, 'detalles creados.');
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
