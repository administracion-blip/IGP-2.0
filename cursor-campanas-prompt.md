# Prompt para Cursor: Módulo Incentivos por producto (campañas de incentivo)

## Nombre en producto (obligatorio en UI)

- **Nombre visible en menú y pantallas:** «Incentivos por producto»
- **Subtítulo sugerido:** «Premios al equipo por vender productos concretos»
- **No confundir con** «Activaciones de marca» (`/reservas/activaciones`), que es otro módulo (campañas pactadas con marcas de bebidas).
- **Rutas frontend:** `app/(app)/cajas/incentivos-producto/` (`index.tsx`, `[campanaId].tsx`)
- **Slug técnico API/tabla:** se mantiene `campanas` / `Igp_Campanas` (interno). En permisos y menú usar el prefijo acordado abajo.

## Contexto del proyecto

- Framework: React Native / Expo con backend Node.js/Express en `/api`
- Base de datos: DynamoDB
- **Objetivo del módulo**: crear campañas de incentivo por venta de productos específicos (ej. "botella de vino selección", "postre de la casa"), medir unidades vendidas durante la campaña contra un baseline, calcular la rentabilidad (margen incremental vs. coste del incentivo) y generar un ranking por empleado o por local.
- Los datos de venta por producto salen del export de facturas de Ágora (`exportInvoices` en `api/lib/agora/client.js`), que devuelve documentos con `SaleLines` (producto, cantidad, importe) y usuario del documento.
- **Patrones de referencia obligatorios**:
  - Sync con throttle + upsert por hash + escritura en batch de 25: `POST /api/agora/products/sync` en `api/routes/agora.js` y `AGORA-PRODUCTS-SYNC.md`
  - Aplanado de líneas por producto y persistencia + consulta por producto con rango de fechas: bloque de `purchases` en `api/routes/agora.js` (`/agora/purchases/sync`, `/agora/purchases/por-producto`, tabla `Igp_ComprasAProveedor`)
  - Detección de líneas anuladas, invitaciones y documentos anulados: lógica de excepciones ya existente en `api/routes/agora.js` (`extractExceptionsFromInvoiceItem`, CONSUMO, `IsCancellation`, etc.). **Extraer a `api/lib/agora/invoiceSaleValidity.js` (o similar) y reutilizar desde el sync de ventas y desde el módulo de excepciones. No duplicar reglas.**
  - Cron interno sin JWT: `api/lib/internalSync.js` (cabecera `X-Internal-Secret`)
  - Maestros ya sincronizados: `Igp_AgoraProducts` (PK `GLOBAL`, SK = Id de producto; incluye `CostPrice`, `Name`, `FamilyId`, `BaseSaleFormatId`) e `Igp_AgoraUsuarios`
  - Patrón de permisos: `hasPermiso('permiso.accion')` desde `useAuth()`
  - Patrón visual: pantalla Objetivos Opción A (`app/(app)/cajas/objetivos-opcion-a.tsx`) para KPIs + detalle; `app/(app)/compras/almacen.tsx` para listas con chips y tarjetas

---

## Modelo de datos

### Tabla `Igp_VentasProducto` — agregado diario de ventas por producto

**No se guardan líneas de ticket crudas.** El sync agrega por (local, jornada, producto, usuario) y guarda un único ítem por combinación. Esto mantiene la tabla pequeña y las consultas de rango baratas.

```
PK                string  — "LOCAL#<localId>"
SK                string  — "DIA#<YYYY-MM-DD>#PROD#<productId>#USER#<agoraUserId>"
Fecha             string  — YYYY-MM-DD (jornada / business-day de Ágora, no día calendario)
LocalId           string
WorkplaceId       string  — workplace de Ágora usado en el export
ProductId         string  — Id de producto en Ágora (mismo Id que Igp_AgoraProducts)
ProductName       string  — denormalizado en el momento del sync
AgoraUserId       string  — usuario del documento en Ágora ("0" si no identificable)
UserName          string  — denormalizado
Unidades          number  — suma de Quantity de las líneas válidas
ImporteBruto      number  — suma del importe de línea (con IVA, como lo da Ágora)
SyncedAt          string  — ISO datetime
```

**GSI sugerido:** `ProductId-Fecha-index` (PK `ProductId`, SK `Fecha`) — mismo patrón que `Igp_ComprasAProveedor`, permite ver la serie histórica de un producto en todos los locales.

**Reglas de agregación (críticas, es dinero):**
- Excluir documentos anulados y líneas con `IsCancellation` / `Cancellations` (reutilizar la lógica de excepciones existente).
- Excluir invitaciones y consumos internos (cliente CONSUMO): esas unidades NO computan para incentivo.
- Las líneas con formato de venta distinto del base (`BaseSaleFormatId`, ej. media botella vs. botella) computan por su `ProductId` real tal y como lo devuelve Ágora; no intentar convertir formatos en v1.
- El sync de un día es **idempotente**: recalcula el agregado completo del día y sobreescribe (PutItem), nunca incrementa.

