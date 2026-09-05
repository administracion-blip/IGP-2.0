# Reporte de Revisión de Código — 2026-06-30

Revisión automática diaria. Sin modificaciones al código; solo hallazgos y márgenes de mejora ordenados por severidad.

---

## Estado respecto al reporte anterior (2026-06-15)

Hay un nuevo commit desde el último reporte: **c1885b9 (26.06.2026)**. Incluye los módulos de Informe Diario, Franjas Horarias, Top de Ventas, Movimientos de Caja y una refactorización importante de Pedidos. Además hay ~219 ficheros modificados sin commitar.

---

## ✅ BUGS CORREGIDOS (en working tree, pendientes de commit)

### 1. `PUT /pedidos` — registros fantasma *(resuelto)*
**Archivo:** `api/routes/pedidos.js` (~línea 519)

`got.Item || {}` reemplazado por `const existing = got.Item; if (!existing) return res.status(404)...`. Corregido correctamente.

---

## 🔴 BUGS CRÍTICOS PERSISTENTES

### 2. Race condition en `LineaIndex` *(sin corregir, 6+ semanas)*
**Archivo:** `api/routes/pedidos.js` (líneas 706-710)

El patrón `max(existentes) + 1` sigue igual. Dos POSTs simultáneos al mismo pedido producirán el mismo índice y una línea sobreescribirá a la otra.

**Impacto:** Pérdida silenciosa de líneas de pedido en escenarios concurrentes.

---

### 3. `GET /marketing/imagen-url` no valida pertenencia de clave *(sin corregir, 6+ semanas)*
**Archivo:** `api/routes/marketing.js` (~línea 1213)

Solo verifica `key.startsWith('marketing/')`. Un usuario con `marketing.proponer` puede pedir presigned URL de imágenes de otro local.

**Impacto:** Fuga de imágenes entre locales/empresas. Seguridad.

---

### 4. `scanAllMarketing()` sin filtros en fallback GSI *(sin corregir, 6+ semanas)*
**Archivo:** `api/routes/marketing.js` (línea 695)

Cuando ningún GSI está activo, se escanea toda la tabla sin `FilterExpression`. Un gestor sin contexto de local/empresa recibe propuestas de todos los locales.

**Impacto:** Exposición de datos entre empresas. Seguridad.

---

### 5. `PUT /cajas/movimientos` crea registros silenciosamente si SK no existe *(nuevo)*
**Archivo:** `api/routes/movimientosCaja.js` (líneas 140-150)

Mismo patrón que el antiguo bug #1 de pedidos: si se envía un `SK` en el body pero no existe en DynamoDB, `existing` queda `null` y el código continúa creando un registro nuevo sin devolver 404. En un PUT, el cliente espera que el recurso exista.

**Corrección sugerida:** Añadir tras la consulta `GetCommand`:
```js
if (sk && !existing) return res.status(404).json({ error: 'Movimiento no encontrado' });
```

---

## 🟠 BUGS MEDIOS

### 6. `LineaIndex` ordenado como string en `GET /pedidos/:pedidoId/lineas` y `GET /pedidos/:pedidoId/details` *(sin corregir, 6+ semanas)*
**Archivo:** `api/routes/pedidos.js` (líneas 658, 678)

```js
.sort((a, b) => String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? '')))
```
Con 10+ líneas, `"10"` ordena antes que `"9"`. El POST de nueva línea ya usa `parseInt` correctamente (línea 707), pero los GETs siguen con string comparison.

**Corrección sugerida:** `Number(a.LineaIndex ?? 0) - Number(b.LineaIndex ?? 0)`

---

### 7. `resolveTotalAportacionUnitaria` hace un `ScanCommand` completo en cada añadido de línea *(nuevo)*
**Archivo:** `api/lib/pedidos/rappelAcuerdo.js` (líneas 54-58)

Esta función se llama desde `POST /pedidos/:pedidoId/lineas`. Ejecuta un scan completo de `tables.acuerdosDetalles` sin ningún índice ni filtro de clave. A medida que crezca la tabla de detalles de acuerdos, cada añadido de línea se degradará linealmente.

**Corrección sugerida:** Añadir un GSI sobre `ProductoId` (o el campo de clave del producto) en `Igp_AcuerdosDetalles` y usar `QueryCommand` en lugar del scan.

---

### 8. `GET /cajas/movimientos/justificante-url` no valida pertenencia del workplaceId *(nuevo)*
**Archivo:** `api/routes/movimientosCaja.js` (~línea 108)

Solo valida el prefijo `cajas-movimientos/` y que no haya `..`. Cualquier usuario autenticado puede obtener la URL firmada de un justificante de otro local si conoce la clave S3.

**Impacto:** Fuga de documentos entre locales. Menor que el de marketing porque la clave incluye el UUID, pero el patrón de seguridad es inconsistente con el resto de la API.

---

