# Prompt de implementación — Módulo "Reuniones" (v2)

> Pega este documento como instrucción de trabajo para el agente de código en el repo `ipg2.0`.
> Redactado contra las convenciones **verificadas** en `api/` y en el frontend Expo (julio 2026).

---

## 0. Fase 0 — validación previa (obligatoria antes de escribir código)

Antes de crear tablas o buckets, validar la pieza que condiciona todo el módulo: grabar 20-30 minutos de una reunión real del grupo, lanzarla a mano contra AWS Transcribe con `LanguageCode: 'es-ES'` y `Settings.ShowSpeakerLabels: true`, y evaluar tres cosas: si distingue correctamente a los hablantes cuando se solapan, si acierta con nombres de locales, proveedores y jerga de hostelería, y si el texto resultante es utilizable para resumir sin corrección manual.

Si la diarización o la precisión no son aceptables, **parar y reevaluar el motor** (alternativas: `gpt-4o-transcribe` sin diarización, o un proveedor especializado). No seguir con el resto de fases hasta tener esta respuesta.

Coste de referencia: AWS Transcribe ~0,024 USD/min en `eu-west-3`, unos 1,4 USD por reunión de una hora.

---

## 1. Objetivo y alcance

Módulo nuevo **Reuniones** que permita subir el audio de una reunión, transcribirlo con diarización, generar resumen y acuerdos con IA, consultar la reunión en lenguaje natural y borrar el audio conservando transcripción y resumen.

Fuera del MVP, explícitamente: grabación de audio dentro de la app, cruce de la consulta IA con datos de negocio (ventas, compras, objetivos), búsqueda semántica entre reuniones. Se abordarán después, con diseño propio.

No reescribir nada existente. Es un módulo más, siguiendo el patrón de `marketing`, `limpieza` y `activaciones`.

---

## 2. Decisión previa: visibilidad de las reuniones

**Bloqueante, decidir antes de crear la tabla.** Los permisos por acción no bastan: una reunión de dirección no puede ser visible para un encargado de local, y `localPermitido()` no resuelve el caso porque muchas reuniones son de grupo y no tienen local asociado.

Modelo propuesto: campo `visibilidad` con valores `direccion` | `empresa` | `local` | `restringida`, más `usuarios_autorizados` (array de `id_usuario`) cuando sea `restringida`. El filtrado se aplica **siempre en el backend** al listar y al leer detalle, nunca en el cliente. Para `visibilidad: 'local'` se cruza con `usuarioPuedeAccederLocal(user, id)` de `api/lib/usuarioLocales.js`. Para `direccion`, permiso dedicado.

Confirmar este modelo con el usuario antes de implementar.

---

## 3. Convenciones del repo (verificadas)

- **API**: Express con ESM en `api/`. Router en `api/routes/reuniones.js`, montado en `api/server.js` con `app.use('/api', reunionesRouter)` después del `app.use('/api', requireAuth)` global. Export `default router`.
- **DynamoDB**: `docClient` y objeto `tables` de `api/lib/db.js`, patrón `process.env.DDB_X || 'Igp_X'`. Región `process.env.AWS_REGION || 'eu-west-3'`.
- **S3**: **no existe `api/lib/s3/`**. El cliente se instancia inline en cada router. Copiar el patrón de presigned upload de `api/routes/acuerdos.js` (`PutObjectCommand` + `getSignedUrl` con `expiresIn`). Dependencias ya presentes: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- **IA**: usar `chatCompletion({ system, user, temperature, model, timeoutMs })` de `api/lib/ia/openaiClient.js`, que devuelve `{ text, model, usage: { prompt, completion } }`. Comprobar disponibilidad con `iaDisponible()`. Ver §6 para las ampliaciones necesarias.
- **Permisos**: middleware `requirePermission(cod)` de `api/middleware/auth.js` y `hasPermission(user, cod)` para chequeos granulares dentro del handler. `req.isInternal` salta permisos en llamadas internas.
- **Jobs**: funciones exportadas en `api/lib/jobs/scheduledTasks.js`, programadas con `setInterval` en el callback de `listen` en `api/server.js`. Config en `Igp_Ajustes` con PK de dominio y SK de tarea, campos `Enabled`, `Days`, `Times`, `UltimaSync`. Llamadas internas con `internalSyncFetchHeaders()` de `api/lib/internalSync.js`.
- **Scripts de tabla**: `api/scripts/create-reuniones-table.js` calcado de `create-cashflow-table.js` (dotenv de `api/.env.local` y `api/.env`, `DynamoDBClient` directo, `DescribeTableCommand` para idempotencia, `BillingMode: 'PAY_PER_REQUEST'`).
- **Frontend**: Expo Router bajo `app/(app)/reuniones/`. `apiFetch` de `app/utils/api.ts`, `useBreakpoint()`, `TablaBasica` para el listado, `formatId6()` para IDs visibles, `MaterialIcons`.
- Comentarios de cabecera en español explicando el porqué. Texto visible en español.

