# Reporte de Revisión de Código — 2026-08-10

Revisión automática diaria. Sin modificaciones al código; solo hallazgos y márgenes de mejora ordenados por severidad.

---

## Estado respecto al reporte anterior (2026-07-29)

Hay **1 commit nuevo** desde el último reporte: `a115f42` (04.08.2026). Es el commit más voluminoso del proyecto hasta la fecha: **11.359 líneas añadidas en 58 ficheros**. Incorpora el módulo de refacturación completo (`api/routes/refacturacion.js`, `api/lib/facturacion/refacturacionCalculo.js`), el motor IA «día a día» (`api/lib/ia/motores/diaADia.js`, `api/lib/ia/ratiosDiaLocal.js`, `api/lib/ia/mantenimientoDia.js`), el servicio de cuadrante de personal (`api/lib/personal/cuadranteServicio.js`), las vistas frontend de refacturación y el componente `VistaDiaADia.tsx` (2.070 líneas).

---

## CORRECCIONES CONFIRMADAS DESDE EL ÚLTIMO REPORTE

### Bug #8 (parcial) — `usuarioAuditoria(req)` ya se usa en 2 rutas
El helper fue añadido y se aplica en `POST /facturacion/facturas/validar-revision` (línea 608) y `POST /facturacion/facturas/:id/emitir` (línea 646). Ambas leen la identidad desde el token JWT. Las otras 10 rutas siguen leyendo del body.

---

## BUGS CRÍTICOS NUEVOS

### 1. `GET /personal/cuadrante` — sin control de permisos ni validación de pertenencia
**Archivo:** `api/routes/cuadrante.js` (línea 38)

La nueva ruta no lleva `requirePermission`. Cualquier usuario autenticado puede pasarle cualquier combinación de `local_ids` y obtendrá los turnos planificados (Factorial) y fichajes reales de esos locales. La función `obtenerCuadrantePorLocales` no verifica que los locales pedidos correspondan al usuario.

**Impacto:** Un usuario de un local puede consultar el cuadrante y fichajes de empleados de cualquier otro local de la empresa.

**Corrección sugerida:** Añadir `requirePermission('personal.cuadrante')` y cruzar `localIds` con `getUserLocales(req.user)` antes de llamar al servicio.

---

## BUGS CRÍTICOS PERSISTENTES (sin corregir, 9+ semanas)

### 2. `facturacion.js` — Sin `requirePermission` en ~26 rutas de escritura
Las rutas más destructivas del módulo siguen sin protección: anular, eliminar, duplicar, rectificar, registrar y editar pagos, enviar email, recordatorios, adjuntos, OCR/confirmar y operaciones de series. Solo `validar-revision` y `emitir` están protegidas. Líneas afectadas: 271, 298, 318, 378, 441, 664, 704, 753, 838, 1033, 1139, 1239, 1439, 1646, 1683, 1762, 1853, 1887, 1900, 1973, 2686, 2852, 2906.

### 3. `GET /facturacion/facturas` sin filtro por local/empresa
**Archivo:** `api/routes/facturacion.js` (~línea 333). Escanea la tabla completa sin restricción por empresa. Sin cambios en el último commit.

### 4. Race condition en `LineaIndex` — `api/routes/pedidos.js`
Sin cambios.

### 5. `GET /marketing/imagen-url` sin validación de pertenencia
Sin cambios.

### 6. `scanAllMarketing()` sin filtros en fallback GSI
Sin cambios.

---

## BUGS MEDIOS NUEVOS

### 7. `GET /refacturacion/lineas` sin empresa filtra todas las sociedades
**Archivo:** `api/routes/refacturacion.js` (líneas 252-278)

Cuando la petición omite `empresa_destino_id`, `scanLineasFiltradas()` hace un `ScanCommand` completo sobre `Igp_Refacturaciones` sin verificar que el usuario tenga acceso a las sociedades devueltas. Aunque la ruta exige `requirePermission('refacturacion.ver')`, cualquier usuario con ese permiso ve líneas de refacturación de todas las empresas.

### 8. Auditoría de identidad del body — 10 rutas aún pendientes
El helper `usuarioAuditoria(req)` existe pero solo se aplica en 2 rutas. Las siguientes 10 siguen leyendo `usuario_id` y `usuario_nombre` del body (un cliente puede implantar otra identidad en la auditoría):

