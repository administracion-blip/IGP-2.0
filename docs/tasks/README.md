# Módulo de dirección — proyectos, tareas y reuniones

Documento maestro del módulo. Es la **referencia compartida** por todas las fases
y por todos los agentes que trabajen en él. Si el código y este documento
discrepan, discrepa el código.

Estado (31/08/2026): **MVP cerrado** (smoke producto + tests API). Código de
1A–1B + 2 (pipeline + importar texto + propuestas) + 3 (campana/ICS) usable.
Detalle del cierre: [09 · Smoke MVP](09-smoke-mvp.md). **Fase 4 no iniciada**
(cuadro de mando oculto en el hub hasta implementarla).

## Índice

| Documento | Contenido |
|---|---|
| [01 · Visión y alcance](01-vision-alcance.md) | Qué resuelve, principios de producto, qué queda fuera, fronteras con otros módulos |
| [02 · Modelo de datos](02-modelo-datos.md) | Esquema completo de **todas** las fases: tablas, claves, índices, campos y tipos compartidos |
| [03 · Contrato de API](03-contrato-api.md) | Todos los endpoints, incluidos los que aún no se implementan |
| [04 · Permisos y acceso](04-permisos-y-acceso.md) | Permiso global + ACL de fila, resuelto en un único punto |
| [05 · Pipeline de reuniones](05-pipeline-reuniones.md) | Captura de audio, transcripción, acta, cobertura del orden del día, idempotencia |
| [06 · Fases y dependencias](06-fases-y-dependencias.md) | Qué bloquea a qué, qué va en paralelo, criterios de cierre de cada fase |
| [07 · Coste](07-coste.md) | Coste recurrente por reunión y por usuario, con números |
| [08 · Decisiones](08-decisiones.md) | Cerradas (con fecha y motivo) y abiertas (con recomendación) |
| [09 · Smoke MVP](09-smoke-mvp.md) | Cierre MVP (31/08/2026): checklist + resultado del smoke |
| [legacy/](legacy/) | Diseños anteriores archivados. **No usar como referencia** |

Las reglas de trabajo que el agente debe respetar sin leerse todo esto están en
`.cursor/rules/modulo-tasks.mdc`.

## Estado de las fases

| Fase | Contenido | Estado |
|---|---|---|
| **0** | Contrato aprobado, capa de acceso, maestro de departamentos | **Completa.** Tipos, capa de acceso (73 pruebas), maestro de departamentos con su pantalla, campo en la ficha de usuario y permisos en el catálogo |
| **1A** | Proyectos, departamentos, tareas, permisos, vista personal | **Completa en código** (26/08/2026). Servidor, pantallas, enlaces/adjuntos en ficha y tarjeta en `planning-dia`. Queda probar a mano la vista personal en móvil |
| **1B** | Reuniones con acta manual, evento en Calendar, detección de sala | **Completa en código + smoke Calendar** (29/08/2026). Tests de visibilidad, orden congelado y acuerdos→tareas OK |
| **2** | Captura de audio, transcripción, resumen, cola de validación | **MVP cerrado** (31/08/2026): 2A–2F + importar texto; smoke producto OK ([09](09-smoke-mvp.md)). Quedan opcionales de fase estricta (purga audio, `coste_ia`, aplazados→serie) |
| **3** | Vencimientos en calendario, sincronización de usuarios, avisos | **MVP cerrado** en campana + ICS (código + smoke). Directory real sigue stub (fuera de MVP) |
| **4** | Plantillas, orden del día automático, cuadro de mando, actas PDF, compras | **No iniciada.** Siguiente horizonte de madurez tras el MVP |

Mantener esta tabla al día es responsabilidad del agente integrador al cerrar
cada fase.

## Cómo usar este documento

1. **Antes de escribir código**, lee el documento de tu fase en
   [06 · Fases y dependencias](06-fases-y-dependencias.md) y el apartado del
   modelo de datos que vas a tocar.
2. **El esquema está diseñado completo desde el principio** para no pagar
   migraciones más adelante, pero **cada fase implementa solo lo suyo**. Un campo
   documentado aquí y no usado todavía es correcto; un campo inventado sobre la
   marcha, no.
3. **Si necesitas cambiar el esquema o el contrato de API, párate y plantéalo.**
   Ningún agente los modifica por su cuenta.
4. Las tablas de DynamoDB **las crea a mano el responsable del proyecto**. El
   agente pide los datos mínimos de una tabla a la vez y espera confirmación.
