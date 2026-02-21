# Sincronización de productos Ágora (Ágora → DynamoDB)

La tabla DynamoDB `Igp_AgoraProducts` almacena productos sincronizados desde Ágora (export-master Products). La lectura es rápida porque se hace desde DynamoDB en lugar de llamar al API de Ágora cada vez.

**Solo se escriben en DynamoDB los registros nuevos o actualizados** (detección por hash de los datos). Si un producto no ha cambiado, no se reescribe.

**Throttle de sync**: No se llama al API de Ágora si la última sincronización fue hace menos de `AGORA_PRODUCTS_SYNC_THROTTLE_MINUTES` minutos (por defecto 30). Usa `?force=1` en POST /api/agora/products/sync para forzar.

## Variables de entorno (api/.env o api/.env.local)

- `AGORA_API_BASE_URL` – URL base del API Ágora (ej. `http://servidor:8984`)
- `AGORA_API_TOKEN` – Token del API
- `DDB_AGORA_PRODUCTS_TABLE` – Tabla DynamoDB (por defecto `Igp_AgoraProducts`)
- `AGORA_PRODUCTS_SYNC_THROTTLE_MINUTES` – Minutos entre syncs automáticos (default 30)
- `AWS_REGION` – Región AWS (ej. `eu-west-3`)

## Estructura de la tabla

Crear en AWS DynamoDB:

- **Nombre:** `Igp_AgoraProducts` (o el valor de `DDB_AGORA_PRODUCTS_TABLE`)
- **Clave de partición:** `PK` (String)
- **Clave de ordenación:** `SK` (String)

Ejecutar:

```bash
node api/scripts/create-agora-products-table.js
```

## Endpoints

**GET** `/api/agora/products` – Lista los productos guardados en DynamoDB (lectura rápida).

- Respuesta: `{ "productos": [ { "Id", "IGP", "Name", "CostPrice", "BaseSaleFormatId", "FamilyId", "VatId" } ] }`
- Query `?source=agora` – Fuerza lectura directa desde el API Ágora (sin DynamoDB)

**POST** `/api/agora/products/sync`

- Obtiene productos desde Ágora (export-master Products)
- Compara con DynamoDB y **solo escribe registros nuevos o modificados**
- Respuesta: `{ "ok": true, "fetched": N, "added": A, "updated": U, "unchanged": C }`

## Flujo en la app

Al abrir la pantalla **Productos Ágora**:

1. Carga los datos desde DynamoDB (rápido)
2. En segundo plano, llama a `POST /api/agora/products/sync`
3. Si el sync detecta cambios (added/updated), la app puede refrescar la lista

## Ejemplo curl

```bash
# Sincronizar productos desde Ágora
curl -X POST http://localhost:3002/api/agora/products/sync \
  -H "Content-Type: application/json" \
  -d '{}'
```
