# Reporte de Revisión de Código — 2026-05-25

Revisión automática diaria del código fuente. No se ha modificado nada; se listan hallazgos y márgenes de mejora ordenados por severidad.

---

## 🔴 BUGS / PROBLEMAS REALES

### 1. `PUT /pedidos` crea silenciosamente un pedido si no existe
**Archivo:** `api/routes/pedidos.js` (~línea 82)

El handler hace `const existing = got.Item || {}`. Si el `Id` no existe en DynamoDB, `got.Item` es `undefined`, y el código continúa con `existing = {}`, generando un item nuevo con todos los campos que vienen en el body. El resultado: una llamada PUT a un ID inexistente no devuelve 404 — crea el pedido en blanco. El mismo problema afecta a `PUT /pedidos/:pedidoId/lineas` con el fallback `got.Item || {}`.

**Impacto:** Potencial corrupción de datos (pedidos fantasma o líneas sin pedido padre).

---

### 2. Race condition en generación de `LineaIndex`
**Archivo:** `api/routes/pedidos.js` (~línea 194)

El índice de línea se calcula como `max(LineaIndex existentes) + 1` con un Query previo. Si dos peticiones POST llegan simultáneamente al mismo `pedidoId`, ambas leerán el mismo `maxIdx` y generarán el mismo `lineaIndex`, provocando que una sobreescriba a la otra en DynamoDB (PutCommand sin condición).

**Impacto:** Pérdida silenciosa de líneas de pedido en escenarios concurrentes.

---

### 3. `LineaIndex` se ordena como string, no como número
**Archivo:** `api/routes/pedidos.js` (líneas 153 y 173)

Tanto `/pedidos/:pedidoId/lineas` como `/pedidos/:pedidoId/details` usan `String(a.LineaIndex).localeCompare(String(b.LineaIndex))`. Con índices de dos cifras (`"9"` vs `"10"`), el orden alfabético da `"10" < "9"`, produciendo un listado incorrecto.

**Impacto:** El frontend recibe las líneas en orden equivocado cuando hay más de 9 líneas por pedido.

---

### 4. `GET /marketing/imagen-url` no valida pertenencia de la clave
**Archivo:** `api/routes/marketing.js` (~línea 1208)

Cualquier usuario con permiso `marketing.proponer` puede pedir una URL prefirmada de S3 para cualquier clave bajo `marketing/` (incluyendo `marketing/estilo-local/` de locales que no le pertenecen). Solo se valida que la key empiece por `marketing/`, pero no que pertenezca al local del usuario.

**Impacto:** Fuga de información — un usuario puede ver imágenes de identidad visual de locales ajenos.

---

### 5. `scanAllMarketing()` sin filtros en el fallback GSI
**Archivo:** `api/routes/marketing.js` (~línea 695)

Cuando ningún GSI está listo y la ruta GET `/marketing/propuestas` cae al fallback, se llama `scanAllMarketing()` sin ningún argumento. Esto devuelve **todas** las propuestas de toda la tabla. Aunque luego se filtra en memoria, un gestor sin `id_local` ni `id_empresa` en la query recibirá datos de todos los locales/empresas sin restricción. En producción con tablas grandes esto también supone un coste y latencia elevados.

**Impacto:** Exposición potencial de datos entre empresas mientras los GSIs están en estado `CREATING`.

---

## 🟡 PROBLEMAS MENORES / INCONSISTENCIAS

### 6. `DELETE /pedidos` acepta `Id` en el body y en query, pero no en params
**Archivo:** `api/routes/pedidos.js` (~línea 111)

El diseño REST convencional espera `DELETE /pedidos/:id`. El uso del body en DELETE no está garantizado en todos los clientes HTTP (algunos lo ignoran). Mismo patrón en `DELETE /pedidos/:pedidoId/lineas` con `LineaIndex`.

---

### 7. `checkAutoSyncs` — Scan completo de la tabla `Igp_Ajustes` cada minuto
**Archivo:** `api/lib/jobs/scheduledTasks.js` (~línea 57)

