# Sincronización de puntos de venta (Ágora → DynamoDB)

La tabla DynamoDB debe existir con **clave de partición** `PK` (string) y **clave de ordenación** `SK` (string). Por ejemplo: `Igp_SaleCenters` con PK = `"GLOBAL"` y SK = Id del punto de venta (ej. `"1"`, `"7"`).

Los datos se obtienen del **WorkplacesSummary** de Ágora (resumen de locales con grupos y puntos de venta), no de SaleCenters. Cada ítem almacenado tiene: Id, Nombre, Tipo (TPV/COMANDERA), Local, Grupo.

## Variables de entorno (api/.env o api/.env.local)

- `AGORA_API_BASE_URL` – URL base del API Ágora (ej. `http://servidor:8984`)
- `AGORA_API_TOKEN` – Token del API
- `DDB_SALE_CENTERS_TABLE` – Tabla DynamoDB (por defecto `Igp_SaleCenters`)
- `AWS_REGION` – Región AWS (ej. `eu-west-3`)

## Estructura de la tabla

Crear en AWS DynamoDB:

- **Nombre:** `Igp_SaleCenters` (o el valor de `DDB_SALE_CENTERS_TABLE`)
- **Clave de partición:** `PK` (String)
- **Clave de ordenación:** `SK` (String)

## Endpoints

**GET** `/api/agora/sale-centers` – Lista los puntos de venta guardados en DynamoDB (lectura rápida).

- Respuesta: `{ "saleCenters": [ { "Id", "Nombre", "Tipo", "Local", "Grupo", ... } ] }`

**POST** `/api/agora/sale-centers/sync`

- **Body:** `{}` (vacío; se obtiene WorkplacesSummary desde Ágora y se aplanan los PointsOfSale)
- **Respuesta:** `{ "ok": true, "fetched": N, "upserted": M }`

## Flujo en la app

Al abrir la pantalla **Puntos de venta**, la app:
1. Carga los datos desde DynamoDB (rápido)
2. En segundo plano, llama a `POST /api/agora/sale-centers/sync`
3. Si el sync termina con éxito, refresca la lista

## Ejemplo curl

```bash
# Sincronizar puntos de venta desde Ágora (WorkplacesSummary)
curl -X POST http://localhost:3001/api/agora/sale-centers/sync \
  -H "Content-Type: application/json" \
  -d '{}'
```
