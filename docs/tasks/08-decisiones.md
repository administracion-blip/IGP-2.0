# 08 · Decisiones

Registro de decisiones del módulo. Las **cerradas** no se reabren sin anotarlo aquí
con fecha y motivo. Las **abiertas** las cierra el responsable del proyecto: ningún
agente decide por su cuenta.

---

## Cerradas

### D-01 · Los departamentos son etiqueta, no candado — 25/08/2026

Un usuario lleva en su ficha uno o varios departamentos. Sirve para agrupar,
filtrar y titular. **No restringe asignaciones**: a alguien de Contabilidad se le
puede asignar una tarea de un proyecto de Marketing, y basta mencionarle con
`@nombre`. **Y no es control de acceso**: la confidencialidad de reuniones es un
candado aparte.

*Motivo:* el trabajo real cruza departamentos constantemente. Un modelo que lo
impida obligaría a inventar excepciones desde el primer día.

*Consecuencia:* campo `Departamentos` en `igp_usuarios` con **IDs** (no nombres,
al contrario que `Locales`), y maestro pequeño en `Igp_Ajustes`.

### D-02 · Web primero; móvil y tablet funcionales — 25/08/2026

El uso principal es escritorio, como el resto de IGP. Móvil y tablet deben
funcionar bien para consultar y marcar tareas, pero **no** se diseña móvil-first ni
se convierte la notificación push en prerrequisito de ninguna fase.

*Motivo:* la app es hoy fundamentalmente web (`expo start --web`), sin build nativa
ni configuración de EAS. Hacer depender una fase de push obligaría a abrir la
distribución nativa, con su firma, tiendas y ciclo de release.

*Consecuencia:* los avisos van por email (Fase 1A) y por campana interna y feed de
calendario (Fase 3). Si algún día se quiere push real, se decide entonces.

### D-03 · Se sube la edición de Google Workspace; Meet es el camino principal — 25/08/2026

La captura de audio por Meet es el camino principal de la Fase 2. **La subida
manual del fichero sigue existiendo siempre** como respaldo: reunión presencial,
fallo de Meet, u organizador sin la licencia que graba.

*Consecuencia:* el adaptador de captura es intercambiable por diseño
([05](05-pipeline-reuniones.md)) y ninguna fase queda bloqueada si la licencia
tarda.

### D-04 · Los diseños anteriores se archivan, no se reutilizan — 25/08/2026

`PROMPT-MODULO-REUNIONES.md`, `cursor-proyectos-prompt.md`,
`cursor-agenda-proyectos-completo-prompt.md` y `cursor-agenda-prompt.md` se
trasladaron a `docs/tasks/legacy/`.

*Motivo:* cuatro documentos proponían esquemas distintos para las mismas entidades
y ninguno se implementó. Se archivan en lugar de borrarse porque contienen
decisiones bien razonadas que este documento sí recoge (modelo de visibilidad,
aviso de grabación, política de borrado de audio, menciones).

### D-05 · La transcripción va a S3, no al ítem de DynamoDB — 25/08/2026

En el ítem quedan el acta y los metadatos; la transcripción con hablantes se guarda
como JSON en S3 y se sirve por URL firmada.

*Motivo:* una reunión larga con segmentos y marcas de tiempo se acerca al límite de
400 KB por ítem, y ese límite no avisa hasta que un día falla al guardar la reunión
importante. Se aparta del diseño archivado, que la guardaba en el ítem.

### D-06 · Registro de actividad genérico desde el principio — 25/08/2026

Una sola tabla `Igp_Actividad` para proyectos, tareas, líneas de compra y
reuniones, con PK `<TIPO>#<id_entidad>`.

*Motivo:* el patrón de `Igp_FacturasAuditoria` funciona, pero está duplicado en
media docena de sitios y es específico de facturas. Genérico desde el inicio evita
cuatro tablas de auditoría y cuatro funciones `registrarAuditoria` distintas.

### D-07 · La imagen de un enlace se descarga y se guarda en S3 — 25/08/2026

No se enlaza la imagen del destino: se descarga y se almacena.

*Motivo:* el requisito es que la captura sea una foto del momento que no se
refresca. Enlazar la imagen del destino haría que la tarjeta quedara rota a los
meses, justo cuando la prueba de qué se pidió y por cuánto importa.

### D-08 · Los avisos de vencimiento se adelantan a la Fase 1A — 25/08/2026

Aviso por email de tareas que vencen, en 1A. La campana y el feed de calendario
siguen en la Fase 3.

*Motivo:* la Fase 1A existe para crear el hábito. Una lista que no avisa se
convierte en una lista que nadie mira.

### D-09 · `igp_usuarios` es la única fuente de autorización — 25/08/2026

