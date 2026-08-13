# Remediación de seguridad — corregir hallazgos SIN romper funcionalidad

> Pega este prompt en Cursor (modo Agent, repo abierto). Corrige los hallazgos del `INFORME-SEGURIDAD-2026-08-11` priorizando **no romper nada existente**. Trabaja de forma incremental y verificable.

---

Actúa como **ingeniero senior de AppSec + backend Node.js**. Vas a **corregir** los hallazgos de seguridad del ERP (API Express en `api/`, cliente Expo/RN en `app/`). El objetivo es cerrar los agujeros **sin romper la funcionalidad actual ni bloquear a usuarios legítimos**.

## Principio rector para NO romper nada (léelo primero)
El frontend ya oculta menús/acciones con `hasPermiso(<codigo>)` (ver `app/constants/modulos.ts` → `PERMISOS_MENU_LATERAL` y los checks en pantallas). Eso implica que **los roles legítimos ya tienen asignados esos códigos** en la tabla `Igp_RolesPermisos`. Por tanto:

- **Regla de oro:** cada ruta del backend debe exigir **exactamente el mismo código de permiso** que el frontend ya usa para mostrar esa pantalla/acción. Si un usuario ve el botón, ya tiene el permiso → no pierde acceso. Si llamaba la ruta sin permiso, queda bloqueado (que es justo lo que queremos).
- El middleware ya existe y funciona: `requirePermission(codigo)`, `requireAnyPermission(...)`, `hasPermission()`, `requireRole()` en `api/middleware/auth.js`. **Reutilízalos, no crees otros nuevos.**
- `Administrador` siempre pasa (ya está contemplado). **No lo toques.**
- El bypass interno `req.isInternal` (cabecera `x-internal-secret` en rutas de sync) debe **seguir funcionando**. No lo rompas.
- **No cambies contratos de API** (rutas, nombres de campos, forma de las respuestas) de los que depende el cliente. Solo añades comprobaciones y endureces; no reestructuras respuestas salvo para ocultar detalles de error internos.

## Método de trabajo obligatorio
1. Trabaja en una **rama nueva** (`security/remediacion-2026-08`). No toques `main` directamente.
2. Avanza **módulo por módulo** en el orden de prioridad de abajo. Tras cada módulo: ejecuta `npm test` en `api/` (existe `node --test tests/*.test.mjs`) y comprueba que arranca (`npm run dev` en `api/`).
3. Antes de proteger un módulo, **lista sus rutas** y, para cada una, propón el código de permiso a exigir **verificando primero** qué código usa el frontend para esa misma función (búscalo en `app/`). Si no encuentras un código equivalente, **no inventes uno restrictivo**: usa el permiso "ver" del módulo o pregúntame antes de bloquear.
4. Para cada cambio, deja un comentario `// [SEC S-xx]` en la línea, para trazabilidad.
5. Haz **commits pequeños por hallazgo**, con mensaje claro, para poder revertir uno sin perder el resto.
6. **No** ejecutes migraciones destructivas ni borres datos. **No** imprimas valores de secretos.

## Correcciones por hallazgo

### Prioridad 1 — Dinero (máximo cuidado)

**S-01 · Facturación sin autorización fina** (`api/routes/facturacion.js`)
- Añade `requirePermission` a cada ruta según la acción, reutilizando los códigos existentes: lecturas → `facturacion.ver`; emitir → `facturacion.emitir`; cobros/pagos/anular → `facturacion.cobrar_pagar` (o el código que ya use el front para pagar). OCR y adjuntos → el permiso de la acción a la que pertenecen.
- Cuando la decisión dependa de datos del handler (estado de la factura, etc.), usa `hasPermission(req.user, ...)` dentro del handler, no un middleware fijo.
- **Verificación anti-rotura:** confirma que los roles que hoy usan facturación tienen esos códigos en `Igp_RolesPermisos` (revisa `seed-roles-catalog.js` y el estado real). Si a algún rol legítimo le falta, **repórtamelo en el informe final; no lo asignes tú a ciegas.**

**S-04 · Remesa `ejecutar` no atómica** (`api/routes/remesas.js:417-474`)
- Convierte el "check estado → pagar en bucle" en algo idempotente y atómico: marca la remesa `Generada → Ejecutada` con un `UpdateCommand` + `ConditionExpression` (`estado = :generada`) **antes** de pagar; si la condición falla, aborta con 409 (ya en curso/ejecutada).
- Haz cada pago **idempotente por línea**: registra el pago condicionado a que esa `(remesaId, id_factura)` no esté ya pagada, de modo que un reintento no duplique.
- **No cambies** el resultado final de una ejecución correcta ni el formato de respuesta. Solo evitas la doble ejecución.
- Añade un test que simule dos ejecuciones concurrentes y verifique un único pago por línea.

### Prioridad 2 — Autorización del resto de módulos sensibles

