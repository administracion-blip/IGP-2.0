# Sincronización de cierres de ventas (Ágora → DynamoDB)

La tabla DynamoDB debe existir con **clave de partición** `PK` (string) y **clave de ordenación** `SK` (string). Por ejemplo: `Igp_SalesCloseouts` con PK = workplaceId y SK = businessDay#closeOutNumber.

## Variables de entorno (api/.env o api/.env.local)

- `AGORA_BASE_URL` o `AGORA_API_BASE_URL` – URL base del API Ágora (ej. `http://servidor:8984`)
- `AGORA_API_TOKEN` – Token del API
- `DDB_SALES_CLOSEOUTS_TABLE` – Tabla DynamoDB (por defecto `Igp_SalesCloseouts`)
- `AWS_REGION` – Región AWS (ej. `eu-west-3`)

## Endpoints

**GET** `/api/agora/closeouts` – Lista los cierres guardados en Igp_SalesCloseouts.

- Query opcionales: `businessDay=YYYY-MM-DD`, `workplaceId=...`
- Respuesta: `{ "closeouts": [ ... ] }`

**POST** `/api/agora/closeouts/sync`

- **Body:** `{ "businessDay": "YYYY-MM-DD", "workplaces": [1, 2, 3] }`  
  - `workplaces` es opcional; si no se envía, se exportan todos los locales.
- **Respuesta:** `{ "ok": true, "fetched": N, "upserted": M, "businessDay": "YYYY-MM-DD" }`

## Ejemplo curl

```bash
# Sincronizar un día concreto (todos los workplaces)
curl -X POST http://localhost:3001/api/agora/closeouts/sync \
  -H "Content-Type: application/json" \
  -d '{"businessDay":"2026-02-01"}'

# Sincronizar solo workplaces 1 y 2
curl -X POST http://localhost:3001/api/agora/closeouts/sync \
  -H "Content-Type: application/json" \
  -d '{"businessDay":"2026-02-01","workplaces":[1,2]}'
```