Ya existe un segundo censo de personas (`Igp_Empleados`, desde Factorial HR) y en
Fase 3 aparecería un tercero (Google Directory). Directory **solo enriquece**
campos concretos; **nunca crea usuarios, ni asigna permisos, ni borra a nadie** de
forma automática.

*Motivo:* tres censos sin una regla de precedencia escrita acaban en un usuario que
no puede entrar o, peor, en uno que entra sin deber.

### D-10 · Estado y pipeline de la reunión son campos separados — 25/08/2026

`estado` (negocio) y `pipeline_estado` (técnico, y **disperso**: existe solo
mientras está en vuelo).

*Motivo:* una reunión con acta manual llega a validada sin pasar por el pipeline;
con un solo campo habría estados imposibles. Y al ser disperso, el poller consulta
un índice minúsculo en lugar de recorrer la tabla.

### D-11 · Rutas `/proyectos` y `/reuniones`, permisos `proyectos.*` y `reuniones.*` — 26/08/2026

Cierra A-01. Lo que ve el usuario va en español, como el resto del menú
(`/facturacion`, `/mantenimiento`, `/planning-dia`). «Tasks» queda **solo** para
nombres internos de fichero y carpeta: `api/lib/tasks/`, `app/types/tasks.ts`,
`docs/tasks/`.

*Motivo:* de la ruta salen los códigos de permiso, que se escriben además en la
pantalla de permisos, en `api/ROLES-PERMISOS.md`, en el sidebar y en cada router.
Decidirlo antes de la Fase 1A no cuesta nada; después es un renombrado en cinco
sitios.

### D-12 · Campo `Departamentos` en `igp_usuarios`, aprobado — 26/08/2026

Consecuencia de D-01, aprobada expresamente por ser la tabla que sostiene el login.
Lista de **IDs** de departamento, atributo disperso —ausente en quien no tenga
ninguno— y tratado como lista vacía cuando falta. No se toca ningún otro atributo
de la tabla: `Email`, `Password`, `Rol` y `Locales` quedan como están.

*Motivo:* el alta la hace el mismo formulario que ya edita el usuario, y tener el
dato en la ficha evita una tabla de relación y una lectura extra en cada petición.

### D-13 · `tareas.editar_todas` no alcanza a los proyectos — 26/08/2026

El permiso deja editar cualquier tarea, incluidas las de proyectos ajenos, pero
**no** editar el proyecto en sí.

*Motivo:* editar un proyecto incluye gestionar sus miembros. Si el permiso llegara
ahí, quien lo tuviera se añadiría como miembro de cualquier proyecto y a partir de
ese momento lo vería entero por la vía legítima. La escalada la habría concedido la
capa de acceso, no el router.

### D-14 · El escalón de aprobación sale de la posición, no del permiso — 26/08/2026

`proyectos.compras_aprobar` habilita a participar en aprobaciones —lo comprueba la
ruta— pero no otorga por sí mismo el nivel `direccion`. El nivel se decide por
posición: dirección (lista de A-07), responsable del departamento, o responsable
del proyecto.

*Motivo:* con el permiso equivaliendo a dirección, a quien se le concede para que
firme compras de 200 € se le estarían dando también las de 40.000 €. Además dejaba
A-07 cerrada de hecho, y por la vía más laxa, sin haberla decidido.

*Consecuencia:* `nivelAprobacionDe` recibe `aux.esDireccion` del llamante, igual
que `esResponsableDepartamento`. Mientras A-07 no se cierre, solo Administrador
alcanza el nivel de dirección.

### D-15 · `Locales` vacío sigue significando «todos los locales» — 26/08/2026

Se mantiene la convención del resto del ERP también en las reuniones con
`visibilidad = local`.

*Motivo:* hacer una excepción solo aquí obligaría a explicar por qué el mismo
usuario ve todas las cajas y solo algunas reuniones. Es coherente, pero es la
puerta más ancha del módulo y hay que tenerlo presente al dar de alta usuarios de
oficina: sin ningún local en su ficha, ven las reuniones de local de todo el grupo.

*Consecuencia:* lo confidencial no se protege con `local`, se protege con
`restringida`, que no depende de los locales del usuario.

### D-16 · Lo que no se ve responde `404`, no `403` — 26/08/2026

En proyectos y tareas, no alcanzar una fila da `404`, indistinguible de que no
exista. El `403` queda para «la veo pero no puedo tocarla».

*Motivo:* un `403` confirma que la fila existe a quien ya ha demostrado que no le
corresponde saberlo. Y sobre todo: los dos routers tenían que responder igual, o la
interfaz acabaría tratando cada caso de una forma según el endpoint.

### D-17 · `DELETE /api/proyectos/:id` borra también las tareas — 27/08/2026

