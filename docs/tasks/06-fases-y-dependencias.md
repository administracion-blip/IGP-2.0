# 06 · Fases y dependencias

**El orden no se altera.** Si la Fase 2 llega antes de que exista el hábito de
trabajar con tareas, lo que genere la IA caerá en el vacío. Cada fase deja el
sistema en estado funcional y desplegable.

## Mapa de dependencias

| Fase | Depende de | Bloquea | ¿Paralelizable? |
|---|---|---|---|
| **0** · Contrato, capa de acceso, departamentos | — | Todo | **No.** Un solo agente |
| **1A** · Proyectos, tareas, vista personal | 0 | 1B, 2, 3, 4 | Sí, tras cerrar la API: backend y frontend |
| **1B** · Reuniones con acta manual, Calendar, sala | 1A · credencial de Google | 2, 3 | Parcial: acta manual (frontend) y Google (backend) |
| **2** · Audio, transcripción, acta, validación | 1B · **puerta de decisión** · edición de Workspace | 4 | Sí: pipeline e interfaz de validación |
| **3** · Vencimientos en calendario, Directory, avisos | 1A. **No depende de la 2** | — | Sí: las tres piezas son independientes |
| **4** · Plantillas, orden del día automático, cuadro de mando, PDF, compras | 1A · 2 · 3 | — | Sí: cinco entregas casi independientes |

### Las dos puertas que no son código

**Credencial de Google con delegación de dominio.** Bloquea 1B y 3, y conseguirla
es trabajo de administración, no de programación. **Empezar el trámite durante la
Fase 1A**, o al llegar a 1B habrá que esperar de brazos cruzados.

**Validación de la transcripción con audio real.** Bloquea la Fase 2 entera. Ver
[05](05-pipeline-reuniones.md). Es una prueba manual de media hora que puede
ahorrar semanas.

### Dos ajustes sobre el orden original

**Los avisos de vencimiento se adelantan de la Fase 3 a la 1A.** Motivo: son el
refuerzo que sostiene el hábito. Una lista de tareas que no avisa se convierte en
una lista que nadie mira, y la Fase 1A existe precisamente para crear el hábito.
En 1A basta el aviso por email de lo que vence; la campana y el feed de calendario
siguen en la 3.

**La Fase 3 no depende de la 2 y se puede adelantar entera** si la puerta de
decisión de la transcripción se retrasa. No hay razón para tener el equipo parado
esperando a la IA.

---

## Fase 0 — Contrato y cimientos

No es solo documentación: tiene código, y es el único momento en que trabaja un
solo agente sobre todo.

**Entra:**
- Este conjunto de documentos, aprobado.
- `app/types/tasks.ts` y `api/lib/tasks/tipos.js` con tipos y constantes de estado.
- `api/lib/tasks/acceso.js` con sus funciones y **sus tests**, aunque todavía no lo
  llame nadie.
- Maestro de departamentos (`Igp_Ajustes`) y su pantalla mínima en `/base-datos`.
- Campo `Departamentos` en `igp_usuarios`: **propuesto, aprobado y aditivo**.
- Entradas nuevas en el mapa `tables` de `api/lib/db.js`.
- Alta de los códigos de permiso en `app/(app)/permisos.tsx` y
  `api/ROLES-PERMISOS.md`.

**No entra:** ninguna pantalla del módulo, ningún endpoint de negocio.

**Cierra cuando:** los tests de la capa de acceso pasan, el contrato está aprobado
y el árbol de trabajo del repositorio está limpio de cambios ajenos a medias.

---

## Fase 1A — Proyectos, tareas y vista personal

El objetivo real de esta fase **no es la funcionalidad, es el hábito**.

**Entra:**
- Tablas `Igp_Proyectos`, `Igp_Tareas`, `Igp_Actividad`.
- CRUD de proyectos, miembros y vínculos.
- CRUD de tareas: estados, subtareas, lista de comprobación, comentarios con
  menciones (guardadas, sin avisar todavía).
