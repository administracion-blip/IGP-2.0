# Reporte de Revisión de Código — 2026-06-08

Revisión automática diaria del código fuente. No se ha modificado nada; se listan hallazgos y márgenes de mejora ordenados por severidad.

---

## Estado respecto al reporte anterior (2026-05-25)

Los bugs reportados el 25-05 **siguen sin corregirse**. Se reproducen aquí con prioridad máxima.

---

## 🔴 BUGS / PROBLEMAS REALES

### 1. `PUT /pedidos` crea registros fantasma silenciosamente *(persistente)*
**Archivo:** `api/routes/pedidos.js` (~línea 88 y 238)

`const existing = got.Item || {}` — si el `Id` no existe, `got.Item` es `undefined` y el código crea un pedido nuevo en blanco sin devolver 404. Afecta tanto a pedidos como a líneas.

**Impacto:** Corrupción de datos. Alta prioridad.

---

### 2. Race condition en `LineaIndex` *(persistente)*
**Archivo:** `api/routes/pedidos.js` (~línea 194)

El índice se calcula como `max(existentes) + 1` con un Query previo. Dos POSTs simultáneos al mismo pedido leerán el mismo `maxIdx` y una línea sobreescribirá a la otra (PutCommand sin condición).

**Impacto:** Pérdida silenciosa de líneas en escenarios concurrentes.

---

### 3. `LineaIndex` ordenado como string en lugar de número *(persistente)*
**Archivo:** `api/routes/pedidos.js` (líneas 153 y 173)

`String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))` produce orden incorrecto con más de 9 líneas (`"10" < "9"` alfabéticamente).

**Impacto:** El frontend recibe las líneas en orden erróneo.

---

### 4. `GET /marketing/imagen-url` no valida pertenencia de la clave *(persistente)*
**Archivo:** `api/routes/marketing.js` (~línea 1208)

Solo verifica `key.startsWith('marketing/')`. Cualquier usuario con `marketing.proponer` puede pedir una presigned URL de una clave de otro local (p.ej. `marketing/estilo-local/` ajeno).

**Impacto:** Fuga de imágenes de identidad visual entre locales/empresas.

---

### 5. `scanAllMarketing()` sin filtros en el fallback GSI *(persistente)*
**Archivo:** `api/routes/marketing.js` (~línea 695)

Cuando ningún GSI está listo, se escanea toda la tabla sin FilterExpression. Un gestor sin `id_local` ni `id_empresa` en la query recibe propuestas de todos los locales. Durante el primer arranque (GSIs en CREATING, varios minutos) esto afecta a todas las peticiones.

**Impacto:** Exposición de datos entre empresas durante el período de creación de GSIs.

---

### 6. `acuerdos.js` no propaga errores al middleware central *(nuevo)*
**Archivo:** `api/routes/acuerdos.js` (todas las rutas)

Todas las rutas de acuerdos usan `try/catch` con `console.error` + `res.status(500).json(...)` local, saltándose el `errorHandler` central. Esto significa que errores de AWS (`ResourceNotFoundException`, `ProvisionedThroughputExceededException`) devuelven siempre 500 en lugar del código HTTP correcto que mapea `errorHandler`. A diferencia de `marketing.js`, que sí usa `throw` y deja que el middleware gestione.

**Impacto:** Respuestas de error incorrectas para clientes; errores de DynamoDB no se traducen al código HTTP apropiado.

---

## 🟡 PROBLEMAS MENORES / INCONSISTENCIAS

### 7. `getUserLocales` se llama dos veces en `GET /marketing/propuestas` *(nuevo)*
**Archivo:** `api/routes/marketing.js` (~líneas 623 y 706)

Para usuarios sin `marketing.gestionar`, `getUserLocales(userId)` se llama una primera vez en la validación inicial y una segunda como "salvaguarda" al final del filtrado en memoria. Ambas hacen el mismo Get a DynamoDB con el mismo `userId`. La segunda llamada es innecesaria porque la primera ya garantizó que el `id_local` pertenece al usuario.

**Impacto:** Latencia y coste innecesario; una llamada extra a DynamoDB por cada request.

---

### 8. Condición duplicada en el selector de GSI *(nuevo)*
**Archivo:** `api/routes/marketing.js` (~línea 632)

```js
if (idLocalQ && (estado || !fechaDesde) && isMarketingLocalEstadoReady() && (estado || !fechaDesde))
```

La subcondición `(estado || !fechaDesde)` aparece dos veces. No produce un bug funcional, pero es señal de que la lógica de selección de índice podría refactorizarse para ser más legible y evitar futuros errores al modificarla.

---

### 9. `checkAutoSyncs` usa `ScanCommand` donde debería usar `QueryCommand` *(persistente)*
**Archivo:** `api/lib/jobs/scheduledTasks.js` (~línea 57)

Se ejecuta cada 60 segundos con `ScanCommand` + `FilterExpression: 'PK = :pk'`. Dado que `PK`/`SK` son las claves de la tabla `Igp_Ajustes`, sería correcto usar `QueryCommand` con `KeyConditionExpression: 'PK = :pk'` — más eficiente y semánticamente correcto.

---

### 10. Inconsistencia en el logger (`console.*` vs `pino`) *(persistente)*
**Archivos:** `api/routes/acuerdos.js` (21 ocurrencias), `api/routes/facturacion.js` (29), `api/routes/agora.js` (16), y otros.

Los módulos más recientes (`marketing.js`, `personal.js`) usan `req.log` (pino estructurado). Los más antiguos siguen con `console.error/warn/log`. Los logs de consola no llevan `requestId` ni correlación, lo que dificulta el debugging en producción.

---

### 11. `DELETE /pedidos` — Id en body en lugar de params *(persistente)*
**Archivo:** `api/routes/pedidos.js` (~línea 111)

Diseño no estándar REST; algunos clientes HTTP ignoran el body en DELETE. Menor riesgo pero puede causar problemas con proxies o caches HTTP.

---

## 📋 Resumen ejecutivo

| # | Archivo | Severidad | Estado |
|---|---------|-----------|--------|
| 1 | pedidos.js | 🔴 Alta | Sin corregir |
| 2 | pedidos.js | 🔴 Alta | Sin corregir |
| 3 | pedidos.js | 🟠 Media | Sin corregir |
| 4 | marketing.js | 🔴 Alta | Sin corregir |
| 5 | marketing.js | 🔴 Alta | Sin corregir |
| 6 | acuerdos.js | 🟠 Media | **Nuevo** |
| 7 | marketing.js | 🟡 Baja | **Nuevo** |
| 8 | marketing.js | 🟡 Baja | **Nuevo** |
| 9 | scheduledTasks.js | 🟡 Baja | Sin corregir |
| 10 | múltiples routes | 🟡 Baja | Sin corregir |
| 11 | pedidos.js | 🟡 Baja | Sin corregir |

**Los bugs 1–5 llevan al menos dos semanas sin corregirse. Los puntos 4 y 5 tienen implicaciones de seguridad/privacidad entre locales.**
