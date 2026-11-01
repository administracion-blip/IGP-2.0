# Plan de corrección de seguridad — 2026-11-01

Origen: auditoría externa de solo lectura, verificada punto por punto contra el código.
Se ejecuta por fases, de menor a mayor impacto funcional. Un commit por fase, sin push
salvo petición expresa. Cada fase pasa los tests de `api/tests` y revisión de código.

## Decisiones tomadas

- **Usuarios:** solo el Administrador crea, edita, borra y cierra sesiones.
- **Festivos:** permiso nuevo `festivos.editar`.
- **Lecturas por local (`ALCANCE_MODO_LECTURAS`):** primero observar los logs unos días, después bloquear.
- **Orden:** se empieza solo por la fase 1.

---

## Fase 1 — Sin cambios de funcionamiento

### 1.1 XSS almacenado en el acta de entrega de activos

- **Problema:** `renderCuerpoPlantilla` (`api/lib/activos/plantillaTexto.js`) limpia la plantilla pero
  sustituye los huecos (`{{trabajador}}`, `{{local}}`, `{{entregado_por}}`, `{{items}}`) con datos sin
  escapar. La web pinta el resultado con `dangerouslySetInnerHTML` (`app/components/activos/EditorPlantilla.tsx`).
  Una marca o modelo con `<img onerror=…>` se ejecutaría al preparar una entrega y podría leer el token de `localStorage`.
- **Cambio:**
  - Una única forma de escapar: `escapeHtml` de `api/lib/seguridad/escapeHtml.js`, aplicada a todos los huecos.
  - `{{items}}` es el único hueco donde se añade HTML: cada línea se escapa y se unen con `<br>`.
  - `itemsLineas` (texto plano de cada línea) sigue sin escapar, para no escapar dos veces.
  - `htmlActaATexto` (PDF) decodifica también `&#39;` y decodifica `&amp;` en último lugar.
  - La vista previa web vuelve a pasar el HTML por `sanitizarHtmlPlantilla` antes de pintarlo.
- **Implicación:** ninguna visible. Las actas ya firmadas no se tocan.
- **Prueba:** texto malicioso en marca, modelo, etiqueta, trabajador, local y quien entrega; el HTML sale escapado y el texto del PDF sale limpio.

### 1.2 Impresión de etiquetas de activos

- **Problema:** `app/lib/activosEtiqueta.ts` escribe etiqueta, marca, modelo y número de serie con `document.write` sin escapar.
- **Cambio:** escapar todos esos campos (incluido el número de serie).
- **Implicación:** ninguna.

### 1.3 Fotos de inventario: el body pisaba el id de la ruta

- **Problema:** en `api/routes/inventarios.js`, `{ inventarioId: req.params.id, ...req.body }` permitía que el body cambiase el inventario de la URL de subida.
- **Cambio:** manda siempre `req.params.id`.
- **Implicación:** ninguna; la app ya manda el mismo id.

### 1.4 Contraseña mínima de 8 caracteres

- **Cambio:** `POST /usuarios` y `PUT /usuarios` (con `id_usuario` en el cuerpo) aplican `MIN_PASSWORD_LENGTH` (el mismo que el restablecimiento), solo cuando se escribe una contraseña nueva. En `PUT`, dejar el campo vacío mantiene la actual, así que editar otros campos no se bloquea.
- **Implicación:** no se pueden poner contraseñas nuevas de menos de 8. Las existentes no cambian.

### 1.5 Longitud de `INTERNAL_SYNC_SECRET`

- **Problema:** es obligatorio, pero sin longitud mínima. Con él se saltan auth, permisos y local en las rutas de sincronización interna.
- **Cambio (fase 1):** si tiene menos de 32 caracteres, **solo se deja un aviso en el log**; la API arranca igual.
- **Pendiente:** convertirlo en bloqueo al arrancar cuando se confirme la longitud real en producción.

---

## Fase 2 — Cambia quién puede escribir

### 2.1 Usuarios: solo Administrador

- `POST`, `PUT`, `DELETE /usuarios` y `POST /usuarios/:id/cerrar-sesiones` exigen rol Administrador en backend; el frontend oculta los botones. `GET /usuarios` sigue con `usuarios.ver`.
- **Los permisos `usuarios.crear`, `usuarios.editar` y `usuarios.borrar` NO se borran del catálogo.** Quedan sin efecto, para poder volver atrás si alguien los necesita.
- **Implicación:** quien gestione usuarios sin ser Administrador deja de poder hacerlo. Antes, listar qué roles tienen hoy esos permisos.

### 2.2 Festivos con permiso propio

- Permiso nuevo `festivos.editar` (catálogo + `permisosDescripciones`) para las escrituras de `api/routes/festivos.js`; la lectura sigue igual.
- **Implicación:** hasta asignarlo en Roles, solo el Administrador edita festivos.