### Tabla `Igp_Campanas` — definición de cada campaña

```
campanaId          (PK, UUID)
nombre             string   — ej. "Vino selección otoño"
estado             string   — "Borrador" | "Activa" | "Finalizada" | "Archivada"
locales            string[] — localIds incluidos
productos          array    — [{ productId, productName, margenUnitario?: number }]
                              margenUnitario opcional: si no se indica, se calcula según
                              «Fórmulas cerradas» más abajo (precio medio sin IVA − CostPrice)
fechaInicio        string   — YYYY-MM-DD
fechaFin           string   — YYYY-MM-DD (recomendado 4-8 semanas; validar aviso si > 8 semanas)
tipoIncentivo      string   — "eur_por_unidad" | "pct_margen"
valorIncentivo     number   — €/ud o fracción del margen (0.10 = 10%)
destinatario       string   — "individual" | "equipo"
                              individual = ranking y pago por AgoraUserId
                              equipo = bote único por local repartido fuera del sistema
baselineInicio     string   — YYYY-MM-DD inicio del periodo de referencia
baselineFin        string   — YYYY-MM-DD fin del periodo de referencia
                              Por defecto al crear: el periodo de la misma longitud
                              inmediatamente anterior a fechaInicio.
notas              string?
creadoPor          string
creadoEn / actualizadoEn
```

---

## Tarea 1 — Registrar tablas y scripts de creación

- Añadir `DDB_VENTAS_PRODUCTO_TABLE` (default `Igp_VentasProducto`) y `DDB_CAMPANAS_TABLE` (default `Igp_Campanas`) en `api/lib/db.js`, siguiendo el patrón existente.
- Crear `api/scripts/create-ventas-producto-table.js` y `api/scripts/create-campanas-table.js` siguiendo el patrón de `create-agora-products-table.js` (incluyendo el GSI de `Igp_VentasProducto`).

## Tarea 2 — Sync de ventas por producto

En `api/routes/agora.js` (o módulo nuevo `api/lib/agora/salesLinesSyncHelpers.js` si el archivo crece demasiado):

**`POST /api/agora/sales-lines/sync`**
- Body: `{ businessDay?: "YYYY-MM-DD" }` (default: jornada de ayer).
- Llama a `exportInvoices(businessDay, workplaces)` para cada local con workplace configurado (mismo mecanismo de resolución local↔workplace que usa el sync de closeouts).
- Aplana `SaleLines` aplicando las reglas de agregación de arriba, agrega por (local, producto, usuario) y escribe en batch de 25.
- Throttle configurable `AGORA_SALES_LINES_SYNC_THROTTLE_MINUTES` (default 30), `?force=1` para saltarlo.
- Respuesta: `{ ok, businessDay, locales: N, items: M }`.

**`POST /api/agora/sales-lines/full-sync`**
- Body: `{ fechaInicio, fechaFin, localId? }`. Itera día a día llamando a la misma función de sync. Necesario para cargar histórico y poder calcular baselines. Seguir el patrón de `closeouts/full-sync` (progreso, tolerancia a errores por día).

**Cron nocturno**: añadir la llamada al sync del día anterior en el mecanismo de jobs existente (`api/lib/jobs`), protegido con `X-Internal-Secret` como el resto de syncs internos.

## Tarea 3 — CRUD de campañas

Crear `api/routes/campanas.js` siguiendo el patrón de autenticación y manejo de errores de `api/routes/activaciones.js`:

- **`GET /api/campanas`** — lista, filtro opcional `?estado=`
- **`GET /api/campanas/:campanaId`** — ficha
- **`POST /api/campanas`** — crea (estado por defecto "Borrador"); valida: fechas coherentes, al menos 1 producto y 1 local, `valorIncentivo > 0`. Al crear, si `margenUnitario` no viene informado en un producto, resolverlo desde `Igp_AgoraProducts` y avisar en la respuesta si `CostPrice` es 0 o nulo (margen no fiable).
- **`PATCH /api/campanas/:campanaId`** — editar; **no permitir cambiar productos ni fechas si estado = "Activa"** (invalidaría el baseline y la comparación).
- **`DELETE /api/campanas/:campanaId`** — solo en estado "Borrador" o "Archivada".
- Permisos (registrar en roles/permisos y `permisos.tsx`):
  - `incentivos_producto.ver` — ver listado y resultados
  - `incentivos_producto.gestionar` — crear, editar, activar, archivar
  - `incentivos_producto.exportar` — Excel/PDF del informe de resultados
  - Alias técnico aceptable en código de rutas: `campanas.*` solo si ya está cableado; en UI y permisos visibles usar `incentivos_producto.*`.