`DELETE` es siempre borrado físico: el proyecto y las tareas que cuelgan de él
(vía `Proyecto-index`, sin `Scan`). Las tareas de otros proyectos no se tocan.
El historial (`Igp_Actividad`) se conserva. Cancelar sin borrar sigue siendo
`PATCH { estado: 'cancelado' }`.

La versión anterior (26/08/2026) respondía `409` si había tareas y remitía a
cancelar, para no dejar `proyecto_id` huérfano. Quien tiene `proyectos.borrar`
necesita poder vaciar un proyecto equivocado; la cascada evita el huérfano y
el `409`. El cliente no cambia de verbo: `DELETE` borra, `PATCH` cancela.

### D-18 · `GET /api/tareas` exige `proyecto` o `responsable` — 26/08/2026

El listado general de tareas no existe sin al menos uno de los dos filtros; sin
ellos responde `400`. Pedir `responsable` con un estado terminal también se rechaza.

*Motivo:* no hay índice de «todas las tareas», y no lo hay a propósito. La única
forma de servir ese listado sería un `Scan`, que es justo lo que el modelo de datos
evita. El índice de responsable contiene solo tareas abiertas, así que el histórico
de cerradas se consulta por proyecto.

### D-19 · El nombre del autor viaja en el contexto de acceso — 26/08/2026

`cargarContextoAcceso` devuelve también `nombre`, y de ahí lo toman el historial y
los comentarios.

*Motivo:* el historial no debe mostrar ids crudos a quien no tenga `usuarios.ver`,
pero resolver el nombre en cada escritura era un `GetItem` por escritura. La ficha
del usuario ya se lee para el rol y los permisos, y la caché de 60 s la absorbe: el
nombre sale gratis. Sin esto, cada router lo resolvía a su manera —uno leyendo, otro
dejándolo vacío— y el historial salía distinto según la entidad.

### D-20 · Cuándo «empieza» la reunión (bloqueo del orden del día) — 26/08/2026

En Fase 1B, el `orden_del_dia` deja de ser editable al pasar a `celebrada` (o
`acta_borrador` / `acta_validada`). En ese tránsito se copia a
`orden_del_dia_congelado` si aún no había copia. Un `PATCH` del orden después
responde `409`.

*Motivo:* el modelo hablaba de congelar «al arrancar la grabación», pero la
grabación es Fase 2. Hacía falta un disparador usable ya. El estado `celebrada` es
explícito y no depende del reloj del servidor. En Fase 2, al iniciar la grabación,
se re-congela si aún no había copia.

### D-21 · Fallo de Calendar al convocar no tumba la reunión — 26/08/2026

Si Google falla o no está configurado, la reunión se crea igual en DynamoDB sin
`calendar_event_id`, y la respuesta avisa (`calendario_sincronizado: false` o
equivalente). La UI lo muestra con honestidad.

*Motivo:* la fase tiene que ser desplegable antes de tener la service account, y un
corte de Google no puede impedir convocar. El mismo criterio aplica a PATCH/DELETE
del evento: se intenta y se registra el fallo sin revertir el cambio local.

### D-22 · Navegación de reuniones — 26/08/2026

Rutas en `app/(app)/reuniones/**`. **No** tienen entrada propia en el menú lateral:
se abren desde la tarjeta del hub de `/proyectos`. El ítem «Proyectos» del lateral
aparece con `proyectos.ver` **o** `reuniones.ver`, para que quien solo gestione
reuniones no se quede sin puerta. Los permisos de API siguen siendo `reuniones.*`.

*Actualizado el mismo día:* la entrada lateral suelta se retiró para no duplicar
el módulo (mismo criterio que Acuerdos bajo Compras).

### D-23 · Acuerdos → tareas en un solo camino de servidor — 26/08/2026

Convertir acuerdos en tareas lo hace el servidor (envuelve la creación en lote y
enlaza `acuerdo.tarea_id`). No se deja a la UI hacer `POST /tareas/lote` + `PATCH`
por su cuenta: un doble clic a medias dejaría acuerdos sin enlace.

---

## Abiertas

### A-02 · Proveedor de transcripción

**Recomendación: decidir con la transcripción delante, no con la tabla de
precios.** En la puerta de decisión de la Fase 2, probar el mismo audio real con
dos candidatos: el servicio genérico de AWS (no añade proveedor ni saca el dato de
la cuenta) frente a un especializado en diarización (suele costar un orden de
magnitud menos y acertar más en español coloquial).

*Impacto:* es el único factor con efecto real en el coste variable, hasta 6× de
diferencia. Ver [07](07-coste.md).

### A-03 · Modelo de lenguaje para el acta

**Recomendación: reutilizar `chatCompletion()` con el proveedor que ya está en
producción, y usar el modelo bueno, no el barato.**

