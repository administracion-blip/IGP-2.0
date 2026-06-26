# Reporte de Revisión de Código — 2026-06-15

Revisión automática diaria. Sin modificaciones al código; solo hallazgos y márgenes de mejora ordenados por severidad.

---

## Estado respecto al reporte anterior (2026-06-08)

Los bugs reportados el 08-06 **siguen sin corregirse**. Se reproducen a continuación con prioridad máxima.

No hay commits nuevos desde 2026-05-23. Los cambios activos son ficheros modificados sin commitar, más un bloque de ficheros nuevos no trackeados que corresponden al nuevo módulo de **Informe Diario** (`api/routes/informes.js`, `api/lib/informes/`, `api/lib/email.js`) y al módulo de **Franjas Horarias / Cajas → Top** (`app/(app)/cajas/franjas-horarias.tsx`, `app/(app)/cajas/top.tsx`, `app/lib/ventasPorHoraApi.ts`).

---

## 🔴 BUGS PERSISTENTES (sin corregir desde reportes anteriores)

### 1. `PUT /pedidos` crea registros fantasma silenciosamente
**Archivo:** `api/routes/pedidos.js` (líneas 88 y 238)

`const existing = got.Item || {}` — si el `Id` no existe, `got.Item` es `undefined` y el PUT crea un pedido/línea en blanco sin devolver 404.

**Impacto:** Corrupción de datos. Alta prioridad.

---

### 2. Race condition en `LineaIndex`
**Archivo:** `api/routes/pedidos.js` (~línea 194)

El índice se calcula como `max(existentes) + 1` con un Query previo. Dos POSTs simultáneos al mismo pedido producirán el mismo `maxIdx` y una línea sobreescribirá a la otra (PutCommand sin condición).

**Impacto:** Pérdida silenciosa de líneas en escenarios concurrentes.

---

### 3. `LineaIndex` ordenado como string en lugar de número
**Archivo:** `api/routes/pedidos.js` (líneas 153 y 173)

`String(a.LineaIndex ?? '').localeCompare(...)` produce orden incorrecto con más de 9 líneas (`"10" < "9"` alfabéticamente).

**Impacto:** El frontend recibe las líneas en orden erróneo.

---

### 4. `GET /marketing/imagen-url` no valida pertenencia de clave
**Archivo:** `api/routes/marketing.js` (~línea 1208)

Solo verifica `key.startsWith('marketing/')`. Un usuario con `marketing.proponer` puede pedir una presigned URL de una clave de otro local.

**Impacto:** Fuga de imágenes entre locales/empresas. Seguridad.

---

### 5. `scanAllMarketing()` sin filtros en fallback GSI
**Archivo:** `api/routes/marketing.js` (~línea 695)

Cuando ningún GSI está listo, se escanea toda la tabla sin `FilterExpression`. Un gestor sin `id_local` ni `id_empresa` recibe propuestas de todos los locales.

**Impacto:** Exposición de datos entre empresas durante arranque o re-creación de GSIs.

---

### 6. `acuerdos.js` no propaga errores al middleware central
**Archivo:** `api/routes/acuerdos.js` (todas las rutas)

Usa `try/catch` + `res.status(500).json(...)` local, saltándose el `errorHandler` central. Errores de AWS devuelven siempre 500 en lugar del código HTTP correcto.

---

## 🟠 BUGS NUEVOS (módulos añadidos desde el último reporte)

### 7. Backend acepta plantillas de franjas con 0 franjas
**Archivo:** `api/routes/agora.js` (`POST /agora/franjas-plantillas`, línea 3510)

`normalizarFranjas([])` devuelve `[]` (no `null`), por lo que la validación `if (franjas == null)` no dispara. Un cliente puede crear una plantilla vacía llamando directamente a la API, saltándose la validación del frontend (`franjas-horarias.tsx` línea 128).

**Corrección sugerida:** añadir `if (franjas.length === 0) return res.status(400).json({ error: 'La plantilla debe tener al menos una franja' });` tras la validación de `normalizarFranjas`.

---

### 8. `GET /informes/diario/destinatarios` provoca un scan doble innecesario
**Archivo:** `api/routes/informes.js` (línea 194)

```js
const destinatarios = await resolverDestinatarios({ rolesPermitidos: config.roles });
// ↑ no pasa mapaLocales → resolverDestinatarios llama internamente a cargarMapaLocales()
```

El endpoint `/enviar` (línea 70) sí pasa `mapaLocales` correctamente. El endpoint `/destinatarios` lanza dos `scanAll` extra por cada llamada (una de locales, otra ya incluida de usuarios), siendo este endpoint el que se usa para previsualizar destinatarios en Ajustes con cada recarga de pantalla.

