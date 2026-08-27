# 04 · Permisos y acceso

## Los dos ejes

El repositorio ya tiene un sistema de permisos por rol, y **no basta** para este
módulo. Hay que combinar dos cosas distintas que a menudo se confunden:

| Eje | Pregunta que responde | Cómo se resuelve |
|---|---|---|
| **Permiso global** | ¿Puede esta persona usar esta función? | `requirePermission(cod)` contra `Igp_RolesPermisos`. Ya existe |
| **ACL de fila** | ¿Puede tocar **esta** tarea, **este** proyecto, **esta** reunión? | `api/lib/tasks/acceso.js`. Es nuevo |

Un usuario con `reuniones.ver` puede usar el módulo de reuniones; eso no le da
derecho a leer la reunión de dirección donde se hablan sueldos. El primer eje
abre la puerta, el segundo dice a qué habitaciones.

**Los departamentos no son ninguno de los dos ejes.** Son etiqueta organizativa.
Alguien de Contabilidad puede tener asignada una tarea de un proyecto de
Marketing; cualquier diseño que lo impida está mal.

---

## Códigos de permiso

Todos nuevos. Se registran en tres sitios: `GRUPOS_PERMISOS` y `PERMISOS_LABELS`
de `app/(app)/permisos.tsx`, `api/ROLES-PERMISOS.md`, y `requirePermission` en el
router. **El backend no tiene lista blanca de códigos**, así que no hay que tocar
`api/routes/permisos.js`.

| Código | Qué habilita | Fase |
|---|---|---|
| `proyectos.ver` | Entrar al módulo. **Es el permiso del menú** (`app/constants/modulos.ts`) | 1A |
| `proyectos.crear` | Crear proyectos | 1A |
| `proyectos.editar` | Editar proyectos, gestionar miembros, crear y editar tareas | 1A |
| `proyectos.borrar` | Borrar proyectos (con sus tareas) y tareas sueltas. Cancelar es editar el estado | 1A |
| `tareas.ver_todas` | Ver tareas de personas y proyectos de los que no se es miembro | 1A |
| `tareas.editar_todas` | Editar cualquier tarea, sin ser responsable ni miembro | 1A |
| `reuniones.ver` | Entrar al módulo de reuniones | 1B |
| `reuniones.gestionar` | Convocar, editar, validar actas y resolver propuestas | 1B |
| `reuniones.ver_direccion` | Ver reuniones con `visibilidad = direccion` | 1B |
| `reuniones.borrar_audio` | Borrar el audio conservando transcripción y acta | 2 |
| `proyectos.presupuesto_ver` | Ver presupuesto, comprometido y real | 4 |
| `proyectos.compras_aprobar` | Aprobar o rechazar líneas de compra, hasta su nivel | 4 |
| `proyectos.plantillas` | Crear y editar plantillas de proyecto | 4 |
| `proyectos.cuadro_mando` | Cuadro de mando de dirección | 4 |

Etiquetas con el formato del resto de la pantalla: `Proyectos · Crear`,
`Reuniones · Ver dirección`.

No se crean permisos `ia.*` para este módulo: la IA no es una función que se
conceda, es un paso interno del pipeline.

---

## La capa de acceso: `api/lib/tasks/acceso.js`

**Punto único.** Ningún handler escribe comprobaciones de visibilidad por su
cuenta, y jamás se filtra en el cliente.

Funciones que expone, todas **puras** salvo la carga de contexto:

Firmas tal como están implementadas (Fase 0, con sus pruebas en
`api/tests/tasksAcceso.test.mjs`):

