# Módulo de Almacenes

La tabla DynamoDB `igp_Almacenes` almacena almacenes sincronizados desde Ágora (export-master Warehouses).

## Variables de entorno (api/.env.local)

- `DDB_ALMACENES` – Tabla DynamoDB (por defecto `igp_Almacenes`)
- `AWS_REGION` – Región AWS (ej. `eu-west-3`)

## Estructura de la tabla

Crear en AWS DynamoDB:

- **Nombre:** `igp_Almacenes` (o el valor de `DDB_ALMACENES`)
- **Clave de partición:** `Id` (String)

## Crear la tabla con PowerShell

```powershell
cd api
node scripts/create-almacenes-table.js
```

## Atributos por ítem

| Atributo | Tipo | Descripción |
|----------|------|-------------|
| Id | String | Clave de partición (ej. "000001") |
| Nombre | String | Nombre del almacén |
| Descripcion | String | Descripción / fiscal info |
| Direccion | String | Dirección (calle, ciudad, etc.) |

## Endpoints

- **GET** `/api/almacenes` – Lista todos los almacenes
- **POST** `/api/almacenes` – Crear almacén
- **PUT** `/api/almacenes` – Actualizar almacén
- **DELETE** `/api/almacenes` – Borrar almacén
- **POST** `/api/agora/warehouses/sync` – Sincronizar desde Ágora

## Error "Requested resource not found"

Si aparece este error, la tabla no existe en DynamoDB. Ejecuta:

```powershell
node api/scripts/create-almacenes-table.js
```

O créala manualmente en la consola de AWS (DynamoDB → Tables → Create table):

- Table name: `igp_Almacenes`
- Partition key: `Id` (String)
- Billing mode: On-demand (recomendado)