## Tarea 4 — Endpoint de resultados

**`GET /api/campanas/:campanaId/resultados`**

Consulta `Igp_VentasProducto` para los locales/productos de la campaña en dos rangos: baseline y campaña. Devuelve:

```
{
  porProducto: [{
    productId, productName,
    udsBaselinePorDia,          — unidades/día del periodo de referencia
    udsCampanaPorDia,
    udsCampanaTotal,
    udsIncrementales,           — max(0, total campaña - baseline extrapolado a los días de campaña)
    margenUnitario,
    margenIncremental,          — udsIncrementales × margenUnitario
    costeIncentivo,             — sobre TODAS las unidades de campaña (no solo incrementales)
    resultadoNeto,              — margenIncremental - costeIncentivo
    veredicto                   — "RENTABLE" | "REVISAR"
  }],
  porEmpleado: [{ agoraUserId, userName, localId, unidades, importe, incentivoDevengado }],
  porLocal:    [{ localId, unidades, incentivoDevengado }],
  totales:     { margenIncremental, costeIncentivo, resultadoNeto },
  serieDiaria: [{ fecha, unidades }]
}
```

Reglas (detalle en «Decisiones cerradas — fórmulas»):
- El incentivo se **devenga sobre todas las unidades válidas** vendidas en campaña; la **rentabilidad solo sobre incrementales**.
- Si `destinatario = "equipo"`, `porEmpleado` vacío; incentivo en `porLocal`.
- Si baseline sin datos: `warning: "baseline_incompleto"`.

## Tarea 5 — Pantalla `app/(app)/cajas/incentivos-producto/`

- **Lista** (`index.tsx`): tarjetas con chips de estado, fechas, locales y semáforo de `resultadoNeto` (verde/rojo). Título «Incentivos por producto». Botón crear con permiso `incentivos_producto.gestionar`.
- **Detalle** (`[campanaId].tsx`): cabecera con KPIs (uds. campaña, incrementales, coste incentivo, resultado neto), pestañas Por producto / Por empleado / Por local / Evolución (serie diaria). Ranking de empleados por `incentivoDevengado`. Exportar con `incentivos_producto.exportar`.
- **Formulario** crear/editar: selector de productos desde `/api/agora/products` (avisar si `CostPrice` es 0), selector de locales, tipo y valor de incentivo, destinatario, fechas (aviso si duración > 8 semanas). Nota visible: «Las fechas de campaña son días naturales; las unidades vienen de la jornada de negocio de Ágora (business-day).»
- Registrar la entrada en el hub de **Cajas** junto a Objetivos, etiqueta **«Incentivos por producto»** (no «Campañas» a secas).

## Tarea 6 — Reglas de negocio que NO son opcionales

1. Invitaciones, consumos internos y líneas/documentos anulados **nunca** devengan incentivo.
2. Los resultados se actualizan con el cron nocturno; la pantalla no consulta Ágora en vivo (evita ranking en tiempo real manipulable a última hora y carga innecesaria al servidor de Ágora).
3. Una campaña "Activa" es inmutable en productos, fechas e incentivo. Para cambiar, se finaliza y se crea otra.
4. `destinatario = "individual"` solo debe usarse en locales donde el usuario del documento en Ágora refleja realmente quién vende (verificarlo local a local antes de activar; si el cobro es centralizado, usar "equipo").
5. El sistema calcula y muestra; **no ejecuta pagos**. La liquidación del incentivo es un proceso humano con el informe de resultados como soporte.

---

## Criterios de aceptación

- El full-sync de 30 días de un local termina sin errores y las unidades de un producto concreto cuadran con el informe de ventas por producto de Ágora para un día muestreado a mano.
- Una campaña con baseline sin datos devuelve `baseline_incompleto` y la UI lo muestra como aviso, no como resultado.
- Un usuario sin `incentivos_producto.gestionar` puede ver resultados pero no crear/editar.
- Un usuario sin `incentivos_producto.exportar` no ve botón Descargar en el detalle.
- Una invitación registrada en Ágora durante la campaña no altera unidades ni incentivo.

---

## Decisiones cerradas — fórmulas y reglas de cálculo

Esta sección es **normativa**. Backend y UI deben implementar exactamente estas fórmulas.

### A) Venta válida para incentivo (sync)

Una línea de `SaleLines` cuenta en `Unidades` solo si:

1. El documento no está anulado (`IsCancellation`, referencia a original, etc.).
2. La línea no está anulada (`IsCancellation` / `Cancellations`).
3. No es invitación ni cortesía (misma heurística que excepciones en `agora.js`).
4. El cliente no es CONSUMO (Id 1 / nombre «CONSUMO»).

