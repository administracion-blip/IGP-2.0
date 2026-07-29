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
| Id | String | Clave de partición, formato `PED-AAAA-NNNNN` (año según Fecha, 5 dígitos de secuencial por año; ej. `PED-2026-00003`) |
| LocalId | String | ID del local (ref. igp_Locales.id_Locales) |
| AlmacenOrigenId | String | ID del almacén origen (ref. igp_Almacenes.Id) |
| AlmacenDestinoId | String | ID del almacén destino |
| TotalAlbaran | Number | Total del albarán |
| Fecha | String | Fecha del pedido (YYYY-MM-DD) |
| Estado | String | Borrador, Pendiente, Enviado, Exportado |
| CreadoEn | String | Fecha de creación (ISO) |
| CreadoPor | String | ID del usuario que creó el pedido |
| Notas | String | Observaciones |
| CompletadoEn | String | Fecha (ISO) del OK del almacén. **Decide el mes que se factura**; no se borra ni se rehace una vez facturado |
| CompletadoPor | String | Email de quien completó el pedido |
| lineas_rev | Number | Contador de revisión de las líneas: sube (`ADD`) **dos veces** en toda escritura que cree, modifique o borre una línea, una antes y otra después del contenido. Los pedidos antiguos no lo tienen y esa ausencia es su estado inicial válido |

### Marca de facturación (contrato con la facturación mensual del almacén)

Los escribe el generador mensual de facturas; el router de pedidos solo los lee.
Con cualquiera de las dos marcas **presentes** (aunque venga vacía: es lo que mira
`attribute_not_exists`), el pedido queda congelado: se rechazan añadir, modificar y
borrar líneas, editar o borrar el pedido y cambiar la preparación de sus líneas
(HTTP 409, nombrando el documento por su periodo). Sin marca, el comportamiento es
el de siempre.

La comprobación no basta con leerla: toda escritura del router va condicionada a
la ausencia de las dos marcas, porque el generador puede marcar el pedido entre que
la guarda lee y el handler escribe. En las escrituras de línea, el reclamo es el
propio incremento de `lineas_rev`, que se hace antes de tocar la línea: si falla, la
línea no se escribe. Y el contador se vuelve a subir **después** de escribir la
línea, que es la invariante que necesita el generador: el contador cambia después
de la última escritura de contenido, así que ninguna lectura incoherente de la
pareja (cabecera, líneas) sobrevive al reclamo. El borrado del pedido borra primero
la cabecera, condicionada, para no dejar una factura huérfana que la reconciliación
ya no pueda liberar.

| Atributo | Tipo | Descripción |
|----------|------|-------------|
| factura_ventas_id | String | Id (UUID) de la factura de venta de la mercancía al local |
| factura_ventas_periodo | String | Mes facturado (`YYYY-MM`). Es con lo que se nombra la factura en el 409: los documentos generados nacen en borrador y **sin numerar** |
| factura_rappel_id | String | Id (UUID) de la factura/abono del rappel del periodo |
| factura_rappel_periodo | String | Mes del abono (`YYYY-MM`) |
| factura_id_empresa_local | String | Sociedad (`igp_Locales.id_empresa`, 6 dígitos) del local del pedido, congelada al completarlo, y rehecha (o borrada) si el pedido cambia de local. Es el **receptor** de la factura de ventas; en una devolución los papeles se invierten. La sociedad del almacén de origen NO se congela aquí: la resuelve el generador |

### Identificar el Almacén General

El maestro `igp_Almacenes` no tiene ningún campo que marque el almacén central:
lo único que lo distingue es su nombre. El criterio (nombre normalizado e igualdad
exacta) vive en **`api/lib/pedidos/almacenGeneral.js`** y es el único origen del
backend: lo usan el permiso `pedidos.crear_entre_locales` de este router y la
resolución de la sociedad emisora de la facturación mensual.

- `esAlmacenGeneral(nombre)` / `normalizarNombreAlmacen(nombre)`: el criterio.
- `idsAlmacenGeneral()`: los `Id` del maestro que lo cumplen, con caché de 5
  minutos. Devuelve `{ ok, ids }`; `ok: false` significa que el maestro **no se
  pudo leer**, que no es lo mismo que leerlo y no encontrar ninguno.
- `olvidarAlmacenGeneralCacheado()`: refresca el criterio tras sincronizar el
  maestro (y lo usan las pruebas).

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
