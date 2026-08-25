# 01 · Visión y alcance

## El problema

Grupo Paripe no tiene un sistema propio para dirigir sus proyectos internos
transversales (RRHH, marketing, I+D, nuevos negocios, obras, operaciones,
finanzas), ni para las tareas que salen de ellos, ni para las reuniones donde se
deciden. Los acuerdos de una reunión se pierden entre la reunión y la siguiente.

## El ciclo completo que debe soportar

1. Se convoca una reunión con un orden del día escrito sin fricción.
2. Se graba.
3. Se transcribe distinguiendo quién habla.
4. La IA genera un acta con decisiones y **tareas propuestas**.
5. Una persona valida esas propuestas.
6. Quedan como tareas con **un** responsable y una fecha.
7. Aparecen en el calendario y en la vista personal de cada uno.
8. En la reunión siguiente el sistema recuerda qué se acordó y qué sigue sin
   cumplirse.

## Por qué no Asana ni ClickUp

Se valoraron y se descartan. El valor diferencial está en integrarse con
**nuestros** usuarios, **nuestros** roles y **nuestras** entidades de negocio
(locales, proveedores, artículos, actuaciones, cuentas bancarias, facturas). Una
herramienta comercial obliga a mantener un censo de personas paralelo y no puede
vincular una tarea a un proveedor real del ERP.

Consecuencia directa sobre el alcance: **es deliberadamente estrecho**. Se
replica el núcleo que se usa a diario, no el catálogo de funciones de una
herramienta comercial. Si algo se puede resolver con una lista de comprobación
dentro de una tarea, no se convierte en una función nueva.

## Principios de producto no negociables

**La IA propone, el humano decide.** Ninguna tarea, acuerdo ni asignación se crea
sin confirmación explícita de una persona. Es el mismo principio que ya se aplica
en el motor de aprovisionamiento (MIA) y en la conciliación bancaria: la máquina
prepara el trabajo, la persona firma.

**Todo lo que propone la IA lleva su cita literal.** Cada tarea propuesta, cada
acuerdo y cada punto del orden del día clasificado arrastra el fragmento de
transcripción que lo justifica, para poder verificarlo en segundos. Sin cita, no
se muestra.

**Un solo responsable por tarea.** No hay responsables compartidos. Si hace falta
implicar a más gente: menciones, o subtareas con su propio responsable único.

**Web primero, móvil y tablet funcionales.** El uso principal es escritorio, como
en el resto de IGP. Pero una tarea se consulta y se marca desde el móvil, así que
la vista personal y el detalle de tarea deben funcionar bien en pantalla pequeña
(`useBreakpoint()`, `MIN_TOUCH`, ver `ui-responsive.mdc`).

**La confidencialidad es parte del modelo de datos.** Las reuniones de dirección
contienen datos de personas y salarios. La visibilidad no es un añadido
posterior: es un campo de la reunión y se filtra **siempre en el servidor**.

## Los departamentos son etiqueta, no candado

Un usuario pertenece a uno o varios departamentos. Eso sirve para **agrupar,
filtrar y titular**: «la gente de Contabilidad», «proyectos de Marketing».

**No restringe asignaciones.** A alguien de Contabilidad se le puede asignar una
tarea de un proyecto de Marketing sin pertenecer a ese departamento; basta
asignársela o mencionarle con `@nombre`. Cualquier diseño que impida eso está
mal.

**Y no es control de acceso.** La confidencialidad de una reunión de dirección
no se resuelve con el departamento del usuario: es un candado aparte (ver
[04 · Permisos y acceso](04-permisos-y-acceso.md)).

## El orden del día

Toda reunión tiene un campo de texto libre y extenso con los temas a tratar. Se
rellena al convocar y se puede editar hasta que empieza.

Debe escribirse **sin fricción**: texto corrido, tal como lo escribiría alguien
con prisa desde el móvil. No se obliga a numerar puntos ni a rellenar campos
estructurados. **La estructura la deriva el sistema, no la persona.**

