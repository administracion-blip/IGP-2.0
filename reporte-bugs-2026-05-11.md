# Reporte de bugs y mejoras — 2026-05-11

Revisión automática diaria del código. Clasificación: 🔴 Bug / riesgo alto · 🟡 Riesgo medio · 🔵 Mejora técnica.

---

## 🔴 1. Race condition en numeración de facturas (`routes/facturacion.js`)

**Función afectada:** `calcNextNumero`

El número de factura se calcula leyendo todas las facturas de esa serie (`scanAll`) y buscando el máximo con `reduce`. No hay atomicidad: si dos peticiones llegan a la vez, ambas calculan el mismo `maxNumero + 1` y generan el mismo `numero_factura`. El check posterior de duplicado (`scanAll` por `numero_factura`) es un parche TOCTOU (time-of-check-time-of-use) que no garantiza unicidad bajo carga.

**Impacto:** duplicidad de número de factura en caso de tráfico concurrente, que puede tener consecuencias legales/fiscales.

**Solución recomendada:** usar un contador atómico en DynamoDB:
```
UpdateCommand con UpdateExpression: 'ADD ultimo_numero :inc'
ReturnValues: 'ALL_NEW'
```
Sobre una tabla `Igp_FacturasSeries`, así el incremento es atómico y se evita el scan.

---

## 🔴 2. `routes/acuerdos.js` — errores no pasan por el middleware central

Todos los handlers de acuerdos tienen su propio bloque `try/catch` que captura el error y llama a `res.status(500).json(...)` directamente, sin pasar por el `errorHandler` central de Express ni por el logger estructurado (pino). Consecuencias:

- Los errores de AWS (throttling, ConditionalCheck, etc.) no se mapean al código HTTP correcto (429, 409, etc.), todos se convierten en 500.
- Se usa `console.error` en lugar de `req.log`, perdiendo el contexto de request_id, usuario, ip, etc.
- Los errores del módulo de acuerdos no aparecen en el sistema de logging centralizado.

El resto de routers modernos (marketing, facturación nueva) ya usan `express-async-errors` + `throw`. Acuerdos y pedidos quedaron con el patrón antiguo.

---

## 🔴 3. `routes/pedidos.js` — mismo patrón de errores que acuerdos

Ídem al punto 2. Todos los handlers de pedidos usan `console.error('DynamoDB error:', err)` con res.status(500) manual. Mismas consecuencias.

---

## 🟡 4. `calcNextNumero` hace Scan completo de `Igp_Facturas` por cada nueva factura

Además del problema de race condition, el mecanismo actual descarga **todas** las facturas de una serie de toda la tabla para calcular el siguiente número. Si hay miles de facturas, esto escala muy mal en coste y latencia.

El mismo problema ocurre en los flujos de rectificativa (se llama `calcNextNumero` dos veces para emitir y para rectificar).

**Mejora:** contador atómico por serie (ver punto 1).

---

## 🟡 5. `GET /marketing/imagen-url` — sin validación de pertenencia de la clave S3

El endpoint solo verifica que la `key` comience por `marketing/`. Un usuario autenticado con el permiso `marketing.proponer` puede solicitar una URL firmada de **cualquier** objeto bajo ese prefijo, incluidos archivos de propuestas o imágenes finales de otros locales o usuarios.

```js
if (!key.startsWith('marketing/')) {
  throw badRequest('key fuera del namespace de marketing');
}
```

No valida que la clave pertenezca a una propuesta o local al que el usuario tenga acceso.

**Mejora:** para usuarios sin `marketing.gestionar`, validar que la key corresponde a una propuesta cuyo `id_local` está entre los locales del usuario (o limitar el namespace a `marketing/referencia/` para el rol proponer).

---

## 🟡 6. Scan completo de `Igp_Actuaciones` en `/marketing/carteles-musico/generar`

El endpoint descarga toda la tabla de actuaciones en memoria y filtra en Node.js por `id_local` y rango de fechas. Si la tabla crece, este endpoint será lento y costoso en unidades de lectura DynamoDB.

**Mejora:** añadir un GSI sobre `Igp_Actuaciones` con PK `id_local` y SK `fecha` (o `fecha#id_actuacion`), similar a lo que ya existe en `Igp_Marketing`.