- Enlaces externos con captura en servidor e imagen en S3.
- Adjuntos por URL prefirmada.
- **Vista personal** (`/proyectos/mis-tareas`): tareas abiertas por vencimiento,
  con recuento de vencidas. Funcional en móvil.
- Tarjeta de resumen en el hub de `planning-dia` que lleva a la vista personal.
- Registro de actividad en las cuatro entidades.
- Aviso por email de tareas que vencen (adelantado de la Fase 3).
- Entrada en el menú (`app/constants/modulos.ts`) y hub del módulo.
- **Esquema** de compras y presupuesto, sin endpoints.

**No entra:** nada de IA, nada de Google, nada de reuniones, ni tableros, ni
dependencias entre tareas, ni cuadro de mando.

**Cierra cuando:**
- [ ] Se crea un proyecto, se le asignan miembros y tareas, y cada persona ve las
      suyas en su vista personal.
- [ ] Una tarea tiene un único responsable, y reasignarla queda registrado.
- [ ] Un enlace pegado aparece como tarjeta con imagen y precio, y sigue igual
      cuando el destino cambia.
- [ ] Ninguna consulta usa `Scan`.
- [ ] Un usuario sin `tareas.ver_todas` no ve tareas de proyectos ajenos, ni
      listando ni por ID directo.
- [ ] La vista personal se usa con una mano en un móvil.

**Reparto:** merece la pena. Superficies disjuntas: `api/routes/proyectos.js` +
`api/lib/tasks/**` frente a `app/(app)/proyectos/**`. Los ficheros comunes solo el
integrador.

---

## Fase 1B — Reuniones con acta manual

Primer contacto con Google. Sin IA todavía.

**Entra:**
- Tabla `Igp_Reuniones`.
- Convocar reunión: título, fecha, asistentes, visibilidad, **orden del día en
  texto libre**.
- Creación del evento en Calendar con el orden del día en la descripción.
- Detección de sala mediante recursos, y `modalidad` derivada.
- Acta **manual**: resumen escrito a mano y acuerdos con responsable y fecha.
- Convertir acuerdos en tareas mediante la **creación en lote** ya existente.
- Aviso de grabación con registro de informados (aunque aún no se grabe).
- Copia congelada del orden del día (el campo funciona; el análisis no llega hasta
  la 2).
- Sugerencia editable de orden del día con pendientes y aplazados de la reunión
  anterior de la serie.
- Filtrado de visibilidad en servidor, con sus tests.

**No entra:** audio, transcripción, IA, actas en PDF.

**Cierra cuando:**
- [ ] Se convoca una reunión y el evento aparece en Calendar con el orden del día.
- [ ] La modalidad se detecta bien en un caso presencial y en uno remoto.
- [ ] Un acuerdo escrito a mano se convierte en tarea con responsable y fecha, y la
      tarea apunta a su reunión.
- [ ] Una reunión de dirección **no** la ve quien no debe, ni listando ni por ID.
- [ ] El orden del día no se puede editar una vez empezada la reunión.

**Reparto:** parcial. El adaptador de Google es una superficie muy acoplada; el
resto (acta manual, pantallas) es disjunto.

---

## Fase 2 — Pipeline asíncrono

**Entra:** todo lo descrito en [05 · Pipeline de reuniones](05-pipeline-reuniones.md),
más la interfaz de validación de propuestas.

**No entra:** actas en PDF, orden del día automático, cuadro de mando, cruce con
datos de negocio.

**Cierra cuando:**
- [ ] Con audio real, sin intervención manual, la reunión llega a `acta_borrador`
      con transcripción, acta y propuestas.
- [ ] Cada propuesta muestra su cita, y validarla crea la tarea con responsable y
      fecha.
- [ ] Rechazar una propuesta la marca y no la borra.
- [ ] Un fallo de transcripción o de IA deja la reunión en `error` con fase
      distinguible, sin perder lo obtenido, y es reintentable.
