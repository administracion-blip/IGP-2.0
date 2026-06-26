# Plantillas de franjas horarias y ventas por horas

Soporte para el desglose de **ventas por horas** en Cajas → Objetivos. Permite definir plantillas de franjas con nombre (reutilizables) y, dentro de Objetivos, ver para un día las ventas agrupadas por franjas, comparando el día real con su día de comparación.

## Tabla DynamoDB

- **Nombre:** `Igp_FranjasHorarias` (o el valor de `DDB_FRANJAS_HORARIAS_TABLE`)
- **Clave de partición (PK):** `PK` (String) → siempre `"GLOBAL"`
- **Clave de ordenación (SK):** `SK` (String) → `plantillaId` único
- **Atributos:**
  - `nombre` (String) — nombre visible en el desplegable
  - `franjas` (List) — `[{ desde:"HH:MM", hasta:"HH:MM", etiqueta? }]`

No requiere GSIs: el acceso es siempre por PK `"GLOBAL"` (listado completo de plantillas).

## Variables de entorno (api/.env o api/.env.local)

- `DDB_FRANJAS_HORARIAS_TABLE` – Tabla DynamoDB (por defecto `Igp_FranjasHorarias`)
- `AWS_REGION` – Región AWS (ej. `eu-west-3`)

## Endpoints

CRUD de plantillas:

- **GET** `/api/agora/franjas-plantillas` → `{ plantillas: [{ plantillaId, nombre, franjas }] }`
- **POST** `/api/agora/franjas-plantillas` body `{ nombre, franjas }` → crea
- **PUT** `/api/agora/franjas-plantillas` body `{ plantillaId, nombre, franjas }` → actualiza
- **DELETE** `/api/agora/franjas-plantillas?plantillaId=...` → borra

Ventas por hora (calculadas desde las facturas de Ágora de un business-day):

- **GET** `/api/agora/invoices/sales-by-hour?workplaceId=...&businessDay=YYYY-MM-DD`
  - Respuesta: `{ businessDay, workplaceId, porHora: { "0": importe, … "23": importe }, totalDia, nFacturas }`
  - Cacheado en memoria 5 min por `workplaceId|businessDay` (forzar recálculo con `&refresh=1`).
  - El agrupado por franjas se hace en el frontend (`app/lib/ventasPorHoraApi.ts`), de modo que la misma respuesta sirve para cualquier plantilla.

## Flujo en la app

1. En Cajas → Objetivos, genera la comparativa de un local (botón **Generar**).
2. Pulsa **Por horas**: abre una pantalla flotante con selector de día y de plantilla.
3. Para el día elegido se cargan las ventas por hora del día real (`Fecha`) y de su día de comparación (`FechaComparacion`), y se agrupan según la plantilla seleccionada. Las franjas que cruzan medianoche (p. ej. `22:00`→`02:00`) se contemplan.
4. Las plantillas se gestionan en Cajas → **Plantillas de franjas** (CRUD con `TablaBasica`).
