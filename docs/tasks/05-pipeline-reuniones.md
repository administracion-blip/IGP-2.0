# 05 · Pipeline de reuniones

Fase 2. Este documento describe el camino desde el audio hasta un acta con tareas
propuestas, y las garantías que debe cumplir.

## Puerta de decisión antes de escribir código

**Bloqueante.** Antes de implementar nada de esta fase: grabar 20-30 minutos de
una reunión real del grupo, transcribirla a mano con el proveedor candidato y
juzgar tres cosas.

1. ¿Distingue correctamente a los hablantes cuando se solapan?
2. ¿Acierta con nombres de locales, proveedores, proyectos y jerga interna?
3. ¿El texto resultante sirve para resumir sin corrección manual?

Si la respuesta a cualquiera de las tres es no, **se para y se reevalúa el
proveedor**. No se sigue con el resto de la fase. Todo lo demás de este documento
depende de que esta prueba salga bien, y sale más barato descubrirlo con una
reunión que con el módulo entero construido.

---

## La captura es intercambiable

Hay tres orígenes posibles de audio y el resto del pipeline no debe saber cuál se
usó. Un adaptador con la misma interfaz para los tres:

| Origen | Cuándo | Qué hace el adaptador |
|---|---|---|
| `meet` | Reunión por Meet con licencia que graba | Localiza la grabación (registro de conferencia de Meet), la descarga de Drive y la sube a S3 |
| `subida` | Reunión presencial, o quien no tenga licencia con grabación | Presigned `PUT` a S3 desde el cliente |
| `grabacion_app` | Reserva. Solo si algún día se graba dentro de la app | — |
| `transcripcion_importada` | Ya hay texto (p. ej. acta externa); `POST …/transcripcion/importar` | Escribe `transcripcion.json` en S3 y salta a `pipeline_estado = transcrita` (sin audio ni STT); el tick genera el resumen |

Interfaz común: *dado un `id_reunion`, dejar el audio en
`tasks/reuniones/<id>/audio.<ext>` y devolver duración y tamaño.* A partir de ahí
el pipeline es idéntico.

Esto no es purismo: la edición de Google Workspace es una decisión que puede
cambiar, y **el camino de `subida` debe seguir funcionando siempre** como respaldo
cuando la reunión es presencial, cuando Meet falla o cuando el organizador no
tiene la licencia que graba.

---

## Máquina de estados

Dos estados separados a propósito: el **estado de negocio** de la reunión y el
**estado técnico** del pipeline.

```
Negocio:  borrador → convocada → celebrada → acta_borrador → acta_validada
                                                    ↑
Pipeline:      audio_pendiente → transcribiendo → transcrita → resumiendo → (fin)
                                        ↓              ↓            ↓
                                      error          error        error
```

Por qué separados:

- Una reunión con acta manual (Fase 1B) llega a `acta_validada` **sin pasar por el
  pipeline**. Si fuera un solo campo, habría estados imposibles.
- `pipeline_estado` es un atributo **disperso**: existe solo mientras la reunión
  está en vuelo y **se borra** al terminar. Eso hace que `Pipeline-index` contenga
  únicamente las reuniones que el poller debe mirar, y que el poller no necesite
  ningún `Scan`.

`acta_borrador` no se alcanza automáticamente al terminar el resumen: el resumen
lo produce, pero pasar a `acta_validada` **siempre lo hace una persona**.

---

## El poller

No hay callback nativo fiable para todos los proveedores de transcripción, así que
se sondea, con el patrón que ya funciona en el repositorio.

- Función en `api/lib/jobs/scheduledTasks.js`, programada con `setInterval` en el
  callback de `listen` de `api/server.js`, **desfasada** respecto a los demás jobs.
- Llama a `POST /api/reuniones/pipeline/tick` con `internalSyncFetchHeaders()`.
- El path debe estar de alta en `INTERNAL_SYNC_POST_PATHS` (`api/lib/internalSync.js`);
  sin ese alta, el cron recibe `401`.
- Cada pasada: Query a `Pipeline-index`, y para cada reunión el paso que le toque.
- Configuración en `Igp_Ajustes`, PK `reuniones`, SK `pipeline`
  (`Enabled`, proveedor, modelo, máximo de intentos).
- Cadencia orientativa: 60 s. Una transcripción de una hora tarda minutos; sondear
  más rápido no acelera nada y cuesta llamadas.