### 2.3 Sesiones de activaciones

- `POST`, `PATCH` y `DELETE` comprueban el local de la sesión; al moverla, también el local nuevo.

### 2.4 Conciliación bancaria

- `descartar` e `ignorar` comprueban la sociedad, igual que `aplicar`.

### 2.5 Borrar proyectos y tareas

- Además de `proyectos.borrar`, exige permiso de edición sobre la fila.

### 2.6 Fugas menores

- `rappel-preview` comprueba el local del pedido.
- `conflicto-artista` no devuelve datos de locales ajenos.
- `marketing/imagen-url` solo firma claves visibles para el usuario.

---

## Fase 3 — Cambia quién puede leer

### 3.1 Permisos en lecturas de Ágora

- En `api/routes/agora.js` hay 17 lecturas que solo exigen sesión.
- **Decisión (2026-11-01):** deja de estar vigente el criterio «datos de grupo visibles para todos»; el comentario de `agora.js` se actualiza con el nuevo criterio.

**Mapa aprobado**

| Ruta | Quién la llama | Permiso |
|---|---|---|
| `GET /agora/closeouts/dashboard-home` | Inicio `/` (todos, solo `totalsTicker`); `FacturacionYtdWidget` en el hub de Cajas (`cajas.ver`) | Sin permiso. `totalsTicker` filtrado en servidor por los locales del usuario; acumulados YTD y por meses solo con `cajas.ver` |
| `GET /cajas/top` | Cajas → Top (`top.ver`) | `top.ver` |
| `totals-by-local-ytd`, `totals-by-month` | Ninguna pantalla | `cajas.ver` |
| `GET /agora/purchases` | Compras a proveedor, resumen, último precio, conciliación de facturas | `compras_proveedor.ver` |
| `GET /agora/purchases/por-producto` | Modal de compras en acuerdos y escandallos | Uno de `compras_proveedor.ver`, `acuerdos.ver`, `escandallos.ver` |
| `GET /agora/users` | Usuarios Ágora | `usuarios_agora.ver` |
| `GET /agora/test-connection` | Ninguna pantalla | Solo Administrador |
| `GET /agora/payment-methods` | Ninguna lectura | `cierres.ver` |
| `GET /agora/formas-pago` | Cierres teóricos, maestro de formas de pago | `cierres.ver` |
| `GET /agora/sale-centers` | Pantallas de cajas; Puntos de venta | Uno de `cierres.ver`, `puntos_venta.ver` |
| `GET /agora/centros-venta`, `GET /agora/locales-tarifa` | Puntos de venta | `puntos_venta.ver` |
| `GET /agora/franjas-plantillas` | Franjas y objetivos, previsión, RRHH → horas por facturación | Uno de `objetivos.ver`, `prevision.ver`, `rrhh.horas` |

Sin cambios: `GET /agora/products` (lo carga `ProductosCache` en el layout global para pedidos, almacén, acuerdos, etc.), `GET /agora/closeouts-ready` (estado, sin datos) y `GET /agora/closeouts/totals-by-local` (ya filtra por local).

**Comprobaciones previas**

- `ComprasProveedorCache` (layout global) no pide compras al arrancar: no tiene `useEffect`; solo carga cuando una pantalla de compras llama a `recargar`.
- `GET /agora/products` **sí devuelve precios de coste** a cualquier usuario con sesión: `CostPrice` y `CostPrices` por almacén (`api/lib/dynamo/agoraProducts.js`, `ALLOWED_FIELDS`). Además, `?source=agora` lanza una consulta en vivo a Ágora para cualquier usuario. Solo se informa; queda pendiente decidir.

**Pendientes de la revisión de la 3.1**

- `dashboard-home` sigue consultando los cierres de todos los locales desde el 1 de enero del año anterior aunque el usuario no tenga `cajas.ver`; se podría consultar solo `dateTo`, `datePrev` y los locales del usuario.
- Con `cajas.ver`, los acumulados mensuales de `FacturacionYtdWidget` son de todo el grupo (el widget no los filtra por local, a diferencia de los YTD). Revisar en la 3.2.

**Pruebas:** por cada ruta, 403 sin el permiso y 200 con él (y con Administrador); en `dashboard-home`, que `totalsTicker` solo trae locales del usuario y que los acumulados no vienen sin `cajas.ver`.

### 3.2 Bloqueo de lecturas por local

- Sin código: revisar los avisos `[alcance] denegaría` del log de producción unos días y después poner `ALCANCE_MODO_LECTURAS=bloquear`.
- **Implicación:** los usuarios con locales asignados dejan de ver otros locales. Reversible quitando la variable.

---

## Fase 4 — Dependencias e infraestructura

### 4.1 Dependencias