**S-02 · Empresas (IBAN/CCC)** (`api/routes/empresas.js`)
- Lecturas → `empresas.ver`; crear → `empresas.crear`; editar → `empresas.editar`; importar → `empresas.importar`; borrar → permiso de borrado equivalente o `requireRole('Administrador')` si no existe código.

**S-03 · Acuerdos + presign S3** (`api/routes/acuerdos.js`)
- Lecturas → `acuerdos.ver`; mutaciones y **generación de presign** → `acuerdos.gestionar` (o el código que ya use el front).
- En el presign: sanitiza `fileName` (usa solo `path.basename`, elimina `../`, caracteres raros), fuerza un prefijo de key controlado por el servidor y valida `content-type` contra una allowlist.

**S-05 · Listado de usuarios** (`api/routes/usuarios.js:22-40`)
- Exige `usuarios.ver` (o `requireRole('Administrador')`). No expongas emails/roles/locales a cualquier autenticado.

### Prioridad 3 — Aislamiento multi-tenant

**S-08 · Filtrado por `Locales`/empresa** (`api/routes/facturacion.js` y demás)
- Donde el usuario tiene `Locales`/empresas acotados en el JWT, **aplica ese filtro en el backend** antes de devolver o mutar datos. `Administrador`/roles globales sin restricción siguen viendo todo.
- **Cuidado de no romper:** roles que hoy operan a nivel grupo (sin `Locales` concretos) deben seguir viéndolo todo. Solo restringe a quien tenga `Locales` definidos. Ante la duda, repórtalo antes de filtrar.

### Prioridad 4 — Hardening rápido (bajo riesgo de rotura)

**S-07 · JWT** (`api/lib/jwt.js`) — fija `algorithms: ['HS256']` en `verify` y el mismo `algorithm` en `sign`. No cambia el flujo, solo endurece.

**S-06 · Uploads** (`api/routes/facturacion.js:86`, `:1853`) — añade `fileFilter` a multer con allowlist de MIME + verificación de **magic bytes** (no confíes en `originalname`/mimetype del cliente), límite de tamaño ya presente, y sanitiza el nombre antes de subir a S3. Rechaza lo no permitido con 400. No cambies el flujo de subida válido.

**S-12 · Fugas en errores** (`api/middleware/errorHandler.js:63` y handlers `res.status(500).json({ error: err.message })`) — en producción devuelve un mensaje genérico + un `id` de error; el detalle (`err.message`, stack) solo al log de `pino`. En desarrollo puede seguir mostrando el detalle.

### Prioridad 5 — Sesión, config, dependencias

**S-13 · `x-internal-secret`** (`api/middleware/auth.js:7-18`) — mantén el mecanismo pero documenta que el secreto debe ser largo y rotatorio; añade (si es fácil) una allowlist de IP opcional por env. No rompas los scripts de sync que ya lo usan.

**S-11 · Helmet/CSP** (`api/server.js:90`) — activa una CSP adecuada a la arquitectura (API + web). Empieza en modo permisivo/`report-only` para no romper la web, valida y luego endurece.

**S-15 · CORS en prod** (`api/server.js:105-108`) — exige `CORS_ALLOWED_ORIGINS` en producción (lista blanca); no combines `*` con credenciales.

**S-09 / S-10 · Sesión y auth legacy** (`app/utils/authToken.ts`, `api/routes/auth.js`) — donde sea posible en el cliente, usa almacenamiento seguro en vez de AsyncStorage plano; en el backend, plan para retirar el soporte de contraseñas en claro (forzar migración) sin bloquear logins actuales de golpe. Propón el plan; no elimines el fallback de golpe si hay usuarios sin migrar.

**S-14 · Dependencias** — ejecuta `npm audit` en raíz y `api/`; aplica `npm audit fix` **solo donde no rompa** la cadena de Expo/AWS SDK. Lista aparte los CVEs que requieran actualización mayor para decidirlos manualmente. No fuerces `--force`.

## Entregable
1. Los cambios en la rama `security/remediacion-2026-08`, en commits pequeños por hallazgo con comentarios `// [SEC S-xx]`.
2. Un fichero `REMEDIACION-SEGURIDAD-<fecha>.md` con: qué se cambió por hallazgo, **qué se dejó pendiente y por qué**, cualquier rol al que le falte un permiso legítimo (para que yo lo asigne), y cómo verificaste que no se rompió nada (tests ejecutados, arranque, pruebas manuales sugeridas).
3. **No** cierres ningún hallazgo cuya corrección pueda bloquear a un usuario legítimo sin habérmelo listado antes en ese informe.

Empieza listando las rutas de `api/routes/facturacion.js` y su mapeo a permisos propuesto, y **espera a que la lógica de permisos esté confirmada** antes de aplicar cambios masivos. Prioriza dinero (S-01, S-04) primero.
