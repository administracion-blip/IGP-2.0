# Prompt Cursor — Submódulo "Control de Excepciones" en Cajas

## Objetivo
Añadir un nuevo submódulo llamado **"Control de Excepciones"** dentro del módulo Cajas
de la app. Permite a los encargados revisar invitaciones, descuentos manuales y anulaciones
realizadas por los empleados en Ágora, filtrando por rango de fechas y local (multiselección).

---

## REGLAS CRÍTICAS — no romper nada

- **NO modificar** ningún endpoint existente en `api/routes/agora.js`.
- **NO modificar** ninguna pantalla existente en `app/(app)/cajas/`.
- **Solo añadir** código nuevo. Los únicos ficheros existentes que se tocan son
  `app/(app)/cajas/_layout.tsx` y `app/(app)/cajas/index.tsx`, únicamente para registrar
  la nueva ruta y la nueva tarjeta.
- Respetar exactamente el estilo de código de cada fichero (imports, StyleSheet, etc.).
- No instalar librerías nuevas.

---

## Ficheros a crear o modificar

| Acción    | Fichero                                              |
|-----------|------------------------------------------------------|
| CREAR     | `app/(app)/cajas/control-excepciones.tsx`            |
| MODIFICAR | `app/(app)/cajas/_layout.tsx`                        |
| MODIFICAR | `app/(app)/cajas/index.tsx`                          |
| MODIFICAR | `api/routes/agora.js` — añadir UN solo endpoint nuevo|

---

## 1. Backend — nuevo endpoint en `api/routes/agora.js`

Insertar **inmediatamente después de la línea que cierra el handler de
`/agora/invoices/payments-review`** (tras el `});` de ese router, antes de
`router.get('/agora/test-connection', ...)`), el siguiente endpoint:

```
GET /agora/invoices/exceptions
```

### Parámetros de query (idénticos a payments-review)
- `businessDay` — YYYY-MM-DD (un solo día)
- `dateFrom` + `dateTo` — YYYY-MM-DD (rango)
- `workplaceIds` — array repetido o CSV (igual que payments-review)
- `refresh` — `'1'` para saltarse caché

### Lógica de validación de rango
**Copiar exactamente** la lógica de validación de `payments-review`:
- Si `workplaceIds.length === 1`: máximo 365 días
- En cualquier otro caso (0 locales = todos, o >1): máximo 31 días
- Iterar días con el mismo bucle `while (d <= end)` ya usado

### Sistema de caché — crear junto al de payments-review
```js
const EXCEPTIONS_CACHE = new Map();
const EXCEPTIONS_TTL_MS = 2 * 60 * 1000;
const EXCEPTIONS_CACHE_MAX = 50;

function exceptionsCacheKey(dateFrom, dateTo, workplaceIds) {
  const ids = Array.isArray(workplaceIds) ? [...workplaceIds].map(String).sort() : [];
  return `exc|${dateFrom}|${dateTo}|${ids.join(',')}`;
}
function exceptionsCacheGet(key) {
  const entry = EXCEPTIONS_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { EXCEPTIONS_CACHE.delete(key); return null; }
  return entry;
}
function exceptionsCacheSet(key, rows) {
  if (EXCEPTIONS_CACHE.size >= EXCEPTIONS_CACHE_MAX) {
    const firstKey = EXCEPTIONS_CACHE.keys().next().value;
    if (firstKey) EXCEPTIONS_CACHE.delete(firstKey);
  }
  EXCEPTIONS_CACHE.set(key, { rows, cachedAt: Date.now(), expiresAt: Date.now() + EXCEPTIONS_TTL_MS });
}
```

> Definir estas funciones justo antes del nuevo `router.get('/agora/invoices/exceptions', ...)`.

### Carga de facturas
Usar **exactamente** las mismas funciones ya importadas/disponibles en el fichero:
- `exportInvoices(day, workplaces)` — ya importada en el fichero
- `extractCloseOutsArray(data, ['Invoices', 'invoices'])` — ya definida en el fichero
- Mismo patrón de paralelismo en chunks de 4 días con `Promise.all`