### 9. `DELETE /cajas/movimientos` sin validación de pertenencia *(nuevo)*
**Archivo:** `api/routes/movimientosCaja.js` (~línea 187)

Solo exige `PK` y `SK`. Cualquier usuario autenticado con `requireAuth` puede eliminar el movimiento de cualquier local si conoce ambos valores. No se verifica que el `PK` (workplaceId) pertenezca a los locales del usuario.

---

### 10. `acuerdos.js` no propaga errores al middleware central *(sin corregir, 3+ semanas)*
**Archivo:** `api/routes/acuerdos.js`

Sigue con `try/catch` + `res.status(500).json(...)` local, saltándose el `errorHandler` central. Impide correlacionar errores con `requestId`.

---

## 🟡 PROBLEMAS MENORES / INCONSISTENCIAS (persistentes)

### 11. Auth check confuso en `GET /informes/diario/destinatarios` *(sin corregir desde 15-06)*
**Archivo:** `api/routes/informes.js` (línea 189)

```js
if (req.user && req.user.rol !== 'Administrador')
```
La condición `req.user &&` es superflua y defensivamente insegura. Debería ser `if (!req.user || req.user.rol !== 'Administrador')`.

---

### 12. `GET /informes/diario/destinatarios` provoca scan doble *(sin corregir desde 15-06)*
**Archivo:** `api/routes/informes.js` (~línea 194)

`resolverDestinatarios` no recibe `mapaLocales`, forzando dos scans DynamoDB extra por cada recarga en Ajustes.

---

### 13. `checkAutoSyncs` usa `ScanCommand` en lugar de `QueryCommand` *(sin corregir)*
**Archivo:** `api/lib/jobs/scheduledTasks.js` (~línea 57)

Se ejecuta cada 60 segundos con un scan + FilterExpression sobre `PK`. Debería ser un `QueryCommand`.

---

### 14. `getUserLocales` se llama dos veces en `GET /marketing/propuestas` *(sin corregir)*
**Archivo:** `api/routes/marketing.js`

Dos llamadas DynamoDB redundantes al mismo `userId` por request.

---

### 15. Backend acepta plantillas de franjas con 0 franjas *(sin corregir desde 15-06)*
**Archivo:** `api/routes/agora.js` (POST `/agora/franjas-plantillas`)

`normalizarFranjas([])` devuelve `[]` (no `null`), la validación `if (franjas == null)` no dispara.

---

### 16. Inconsistencia de logger (`console.*` vs `req.log`/pino) *(sin corregir)*
**Archivos:** `api/routes/acuerdos.js`, `api/routes/movimientosCaja.js` (nuevo), y otros.

`movimientosCaja.js` añade nuevos `console.error/warn` en lugar de usar el logger pino con `requestId`.

---

## 📋 Resumen ejecutivo

| # | Archivo | Severidad | Estado |
|---|---------|-----------|--------|
| 1 | pedidos.js (PUT fantasma) | ✅ | Corregido (working tree, sin commit) |
| 2 | pedidos.js (race condition) | 🔴 Alta | Sin corregir (6+ semanas) |
| 3 | marketing.js (imagen-url seguridad) | 🔴 Alta | Sin corregir (6+ semanas) |
| 4 | marketing.js (scanAll sin filtro) | 🔴 Alta | Sin corregir (6+ semanas) |
| 5 | movimientosCaja.js (PUT fantasma) | 🔴 Alta | **Nuevo** |
| 6 | pedidos.js (LineaIndex string sort) | 🟠 Media | Sin corregir (6+ semanas) |
| 7 | rappelAcuerdo.js (ScanCommand por línea) | 🟠 Media | **Nuevo** |
| 8 | movimientosCaja.js (justificante-url pertenencia) | 🟠 Media | **Nuevo** |
| 9 | movimientosCaja.js (DELETE sin pertenencia) | 🟠 Media | **Nuevo** |
| 10 | acuerdos.js (no usa errorHandler) | 🟠 Media | Sin corregir (3+ semanas) |
| 11 | informes.js (auth check confuso) | 🟡 Baja | Sin corregir (15-06) |
| 12 | informes.js (scan doble destinatarios) | 🟡 Baja | Sin corregir (15-06) |
| 13 | scheduledTasks.js (Scan vs Query) | 🟡 Baja | Sin corregir |
| 14 | marketing.js (getUserLocales doble) | 🟡 Baja | Sin corregir |
| 15 | agora.js (plantilla 0 franjas) | 🟡 Baja | Sin corregir (15-06) |
| 16 | múltiples routes (console vs pino) | 🟡 Baja | Sin corregir + nuevo en movimientosCaja |

**Prioridad inmediata:** Bugs 2, 3 y 4 llevan 6+ semanas sin corregirse e implican seguridad entre locales/empresas. El bug 5 reproduce el mismo patrón del antiguo bug #1 en el módulo nuevo de movimientos de caja y debería corregirse antes de que entre en producción.