Cumple cuatro funciones, y las cuatro están contempladas en el diseño:

| Función | Dónde se resuelve |
|---|---|
| Contexto para los asistentes | Se vuelca en la descripción del evento de Google Calendar al convocar (Fase 1B) |
| Mejorar la transcripción | Se extraen nombres propios y jerga y se pasan al motor como vocabulario esperado (Fase 2) |
| Contexto para el resumen | Se entrega al modelo junto con la transcripción y los asistentes (Fase 2) |
| Control de cobertura | Se descompone en puntos y cada uno se clasifica como tratado, parcial o no tratado, con cita (Fase 2) |

Los puntos **no tratados** pasan automáticamente a temas aplazados y quedan
marcados como candidatos al orden del día de la reunión siguiente. Los temas que
se trataron **sin estar previstos** se marcan como emergentes.

**Copia congelada.** Al arrancar la grabación se guarda una copia del orden del
día. Si alguien lo edita después, el análisis de cobertura sigue comparando
contra la versión congelada, no contra la editada. El campo y su copia forman
parte del esquema desde el inicio, aunque el análisis no llegue hasta la Fase 2.

**Se puede convocar sin orden del día.** El sistema funciona igual, solo que sin
análisis de cobertura y con una transcripción algo menos precisa. No es
obligatorio, pero la interfaz avisa de lo que se pierde al omitirlo.

## Qué queda fuera, y para cuándo

| Fuera de… | Qué | Cuándo |
|---|---|---|
| Fase 1A | Todo lo de IA y todo lo de Google | 1B y 2 |
| Fase 1B | Audio, transcripción, acta automática | 2 |
| Fase 2 | Plantillas, orden del día automático, cuadro de mando, actas en PDF | 4 |
| Fase 4 | Enganche de líneas de compra con conciliación bancaria | Sin fecha. El esquema lo permite sin migración |
| Todo el módulo | Búsqueda semántica entre reuniones, consulta cruzada con datos de negocio (ventas, compras, objetivos) | Sin fecha, con diseño propio |
| Todo el módulo | Chat o mensajería general. Los comentarios de una tarea no son un chat | — |
| Todo el módulo | Diagramas de Gantt, dependencias entre tareas, cargas de trabajo | — |

## Fronteras con módulos existentes

**Mantenimiento.** Una incidencia de mantenimiento **nunca** se convierte en
tarea de proyecto. Tiene su propio ciclo, sus fotos y su facturación. Se puede
referenciar desde una tarea mediante vínculo, y ahí acaba la relación. Sin esta
frontera, en tres meses habría dos sitios donde mirar «qué tengo pendiente» y la
vista personal perdería su razón de ser.

**Planning del día.** Es la vista operativa del local: qué pasa hoy aquí. Las
tareas de proyecto son transversales y no operativas del día. Aparecen en
`planning-dia` como **tarjeta de resumen** («tienes N tareas, M vencidas») que
lleva a la vista personal, no como gestión completa.

**Facturación y compras.** Las líneas de compra de un proyecto son una
**previsión de gasto**, no un documento contable. No emiten factura ni pedido.
Pueden apuntar a un proveedor real y, más adelante, casarse con un cargo
bancario; nada más.

**Actuaciones, cajas, cierres.** Sin relación funcional. Solo pueden aparecer
como entidad vinculada a una tarea.

## Cómo se mide si ha funcionado

El riesgo número uno no es técnico: es construirlo y que nadie lo use. Por eso el
orden de fases no se altera. Señales de que la Fase 1A ha funcionado, antes de
invertir en la Fase 2:

- La gente entra a su vista personal sin que nadie se lo recuerde.
- Las tareas se cierran en el sistema, no en un grupo de WhatsApp.
- Hay tareas creadas por personas distintas de quien montó el módulo.

Si la Fase 2 llega antes de que exista ese hábito, lo que genere la IA caerá en
el vacío.
