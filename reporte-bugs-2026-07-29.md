# Reporte de Revisión de Código — 2026-07-29

Revisión automática diaria. Sin modificaciones al código; solo hallazgos y márgenes de mejora ordenados por severidad.

---

## Estado respecto al reporte anterior (2026-06-30)

Hay **17 commits nuevos** desde el último reporte (del 14.07 al 22.07.2026). El cambio más significativo es la incorporación del **módulo de facturación completo** (`api/routes/facturacion.js`, ~2700 líneas) junto con sus librerías de soporte (`construirFactura`, `emitirFactura`, `facturarMantenimiento`, `facturarRappel`, `facturarVentasInternas`, `series`). También hay cambios en mantenimiento, compras y ajustes protegidos.

El working tree sigue con ~120 ficheros modificados sin commitar.

---

## ✅ BUGS ANTERIORES CON CIERRE CONFIRMADO

Ninguno de los bugs abiertos del reporte anterior aparece corregido. El bug #1 (PUT fantasma en pedidos) que estaba corregido en working tree sigue sin commitarse.

---

## 🔴 BUGS CRÍTICOS NUEVOS

### 1. `facturacion.js` — Sin `requirePermission` en ~28 rutas de escritura *(nuevo)*
**Archivo:** `api/routes/facturacion.js`

Solo 2 de las ~30 rutas del módulo tienen control de permisos: `POST /facturacion/facturas/validar-revision` y `POST /facturacion/facturas/:id/emitir`. Todas las demás —crear, editar, anular, eliminar, duplicar y rectificar facturas; registrar, editar y eliminar pagos; crear, editar y eliminar series— solo exigen token JWT válido (`requireAuth` global), sin verificar ningún permiso.

**Rutas afectadas sin `requirePermission`:**
- `POST /facturacion/facturas` — crear factura
- `PUT /facturacion/facturas/:id` — editar factura
- `POST /facturacion/facturas/:id/anular` — anular factura fiscal
- `DELETE /facturacion/facturas/:id` — borrar factura de gasto
- `POST /facturacion/facturas/:id/duplicar`
- `POST /facturacion/facturas/:id/rectificar` — generar rectificativa
- `POST /facturacion/facturas/:id/pagos` — registrar cobro/pago
- `PUT /facturacion/pagos/:id_factura/:id_pago`
- `DELETE /facturacion/pagos/:id_factura/:id_pago`
- `POST /facturacion/series`, `PUT /facturacion/series`, `DELETE /facturacion/series`
- `POST /facturacion/facturas/:id/enviar-email`
- `POST /facturacion/enviar-recordatorios`
- `POST /facturacion/ocr/confirmar`
- `POST /facturacion/facturas/:id/adjuntos`, `DELETE /facturacion/facturas/:id/adjuntos/:adjId`

**Impacto:** Un usuario con rol `Camarero` puede anular facturas fiscales emitidas, registrar pagos falsos o borrar series de numeración.

---

### 2. `facturacion.js` — `GET /facturacion/facturas` sin filtro por local/empresa *(nuevo)*
**Archivo:** `api/routes/facturacion.js` (~línea 317)

```js
router.get('/facturacion/facturas', async (req, res) => {
  const items = await scanAll(tables.facturas);  // sin filtro de usuario
```

Escanea toda la tabla y devuelve todas las facturas de todas las empresas sin verificar que pertenezcan a los locales del usuario. Los endpoints de detalle, pagos, adjuntos y métricas tienen el mismo problema.

**Impacto:** Cualquier usuario autenticado puede leer facturas (CIF, importes, condiciones de pago) de empresas con las que no tiene relación.

---

## 🔴 BUGS CRÍTICOS PERSISTENTES (sin corregir, 6+ semanas)

### 3. Race condition en `LineaIndex` — `api/routes/pedidos.js` (líneas 706-710)
El patrón `max(existentes) + 1` sigue igual.

### 4. `GET /marketing/imagen-url` no valida pertenencia de clave — `api/routes/marketing.js` (~línea 1213)
Un usuario con `marketing.proponer` puede pedir presigned URL de imágenes de otro local.

### 5. `scanAllMarketing()` sin filtros en fallback GSI — `api/routes/marketing.js` (línea 695)
Scan completo sin `FilterExpression`. Exposición de datos entre empresas.

---

## 🟠 BUGS MEDIOS NUEVOS

### 6. Race condition en `id_pago` — `api/routes/facturacion.js` (líneas 926-927) *(nuevo)*
```js
const nextIdx = pagos.length + 1;
const id_pago = `P${String(nextIdx).padStart(3, '0')}`;
```
Mismo patrón que el `LineaIndex` de pedidos. Dos `POST` concurrentes sobre la misma factura generarán el mismo `id_pago`; uno sobreescribirá al otro y el `total_cobrado` quedará mal calculado.

**Corrección sugerida:** Usar `uuid()` para el `id_pago` o envolver el read-modify-write en `TransactWriteCommand`.

---

### 7. `GET /facturacion/pagos` sin filtros — `api/routes/facturacion.js` (~línea 869) *(nuevo)*
```js
router.get('/facturacion/pagos', async (_req, res) => {
  const items = await scanAll(tables.facturasPagos);
```
Scan completo sin parámetro alguno. Devuelve todos los pagos de todas las facturas de todas las empresas.

---

### 8. Auditoría de identidad leída del body en ~10 rutas — `api/routes/facturacion.js` *(nuevo)*
El módulo tiene el helper `usuarioAuditoria(req)` (línea 219) que prioriza `req.user?.sub` del JWT, pero solo lo usan 2 rutas. El resto lee `usuario_id` / `usuario_nombre` directamente del body:

```js
// anular (línea 607), eliminar (647), duplicar (696), rectificar (781), pagos (~930)...
const { motivo, usuario_id, usuario_nombre } = req.body || {};
```

**Impacto:** Un usuario puede auditar acciones a nombre de otro sin que el sistema lo detecte. La trazabilidad fiscal queda comprometida.

**Corrección sugerida:** Reemplazar todas las lecturas directas de body por `usuarioAuditoria(req)`.

---

## 🟠 BUGS MEDIOS PERSISTENTES

### 9. `PUT /cajas/movimientos` crea registros silenciosamente si SK no existe *(sin corregir desde 30-06)*
**Archivo:** `api/routes/movimientosCaja.js` (líneas 140-150)

### 10. `LineaIndex` ordenado como string — `api/routes/pedidos.js` (líneas 658, 678) *(sin corregir)*
Con 10+ líneas, `"10"` ordena antes que `"9"`.

### 11. `resolveTotalAportacionUnitaria` hace `ScanCommand` completo — `api/lib/pedidos/rappelAcuerdo.js` *(sin corregir)*

### 12. `GET /cajas/movimientos/justificante-url` sin validación de pertenencia *(sin corregir)*

### 13. `DELETE /cajas/movimientos` sin validación de pertenencia *(sin corregir)*

### 14. `acuerdos.js` no propaga errores al middleware central *(sin corregir, 3+ semanas)*

---

## 🟡 PROBLEMAS MENORES NUEVOS

### 15. `facturacion.js` — `err.message` expuesto en ~25 endpoints 500 *(nuevo)*
Todos los catch del módulo hacen `res.status(500).json({ error: err.message })` en lugar de `next(err)`. Los mensajes de error de DynamoDB pueden exponer nombres de tablas y estructura interna. El módulo no usa el `errorHandler` central con `requestId`.

### 16. `scanAll` en métricas sin límite temporal *(nuevo)*
**Archivo:** `api/routes/facturacion.js` (~líneas 1114 y 1302)

`GET /facturacion/metricas` y `GET /facturacion/metricas-avanzadas` escanean la tabla completa de facturas (el segundo también la de pagos) y filtran en memoria. Sin ningún GSI de fecha ni guardabarrera, se degradarán linealmente con el volumen.

---

## 🟡 PROBLEMAS MENORES PERSISTENTES

### 17. Auth check confuso en `GET /informes/diario/destinatarios` *(sin corregir desde 15-06)*
### 18. `resolverDestinatarios` provoca scan doble *(sin corregir desde 15-06)*
### 19. `checkAutoSyncs` usa `ScanCommand` en lugar de `QueryCommand` *(sin corregir)*
### 20. `getUserLocales` llamado dos veces en `GET /marketing/propuestas` *(sin corregir)*
### 21. Backend acepta plantillas de franjas con 0 franjas *(sin corregir desde 15-06)*
### 22. Inconsistencia de logger (`console.*` vs pino) en rutas nuevas *(facturacion.js suma ~25 console.error más)*

---

## 📋 Resumen ejecutivo

| # | Archivo | Severidad | Estado |
|---|---------|-----------|--------|
| 1 | facturacion.js (sin requirePermission en ~28 rutas) | 🔴 Alta | **Nuevo** |
| 2 | facturacion.js (GET /facturas sin filtro empresa) | 🔴 Alta | **Nuevo** |
| 3 | pedidos.js (race condition LineaIndex) | 🔴 Alta | Sin corregir (6+ semanas) |
| 4 | marketing.js (imagen-url seguridad) | 🔴 Alta | Sin corregir (6+ semanas) |
| 5 | marketing.js (scanAll sin filtro) | 🔴 Alta | Sin corregir (6+ semanas) |
| 6 | facturacion.js (race condition id_pago) | 🟠 Media | **Nuevo** |
| 7 | facturacion.js (GET /pagos sin filtros) | 🟠 Media | **Nuevo** |
| 8 | facturacion.js (auditoría leída del body) | 🟠 Media | **Nuevo** |
| 9 | movimientosCaja.js (PUT fantasma) | 🟠 Media | Sin corregir (desde 30-06) |
| 10 | pedidos.js (LineaIndex string sort) | 🟠 Media | Sin corregir (6+ semanas) |
| 11 | rappelAcuerdo.js (ScanCommand por línea) | 🟠 Media | Sin corregir (desde 30-06) |
| 12 | movimientosCaja.js (justificante-url pertenencia) | 🟠 Media | Sin corregir (desde 30-06) |
| 13 | movimientosCaja.js (DELETE sin pertenencia) | 🟠 Media | Sin corregir (desde 30-06) |
| 14 | acuerdos.js (no usa errorHandler) | 🟠 Media | Sin corregir (3+ semanas) |
| 15 | facturacion.js (err.message expuesto en 500s) | 🟡 Baja | **Nuevo** |
| 16 | facturacion.js (scanAll en métricas) | 🟡 Baja | **Nuevo** |
| 17-22 | varios (persistentes desde reportes anteriores) | 🟡 Baja | Sin corregir |

**Prioridad inmediata:** El módulo de facturación entra con 4 bugs nuevos de severidad media-alta (#1, #2, #6, #8). El más urgente es el #1: es el único módulo de la API donde operaciones destructivas —incluida anular facturas fiscales ya emitidas— son accesibles a cualquier usuario autenticado sin restricción de permiso. Debería quedar protegido antes de que el módulo llegue a usuarios finales.
