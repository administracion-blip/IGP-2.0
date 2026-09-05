# Reporte de Revisión de Código — 2026-08-24

Revisión automática diaria. Sin modificaciones al código; solo hallazgos y márgenes de mejora ordenados por severidad.

---

## Commits nuevos desde el último reporte (2026-08-17)

| Hash | Fecha | Descripción |
|------|-------|-------------|
| `722d2d0` | 19.08 | Módulo MIA, escandallos, integración externa actuaciones, agora purchase orders |
| `f685133` | 21.08 | **Módulo banca** completo: lectores N43/BBVA/CaixaBank, conciliación bancaria, maestro cuentas, IBAN congelado |
| `103a0b3` | 19.08 | Solo `Notas.md` |

---

## BUGS CRÍTICOS NUEVOS

### 1. `GET /banca/movimientos` — sin validación de pertenencia de cuenta
**Archivo:** `api/routes/banca.js` (línea 213)

La ruta acepta `iban` o `empresaId` como query params y los pasa directamente a DynamoDB sin comprobar que pertenezcan a un local/empresa del usuario autenticado. Cualquier usuario con el permiso `banca.ver` puede ver los movimientos bancarios de **cualquier IBAN del sistema** simplemente pasando el parámetro correcto.

```js
// tal como está ahora:
const iban = limpiarIban(req.query.iban);       // sin validación de pertenencia
const empresaId = String(req.query.empresaId);  // sin validación de pertenencia
salida = await queryMovimientosCuenta(iban, { ... });
```

**Corrección sugerida:** cruzar el IBAN o `empresaId` recibido con las cuentas de los locales que tiene asignados `req.user` antes de ejecutar la query.

---

### 2. `GET /mia/locales-almacenes` — scan global sin filtro de usuario
**Archivo:** `api/routes/mia.js` (línea 164)

`buildMapaLocalAlmacen()` hace `ScanCommand` completo de las tablas `locales` y `almacenes` sin ningún filtro de tenant. La ruta devuelve todos los locales y almacenes del sistema a cualquier usuario con `mia.ver`, incluyendo locales de otras empresas.

```js
router.get('/mia/locales-almacenes', requirePermission('mia.ver'), async (_req, res) => {
  const mapa = await buildMapaLocalAlmacen();  // scan global, sin req.user
  res.json({ locales: mapa.locales, almacenes: mapa.almacenes, ... });
});
```

**Corrección sugerida:** pasar `req.user` a `buildMapaLocalAlmacen()` y filtrar el resultado a los locales del usuario, igual que hace `GET /mia/calendario` con `localId`.

---

### 3. `GET /escandallos/:productoId/imagen-url` — sin validación de pertenencia
**Archivo:** `api/routes/escandallos.js` (línea 264)

Lee la receta por `productoId` y genera una URL firmada de S3 sin comprobar que esa receta pertenezca a un local del usuario autenticado. Cualquier usuario con `escandallos.ver` puede obtener la URL de la imagen de cualquier receta del sistema. Misma clase de bug que `GET /marketing/imagen-url` (pendiente desde reporte 2026-08-10).

```js
const receta = await getReceta(productoId);  // no verifica pertenencia
const url = await getSignedUrl(s3, new GetObjectCommand({ Key: receta.meta.imagen_key }));
```

**Corrección sugerida:** verificar que `receta.local_id` (o campo equivalente) está en los locales del usuario antes de devolver la URL.

---

### 4. `GET /mia/informes/:id` — sin validación de pertenencia
**Archivo:** `api/routes/mia.js` (línea 288)

`getInformeCompleto(id)` lee directamente por PK sin cruzar el `warehouseId` del informe con los locales del usuario. Cualquier usuario con `mia.ver` puede leer informes de pedido de otros locales.

```js
const full = await getInformeCompleto(id);  // solo por ID, sin ownership check
```

**Corrección sugerida:** tras obtener el informe, verificar que `full.informe.warehouseId` pertenece a un local del usuario antes de devolverlo.

---

## BUGS ALTOS NUEVOS

### 5. `facturacion.js` — `body.usuario_id` persiste en rutas del commit 21.08
**Archivo:** `api/routes/facturacion.js` (líneas 1164–1165 y 1274–1275)

La refactorización que extrajo la lógica a `eliminarPago.js` no aprovechó `usuarioAuditoria(req)`. Las rutas `POST /facturacion/pagos` y `PUT /facturacion/pagos/:id_factura/:id_pago` siguen leyendo identidad del body:

```js
const usuario_id = b.usuario_id;       // línea 1164 / 1274 — viene del cliente
const usuario_nombre = b.usuario_nombre; // línea 1165 / 1275
```

Cualquier cliente puede suplantar la identidad en el registro de auditoría. Mismo patrón que el bug #3 del reporte anterior (8 rutas afectadas), que sigue sin corregirse.

---

### 6. `escandallos.js` — 5 rutas async sin try/catch
**Archivo:** `api/routes/escandallos.js`

De 9 rutas async, solo 4 tienen bloque try/catch. Las siguientes quedan sin protección:

| Ruta | Línea |
|------|-------|
| `GET /escandallos` | 64 |
| `GET /escandallos/compras-contexto` | 71 |
| `GET /escandallos/almacen-contexto` | 112 |
| `GET /escandallos/:productoId` | 179 |
| `DELETE /escandallos/:productoId` | 299 |

Un error de DynamoDB en cualquiera de estas rutas propagará una excepción no capturada. Dependiendo del `unhandledRejection` handler del proceso, puede generar un 500 sin cuerpo o matar el worker.

**Corrección sugerida:** envolver cada handler con try/catch (o usar un wrapper `asyncHandler`).

---

## BUGS CRÍTICOS PERSISTENTES (sin corregir desde reportes anteriores)

### P-1. `GET /personal/cuadrante` — sin `requirePermission` ni filtro de locales
**Archivo:** `api/routes/cuadrante.js` (línea 38) — **sin corregir desde 2026-08-10.**
Cualquier empleado autenticado puede ver turnos y fichajes de locales a los que no pertenece.

### P-2. `PUT /facturacion/facturas/:id` — auditoría usa `body.usuario_id`
**Archivo:** `api/routes/facturacion.js` (líneas 670 y 675) — **sin corregir desde 2026-08-10.**

### P-3. Otras 8 rutas de `facturacion.js` con `body.usuario_id`
**Archivo:** `api/routes/facturacion.js` — **sin corregir desde 2026-08-10.**
Líneas: 756, 787, 799, 831, 851, 926, 939, 1019.

### P-4. `GET /marketing/imagen-url` — sin validación de pertenencia
**Archivo:** `api/routes/marketing.js` (~línea 1274) — **sin corregir desde 2026-08-10.**

### P-5. `scanAllMarketing()` — cross-local para gestores
**Archivo:** `api/routes/marketing.js` — **sin corregir desde 2026-08-10.**

### P-6. `usuarioAuditoria()` — fallback a `body.usuario_nombre`
**Archivo:** `api/routes/facturacion.js` (líneas 281–282) — **sin corregir desde 2026-08-10.**
Si el JWT no lleva campo `Nombre`, la función cae a `body.usuario_nombre`, que es controlable por el cliente.

---

## LO QUE SÍ ESTÁ BIEN (módulos nuevos)

- **`bancaConciliacion.js`**: todas las rutas tienen `requirePermission`/`requireAnyPermission` y la identidad de usuario se extrae con `usuarioDeReq(req)` (no del body). Bien hecho.
- **`integraciones.js`**: usa su propio middleware `requireIntegracionApiKey` con hash SHA-256 comparado en tiempo constante, rechaza non-GET a nivel de namespace y valida scopes. Implementación correcta.
- **`mia.js`** (en general): todas las rutas tienen permiso declarado y las mutaciones pasan `req.user` correctamente. El problema está solo en las dos rutas de lectura señaladas arriba.
- **Tests nuevos**: el commit 21.08 incluye 11 suites de tests para los parsers bancarios (N43, BBVA, CaixaBank), la conciliación y el IBAN. Buena cobertura de la capa de parsing.

---

## RESUMEN EJECUTIVO

| Severidad | Nuevos | Persistentes |
|-----------|--------|--------------|
| Crítico   | 4      | 5            |
| Alto      | 2      | 1            |

Los 4 bugs críticos nuevos son todos de **aislamiento de tenant**: tres módulos nuevos (banca, mia, escandallos) exponen datos de otros locales porque no cruzan el recurso solicitado con los locales del usuario autenticado. Es un patrón repetido que convendría resolver con un helper centralizado de validación de pertenencia, similar a `empresasPermitidasDelUsuario()` que ya existe en `facturacion.js`.