### Detección de excepciones — parseo de cada factura
Para cada invoice `inv` del array resultante, extraer:

```js
const toNum = (v) => typeof v === 'number' ? v
  : (v == null || v === '' ? 0 : parseFloat(String(v).replace(',', '.')) || 0);

const EPS = 0.001;

// Campos del documento
const workplaceId = String(inv?.Workplace?.Id ?? inv?.WorkplaceId ?? inv?.workplaceId ?? '').trim() || '0';
const workplaceName = inv?.Workplace?.Name ?? inv?.WorkplaceName ?? inv?.workplaceName ?? null;
const posId = inv?.Pos?.Id ?? inv?.PosId ?? inv?.posId ?? null;
const posName = inv?.Pos?.Name ?? inv?.PosName ?? inv?.posName ?? null;
const businessDay = String(inv?.BusinessDay ?? inv?.businessDay ?? inv?.__businessDay ?? '').trim();
const ticketNumber = String(inv?.SerialNumber ?? inv?.Number ?? inv?.Id ?? '').trim();
const invDate = String(inv?.Date ?? inv?.DateTime ?? inv?.date ?? '').trim();
const grossAmount = toNum(inv?.Totals?.GrossAmount ?? inv?.GrossAmount ?? inv?.grossAmount);

// UserId del empleado (nivel documento)
const userId = inv?.UserId ?? inv?.userId ?? inv?.OpenerId ?? inv?.openerId ?? null;
const userName = inv?.UserName ?? inv?.userName ?? null;

const lines = inv?.Lines ?? inv?.lines ?? [];
const grossEps = 0.005;
```

**Tipo 1 — Invitación**: línea donde se ha regalado un producto
```js
// Para cada línea en lines:
const productPrice = toNum(line?.ProductPrice ?? line?.productPrice);
const unitPrice    = toNum(line?.UnitPrice    ?? line?.unitPrice);
const quantity     = toNum(line?.Quantity     ?? line?.quantity ?? 1);

if (productPrice > EPS && unitPrice < EPS) {
  // Es invitación: el producto tenía precio pero se cobró 0
  exceptions.push({
    tipo: 'Invitacion',
    // ...campos del documento +
    ProductId:    line?.ProductId    ?? line?.productId    ?? null,
    ProductName:  line?.ProductName  ?? line?.productName  ?? '—',
    FamilyName:   line?.FamilyName   ?? line?.familyName   ?? '—',
    Quantity:     quantity,
    PrecioTarifa: productPrice,
    PrecioAplicado: unitPrice,
    Diferencia:   -(productPrice * quantity),  // importe "regalado" en negativo
  });
}
```

**Tipo 2 — Descuento manual**: línea con descuento aplicado
```js
const discountRate  = toNum(line?.DiscountRate  ?? line?.discountRate);
const cashDiscount  = toNum(line?.CashDiscount  ?? line?.cashDiscount);
const totalAmount   = toNum(line?.TotalAmount   ?? line?.totalAmount);

if (discountRate > EPS || cashDiscount > EPS) {
  // Calcular importe descontado
  const precioSinDescuento = productPrice > EPS ? productPrice * quantity : totalAmount / (1 - discountRate);
  const diferencia = -(precioSinDescuento - totalAmount);
  exceptions.push({
    tipo: 'Descuento',
    // ...campos del documento +
    ProductId:      line?.ProductId    ?? line?.productId    ?? null,
    ProductName:    line?.ProductName  ?? line?.productName  ?? '—',
    FamilyName:     line?.FamilyName   ?? line?.familyName   ?? '—',
    Quantity:       quantity,
    PrecioTarifa:   productPrice,
    PrecioAplicado: toNum(line?.UnitPrice ?? line?.unitPrice),
    DiscountRate:   discountRate,
    CashDiscount:   cashDiscount,
    Diferencia:     diferencia,
  });
}
```