**Corrección sugerida:** Añadir `const mapaLocales = await cargarMapaLocales();` antes de la llamada y pasarlo como parámetro.

---

### 9. Auth check confuso en `GET /informes/diario/destinatarios`
**Archivo:** `api/routes/informes.js` (línea 189)

```js
if (req.user && req.user.rol !== 'Administrador') { ... 403 ... }
```

Para rutas GET, `requireAuth` siempre establece `req.user` (el bypass de `X-Internal-Secret` solo aplica a POST). La guarda `req.user &&` es innecesaria y sugiere que si `req.user` es `undefined` (algo que no puede ocurrir hoy en GET) el 403 se silencia y cualquiera pasaría. Es una deuda de legibilidad que puede convertirse en bug si en el futuro este path se añade a `INTERNAL_SYNC_POST_PATHS`.

**Corrección sugerida:** Simplificar a `if (!req.user || req.user.rol !== 'Administrador')` para mayor claridad y seguridad defensiva.

---

## 🟡 PROBLEMAS MENORES / INCONSISTENCIAS (persistentes)

### 10. `getUserLocales` se llama dos veces en `GET /marketing/propuestas`
**Archivo:** `api/routes/marketing.js` (~líneas 623 y 706)

Dos llamadas a DynamoDB con el mismo `userId` por request. La segunda es superflua.

---

### 11. Condición duplicada en el selector de GSI
**Archivo:** `api/routes/marketing.js` (~línea 632)

`(estado || !fechaDesde)` aparece dos veces en la misma condición `if`.

---

### 12. `checkAutoSyncs` usa `ScanCommand` en lugar de `QueryCommand`
**Archivo:** `api/lib/jobs/scheduledTasks.js` (~línea 57)

Se ejecuta cada 60 segundos con `ScanCommand + FilterExpression: 'PK = :pk'`. Dado que `PK` es clave primaria de `Igp_Ajustes`, debería ser un `QueryCommand`.

---

### 13. Inconsistencia en el logger (`console.*` vs `req.log`/pino)
**Archivos:** `api/routes/acuerdos.js`, `api/routes/facturacion.js`, `api/routes/agora.js` (nuevo endpoint `sales-by-hour`, línea 3619), y otros.

Los módulos más antiguos y algunos nuevos siguen usando `console.warn/error`. Impide correlacionar errores con `requestId` en producción.

---

### 14. `DELETE /pedidos` — Id en body en lugar de params
**Archivo:** `api/routes/pedidos.js` (~línea 111)

Diseño no estándar REST; algunos proxies y clientes HTTP ignoran el body en DELETE.

---

### 15. `pdfInformeDiario.js` — color de desvío en euros derivado de `variacionPctTotal`
**Archivo:** `api/lib/informes/pdfInformeDiario.js` (línea 112)

En la tabla de resumen (KPIs), la columna de desvío en euros (índice 2) se colorea usando `datos.variacionPctTotal`. Si `variacionPctTotal` es `null` (no hay comparativa), la columna queda sin color aunque el desvío en euros tenga valor. Imprecisión visual menor; considerar derivar el color del signo del propio desvío.

---

## 📋 Resumen ejecutivo

| # | Archivo | Severidad | Estado |
|---|---------|-----------|--------|
| 1 | pedidos.js | 🔴 Alta | Sin corregir (3+ semanas) |
| 2 | pedidos.js | 🔴 Alta | Sin corregir (3+ semanas) |
| 3 | pedidos.js | 🟠 Media | Sin corregir (3+ semanas) |
| 4 | marketing.js | 🔴 Alta | Sin corregir (3+ semanas) |
| 5 | marketing.js | 🔴 Alta | Sin corregir (3+ semanas) |
| 6 | acuerdos.js | 🟠 Media | Sin corregir (1 semana) |
| 7 | agora.js | 🟠 Media | **Nuevo** |
| 8 | informes.js | 🟡 Baja | **Nuevo** |
| 9 | informes.js | 🟡 Baja | **Nuevo** |
| 10 | marketing.js | 🟡 Baja | Sin corregir |
| 11 | marketing.js | 🟡 Baja | Sin corregir |
| 12 | scheduledTasks.js | 🟡 Baja | Sin corregir |
| 13 | múltiples routes | 🟡 Baja | Sin corregir |
| 14 | pedidos.js | 🟡 Baja | Sin corregir |
| 15 | pdfInformeDiario.js | 🟡 Baja | **Nuevo** |

**Los bugs 1–5 llevan más de 3 semanas sin corregirse. Los puntos 4 y 5 tienen implicaciones de seguridad entre locales/empresas y son los más urgentes.**