**Precisión importante:** el OCR existente del repo es Tesseract ejecutándose en proceso, no un pipeline asíncrono. No hay precedente de trabajo diferido salvo los pollers de `scheduledTasks.js`. Usar ese patrón, no "el espíritu del OCR".

---

## 4. Modelo de datos

Añadir a `tables` en `api/lib/db.js`: `reuniones: process.env.DDB_REUNIONES || 'Igp_Reuniones'`.

PK `id_reunion` (UUID), sin sort key. Atributos: `id_empresa`, `id_local` (opcional), `titulo`, `fecha`, `participantes`, `visibilidad`, `usuarios_autorizados`, `creado_por`, `creado_en`, `updatedAt`, `estado`, `error_motivo`, `intentos`, `audio_estado`, `audio_s3_key`, `audio_borrado_en`, `duracion_seg`, `transcripcion`, `segmentos` (`[{speaker, inicio, fin, texto}]`), `resumen`, `acuerdos` (`[{texto, responsable, fecha_limite}]`), `aviso_grabacion` (`{informados: string[], aceptado_por, aceptado_en}`), `transcribe_job_name`.

Estados: `SUBIENDO` → `SUBIDO` → `TRANSCRIBIENDO` → `TRANSCRITO` → `RESUMIENDO` → `COMPLETADA`, más `ERROR` con `error_motivo` que distinga fallo de transcripción de fallo de IA, e `intentos` para reintentos.

`audio_estado`: `PRESENTE` | `BORRADO`.

**Sin GSIs en el MVP.** El volumen esperado son decenas de reuniones al año: `Scan` con filtro y paginación es suficiente y evita índices que habría que mantener. Si el volumen crece, añadir entonces `Empresa-Fecha-index` siguiendo el patrón idempotente con fallback a `Scan` de `api/lib/dynamo/marketing.js`. No crear un GSI con PK `estado`: cardinalidad de seis valores, partición caliente y sin beneficio.

---

## 5. Audio en S3

Prefijo `reuniones/<id_empresa>/<id_reunion>.<ext>` sobre el bucket existente `S3_BUCKET`, salvo que se decida bucket dedicado (`S3_REUNIONES_BUCKET`).

Requisitos: `ServerSideEncryption: 'AES256'` explícito en el `PutObjectCommand` del presign (hoy ningún router del repo lo pone, aquí sí por sensibilidad del dato), acceso público bloqueado, y **configuración de CORS del bucket permitiendo `PUT` desde los orígenes de la app** — necesaria para subir desde web y hoy no configurada.

El audio no pasa por Express: la API devuelve URL prefirmada y el cliente hace `PUT` directo. Pedir al cliente audio comprimido (m4a/opus): una reunión de dos horas en WAV son cientos de MB y el `PUT` prefirmado no es reanudable. Validar `Content-Length` y extensión al crear la reunión, y limitar el tamaño máximo aceptado.

Transcribe tiene límite de 4 horas y 2 GB por job. Rechazar audios que lo excedan con un mensaje claro.

---

## 6. Ampliaciones necesarias en `openaiClient.js`

El resumen debe devolver estructura (`acuerdos` con responsable y fecha límite), y hoy `chatCompletion` no lo permite. Cambios mínimos:

- Aceptar un parámetro `responseFormat` opcional que se traslade a `response_format: { type: 'json_object' }` en el body de la petición.
- Permitir `maxTokens` opcional (hoy no se envía `max_tokens`).
- Subir `timeoutMs` en la llamada de resumen: una transcripción de una hora ronda los 15.000 tokens de entrada y los 90 s por defecto pueden quedarse cortos.

Son cambios aditivos y retrocompatibles; no alterar el comportamiento por defecto para no afectar a `api/routes/ia.js`. Si el modelo devuelve JSON inválido, parsear con tolerancia y dejar la reunión en `TRANSCRITO` con `error_motivo`, nunca perder la transcripción.

---

## 7. Procesamiento asíncrono

AWS Transcribe **no tiene callback nativo**. Opción elegida por simplicidad: poller en `scheduledTasks.js`.