**Cerrojo.** Se reutiliza `crearCerrojo()` de
`api/lib/facturacion/facturacionPeriodica.js`: ítem en `Igp_Ajustes` con `Put`
condicional, TTL, renovación y `confirmarParaEscribir()` para no escribir si se
perdió el cerrojo. Más el flag en memoria del patrón de
`facturacionPeriodicaJob.js`. No se escribe un mecanismo nuevo.

Aviso que debe quedar escrito: los flags en memoria asumen **un proceso**. Con
varias instancias del API el cerrojo de DynamoDB salva la corrección, pero los
`setInterval` duplicarían intentos.

---

## Idempotencia: no pagar dos veces

La transcripción y el resumen se lanzan **una sola vez por reunión**. Reprocesar no
debe duplicar ni volver a pagar.

| Garantía | Cómo |
|---|---|
| No relanzar transcripción | Si `transcripcion_job_id` existe, no se arranca otra. `POST /procesar` es idempotente |
| No repetir resumen | Se guarda `transcripcion_hash`. Si al resumir el hash coincide con el del resumen ya generado, no se llama al modelo |
| No duplicar tareas al validar | La creación en lote ignora propuestas cuyo `propuesta_origen_id` ya generó tarea |
| No procesar dos veces en paralelo | Cerrojo por reunión |
| Reintentos acotados | `intentos`, con máximo configurable. Al agotarse, `error` con motivo y sin más reintentos automáticos |
| Coste medido | `coste_ia` en la reunión, alimentado con el `usage` que devuelve `chatCompletion` |

**Un fallo nunca pierde lo ya obtenido.** Si el resumen falla, la transcripción
queda guardada y la reunión va a `error` con `pipeline_error_fase = 'resumen'`,
reintentable desde ese punto. Nunca se vuelve a transcribir por un fallo de IA.

---

## Vocabulario esperado

Antes de transcribir se extraen del **orden del día congelado** los nombres propios
y términos específicos (locales, proveedores, proyectos, jerga interna) y se pasan
al motor como vocabulario esperado. Es la vía más barata de subir la precisión en
nombres propios.

- Se guardan en `vocabulario_esperado` para poder auditar qué se envió.
- Cada proveedor lo consume distinto (vocabulario personalizado previo, o lista de
  términos por petición): **lo traduce el adaptador**, la interfaz común recibe
  siempre «lista de términos».
- Si no hay orden del día, se transcribe igual, algo menos preciso.

Se puede enriquecer con nombres de locales y proveedores reales del ERP. Es
opcional y se decide al implementar: mejora la precisión pero engorda la lista, y
las listas muy largas degradan a algunos motores.

---

## Resumen y extracción

Se usa `chatCompletion()` de `api/lib/ia/openaiClient.js`. Necesita tres
ampliaciones **aditivas y retrocompatibles**, sin alterar el comportamiento por
defecto para no afectar al OCR ni a los informes:

1. `responseFormat` opcional, que se traslade a `response_format: { type: 'json_object' }`.
2. `maxTokens` opcional (hoy no se envía).
3. Poder subir el tiempo máximo de espera: una transcripción de una hora ronda las
   decenas de miles de tokens de entrada y los 90 s por defecto se quedan cortos.

Entrada al modelo: orden del día congelado, lista de asistentes y transcripción con
hablantes. Salida esperada, en JSON:

- `resumen`: acta redactada, por temas.
- `acuerdos`: cada uno con texto, **cita literal**, responsable sugerido y fecha.
- `tareas_propuestas`: título, descripción, **cita literal**, responsable sugerido,
  fecha sugerida.
- `cobertura`: por cada punto del orden del día, `tratado` / `parcial` /
  `no_tratado`, con cita.
- `emergentes`: temas tratados que no estaban previstos.

Reglas de redacción, que van en el prompt y este es su sitio de referencia:

- **Nada sin cita.** Un acuerdo o una tarea sin fragmento que la respalde se
  descarta al validar la respuesta, no se muestra.
- Los responsables se sugieren **solo** entre los asistentes registrados. Un
  nombre que no case con un usuario se deja vacío para que lo ponga la persona.
- Si algo no consta, se dice. No se rellena.

El prompt vive en `Igp_IaPrompts` (`api/lib/ia/promptsStore.js`) para poder
afinarlo sin desplegar. Es la pieza que más iteración va a necesitar.

**JSON inválido no rompe la reunión**: se parsea con tolerancia y, si no hay forma,
la reunión queda en `error` con fase `resumen`, conservando la transcripción.

---

## Cobertura del orden del día

El sistema descompone el orden del día **congelado** en puntos y clasifica cada
uno con su cita. Consecuencias automáticas:

- Los puntos `no_tratado` se marcan `aplazado` y `candidato_siguiente`.
- Los temas tratados sin estar previstos se guardan como `emergentes`.
- En Fase 4, la siguiente reunión de la serie propone su orden del día con los
  aplazados y los acuerdos incumplidos; en Fase 1B eso mismo se ofrece como
  **texto editable** vía `GET /api/reuniones/:id/sugerencia-orden-del-dia`.

Se compara **siempre contra la copia congelada**, nunca contra el orden del día
editado después de empezar. Si no, alguien podría reescribir el orden del día a
posteriori y salir con una cobertura del 100 %.

---

## Retención y borrado del audio

**Borrado manual** (`DELETE /api/reuniones/:id/audio`): exige acta validada y audio
presente; si no, `409` con motivo. Borra el objeto de S3, marca
`audio_estado = 'borrado'` y `audio_borrado_en`, vacía `audio_s3_key`, y escribe en
`Igp_Actividad`. **Conserva transcripción y acta.**

**Borrado automático**: job diario que recorre las reuniones con acta validada y
audio más antiguo que el plazo de retención, reutilizando exactamente la lógica del
manual. Se implementa **después** de que el manual esté validado en producción.
Configuración en `Igp_Ajustes`, PK `reuniones`, SK `retencion_audio`.

**Los audios de reuniones en error no los toca el job**, porque borrarlos
impediría reintentar. Y eso significa que se acumulan. La decisión, que hay que
tomar explícitamente y no dejar a medias:

- Si se pone una **regla de ciclo de vida en S3** como red de seguridad, hay que
  aceptar que también borrará audios no transcritos y con ellos la posibilidad de
  reintentar.
- La alternativa es un aviso cuando un audio en error supera X días, y decidir a
  mano.

Está registrada como decisión abierta en [08](08-decisiones.md). Lo que no vale es
dejar las dos reglas contradiciéndose.

---

## Privacidad

No es un apartado de cortesía: condiciona el diseño.

- **Aviso de grabación antes de grabar**, con registro de los asistentes informados
  y de quién acepta (`aviso_grabacion`). **Sin aceptación no se emite la URL de
  subida.** No es un aviso decorativo: es una precondición del endpoint.
- Cifrado en reposo (`AES256` explícito en el `PutObject`) y en tránsito. Dato en
  `eu-west-3`.
- Bucket sin acceso público. Toda lectura por URL firmada de duración corta.
- Retención del audio corta y configurable; transcripción y acta se conservan.
- Todo acceso pasa por permiso **y** filtro de visibilidad en servidor.
- **El resumen envía el contenido de la transcripción a un tercero.** Es una
  transferencia a un proveedor externo y debe constar en el registro de
  tratamientos. La interfaz lo advierte donde se lanza el procesado.
- Derecho de supresión: `DELETE /api/reuniones/:id` borra registro, audio y evento
  de calendario.

---

## Errores y reintentos

| Situación | Comportamiento |
|---|---|
| Audio no está en S3 al procesar | `409`. No se arranca el trabajo |
| Audio demasiado largo o grande para el proveedor | Se rechaza al pedir el presign, con mensaje claro. No se descubre a mitad del pipeline |
| Transcripción falla | `error`, fase `transcripcion`, reintentable. El audio se conserva |
| Resumen falla | `error`, fase `resumen`. **La transcripción se conserva** y el reintento no vuelve a transcribir |
| JSON inválido del modelo | Igual que fallo de resumen |
| Se agotan los intentos | `error` definitivo. Solo reintento manual explícito |
| El poller cae a mitad | El cerrojo expira por TTL y la pasada siguiente retoma. Ningún paso queda a medias sin marca |

---

## Tests obligatorios

La otra zona del módulo donde se exigen pruebas. Con `node:test` y
`api/tests/dynamoMemoria.mjs`.

- [ ] `POST /procesar` dos veces seguidas arranca **un solo** trabajo.
- [ ] Con `transcripcion_hash` sin cambios, no se vuelve a llamar al modelo.
- [ ] Fallo de resumen deja la transcripción guardada y el reintento no transcribe
      de nuevo.
- [ ] Al terminar, `pipeline_estado` desaparece del ítem (y por tanto del índice).
- [ ] Validar la misma propuesta dos veces crea **una sola** tarea.
- [ ] Una propuesta sin cita no se muestra.
- [ ] Sin aviso de grabación aceptado no se emite URL de subida.
- [ ] El borrado de audio con acta no validada devuelve `409`.
- [ ] La cobertura se calcula contra el orden del día congelado, aunque el campo
      editable haya cambiado.