| Función | Devuelve | Para qué |
|---|---|---|
| `cargarContextoAcceso(user, { forzar })` | contexto | Recibe `req.user`; caché corta por `id_usuario` |
| `crearContextoAcceso({ … })` | contexto | Construye uno a mano: pruebas y trabajos programados |
| `contextoVacio()` | contexto | Sin identidad: deniega todo |
| `invalidarContextoAcceso(id?)` | — | Sin argumento vacía la caché entera |
| `tienePermiso(ctx, codigo)` | boolean | Permiso global, con los alias legacy del ERP |
| `rolEnProyecto(ctx, proyecto, miembros)` | rol \| null | `responsable_id` cuenta como responsable |
| `puedeVerProyecto(ctx, proyecto, miembros)` | boolean | Detalle y listado de proyectos |
| `puedeEditarProyecto(ctx, proyecto, miembros)` | boolean | El observador nunca edita |
| `puedeVerPresupuesto(ctx)` | boolean | Oculta importes del proyecto |
| `puedeVerTarea(ctx, tarea, { proyecto, miembros })` | boolean | |
| `puedeEditarTarea(ctx, tarea, { proyecto, miembros })` | boolean | |
| `puedeReasignarTarea(ctx, tarea, { proyecto, miembros })` | boolean | Más estrecho que editar |
| `puedeVerReunion(ctx, reunion, asistentes, aux)` | boolean | **La función más delicada del módulo** |
| `puedeGestionarReunion(ctx, reunion, asistentes, aux)` | boolean | Exige poder verla |
| `puedeBorrarAudio(ctx, reunion, asistentes, aux)` | boolean | Irreversible: permiso aparte |
| `nivelAprobacionDe(ctx, proyecto, miembros, aux)` | nivel \| null | Escalón máximo que puede firmar |
| `puedeAprobarLinea(ctx, proyecto, linea, miembros, aux)` | boolean | Compara con el nivel de la línea |
| `filtrarVisibles(ctx, tipo, items, auxDe)` | array | Filtra un listado ya leído |

`aux` transporta lo que la función no puede averiguar sin consultar:
`esResponsableDepartamento` para las reuniones de departamento y para el escalón
de aprobación. `auxDe` es una función que devuelve ese contexto por elemento.

Reglas de forma que hacen que esto sea testeable y no se degrade:

- **Reciben datos, no hacen consultas.** El handler lee proyecto, miembros o
  asistentes y los pasa. Así se pueden probar sin DynamoDB y no esconden lecturas.
- **Devuelven boolean, no lanzan.** El handler decide si eso es `403` o `404`.
- **No conocen Express.** Salvo `cargarContextoAcceso`, que recibe `req`.

### Contexto de la petición y por qué hace falta

El token JWT solo lleva `{ sub, email, rol }` (`api/routes/auth.js`). No lleva
`Locales`, ni departamentos, ni nada más. Cualquier decisión por pertenencia
obliga a releer el usuario, y `hasPermission` hace además un `GetItem` por cada
código de permiso.

`cargarContextoAcceso(req)` resuelve las dos cosas de una vez y **cachea en
memoria unos segundos** (60 s orientativos) por `id_usuario`:

- El usuario completo desde `igp_usuarios` (`Locales`, `Departamentos`, `Rol`).
- Los permisos del rol, con una sola Query a `Igp_RolesPermisos` en vez de N
  `GetItem`.

Los permisos de un rol cambian una vez al mes, no cada segundo, así que la caché
es segura. Aun así: **al cambiar los permisos de un rol o los datos de un usuario,
se invalida la entrada**. Y la caché es por proceso; con varias instancias del API,
el peor caso es que un cambio de permisos tarde hasta un minuto en verse, que es
aceptable y debe quedar escrito.

`esAdmin` sigue el cortocircuito que ya existe en todo el repositorio:
`user.Rol === 'Administrador'` lo ve todo. La única excepción es la aprobación de
compras, más abajo.

**El rol sale solo de la ficha, nunca del token** (D-09). Vaciar el `Rol` de un
usuario es la forma de cortarle el acceso, y su token sigue vivo hasta ocho horas:
si el token sirviera de respaldo, la baja no surtiría efecto. Un rol vacío deja el
contexto sin permisos, que es lo mismo que denegar.

El contexto se devuelve **inmutable**, contenedores incluidos: es el mismo objeto
que se sirve a todas las peticiones de ese usuario mientras dure la caché, así que
añadirle un permiso se lo añadiría a todas.

Un fallo de DynamoDB al cargar el contexto **se propaga**, no degrada a «denegar»:
un 500 no debe confundirse con un 403, o una avería de la tabla de permisos parece
un problema de permisos del usuario y se diagnostica en el sitio equivocado.

**Cableado (Fase 0):** el alta, la edición y la baja de usuarios
(`api/routes/usuarios.js`) llaman a `invalidarContextoAcceso(id_usuario)`, y el
alta y la retirada de permisos de un rol (`api/routes/permisos.js`) llaman a
`invalidarContextoAcceso()` sin argumento, porque no hay variante por rol.

