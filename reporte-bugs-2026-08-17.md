# Reporte de Revisión de Código — 2026-08-17

Revisión automática diaria. Sin modificaciones al código; solo hallazgos y márgenes de mejora ordenados por severidad.

---

## Estado respecto al reporte anterior (2026-08-10)

Hay **2 commits nuevos** desde el último reporte:
- `8ced044` (13.08): solo toca `Notas.md`.
- `450ba73` (04.08, incluido en el reporte anterior como "nuevo"): introduce el módulo de **conciliación albarán ↔ factura** (`api/lib/facturacion/albaranesConciliados.js`, `api/routes/facturacion.js` ampliado, `app/(app)/compras/conciliacion-facturas.tsx` ~2.600 líneas, `app/lib/conciliacionAsignacion.ts`).

---

## CORRECCIONES CONFIRMADAS DESDE EL ÚLTIMO REPORTE

### ✅ Bug #2 (ALTA) — facturacion.js sin `requirePermission` en ~26 rutas
**Corregido.** Todas las rutas del módulo de facturación tienen ahora `requirePermission` o `requireAnyPermission`. El bug más antiguo del proyecto ya no existe.

---

## BUGS CRÍTICOS PERSISTENTES

### 1. `GET /personal/cuadrante` — sin `requirePermission` ni validación de pertenencia
**Archivo:** `api/routes/cuadrante.js` (línea 38) — **sin corregir desde el reporte de 2026-08-10.**

La ruta está detrás del `requireAuth` global (line 192, `server.js`), así que sí exige token. Pero no lleva `requirePermission` y no cruza los `local_ids` recibidos con los locales del usuario autenticado. Cualquier empleado puede pasar el ID de cualquier local y ver turnos y fichajes de personal ajeno.

**Corrección sugerida:** añadir `requirePermission('personal.cuadrante')` y filtrar `localIds` con `getUserLocales(req.user.sub)` antes de llamar a `obtenerCuadrantePorLocales`.

---

### 2. `PUT /facturacion/facturas/:id` — auditoría usa `body.usuario_id`
**Archivo:** `api/routes/facturacion.js`, líneas 648 y 653.

Esta ruta ya tiene `requirePermission` y usa `usuarioAuditoria(req)` para otras operaciones, pero el campo `modificado_por` y la llamada a `registrarAuditoria` siguen leyendo directamente de `body.usuario_id` / `body.usuario_nombre`. Un cliente puede implantar la identidad de otro usuario en el registro de auditoría.

```js
// línea 648 (problema)
factura.modificado_por = body.usuario_id || factura.modificado_por;
await registrarAuditoria(id, 'modificacion', body.usuario_id, body.usuario_nombre, changes);
```

**Corrección sugerida:** reemplazar las dos líneas con los valores de `usuarioAuditoria(req)`.

---

### 3. Rutas con `usuario_id`/`usuario_nombre` leídos del body — 8 rutas pendientes
**Archivo:** `api/routes/facturacion.js`

El helper `usuarioAuditoria(req)` existe y se usa correctamente en varias rutas, pero las siguientes 8 siguen destructurando del body:

| Línea | Ruta |
|-------|------|
| 734 | `POST /facturacion/facturas/:id/anular` |
| 777 | `DELETE /facturacion/facturas/:id` |
| 829 | `POST /facturacion/facturas/:id/duplicar` |
| 917 | `POST /facturacion/facturas/:id/rectificar` |
| 1350 | `PUT /facturacion/pagos/:id_factura/:id_pago` |
| 1556 | `POST /facturacion/facturas/:id/enviar-email` |
| 1968 | `POST /facturacion/ocr/confirmar` |
| 2908 | `POST /facturacion/registro-masivo` |

Y dos líneas adicionales en la gestión de adjuntos (líneas 1909 y 1919).

**Nota sobre el propio helper:** `usuarioAuditoria()` también tiene un fallback problemático. Para `usuario_nombre` prioriza `req.user?.Nombre`, pero `Nombre` puede no existir en el JWT y cae a `body.usuario_nombre`. Para `usuario_id` prioriza `req.user?.sub` correctamente, pero añade `|| body.usuario_id` como fallback innecesario en rutas siempre autenticadas.

---

### 4. `GET /marketing/imagen-url` — sin validación de pertenencia
**Archivo:** `api/routes/marketing.js` (línea ~1274) — sin corregir desde reporte anterior.

Solo valida que la `key` empiece por `marketing/`. Cualquier usuario con `marketing.proponer` puede obtener una URL firmada de S3 para cualquier imagen del módulo (incluidas las de otros locales o imágenes finales aprobadas por gestores).

**Corrección sugerida:** verificar que la clave referenciada pertenece a un local del usuario, o restringir `marketing/final/` y `marketing/estilo-local/` a `marketing.gestionar`.

---

### 5. `scanAllMarketing()` sin filtros en el fallback — cross-local para gestores
**Archivo:** `api/routes/marketing.js` — sin corregir desde reporte anterior.

Cuando ningún GSI está listo y `esGestor=true` sin `id_empresa`, `scanAllMarketing()` devuelve todas las propuestas de todos los locales/empresas sin restricción. Un gestor ve propuestas de empresas a las que no debería acceder.