Implementación: función compartida `esLineaVentaValidaParaIncentivo(line, invoiceCtx)` en `api/lib/agora/invoiceSaleValidity.js`, reutilizada por el sync y testeable aparte.

### B) Base del margen (IVA)

- `ImporteBruto` en `Igp_VentasProducto` se guarda **con IVA** (como Ágora).
- Para calcular margen se usa **base sin IVA**:
  - `precioMedioUnitarioSinIva = (suma ImporteBruto líneas válidas / suma Unidades) / (1 + tipoIva/100)`
  - Si el ticket no trae desglose de IVA por línea, usar el tipo impositivo de la línea o, en último caso, **10%** (config `INCENTIVOS_IVA_DEFAULT=0.10`) y marcar `warning: "iva_estimado"` en resultados.
- `CostPrice` de `Igp_AgoraProducts` se trata como **sin IVA** (coste almacén).
- **Margen unitario** (por producto y periodo):
  ```
  margenUnitario = round2(precioMedioUnitarioSinIva - CostPrice)
  ```
- Si `CostPrice` es 0 o null: `margenUnitario` no es fiable → `warning: "coste_desconocido"` y `veredicto` no puede ser «RENTABLE» sin revisión manual.

El campo opcional `margenUnitario` en la campaña **fija** el valor y sustituye el cálculo automático para ese producto.

### C) Baseline y unidades incrementales (por producto)

Para cada `productId` y local incluido en la campaña:

```
diasBaseline  = días con al menos un registro en [baselineInicio, baselineFin], o
                (baselineFin - baselineInicio + 1) si se prefiere calendario completo — usar calendario completo en v1
udsBaselineTotal = suma Unidades en baseline
udsBaselinePorDia = udsBaselineTotal / diasBaseline

diasCampana = (fechaFin - fechaInicio + 1)   // días naturales de la campaña
udsCampanaTotal = suma Unidades en [fechaInicio, fechaFin]
udsCampanaPorDia = udsCampanaTotal / diasCampana

baselineExtrapolado = udsBaselinePorDia × diasCampana
udsIncrementales = max(0, udsCampanaTotal - baselineExtrapolado)
```

Si en baseline no hay ningún registro para ese producto/local: `warning: "baseline_incompleto"` a nivel campaña (o producto) y **no** asumir que todo es incremental.

### D) Rentabilidad (solo sobre incrementales)

Por producto:

```
margenIncremental = round2(udsIncrementales × margenUnitario)
```

Totales campaña: suma de `margenIncremental` de todos los productos.

### E) Incentivo devengado (sobre TODAS las unidades de campaña)

Por producto, según `tipoIncentivo`:

**`eur_por_unidad`**
```
incentivoProducto = round2(udsCampanaTotal × valorIncentivo)
```

**`pct_margen`**
```
incentivoProducto = round2(udsCampanaTotal × margenUnitario × valorIncentivo)
```
(`valorIncentivo` 0,10 = el empleado/local recibe el 10% del **margen unitario** por cada unidad vendida en campaña, no el 10% del margen incremental total.)

`costeIncentivo` (por producto) = `incentivoProducto`.  
Total campaña = suma por productos.

### F) Resultado neto y semáforo

Por producto:

```
resultadoNeto = round2(margenIncremental - costeIncentivo)
veredicto = resultadoNeto >= 0 ? "RENTABLE" : "REVISAR"
```

Totales: mismas sumas. Semáforo global en UI = verde si `totales.resultadoNeto >= 0`.

### G) Reparto por empleado y por local

Solo si `destinatario = "individual"`:

- Agrupar `Igp_VentasProducto` en periodo campaña por `(localId, agoraUserId, productId)`.
- Por cada grupo: `unidades` = suma `Unidades`.
- Incentivo del grupo con la misma fórmula E) aplicada a esas unidades y al `margenUnitario` / `valorIncentivo` de la campaña para ese `productId`.
- `porEmpleado`: suma de incentivos de todos los productos del mismo `(localId, agoraUserId)`.
- Ordenar por `incentivoDevengado` descendente.

Si `destinatario = "equipo"`:

- `porEmpleado` = `[]`.
- `porLocal`: un registro por local con `unidades` = suma total y `incentivoDevengado` = suma incentivos de todos los productos de ese local.

### H) Fechas campaña vs jornada Ágora

- Las fechas `fechaInicio` / `fechaFin` / baseline en la ficha son **días naturales** (selección del usuario).
- La consulta a `Igp_VentasProducto` filtra por campo `Fecha` (= business-day de Ágora al sincronizar).
- En UI, dejar claro que el informe sigue la jornada TPV, no el corte operativo IGP de las 09:30.