Toda escritura de filas `PERMISO#` tiene que invalidar, no solo las de ese router:
`crearRol` con `clonarDe` y `eliminarRol` (`api/lib/roles.js`) también llaman a
`invalidarContextoAcceso()`. Clonar es el camino peligroso: `listarRolesCatalogo`
admite roles legacy que solo tienen filas de permiso y ningún `META`, y `crearRol`
solo comprueba el `META`, así que se puede «crear» un rol que ya usa gente y
concederle de golpe los permisos de `Administrador`.

---

## Visibilidad de proyectos y tareas

| Puede… | Quién |
|---|---|
| Ver un proyecto | Administrador · miembro (cualquier rol de proyecto) · quien tenga `tareas.ver_todas` |
| Editar un proyecto | Administrador · responsable del proyecto · miembro con `proyectos.editar`. **No** `tareas.editar_todas` (D-13) |
| Ver una tarea | Quien vea su proyecto · su responsable · quien esté mencionado · quien tenga `tareas.ver_todas`. Si la tarea no tiene proyecto: su responsable, quien la creó y los mencionados |
| Editar una tarea | Su responsable · quien pueda editar el proyecto · quien tenga `tareas.editar_todas`. Si la tarea no tiene proyecto, también quien la creó |
| Cambiar su estado | Igual que editar. Cerrarla es siempre acto de una persona |
| Reasignarla | Quien pueda editar el proyecto. No basta ser el responsable actual: no se puede soltar el marrón sin más. En tareas sueltas, quien la creó |

Estar mencionado da lectura, nunca escritura.

Una tarea con `proyecto_id` **hereda la visibilidad de su proyecto**, y por eso el
handler tiene que cargar el proyecto antes de comprobar: si no lo pasa, la capa
deniega. Es deliberado — sin ese dato no se puede decidir, y adivinarlo sería
filtrar.

Un proyecto **no** tiene campo de visibilidad: se es miembro o no. La
confidencialidad fuerte vive en las reuniones, que es donde están los datos
sensibles.

---

## Visibilidad de reuniones

Campo `visibilidad` en la reunión, con este significado. **Se aplica al listar y
al leer el detalle**, siempre en el servidor.

| Valor | Quién la ve |
|---|---|
| `direccion` | Administrador · quien tenga `reuniones.ver_direccion` · asistentes registrados |
| `empresa` | Cualquiera con `reuniones.ver` |
| `departamento` | Quien tenga ese departamento en su ficha · el responsable del departamento · asistentes |
| `local` | Quien tenga el local permitido, cruzando con la lógica de locales ya existente · asistentes |
| `restringida` | Solo quien esté en `usuarios_autorizados` · asistentes · Administrador |

**`Locales` vacío alcanza todos los locales** (D-15), igual que en el resto del ERP.
Al dar de alta a alguien de oficina sin ningún local en su ficha, hay que saber que
verá las reuniones de local de todo el grupo. Lo confidencial no se protege con
`local`, se protege con `restringida`.

Reglas transversales:

- **Un asistente registrado siempre puede ver la reunión a la que asistió**,
  cualquiera que sea la visibilidad. Estuvo allí. Lo mismo para quien la convocó.
- `empresa`, `departamento` y `local` exigen además `reuniones.ver`: son alcances
  amplios y quien no puede entrar al módulo no entra por ahí. Ser asistente,
  convocante o estar autorizado no necesita permiso alguno.
- La comparación de `local` es **por nombre**, porque `Locales` de `igp_usuarios`
  guarda nombres. De ahí que la reunión guarde `local_nombre` junto a `local_id`:
  sin él no habría forma de decidir sin una lectura extra por fila.
- El valor por defecto al convocar es **`departamento`**, no `empresa`. Si se
  equivocan al convocar, que el error sea hacia lo cerrado.
- Cambiar `visibilidad` requiere `reuniones.gestionar` y **queda en el registro de
  actividad**: es el cambio con más consecuencias del módulo.
- Al leer una reunión no visible se responde `404`, no `403`.

La visibilidad se hereda a lo que cuelga de la reunión: transcripción, acta,
puntos del orden del día, acuerdos y propuestas. No hay atajo por el que la cita
de una propuesta filtre el contenido de una reunión que no se puede ver.

