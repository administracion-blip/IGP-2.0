# Reporte de revisión de código — 2026-05-18

Revisión automática diaria del repositorio `ipg2.0`. Se analizaron todos los archivos fuente del backend (`api/`) y frontend (`app/`) excluyendo `node_modules` y `dist`.

---

## 🔴 Bugs confirmados

### 1. `api/routes/closeouts.js` no está registrado en `server.js` → código muerto

El archivo `api/routes/closeouts.js` existe y define un conjunto completo de rutas CRUD (`GET /agora/closeouts`, `POST`, `PUT`, `DELETE`, totales por local, etc.), pero **no se importa ni se monta en `server.js`**. Las rutas de cierre de caja que sí están activas son las definidas dentro de `api/routes/agora.js`.

Esto significa que cualquier cambio hecho en `closeouts.js` no tiene efecto en producción, y el archivo puede dar una falsa sensación de que las rutas están separadas cuando en realidad no lo están.

**Opciones:** eliminar el archivo si es duplicado de agora.js, o importarlo y reemplazar las rutas equivalentes en agora.js.

---

### 2. Doble llamada a `getUserLocales` por request en `GET /marketing/propuestas`

Cuando el usuario **no tiene** el permiso `marketing.gestionar`, la ruta llama a `getUserLocales(userId)` dos veces en el mismo request:

- Primera vez: para validar que el usuario tiene acceso al local solicitado.
- Segunda vez: como "segunda salvaguarda" al final del handler para filtrar los resultados.

El resultado de la primera llamada se descarta y se vuelve a hacer el mismo Get a DynamoDB. Basta con guardar el resultado en una variable y reutilizarlo.

```js
// Situación actual (simplificado):
const userLocales = await getUserLocales(userId);  // llamada 1
if (!userLocales.includes(idLocalQ)) throw forbidden(...);
// ... lógica de consulta ...
const userLocales = await getUserLocales(userId);  // llamada 2 (innecesaria)
items = items.filter(...);
```

---

### 3. `checkAutoSyncs` usa `ScanCommand` con `FilterExpression` sobre la clave de partición

En `api/lib/jobs/scheduledTasks.js`, la función `checkAutoSyncs` hace:

```js
new ScanCommand({
  TableName: tableAjustesName,
  FilterExpression: 'PK = :pk AND Enabled = :e',
  ExpressionAttributeValues: { ':pk': 'sincronizaciones', ':e': true },
})
```

`FilterExpression` en un `Scan` **no reduce las unidades de lectura consumidas** — DynamoDB lee toda la tabla y luego filtra en memoria. Para la clave de partición hay que usar `QueryCommand` con `KeyConditionExpression`. Este scheduler se ejecuta cada 60 segundos, así que el consumo de RCUs innecesario se acumula.

**Corrección:** reemplazar `ScanCommand` por `QueryCommand` con `KeyConditionExpression: 'PK = :pk'` y mover `Enabled = :e` a `FilterExpression` del Query (que sí reduce el set de ítems procesados).

---

### 4. `console.log` en rutas de producción (agora.js)

El archivo `api/routes/agora.js` contiene al menos **8 llamadas a `console.log`** en lógica de negocio (sync de closeouts, full-sync, purchases/sync). El proyecto ya tiene un logger estructurado (`pino`) configurado y disponible via `import { logger }`. Los `console.log` no emiten JSON estructurado, no tienen nivel de log configurable y se escapan de los sistemas de agregación.

Afectados: líneas ~2087, 2119, 2200, 2295, 2333, 2340, 2609, 3038.

---

### 5. `console.error` en lugar del logger estructurado en `acuerdos.js` y `facturacion.js`

El archivo `api/routes/acuerdos.js` usa `console.error` en **al menos 22 puntos** de manejo de errores. Lo mismo ocurre en varios catch blocks de `facturacion.js`. Estos errores no aparecen en los logs estructurados de pino y no tienen correlación de request-id.

---

## 🟡 Problemas de diseño / comportamiento potencialmente incorrecto

### 6. Múltiples consultas DynamoDB por request en el módulo Marketing

Para cada request al módulo de marketing que requiera saber si el usuario es gestor, se producen al menos **3 consultas DB encadenadas**:

1. `requirePermission('marketing.proponer')` → Get a `Igp_RolesPermisos`
2. `hasGestionPermission(req)` → Get a `Igp_RolesPermisos` (mismo usuario, permiso diferente)
3. `getUserLocales(userId)` → Get a `igp_usuarios`

Sería más eficiente combinar los pasos 1 y 2 en una sola Query (que devuelva todos los permisos del rol de una vez) y cachear el resultado de locales dentro del handler.

---