*Motivo:* el coste del resumen es de céntimos frente a la transcripción, y es la
pieza que decide si el acta sirve. Introducir un proveedor nuevo añadiría clave,
cliente y modo de fallo por un ahorro irrelevante.

### A-04 · Plazo de retención del audio

**Recomendación: 30 días, configurable, y borrado solo con acta validada.**

*Motivo:* menos margen (el plazo de 7 días del diseño archivado) no deja reprocesar
cuando en la reunión siguiente alguien descubre que el acta se comió un acuerdo. El
coste de almacenar es despreciable, así que aquí no se ahorra nada recortando.

### A-05 · Qué hacer con el audio de reuniones en error

El job de retención no los toca, porque borrarlos impide reintentar, así que se
acumulan. Dos caminos incompatibles:

1. Regla de ciclo de vida en S3 como red de seguridad, **aceptando** que borrará
   también audios no transcritos.
2. Aviso cuando un audio en error supera X días, y decisión manual.

**Recomendación: la 2.** Una regla de ciclo de vida y un job con reglas distintas
sobre el mismo objeto acaban contradiciéndose, y el caso perdido siempre es el que
más importaba.

### A-06 · Vencimientos: feed de calendario o escribir eventos por API

**Recomendación: feed ICS firmado por usuario** (`GET /api/tasks/vencimientos.ics`),
en lugar de escribir eventos en un calendario secundario de cada persona.

*Motivo:* es una fracción del trabajo, se actualiza solo, no puede corromper el
calendario de nadie y funciona igual en Google, Outlook y Apple. Escribir por API
solo aporta si hace falta que la persona modifique el evento desde su calendario, y
para un vencimiento de tarea eso es más riesgo que función.

*Si se elige la API:* hay que resolver qué pasa cuando alguien borra el evento a
mano, y eso es una fuente de incidencias permanente.

### A-07 · Quién es «dirección» para aprobar compras

Los umbrales están definidos, pero no quién ocupa el nivel más alto.

**Recomendación: una lista de usuarios en configuración**, no un rol nuevo.

*Motivo:* el rol es global y afectaría a todo el ERP; aquí solo se necesita saber
quién firma por encima del segundo umbral. Una lista es reversible y no toca el
sistema de roles.

*Estado del código:* la capa de acceso ya está preparada y **no prejuzga la
respuesta** (D-14): recibe `aux.esDireccion` de quien la llama. Mientras esto no se
cierre, solo Administrador alcanza el nivel de dirección.

### A-08 · Importes de los umbrales

Faltan las dos cifras. Viven en configuración
(`Igp_Ajustes`, PK `proyectos`, SK `compras`) y **nunca en el código**, así que se
pueden fijar en la Fase 4 y cambiar luego. No bloquean nada.

*Ojo:* hasta que se configuren, **toda línea de compra exige nivel de dirección**.
Es deliberado: el nivel se congela al crear la línea, así que el lado inseguro no
tendría vuelta atrás. Ver `nivelRequeridoParaImporte`.

### A-09 · ¿Grabación dentro de la app?

**Recomendación: no, y quitarlo del alcance mientras la respuesta a D-02 siga
siendo «web primero».**

*Motivo:* grabar en navegador una reunión de dos horas es el punto de fallo más
probable de todo el módulo, y hacerlo bien en móvil obliga a distribución nativa.
Con Meet grabando y la subida manual como respaldo, no aporta.

### A-10 · Bucket dedicado para el audio o prefijo en el bucket actual

**Recomendación: prefijo `tasks/` en el bucket existente**, con cifrado explícito y
CORS para `PUT`.

*Motivo:* un bucket aparte solo se justifica si el audio necesita una política de
ciclo de vida o de acceso incompatible con el resto, y con la recomendación de A-05
no la necesita. Si se elige la opción 1 de A-05, entonces sí conviene bucket
dedicado, porque una regla de ciclo de vida a nivel de bucket afectaría a facturas
y adjuntos.

### A-11 · Enriquecer el vocabulario con datos del ERP

Además de los términos del orden del día, se podrían enviar nombres de locales y
proveedores reales.

**Recomendación: no en la primera versión.** Medir primero la precisión con solo el
orden del día. Las listas muy largas degradan a algunos motores, y no tiene sentido
pagar ese riesgo antes de saber si hace falta.

### A-12 · Limpieza del árbol de trabajo antes de la Fase 1A

No es una decisión de diseño, pero bloquea el reparto entre agentes: hay muchos
cambios a medias de otros módulos sin consolidar.

**Recomendación: consolidarlos antes de abrir la Fase 1A.** Trabajar con una rama
por agente y un integrador sobre un árbol así genera conflictos que no tienen nada
que ver con este módulo.