Nueva dependencia: `@aws-sdk/client-transcribe` en `api/package.json`.

Función `checkReunionesEnProceso()` que cada 60 s busca reuniones en `TRANSCRIBIENDO`, llama a `GetTranscriptionJob`, y al completar descarga el resultado de S3, guarda `transcripcion` y `segmentos`, pasa a `TRANSCRITO` y encadena el resumen (`RESUMIENDO` → `COMPLETADA`). Guarda anti-doble-ejecución con flag en memoria, como los jobs existentes. Reintentos limitados por `intentos`; al agotarlos, `ERROR` con motivo.

Si más adelante se quiere EventBridge, el endpoint de callback debe montarse **antes** del `app.use('/api', requireAuth)` de `api/server.js` (como las rutas públicas) o añadir su path a `INTERNAL_SYNC_POST_PATHS` en `api/lib/internalSync.js`, que es una lista blanca.

---

## 8. Endpoints

Todos en `api/routes/reuniones.js`, bajo `/api/reuniones`, con `requirePermission` y filtrado de visibilidad de §2 aplicado en backend.

- `POST /api/reuniones` — crea metadatos + aviso de grabación, devuelve presigned PUT. Permiso `reuniones.gestionar`.
- `POST /api/reuniones/:id/procesar` — confirma subida (verificar que el objeto existe en S3) y lanza `StartTranscriptionJob`. Permiso `reuniones.gestionar`.
- `GET /api/reuniones` — lista con filtros de empresa/local/fecha/estado y paginación. Permiso `reuniones.ver`.
- `GET /api/reuniones/:id` — detalle. Permiso `reuniones.ver` + visibilidad.
- `PATCH /api/reuniones/:id` — título, participantes, acuerdos. Permiso `reuniones.gestionar`.
- `POST /api/reuniones/:id/consultar` — Q&A sobre la transcripción de esa reunión, sin datos de negocio. Permiso `reuniones.ver`.
- `DELETE /api/reuniones/:id/audio` — borrado del audio. Permiso `reuniones.borrar_audio`.
- `DELETE /api/reuniones/:id` — borra registro y audio (derecho de supresión). Permiso `reuniones.gestionar`.

---

## 9. Consulta IA (MVP)

`POST /:id/consultar` recibe `{ pregunta }`, recupera la transcripción de esa reunión, comprueba visibilidad, y llama a `chatCompletion` con un `system` que instruya: responder únicamente con lo que aparece en la transcripción, citar el fragmento o el hablante en el que se apoya, y decir explícitamente "no consta en la reunión" cuando la respuesta no esté ahí. No inyectar datos de otras reuniones ni de la base de datos.

Aplicar el límite de ejecuciones por hora del mismo modo que `api/routes/ia.js` (`permitirEjecucion`), y cortar si la transcripción excede un tamaño configurable.

**Nota para fase futura:** el cruce con datos de negocio requiere function calling (no soportado hoy en `openaiClient`) y, además, `api/lib/ia/fuentes/comprasVariaciones.js` **no filtra por local**: usarlo en un contexto de consulta libre expondría compras de locales ajenos. Corregir esa fuente es prerrequisito de esa fase.

---

## 10. Borrado de audio

**Manual** (`DELETE /:id/audio`): validar `estado === 'COMPLETADA'` y `audio_estado === 'PRESENTE'`, si no responder 409 con motivo. `DeleteObject` en S3, luego `UpdateCommand` con `audio_estado='BORRADO'`, `audio_borrado_en`, `audio_s3_key` a null. Log de auditoría con usuario y timestamp. El registro de DynamoDB nunca se toca más allá de esos campos.

**Automático**: job en `scheduledTasks.js`, config en `Igp_Ajustes` con PK `reuniones` y SK `retencion_audio` (`{ Enabled, RetencionDias }`, default desde `REUNIONES_RETENCION_AUDIO_DIAS`, 7). Recorre reuniones `COMPLETADA` con audio presente y antigüedad superior a la retención, y reutiliza la lógica del borrado manual. Guarda `lastRun` por día. Implementar después de que el manual esté validado en producción.

**Política de fallidos, decidir explícitamente:** las reuniones en `ERROR` conservan el audio y el job no las toca, así que se acumularían indefinidamente. Si se configura una regla de ciclo de vida en S3 como red de seguridad, hay que asumir que **también borrará audios no transcritos** y con ello la posibilidad de reintentar. Documentar la decisión en el README del módulo en lugar de dejar las dos reglas contradiciéndose.

---

## 11. Permisos