---

## 🟡 7. `checkAutoSyncs` en `scheduledTasks.js` — ScanCommand con FilterExpression sobre PK

```js
const { Items = [] } = await docClient.send(new ScanCommand({
  TableName: tableAjustesName,
  FilterExpression: 'PK = :pk AND Enabled = :e',
  ExpressionAttributeValues: { ':pk': 'sincronizaciones', ':e': true },
}));
```

Si `PK` es la clave de partición de `Igp_Ajustes`, un `ScanCommand` lee toda la tabla antes de filtrar. Debería ser un `QueryCommand` con `KeyConditionExpression: 'PK = :pk'` y `FilterExpression: 'Enabled = :e'`.

---

## 🟡 8. Fallback Scan sin filtro en `/marketing/propuestas` para usuarios no-gestores

Cuando ningún GSI está listo, el fallback llama `scanAllMarketing()` sin argumentos (descarga toda la tabla `Igp_Marketing`), y luego filtra en memoria. Los GSIs tardan varios minutos en activarse tras el primer arranque, por lo que en ese intervalo cualquier consulta de propuestas de un local causa un full-table-scan.

Para usuarios no-gestores esto es especialmente innecesario porque `id_local` es obligatorio en la query — podría pasarse al `ScanCommand` como `FilterExpression` aunque el GSI no esté listo.

---

## 🔵 9. CORS silencioso cuando el origen no está permitido

```js
cb(null, false);
```

El módulo `cors` con `false` omite las cabeceras `Access-Control-*` pero no envía error HTTP. El navegador recibe un 200 sin las cabeceras y falla con un error CORS genérico que no da contexto al equipo. Dificulta el diagnóstico en producción.

**Mejora:** añadir un logger de warning cuando se rechaza un origen no esperado, o usar `cb(new Error('Origen no permitido'))` si se prefiere un error explícito (aunque esto cambiaría el comportamiento de cliente).

---

## 🔵 10. Login: migración bcrypt silenciosa y potencialmente eterna

Si la migración de contraseña plana a bcrypt falla (por un error de red o permisos DynamoDB), el error se traga y el usuario sigue autenticándose con contraseña en texto plano indefinidamente:

```js
} catch (migrationErr) {
  req.log.warn({ err: migrationErr }, '[auth] Error migrando password a bcrypt');
}
```

No hay reintento ni contador de intentos fallidos de migración.

**Mejora:** añadir un campo `password_migrated_at` en el ítem de usuario para saber cuándo ocurrió la migración y detectar cuentas que nunca migraron. Considerar un script de migración masiva en lugar de hacerlo on-login.

---

## 🔵 11. Git commits sin mensajes descriptivos

Los últimos 15+ commits tienen el mensaje genérico "Describe el cambio". Esto hace imposible rastrear regresiones o entender la historia del proyecto en caso de necesitar un rollback.

---

## Resumen ejecutivo

| # | Área | Severidad | Esfuerzo estimado |
|---|------|-----------|-------------------|
| 1 | Race condition numeración facturas | 🔴 Alta | Medio (contador atómico DDB) |
| 2 | Acuerdos: errores no pasan por errorHandler | 🔴 Alta | Bajo (refactor try/catch → throw) |
| 3 | Pedidos: errores no pasan por errorHandler | 🔴 Alta | Bajo (igual que acuerdos) |
| 4 | Scan completo por cada factura nueva | 🟡 Media | Medio (contador atómico) |
| 5 | imagen-url sin validación de pertenencia | 🟡 Media | Bajo |
| 6 | Scan completo de actuaciones en carteles | 🟡 Media | Medio (nuevo GSI) |
| 7 | ScanCommand donde debería ser QueryCommand | 🟡 Media | Bajo |
| 8 | Fallback Scan sin filtro en marketing | 🟡 Media | Bajo |
| 9 | CORS silencioso | 🔵 Baja | Bajo |
| 10 | Migración bcrypt silenciosa | 🔵 Baja | Bajo |
| 11 | Commits sin mensajes | 🔵 Baja | Proceso |

Los puntos 1, 2 y 3 son los más urgentes. El 1 por riesgo de duplicidad fiscal; el 2 y 3 porque enmascaran errores reales y dificultan el diagnóstico en producción.