El scheduler hace un `ScanCommand` de toda la tabla de ajustes con `FilterExpression: 'PK = :pk AND Enabled = :e'` cada 60 segundos. Dado que la tabla tiene clave `PK`/`SK`, sería más eficiente usar `QueryCommand` con `KeyConditionExpression: 'PK = :pk'` y filtrar `Enabled` en memoria. El Scan recorre todos los items de la tabla aunque solo haya unos pocos registros de sincronizaciones.

---

### 8. Inconsistencia en el logger (`console.*` vs `pino`)
**Archivos:** `api/routes/acuerdos.js`, `api/routes/agora.js`, `api/lib/dynamo/marketing.js`, `api/lib/dynamo/usuarios.js`

Gran parte de las rutas antiguas usan `console.error` / `console.warn` directamente en lugar del logger estructurado `pino` (disponible vía `req.log` o la instancia `logger`). Esto rompe la trazabilidad estructurada en producción (los logs de consola no llevan `requestId`, `traceId`, etc.).

---

### 9. Endpoints duplicados `/pedidos/:id/lineas` y `/pedidos/:id/details`
**Archivo:** `api/routes/pedidos.js` (líneas 143 y 163)

Ambos hacen exactamente lo mismo: `QueryCommand` sobre `pedidosLineas` y devuelven los items ordenados. Solo difieren en la clave de respuesta (`lineas` vs `details`). Si es intencional para compatibilidad con el frontend, debería documentarse; si no, uno de los dos es código muerto.

---

### 10. `VatRate: 0` y `TotalRappel: 0` se descartan silenciosamente al crear líneas
**Archivo:** `api/routes/pedidos.js` (~línea 213)

La condición `vatRate != null && !Number.isNaN(vatRate)` incluye `0`. Pero más arriba, si `body.VatRate` es `0`, `parseFloat('0') || 0` devuelve `0`, que es falsy... en realidad no, `0` no es `NaN`, así que sí se guarda. **Sin embargo**, en el `PUT` de líneas estos campos no se incluyen en el item construido si no vienen en el body — si el item existente tenía `VatRate`, el PUT lo borrará del item (DynamoDB PutCommand sobreescribe el item completo). Mismo riesgo con `TotalRappel`.

---

### 11. CORS silencioso: orígenes no permitidos reciben `CORS error` sin mensaje claro
**Archivo:** `api/server.js` (~línea 91)

`cb(null, false)` no envía un error al cliente, solo omite las cabeceras CORS. En navegadores esto produce un error genérico "Network Error" sin ningún cuerpo de respuesta útil para depuración. En desarrollo es confuso. Considerar `cb(new Error('Origin no permitido'))` o al menos un header `Vary: Origin`.

---

### 12. `GET /marketing/carteles-musico/generar` — Scan completo de `tables.actuaciones`
**Archivo:** `api/routes/marketing.js` (~línea 895)

Para obtener actuaciones de un local en un rango de fechas, se descarga toda la tabla `actuaciones` a memoria con un Scan y se filtra en JS. Si el volumen de actuaciones crece, esto será lento y caro. Debería aprovecharse un GSI por `id_local` y `fecha` si existe, o añadirse.

---

## 🟢 MEJORAS RECOMENDADAS (no son bugs)

- **Paginación en `GET /pedidos`:** Actualmente descarga todos los pedidos Y todas las líneas de cada pedido en cada llamada para calcular `TotalAlbaran`. Con volumen alto, esto escala muy mal. Considerar guardar `TotalAlbaran` desnormalizado en el item del pedido y actualizarlo al añadir/modificar líneas.
- **Tests de integración:** No hay evidencia de tests automatizados en el repo. Los bugs 1-3 serían detectables con tests básicos de los endpoints.
- **Validación de `Estado` en `POST /pedidos`:** El campo `Estado` acepta cualquier string; no se valida contra una lista de estados permitidos (a diferencia del módulo marketing que sí lo hace).
- **Limitar campos en `PATCH /marketing/propuestas` al rechazar:** La validación de `comentario_rechazo` solo comprueba el campo enviado en el body actual; si el campo no viene en el PATCH pero ya existía en el item previo, lo acepta. Correcto por diseño, pero merece un comentario explícito.

---

*Revisión generada automáticamente el 2026-05-25. No se realizaron cambios en el código.*
