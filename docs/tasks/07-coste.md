# 07 · Coste

Números para poder decidir. **Órdenes de magnitud, no presupuesto**: los precios de
los proveedores cambian y hay que confirmarlos el día de la decisión.

La conclusión, antes de los detalles: **el coste dominante no es la IA, son las
licencias de Google Workspace**. Subir cinco organizadores a una edición con
grabación cuesta más al mes que toda la transcripción y el resumen del año.

---

## Coste variable por reunión

Reunión de una hora, unas 9.000-15.000 palabras de transcripción.

| Concepto | Coste orientativo | Notas |
|---|---|---|
| Transcripción con diarización | **0,25 – 1,50 USD** | El 90 % del coste variable. El rango es enorme según proveedor: los especializados suelen estar un orden de magnitud por debajo del servicio genérico de AWS |
| Resumen, acuerdos y cobertura | **< 0,05 USD** | Decenas de miles de tokens de entrada y unos miles de salida. Con un modelo pequeño son céntimos; con uno grande, sigue siendo céntimos |
| Almacenamiento del audio | Despreciable | Un audio comprimido de una hora ronda los 30-60 MB. Con retención corta, céntimos al mes en total |
| Almacenamiento de transcripción y acta | Despreciable | Kilobytes, permanentes |
| **Total por reunión** | **0,30 – 1,60 USD** | |

Consecuencia práctica: **en el resumen no merece la pena ahorrar**. Es la pieza que
determina si el acta sirve o no, y cuesta céntimos. El modelo bueno para el acta,
el barato para tareas mecánicas.

---

## Coste recurrente mensual

Escenario de referencia: 8 reuniones al mes, 25 usuarios, 5 organizadores.

| Partida | Mensual | Notas |
|---|---|---|
| Transcripción + resumen (8 reuniones) | **3 – 13 USD** | |
| DynamoDB bajo demanda | **< 2 USD** | Todo por índice; los índices dispersos evitan multiplicar escrituras |
| S3 | **< 1 USD** | |
| Email de avisos | 0 | SMTP ya existente |
| **Subtotal técnico** | **≈ 5 – 16 USD** | |
| **Licencias Workspace (delta por grabación)** | **≈ 25 – 30 EUR** | 5 organizadores × ~5-6 EUR de diferencia entre ediciones |
| **Total** | **≈ 30 – 45 EUR** | |

**Por usuario**, el módulo de proyectos y tareas cuesta prácticamente nada: por
debajo de **0,10 USD/usuario/mes** en DynamoDB, S3 y correo. No hay coste por
asiento salvo la licencia de Google de quien organiza reuniones.

---

## Lo que cambiaría los números

| Decisión | Efecto |
|---|---|
| Proveedor de transcripción | El único factor con impacto real en el coste variable: hasta 6× de diferencia |
| Número de organizadores con licencia que graba | El factor con más impacto en el total. Cada uno suma ~5-6 EUR/mes |
| Retención del audio | Marginal. Incluso guardando un año, el almacenamiento sigue siendo céntimos |
| Grabar dentro de la app en lugar de Meet | Ahorra licencias, pero obliga a distribución nativa, cuyo coste de mantenimiento supera lo ahorrado |
| Volumen de reuniones | Lineal y barato: pasar de 8 a 30 reuniones al mes sube el coste técnico unos 30 USD |
| Modelo de lenguaje | Prácticamente irrelevante frente a la transcripción |

---

## Cómo medirlo de verdad

No hay que estimar el coste eternamente: **el módulo lo mide solo**.

- El campo `coste_ia` de cada reunión guarda coste de transcripción, coste de
  resumen y tokens de entrada y salida.
- `chatCompletion()` ya devuelve `usage` con los tokens; el adaptador de
  transcripción aporta la duración facturada.
- Con eso, el cuadro de mando de la Fase 4 puede mostrar el coste real por reunión
  y por mes, y esta página deja de ser una estimación.

---

## Contención del coste operativo, por diseño

| Medida | Dónde está garantizada |
|---|---|
| Transcripción y resumen **una sola vez** por reunión | Idempotencia por `transcripcion_job_id` y `transcripcion_hash` ([05](05-pipeline-reuniones.md)) |
| Reprocesar no vuelve a pagar | Mismo mecanismo |
| Audio borrado pasado un plazo, conservando transcripción y acta | Job de retención |
| DynamoDB bajo demanda y consultas por índice | [02](02-modelo-datos.md) |
| Sin escritura multiplicada por los índices | Índices dispersos |
| Sondeo del pipeline cada 60 s, no cada segundo | Cadencia del poller |
| Vocabulario esperado para subir precisión | Gratis: sale del orden del día, no de un modelo mejor |

Y del coste de desarrollo: lista de ficheros acotada antes de empezar, sin
refactores fuera de alcance, reutilizar componentes existentes, preguntar antes de
añadir dependencias, y tests solo en la capa de acceso y el pipeline.