**Tipo 3 — Anulación**: ticket con importe total 0 que tiene líneas
```js
if (Math.abs(grossAmount) < grossEps && lines.length > 0) {
  // Ticket anulado
  exceptions.push({
    tipo: 'Anulacion',
    // ...campos del documento +
    ProductId:      null,
    ProductName:    `${lines.length} línea(s)`,
    FamilyName:     '—',
    Quantity:       lines.reduce((s, l) => s + toNum(l?.Quantity ?? l?.quantity ?? 1), 0),
    PrecioTarifa:   0,
    PrecioAplicado: 0,
    Diferencia:     0,
  });
}
```

### Estructura de cada excepción en el array de respuesta
```js
{
  tipo: 'Invitacion' | 'Descuento' | 'Anulacion',
  WorkplaceId:    string,
  WorkplaceName:  string | null,
  PosId:          number | string | null,
  PosName:        string | null,
  BusinessDay:    string,           // YYYY-MM-DD
  TicketNumber:   string,
  DateTime:       string,           // ISO
  UserId:         number | null,
  UserName:       string | null,
  ProductId:      number | null,
  ProductName:    string,
  FamilyName:     string,
  Quantity:       number,
  PrecioTarifa:   number,
  PrecioAplicado: number,
  DiscountRate:   number,           // solo en Descuento, 0 en los demás
  CashDiscount:   number,           // solo en Descuento, 0 en los demás
  Diferencia:     number,           // importe "perdido" (negativo)
}
```

### Respuesta JSON del endpoint
```json
{
  "dateFrom": "YYYY-MM-DD",
  "dateTo": "YYYY-MM-DD",
  "workplaceIds": [],
  "fromCache": false,
  "cachedAt": "<ISO>",
  "totalExceptions": 42,
  "totalInvitaciones": 10,
  "totalDescuentos": 28,
  "totalAnulaciones": 4,
  "importeInvitado": -35.50,
  "importeDescontado": -12.30,
  "rows": [ /* array de excepciones */ ]
}
```

Los totales `importeInvitado` e `importeDescontado` son la suma de `Diferencia`
de cada tipo.

---

## 2. Frontend — nueva pantalla `app/(app)/cajas/control-excepciones.tsx`

### Patrón a seguir
Modelar **exactamente** sobre `app/(app)/cajas/revision-formas-pago.tsx`:
- Mismos imports (`useEffect`, `useState`, `useCallback`, `useMemo`, `useRouter`, etc.)
- Mismo bloque de selección de fechas con `InputFecha` de `../../components/InputFecha`
- Mismo selector de locales con multiselección (copiar el bloque completo del dropdown de locales)
- Mismo patrón de validación de rango (31/365 días) con `validacionRango` y `rangoBadge`
- Mismo indicador de caché (`cachedAt`, `fromCache`, `cachedAgoLabel`)
- Mismo botón "Consultar" / "Aplicar" / "Refrescar"
- Misma cabecera con botón de back: `router.back()`
- Misma carga inicial automática del día de hoy (`useRef didAutoConsult`)
- Mismos estilos base (colores `#0ea5e9`, `#334155`, `#64748b`, etc.)

### Endpoint a llamar
```
GET /api/agora/invoices/exceptions
```
Con los mismos parámetros que `payments-review`:
`businessDay`, `dateFrom`, `dateTo`, `workplaceIds[]`, `refresh`

### Tipos TypeScript de la respuesta
```ts
type TipoExcepcion = 'Invitacion' | 'Descuento' | 'Anulacion';

type ExcepcionRow = {
  tipo: TipoExcepcion;
  WorkplaceId: string;
  WorkplaceName: string | null;
  PosId: number | string | null;
  PosName: string | null;
  BusinessDay: string;
  TicketNumber: string;
  DateTime: string;
  UserId: number | null;
  UserName: string | null;
  ProductId: number | null;
  ProductName: string;
  FamilyName: string;
  Quantity: number;
  PrecioTarifa: number;
  PrecioAplicado: number;
  DiscountRate: number;
  CashDiscount: number;
  Diferencia: number;
};
```

### KPIs (tarjetas resumen) — mostrar encima de la tabla
Cuatro tarjetas en fila (estilo similar a `totalFacturadoBox` de revision-formas-pago):