- **jspdf no necesita salto mayor:** la última publicada es 4.2.1. La API ya la tiene; la raíz va en 4.2.0 (subida de parche).
- El aviso crítico de la API viene de `dompurify` 3.4.16 (dependencia opcional de jspdf, rango `^3.3.1`): se arregla subiendo `dompurify` a 3.4.17.
- **Antes de instalar se enseñan las versiones exactas y la salida de `npm audit`.**
- También: `multer`, `body-parser` (vía `express`) y las herramientas de desarrollo `concurrently`, `tar`, `shell-quote`.
- No se tocan `expo` ni `expo-router` (salto mayor fuera del SDK 54). `xlsx` y `nodemailer` de la raíz se tratan aparte.
- **Riesgo:** revisar a mano los PDF (factura, recibo de cashflow, acta de activos, informe diario).

**Hecho (2026-11-01):**

- `api/`: `dompurify` 3.4.17, `multer` 2.5.0, `body-parser` 1.20.9, `qs` 6.16.2, `nodemailer` 10.3.1 y `npm audit fix` sin `--force`. Queda 0 críticas, 0 altas, 13 moderadas (exceljs y nodemon, sin corrección compatible).
- Raíz: `jspdf` 4.2.1 (con `dompurify` 3.4.17), `concurrently` 9.2.5, `shell-quote` 1.12.0, `tar` 7.5.22; `multer` y `nodemailer` eliminados de la raíz (no se usaban fuera de `api/`). Queda 0 críticas, 23 altas, 18 moderadas (Expo, `xlsx`). En la raíz hay que instalar con `--legacy-peer-deps` por un conflicto previo entre `@types/react` ~19.1 y `@types/react-dom` 19.2.
- `npx expo install --check` ya avisaba de versiones de parche de paquetes Expo y de `@types/react-dom`; no se han tocado.
- Pendiente: revisión manual de los PDF (factura, recibo de cashflow, acta de activos, informe diario), un envío de correo y que la web compila.

### 4.2 `trust proxy`

- Solo tras confirmar cuántos proxies hay delante de la API.

### 4.3 Contraseñas en texto plano

- Ejecutar `api/scripts/audit-plaintext-passwords.js` (solo lectura), forzar el restablecimiento de esos usuarios y quitar la aceptación de texto plano.

---

## Estado

- **Fase 1:** hecha (`ac40e3d`). La 1.5 pasa a bloquear el arranque en la fase 2, tras confirmar que el secreto de producción tiene más de 32 caracteres.
- **Fase 2:** hecha. Solo el rol Administrador usaba los permisos `usuarios.*`.

### Notas de despliegue de la fase 2

- Asignar `festivos.editar` en Permisos a los roles que deban editar festivos; hasta entonces solo puede el Administrador.
- Un `INTERNAL_SYNC_SECRET` de menos de 32 caracteres impide arrancar la API, también en los `.env.local` de desarrollo.
- Las subidas nuevas de marketing llevan `.u<id_usuario>` en el nombre (lo genera el servidor). Un no gestor solo puede guardar claves de imagen que ya estaban en el registro o que subió él.
- `rappel-preview` sigue el modo de lecturas: en «observar» solo avisa, hasta la 3.2.
- `ignorar` en conciliación: un movimiento sin cuenta asignada da 404 a los usuarios restringidos a algunas sociedades.

### Pendientes detectados en la revisión de la fase 2

- `getUserLocales` (`api/routes/marketing.js`) trata `usuarios.Local` como ids, pero guarda nombres: los no gestores con locales asignados no ven propuestas ni estilos (ya pasaba antes). Resolver con `alcanceDelUsuario` / `permiteLocal`.
- Conciliación: `aplicar` y `DELETE /banca/conciliacion` no comprueban la sociedad del movimiento, y `GET /sugerencias` puede devolver movimientos de otras sociedades.
- `POST /locales` sigue aceptando `usuarios.crear` / `usuarios.editar`.
- `GET /locales` devuelve `estilo_visual_imagen_keys` de todos los locales.

## Fuera de este plan

- Token fuera de `localStorage` (cookie `httpOnly` + CSRF): proyecto aparte.
- CSP en la web Expo: probar antes en modo report-only.
- Lista blanca de campos en ajustes: solo si se decide.
- Acuerdos, mayorista, facturación de mantenimiento y cierre del bonus: se asumen globales a propósito (pendiente de confirmar).

## Preguntas abiertas para el developer senior

1. Longitud de `INTERNAL_SYNC_SECRET` en producción.
2. Qué roles tienen hoy `usuarios.crear`, `usuarios.editar` o `usuarios.borrar`.
3. Cómo está desplegada la API (proxies, saltos) y dónde se leen sus logs.
4. Valores en producción de `NODE_ENV` y `ALCANCE_MODO_LECTURAS`.
5. Si acuerdos, mayorista, facturación de mantenimiento y bonus deben ser globales.
6. Aprobación del mapa de permisos de la fase 3.