Tres códigos nuevos, añadidos a `api/ROLES-PERMISOS.md`, a `GRUPOS_PERMISOS` y `PERMISOS_LABELS` de `app/(app)/permisos.tsx`, y al catálogo de menú si procede:

- `reuniones.ver`
- `reuniones.gestionar`
- `reuniones.borrar_audio`

Si el modelo de visibilidad de §2 incluye `direccion`, añadir `reuniones.ver_direccion`. No crear permisos `ia.*` para reuniones hasta que exista la fase de informes/RAG.

---

## 12. Privacidad

Aviso de grabación mostrado antes de subir, con registro de los asistentes informados y de quién acepta (`aviso_grabacion`); sin aceptación no se genera la URL de subida. Cifrado en reposo (SSE) y en tránsito, dato en `eu-west-3`. Retención del audio corta y configurable. Todo el acceso tras permiso y filtro de visibilidad aplicado en servidor.

Advertir en la UI y en el README que el resumen y las consultas envían el contenido de la transcripción a OpenAI: es una transferencia a un tercero y debe constar en el registro de tratamientos.

---

## 13. Variables de entorno

`DDB_REUNIONES` (default `Igp_Reuniones`), `S3_REUNIONES_PREFIX` (default `reuniones/`), `TRANSCRIBE_LANGUAGE` (default `es-ES`), `TRANSCRIBE_MAX_SPEAKERS`, `REUNIONES_RETENCION_AUDIO_DIAS` (default 7), `REUNIONES_MAX_AUDIO_MB`. Reutilizar `OPENAI_API_KEY`, `IA_INFORMES_MODEL`, `AWS_REGION`, `S3_BUCKET`. No añadir a `REQUIRED` en `api/lib/validateEnv.js` (todas tienen default); como mucho a `RECOMMENDED`.

---

## 14. Frontend

`app/(app)/reuniones/`: listado con `TablaBasica` (fecha, título, empresa/local, estado, estado de audio), alta con formulario y aviso de grabación, y detalle con resumen arriba, acuerdos editables, transcripción con hablantes desplegable y caja de consulta.

**Solo subida de fichero en el MVP, sin grabación integrada.** Motivo: React Native Web no expone `MediaRecorder`, `expo-av` está deprecado en SDK 54, ninguna librería de audio está instalada, y grabar una reunión de dos horas en navegador es el punto de fallo más probable de todo el módulo. Que quien grabe use la grabadora del móvil o la de Teams/Meet y suba el fichero. Evaluar `expo-audio` en una fase posterior.

Acción "Borrar audio" visible solo con `reuniones.borrar_audio` y solo si `COMPLETADA` con audio presente, con confirmación. Estados de carga por sección con `ActivityIndicator`, nunca bloqueo de pantalla completa.

---

## 15. Fases

0. Validación de la transcripción con audio real (§0). **Puerta de decisión.**
1. Tabla + script + presigned upload + CRUD + visibilidad + aviso de grabación. Estados `SUBIENDO`/`SUBIDO`.
2. Transcribe + poller + guardado de transcripción y segmentos.
3. Ampliación de `openaiClient` + resumen y acuerdos + `COMPLETADA`.
4. Borrado manual de audio; job automático después.
5. Q&A sobre la transcripción.
6. Frontend: listado, alta, detalle, consulta, borrar audio.

Posterior y fuera de este documento: grabación integrada, cruce con datos de negocio (requiere function calling y arreglar el filtrado de locales de `comprasVariaciones`), búsqueda entre reuniones, fuente IA para informes.

---

## 16. Criterios de aceptación

- [ ] La transcripción distingue hablantes de forma utilizable en audio real del grupo (validado en fase 0).
- [ ] Se sube un fichero de audio y, sin intervención manual, la reunión queda `COMPLETADA` con transcripción diarizada, resumen y acuerdos estructurados.
- [ ] Un fallo de Transcribe o de OpenAI deja la reunión en `ERROR` con motivo distinguible, sin perder lo ya obtenido, y es reintentable.
- [ ] Un usuario sin visibilidad sobre una reunión no la ve al listar ni puede leerla por ID directo.
- [ ] El borrado manual elimina el objeto de S3, conserva transcripción y resumen, y devuelve 409 si la reunión no está `COMPLETADA`.
- [ ] El audio se guarda cifrado en `eu-west-3` y el bucket no es públicamente accesible.
- [ ] Todos los endpoints exigen su permiso y el aviso de grabación queda registrado antes de permitir la subida.
- [ ] La consulta responde "no consta en la reunión" cuando la pregunta no tiene respuesta en la transcripción, en lugar de inventar.
