# Módulo de Pedidos (Compras)

La tabla DynamoDB `Igp_Pedidos` almacena la cabecera de los pedidos de productos entre almacenes (módulo Compras → Pedidos).

## Variables de entorno (api/.env.local)

- `DDB_PEDIDOS` – Tabla DynamoDB (por defecto `Igp_Pedidos`)
- `AWS_REGION` – Región AWS (ej. `eu-west-3`)

## Estructura de la tabla

Crear en AWS DynamoDB:

- **Nombre:** `Igp_Pedidos` (o el valor de `DDB_PEDIDOS`)
- **Clave de partición:** `Id` (String)
- **Billing mode:** On-demand (recomendado)

## Endpoints

- **GET** `/api/pedidos` – Lista todos los pedidos

## Crear la tabla

```powershell
cd api
node scripts/create-pedidos-table.js
```

## Insertar pedido de ejemplo

```powershell
cd api
node scripts/seed-pedidos.js
```

## Atributos por ítem

| Atributo | Tipo | Descripción |
|----------|------|-------------|
| Id | String | Clave de partición (ej. "PED-001" o UUID) |
| LocalId | String | ID del local (ref. igp_Locales.id_Locales) |
| AlmacenOrigenId | String | ID del almacén origen (ref. igp_Almacenes.Id) |
| AlmacenDestinoId | String | ID del almacén destino |
| TotalAlbaran | Number | Total del albarán |
| Fecha | String | Fecha del pedido (YYYY-MM-DD) |
| Estado | String | Borrador, Pendiente, Enviado, Exportado |
| CreadoEn | String | Fecha de creación (ISO) |
| CreadoPor | String | ID del usuario que creó el pedido |
| Notas | String | Observaciones |

## Tabla de líneas (Igp_PedidosLineas)

Almacena los productos de cada pedido.

- **Nombre:** `Igp_PedidosLineas` (o el valor de `DDB_PEDIDOS_LINEAS`)
- **Clave de partición:** `PedidoId` (String) – Id del pedido
- **Clave de ordenación:** `LineaIndex` (String) – Índice de línea (0, 1, 2...)

### Crear la tabla

```powershell
cd api
node scripts/create-pedidos-lineas-table.js
```

### Atributos por ítem

| Atributo | Tipo | Descripción |
|----------|------|-------------|
| PedidoId | String | PK – Id del pedido |
| LineaIndex | String | SK – Índice de línea |
| ProductId | String | Id del producto |
| ProductoNombre | String | Nombre del producto |
| Cantidad | Number | Cantidad pedida |
| PrecioUnitario | Number | Precio unitario |
| TotalLinea | Number | Total de la línea |
| PurchaseUnitId | String | Id unidad de compra (opcional) |
| PurchaseUnitName | String | Nombre unidad (opcional) |
| Notas | String | Observaciones (opcional) |

### Insertar líneas de ejemplo

```powershell
cd api
node scripts/seed-pedidos-lineas.js
```

## Tabla Igp_PedidosDetails (Detalles Pedidos)

Almacena los artículos asociados a cada pedido. Módulo: Compras → Detalles Pedidos.

- **Nombre:** `Igp_PedidosDetails` (o el valor de `DDB_PEDIDOS_DETAILS`)
- **Clave de partición:** `PedidoId` (String)
- **Clave de ordenación:** `LineaIndex` (String)

### Crear la tabla

```powershell
cd api
node scripts/create-pedidos-details-table.js
```

### API

- **GET** `/api/pedidos/:pedidoId/details` – Lista los artículos de un pedido

## Error "Requested resource not found"

Si aparece este error, la tabla no existe. Ejecuta:

```powershell
node api/scripts/create-pedidos-table.js
```
