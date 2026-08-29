# Módulo de dirección — proyectos, tareas y reuniones

Documento maestro del módulo. Es la **referencia compartida** por todas las fases
y por todos los agentes que trabajen en él. Si el código y este documento
discrepan, discrepa el código.

Estado: **Fase 1A completa en código** (26/08/2026). Redactado el 25/08/2026 contra el estado
real del repositorio (Expo SDK 54 + Express ESM en `api/`, DynamoDB `eu-west-3`).
Rutas y permisos decididos el 26/08/2026 (D-11): `/proyectos` y `/reuniones`, con
`proyectos.*` y `reuniones.*`.

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
| [legacy/](legacy/) | Diseños anteriores archivados. **No usar como referencia** |

Las reglas de trabajo que el agente debe respetar sin leerse todo esto están en
`.cursor/rules/modulo-tasks.mdc`.

## Estado de las fases

| Fase | Contenido | Estado |
|---|---|---|
| **0** | Contrato aprobado, capa de acceso, maestro de departamentos | **Completa.** Tipos, capa de acceso (73 pruebas), maestro de departamentos con su pantalla, campo en la ficha de usuario y permisos en el catálogo |
| **1A** | Proyectos, departamentos, tareas, permisos, vista personal | **Completa en código** (26/08/2026). Servidor, pantallas, enlaces/adjuntos en ficha y tarjeta en `planning-dia`. Queda probar a mano la vista personal en móvil |
| **1B** | Reuniones con acta manual, evento en Calendar, detección de sala | **En curso.** Tabla AWS creada. API + pantallas operativas con Calendar en stub. Falta service account Google para evento real y modalidad |
| **2** | Captura de audio, transcripción, resumen, cola de validación | No iniciada |
| **3** | Vencimientos en calendario, sincronización de usuarios, avisos | **En curso.** Campana + ICS + emisores en código (stub Directory). Falta crear `Igp_Notificaciones` en AWS y Directory real cuando haya credencial |
| **4** | Plantillas, orden del día automático, cuadro de mando, actas PDF, compras | No iniciada |

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