- [ ] Reprocesar no duplica tareas ni vuelve a pagar transcripción.
- [ ] Los puntos no tratados aparecen como aplazados y candidatos a la siguiente.
- [ ] El audio se borra conservando transcripción y acta.
- [ ] El poller no ejecuta ningún `Scan`.
- [ ] `coste_ia` refleja el coste real de la reunión.

**Reparto:** sí. Pipeline (backend, `api/lib/tasks/reuniones/**`) frente a la cola
de validación (frontend). Nunca dos agentes en el adaptador de captura.

---

## Fase 3 — Calendario, usuarios y avisos

Las tres piezas son independientes entre sí.

**Entra:**
- Feed ICS de vencimientos por usuario, con token propio revocable, montado antes
  del `requireAuth` global.
- Tabla `Igp_Notificaciones`, campana en la interfaz y avisos de mención,
  asignación, vencimiento, compra pendiente y acta lista.
- Sincronización de usuarios desde Directory: **solo enriquece** campos concretos,
  **nunca crea usuarios ni asigna permisos**.

**Cierra cuando:**
- [ ] Un usuario se suscribe al feed y ve sus vencimientos en su calendario.
- [ ] Revocar el token corta el acceso al feed.
- [ ] El feed no expone contenido de reuniones, solo título y fecha de tareas.
- [ ] Una mención genera aviso y la campana lo cuenta sin `Scan`.
- [ ] La sincronización con Directory no altera roles, permisos ni contraseñas, y
      un usuario que ya no está en Directory **no** se borra automáticamente.

---

## Fase 4 — Madurez

Cinco entregas casi independientes; se pueden priorizar por separado según lo que
pida el uso real.

| Entrega | Contenido |
|---|---|
| Compras y presupuesto | Endpoints sobre el esquema de 1A, cola de aprobación por umbrales, presupuesto contra comprometido y real |
| Plantillas de proyecto | Crear e instanciar vía creación en lote |
| Orden del día automático | Generación completa para el comité recurrente, a partir de aplazados y acuerdos incumplidos |
| Cuadro de mando de dirección | Estado de proyectos, acuerdos incumplidos, carga por persona y departamento |
| Actas en PDF | Con el patrón de PDF ya existente en el repositorio |

**Cierra cuando:**
- [ ] Una línea por debajo del primer umbral la aprueba el responsable del
      proyecto, y una por encima del segundo la rechaza hasta que llega dirección.
- [ ] Quien solicita no puede aprobar su propia línea.
- [ ] El proyecto muestra a la vez presupuesto, comprometido y real, y cuadra con
      sus líneas.
- [ ] Cambiar los umbrales no altera las líneas ya en cola.
- [ ] La reunión siguiente de una serie propone su orden del día sin escribir nada.

**Fuera, con el esquema ya preparado:** el enganche de líneas de compra con
conciliación bancaria. El campo existe; la implementación no se hace en esta fase.

---

## Reparto entre agentes, por fase

| Fase | Modo |
|---|---|
| 0 | Un agente. Sin excepción |
| 1A | Integrador + backend + frontend |
| 1B | Integrador + backend (Google) + frontend (acta manual) |
| 2 | Integrador + backend (pipeline) + frontend (validación) |
| 3 | Tres piezas independientes, un agente cada una, integrador al cerrar |
| 4 | Una entrega por agente, integrador al cerrar |

Reglas que no cambian en ninguna fase:

- Los ficheros comunes (`app/types/tasks.ts`, `api/lib/tasks/tipos.js`,
  `api/lib/tasks/acceso.js`, `api/lib/db.js`, `app/constants/modulos.ts`,
  `app/(app)/permisos.tsx`) los toca **solo el integrador**.
- Ningún agente cambia el esquema ni el contrato de API por su cuenta.
- Cada agente en su rama; el integrador consolida.
- **Al cerrar cada fase, el integrador verifica que backend y frontend siguen
  coherentes con el contrato** y actualiza la tabla de estado del
  [README](README.md).
- Si en una fase no compensa paralelizar, se trabaja en secuencia. No se reparte
  por repartir.