---

## Aprobación de compras (Fase 4)

Umbrales en configuración (`Igp_Ajustes`, PK `proyectos`, SK `compras`), **nunca en
el código**.

| Importe de la línea | Aprueba |
|---|---|
| Menor que el primer umbral | Responsable del proyecto |
| Entre el primero y el segundo | Responsable del departamento del proyecto |
| A partir del segundo | Dirección |

`nivelAprobacionDe` devuelve el nivel máximo que esa persona puede aprobar en ese
proyecto, y `puedeAprobarLinea` lo compara con el `nivel_aprobacion_requerido` que
la línea calculó al crearse. Si no llega, `422` con un mensaje que diga qué nivel
hace falta.

Reglas:

- **Quien solicita no aprueba**, ni siquiera siendo responsable del proyecto, y
  **tampoco siendo Administrador**. Es la única excepción del módulo al
  cortocircuito de administrador que hay en todo el ERP, y es deliberada: un
  control de gasto con puerta trasera para el rol que más gente tiene no controla
  nada. La línea se queda esperando a otra persona del nivel que toque; no hay
  escalado automático.
- El nivel se calcula **al crear la línea** y se guarda. Si luego cambian los
  umbrales, las líneas ya en cola conservan el que tenían: cambiar la
  configuración no debe reabrir aprobaciones ya hechas ni saltarse las pendientes.
- **Sin umbrales configurados, todo exige `direccion`.** Como el nivel se congela
  al crear la línea, el lado inseguro no tiene vuelta atrás: una línea de 40.000 €
  nacida con el escalón bajo seguiría siendo firmable por el responsable del
  proyecto aunque después se configuren los umbrales. Lo mismo si los umbrales
  vienen a medias, incoherentes (el primero mayor que el segundo) o el importe no
  es un número.
- Toda aprobación escribe en `Igp_Actividad` con autor **e importe**.

---

## Frontend

**El frontend no reimplementa estas reglas.** Se intentó —`app/lib/tasksAcceso.ts`
nació como espejo de este fichero— y divergió el primer día: exigía
`proyectos.editar` al responsable del proyecto, que aquí puede editar sin ese
permiso, así que el dueño de un proyecto no veía sus propios botones. Dos
implementaciones de la misma regla no se mantienen sincronizadas.

Lo que hay ahora: **las respuestas de proyectos y tareas traen `permisos_fila`**,
calculado con las funciones de este fichero. La pantalla obedece, no decide. Ver
`docs/tasks/03-contrato-api.md`, «Nombres y permisos de fila».

De `app/lib/tasksAcceso.ts` solo quedan envoltorios legibles sobre `hasPermiso`
para los permisos **globales** (`proyectos.crear`, `proyectos.presupuesto_ver`…),
que no duplican lógica porque no hay ninguna: son un `hasPermiso` con nombre.

Todo esto **solo sirve para ocultar y deshabilitar**. No es seguridad: quien decide
es el backend. Un botón oculto sin la comprobación equivalente en el servidor es un
agujero, no una función.

En el sidebar, la entrada del módulo se filtra por `proyectos.ver` desde
`app/constants/modulos.ts`, como el resto.

---

## Tests obligatorios

Es una de las dos únicas zonas del módulo donde se exigen pruebas (la otra es el
pipeline). Con `node:test` y, cuando haga falta DynamoDB, con
`api/tests/dynamoMemoria.mjs`.

Casos que deben estar cubiertos:

- [ ] Cada valor de `visibilidad` de reunión, con un usuario que sí y otro que no.
- [ ] Un asistente ve la reunión aunque no cumpla la regla de visibilidad.
- [ ] Un usuario sin visibilidad **no la ve al listar ni al pedirla por ID
      directo**, y recibe `404`.
- [ ] La transcripción y las propuestas heredan la visibilidad de su reunión.
- [ ] Ver y editar tarea: responsable, miembro, mencionado, ajeno.
- [ ] Tarea sin proyecto: quién la ve.
- [ ] Administrador lo ve todo.
- [ ] Permisos aún no cargados: se deniega, nunca se concede por defecto.
- [ ] Niveles de aprobación, incluido el caso de que solicitante y aprobador sean
      la misma persona.
- [ ] Cambiar los umbrales no altera las líneas ya en cola.