---

## BUGS NUEVOS (commit 04.08 — módulo conciliación)

### 6. `PUT /facturacion/facturas/:id/albaranes-conciliados` — sin bloqueo optimista
**Archivo:** `api/routes/facturacion.js` (línea ~1808) + `app/(app)/compras/conciliacion-facturas.tsx` (línea ~1066)

La ruta reemplaza el array completo de `albaranes_conciliados` sin ningún mecanismo de versión o `ConditionExpression`. Si dos usuarios editan la conciliación de la misma factura simultáneamente, el segundo `PUT` sobrescribe silenciosamente el trabajo del primero.

El frontend (`persistirAlbaranesFactura`) también confirma que no envía ningún token de versión al backend.

**Corrección sugerida:** añadir un campo `version` al ítem DynamoDB, enviarlo en el body, y usar `ConditionExpression: '#v = :expected'` en el `UpdateCommand`. Devolver 409 si hay conflicto.

---

### 7. `POST /marketing/carteles-musico/generar` — Scan completo de actuaciones
**Archivo:** `api/routes/marketing.js` (línea ~1125)

Carga la tabla `tables.actuaciones` completa en memoria y filtra por `id_local` y rango de fechas a posteriori. Además, para cada actuación resultante hace un `GetCommand` individual a `tables.artistas` (N+1 secuencial, aunque tiene caché en memoria para el mismo `id_artista`). Escalará mal con el volumen de actuaciones.

**Corrección sugerida:** añadir un GSI `id_local + fecha` a la tabla de actuaciones (el mismo patrón ya sugerido para `ratiosDiaLocal`).

---

## BUGS MEDIOS PERSISTENTES (sin corrección, desde reportes anteriores)

### 8. Race condition en `id_pago` — `facturacion.js` (~línea 926)
### 9. `GET /facturacion/pagos` sin filtros — `facturacion.js` (~línea 869)
### 10. `GET /facturacion/facturas` sin filtro por empresa — `facturacion.js` (~línea 333)
### 11. `PUT /cajas/movimientos` crea registros si SK no existe — `movimientosCaja.js`
### 12. Race condition en `LineaIndex` — `pedidos.js`
### 13. `resolveTotalAportacionUnitaria` hace Scan completo — `rappelAcuerdo.js`
### 14. `GET /cajas/movimientos/justificante-url` sin validación de pertenencia
### 15. `DELETE /cajas/movimientos` sin validación de pertenencia
### 16. `acuerdos.js` no propaga errores al middleware central

---

## PROBLEMAS MENORES

### 17. `ratiosDiaLocal.js` — Scan completo de pedidos y actuaciones por informe IA
Sin cambios respecto al reporte anterior.

### 18. `err.message` expuesto en 168 respuestas 500
`res.status(500).json({ error: err.message })` aparece 168 veces en las rutas. En producción esto filtra detalles internos (nombres de tablas DynamoDB, paths de ficheros, mensajes de AWS). El middleware `errorHandler.js` ya sanitiza, pero estas respuestas lo cortocircuitan devolviéndolas antes.

### 19. `console.*` vs pino en rutas antiguas
Varias rutas (incluyendo `cuadrante.js` línea ~50) usan `console.error` en lugar del logger pino (`req.log`). Los errores no aparecen en el flujo estructurado de logs.

### 20. `conciliacion-facturas.tsx` — 2.671 líneas en un solo componente
El fichero ya supera las 2.600 líneas con múltiples responsabilidades (carga de datos, lógica de negocio de conciliación, UI de tres paneles). No es un bug funcional, pero aumenta el riesgo de regresiones en futuras ediciones y dificulta el testing.

---

## Resumen ejecutivo

| # | Archivo | Severidad | Estado |
|---|---------|-----------|--------|
| 1 | cuadrante.js (sin requirePermission ni ownership) | ALTA | Sin corregir (2+ sem.) |
| 2 | facturacion.js (PUT factura usa body para auditoría) | ALTA | Sin corregir |
| 3 | facturacion.js (8 rutas con body.usuario_id) | MEDIA | Parcial (4 de 12 fijadas) |
| 4 | marketing.js (imagen-url sin ownership) | ALTA | Sin corregir (3+ sem.) |
| 5 | marketing.js (scanAll sin filtro) | ALTA | Sin corregir (3+ sem.) |
| 6 | facturacion.js (albaranes-conciliados sin optimistic lock) | MEDIA | **Nuevo** |
| 7 | marketing.js (carteles-musico Scan + N+1) | BAJA | **Nuevo** |
| 8–16 | varios (race conditions, scans, ownership cajas) | MEDIA | Sin corregir |
| 17–20 | varios (scalability, logging, componente largo) | BAJA | Sin corregir |

**Prioridad inmediata:**
1. **Bug #1** (cuadrante) — expone datos de RRHH, fix de 5 líneas, lleva 2 semanas abierto.
2. **Bug #2** (PUT factura, auditoría del body) — 2 líneas a reemplazar con `usuarioAuditoria(req)`.
3. **Bug #6** (albaranes-conciliados sin lock) — módulo nuevo en producción, riesgo de sobrescritura silenciosa.