- `PUT /facturacion/facturas/:id` — líneas 590 y 595
- `POST /facturacion/facturas/:id/anular` — línea 666
- `DELETE /facturacion/facturas/:id` — línea 706
- `POST /facturacion/facturas/:id/duplicar` — línea 755
- `POST /facturacion/facturas/:id/rectificar` — línea 840
- `PUT /facturacion/pagos/:id_factura/:id_pago` — línea 1241 (indirecta)
- `POST /facturacion/facturas/:id/enviar-email` — línea 1441
- `POST /facturacion/facturas/:id/adjuntos` — línea 1719
- `DELETE /facturacion/facturas/:id/adjuntos/:adjId` — línea 1764
- `POST /facturacion/ocr/confirmar` — línea 2687

El fix es mecánico: reemplazar las destructuraciones de body por `usuarioAuditoria(req)`.

---

## BUGS MEDIOS PERSISTENTES

### 9. Race condition en `id_pago` — `facturacion.js` (~línea 926)
### 10. `GET /facturacion/pagos` sin filtros — `facturacion.js` (~línea 869)
### 11. `PUT /cajas/movimientos` crea registros si SK no existe — `movimientosCaja.js`
### 12. `LineaIndex` ordenado como string en pedidos
### 13. `resolveTotalAportacionUnitaria` hace `ScanCommand` completo — `rappelAcuerdo.js`
### 14. `GET /cajas/movimientos/justificante-url` sin validación de pertenencia
### 15. `DELETE /cajas/movimientos` sin validación de pertenencia
### 16. `acuerdos.js` no propaga errores al middleware central

---

## PROBLEMAS MENORES NUEVOS

### 17. `ratiosDiaLocal.js` — `scanAll` sobre pedidos y actuaciones sin filtro de local
**Archivo:** `api/lib/ia/ratiosDiaLocal.js` (líneas 164, 218)

`gastoPedidosPorLocal()` y `gastoActuacionesPorLocal()` cargan las tablas completas de pedidos y actuaciones en memoria y filtran por local después. Se llaman con cada generación de informe IA. Escalarán linealmente con el volumen.

**Corrección sugerida:** GSI de fecha+local y cambiar scans por queries.

---

## PROBLEMAS MENORES PERSISTENTES

### 18-25. Varios (err.message en 500s, scanAll en métricas, auth check confuso en informes, resolverDestinatarios doble scan, checkAutoSyncs, getUserLocales doble llamada en marketing, plantillas 0 franjas, console.* vs pino)

---

## Resumen ejecutivo

| # | Archivo | Severidad | Estado |
|---|---------|-----------|--------|
| 1 | cuadrante.js (GET /personal/cuadrante sin permisos ni ownership) | ALTA | Nuevo |
| 2 | facturacion.js (sin requirePermission en ~26 rutas) | ALTA | Sin corregir (9+ sem.) |
| 3 | facturacion.js (GET /facturas sin filtro empresa) | ALTA | Sin corregir (9+ sem.) |
| 4 | pedidos.js (race condition LineaIndex) | ALTA | Sin corregir (9+ sem.) |
| 5 | marketing.js (imagen-url seguridad) | ALTA | Sin corregir (9+ sem.) |
| 6 | marketing.js (scanAll sin filtro) | ALTA | Sin corregir (9+ sem.) |
| 7 | refacturacion.js (GET /lineas sin empresa → cross-company) | MEDIA | Nuevo |
| 8 | facturacion.js (auditoría del body — 10 rutas pendientes) | MEDIA | Parcial (2 de 12 fijadas) |
| 9 | facturacion.js (race condition id_pago) | MEDIA | Sin corregir (desde 29-07) |
| 10 | facturacion.js (GET /pagos sin filtros) | MEDIA | Sin corregir (desde 29-07) |
| 11–16 | movimientosCaja, rappelAcuerdo, acuerdos (varios) | MEDIA | Sin corregir |
| 17 | ratiosDiaLocal.js (scanAll pedidos + actuaciones) | BAJA | Nuevo |
| 18–25 | varios | BAJA | Sin corregir |

**Prioridad inmediata:** El bug #1 (cuadrante sin permisos) es el más urgente del commit 04.08 — expone datos de RRHH sensibles y el fix es 5 líneas. Los bugs #2 y #3 de facturacion llevan 9 semanas abiertos; conviene resolverlos antes del primer despliegue real del módulo de facturación.