### 7. `localPermitido()` en `AuthContext` retorna `true` cuando `user.Locales` está vacío

```typescript
if (!user.Locales || user.Locales.length === 0) return true;
```

Un usuario sin locales asignados **tiene acceso a todos los locales**. Esto puede ser intencional (usuario sin restricción de local), pero el nombre del campo `Locales` vacío como "sin restricción" es semánticamente opaco y no está documentado en el tipo. Si en algún momento un nuevo usuario se crea sin asignar locales, tiene acceso total sin que sea obvio.

---

### 8. `syncLastRun` es estado en memoria — se pierde al reiniciar el servidor

```js
const syncLastRun = {};  // reinicia con el proceso
```

Si el servidor se reinicia durante el día, el scheduler volvería a ejecutar todas las sincronizaciones que ya corrieron ese día, potencialmente enviando datos duplicados o sobrescribiendo registros. Para robustez, el estado de última ejecución debería persistirse en DynamoDB (en la misma tabla `Igp_Ajustes`), que además ya se actualiza con `UltimaSync` al final de cada ejecución — bastaría leer ese campo al inicio en lugar de usar la variable en memoria.

---

### 9. CORS en producción: si `CORS_ALLOWED_ORIGINS` no está definido, se usan orígenes de desarrollo

En `server.js`, si `NODE_ENV=production` pero la variable de entorno `CORS_ALLOWED_ORIGINS` está vacía, el servidor emite un `logger.warn` pero **sigue aceptando peticiones desde `localhost:8084` y `localhost:3002`**. Aunque en producción esto raramente es un vector de ataque real, un despliegue sin esa variable configurada pasaría desapercibido.

---

### 10. `Alert.prompt` en Android no tiene implementación

En `app/(app)/rrss/propuesta/[id].tsx`, la función `promptInput` usa `Alert.prompt` para pedir el comentario de rechazo:

```typescript
Alert.prompt?.(titulo, mensaje, [...], 'plain-text');
```

`Alert.prompt` **solo existe en iOS**. En Android, `Alert.prompt` es `undefined`, y el optional chaining (`?.`) hace que el `Promise` nunca se resuelva (ni se rechace). El flujo quedaría bloqueado silenciosamente en Android cuando un gestor intente rechazar una propuesta desde un dispositivo Android.

**Corrección:** implementar un modal propio con `TextInput` para el comentario, o usar una librería cross-platform.

---

## 🟢 Mejoras menores sugeridas

- **`api/routes/auth.js` login**: en el catch de la migración bcrypt, `req.log.warn(...)` asume que pinoHttp ha añadido `req.log`. Si se reestructura el orden de middlewares en el futuro, esto podría fallar. Sería más robusto usar `(req.log ?? logger).warn(...)`.

- **`api/lib/jobs/scheduledTasks.js` — `SYNC_CLOSEOUTS_ENABLED`**: la variable booleana se lee de `process.env.SYNC_CLOSEOUTS_ENABLED === 'true'`, lo que significa que cualquier otro valor (incluido `'1'` o `'yes'`) la deja en `false`. Está documentado por convención, pero podría ser más permisivo o al menos emitir un warning si el valor existe pero no es exactamente `'true'`.

- **Módulo Marketing — falta campo `actualizado_en` en PATCH**: el PATCH de propuestas no añade un timestamp de última modificación. Añadir `actualizado_en: new Date().toISOString()` junto con el resto de los updates facilitaría auditoría y ordenación por reciente.

- **`api/routes/marketing.js` — endpoint `GET /marketing/imagen-url` solo valida prefijo `marketing/`**: cualquier usuario con el permiso `marketing.proponer` puede pedir una URL prefirmada de S3 para **cualquier clave bajo `marketing/`**, incluyendo claves de otros locales. Sería más robusto validar que la clave pertenece al local al que el usuario tiene acceso.

---

## Resumen ejecutivo

| Severidad | Nº | Descripción |
|-----------|-----|-------------|
| 🔴 Bug real | 5 | `closeouts.js` dead code, doble getUserLocales, Scan en PK, console.log en producción, console.error en lugar de logger |
| 🟡 Comportamiento cuestionable | 5 | N+3 queries en marketing, localPermitido vacío=true, syncLastRun volátil, CORS en prod, Alert.prompt Android bloqueado |
| 🟢 Mejoras menores | 4 | req.log fallback, SYNC_CLOSEOUTS_ENABLED parsing, campo actualizado_en, validación de clave S3 en imagen-url |

El problema más urgente para corregir es el **`Alert.prompt` en Android** (bloquea a gestores en ese OS) y la **doble llamada a `getUserLocales`** (impacto de rendimiento en cada request de usuario no-gestor al módulo Marketing).