| KPI | Valor | Color fondo |
|---|---|---|
| Total invitado | `formatMoneda(Math.abs(importeInvitado))` | `#fef3c7` (amarillo suave) |
| Total descontado | `formatMoneda(Math.abs(importeDescontado))` | `#fce7f3` (rosa suave) |
| Nº anulaciones | `totalAnulaciones` | `#fee2e2` (rojo suave) |
| Total excepciones | `totalExceptions` | `#f0f9ff` (azul suave) |

### Filtros rápidos sobre los datos (client-side, sin re-fetch)
- **Por tipo**: chips "Todos / Invitación / Descuento / Anulación"
  - "Invitacion" → icono `card-giftcard`, color `#d97706`
  - "Descuento"  → icono `local-offer`, color `#7c3aed`
  - "Anulacion"  → icono `cancel`, color `#dc2626`
- **Búsqueda libre**: filtrar por `ProductName`, `FamilyName`, `WorkplaceName`, `UserName`, `TicketNumber`

### Tabla de resultados
Columnas (ScrollView horizontal, sin redimensionado de columnas en esta versión):

| Col | Campo | Ancho aprox |
|---|---|---|
| Fecha | `BusinessDay` formateado `dd/mm/yyyy` | 90 |
| Hora | `DateTime` → solo HH:MM | 55 |
| Local | `WorkplaceName` o `WorkplaceId` mapeado | 130 |
| TPV | `PosName` | 80 |
| Empleado | `UserName ?? UserId ?? '—'` | 110 |
| Nº Ticket | `TicketNumber` | 90 |
| Tipo | badge coloreado con el tipo | 100 |
| Producto | `ProductName` | 140 |
| Familia | `FamilyName` | 100 |
| Tarifa | `PrecioTarifa` formateado como moneda | 85 |
| Aplicado | `PrecioAplicado` formateado como moneda | 85 |
| Diferencia | `Diferencia` en rojo si < 0 | 90 |

Paginación de 100 filas: misma lógica que `revision-formas-pago`.

### Fila de badge de tipo
El tipo se muestra como un pequeño badge coloreado (no texto plano):
```
Invitación → fondo #fef3c7, texto #92400e
Descuento  → fondo #ede9fe, texto #5b21b6
Anulación  → fondo #fee2e2, texto #991b1b
```

### Exportación Excel
Añadir botón "Descargar Excel" usando `xlsx-js-style` (ya instalado en el proyecto).
Las columnas del Excel deben coincidir con la tabla.

---

## 3. Modificar `app/(app)/cajas/_layout.tsx`

Añadir dentro del `<Stack>` existente, **sin tocar las demás Screen**:
```tsx
<Stack.Screen name="control-excepciones" />
```

---

## 4. Modificar `app/(app)/cajas/index.tsx`

Añadir al array `OPCIONES` (sin mover ni cambiar las existentes):
```ts
{
  id: 'control-excepciones',
  label: 'Control de Excepciones',
  icon: 'policy',
  descripcion: 'Invitaciones, descuentos y anulaciones por empleado y local',
  permiso: 'excepciones.ver',
},
```

Y añadir en el `handleSeleccionar`:
```ts
if (id === 'control-excepciones') router.push('/cajas/control-excepciones');
```

---

## Notas finales para Cursor

1. **No crear tests**, no crear ficheros README ni documentación adicional.
2. Si un campo de Ágora puede venir en camelCase o PascalCase, usar el operador `??`
   para aceptar ambos (patrón ya establecido en el código).
3. La función `formatMoneda` debe copiarse localmente en la nueva pantalla
   (igual que en `revision-formas-pago.tsx` — no importar de otro sitio).
4. Los locales se cargan desde `/api/locales` con `apiFetch` exactamente igual que en
   `revision-formas-pago.tsx`.
5. El permiso `excepciones.ver` es nuevo — no existe aún en la BD. La pantalla funciona
   aunque el permiso no esté asignado todavía; simplemente no se verá la tarjeta en el
   índice hasta que se asigne desde el panel de administración.
6. **No modificar** `api/lib/agora/client.js` ni ningún helper existente.
