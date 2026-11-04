# MIA stock máximo — qué probar antes de desplegar

Lista manual. La suite automática no abre el navegador ni llama al Ágora real.
OpenAI no interviene en este módulo: no hace falta revisar claves ni modelos de IA para este despliegue.

## Producción, antes del primer pedido

- En el servidor de la API, confirma a qué Ágora apunta `AGORA_BASE_URL` (o `AGORA_API_BASE_URL` si esa es la que está definida). Tiene que ser el TPV real del grupo, no un host de prueba. No hace falta copiar el token para comprobarlo: basta el host.
- Después de desplegar, en la app: **Ajustes → Productos Agora → Sincronizar**. Ese botón fuerza la sincronización. Sin ella, los productos ya copiados no tienen los formatos y el desplegable de unidad de compra sale vacío.
- Configura los **tramos globales** antes del primer conteo. Sin ningún tramo, Calcular responde que no hay tramos de multiplicador y no escribe cantidades.
- El MIA de consumo sigue en `/compras/mia-consumo`. `/compras/mia` solo redirige al hub nuevo. Abre el de consumo y comprueba que calcular, revisar y aprobar un informe se comportan como antes.

## En el navegador

Hazlo en **Safari** y en la **tablet**, no solo en Chrome de escritorio. En los dos, descarga un PDF suelto y **Descargar todos los PDF** (el zip `Pedidos_<Almacen>_<fecha>.zip`) y ábrelo.

1. Compras → **MIA — Aprovisionamiento**. Elige un almacén. Las tarjetas enseñan el último conteo y su estado, cuántos productos no tienen máximo, y si hay tramos propios o heredados.
2. Stock máximo: pon máximo y unidad de compra (salen de los formatos de Ágora, tras la sincronización) a un producto de prueba. Guarda. Recarga y comprueba que sigue.
3. Tramos: un tramo global desde 0, sin tope, con un multiplicador. Guarda.
4. Conteo: importa un Excel de inventario con al menos una línea contada. Mira avisos de ids desconocidos, duplicados y líneas sin contar.
5. Calcular. La cantidad es el máximo por el multiplicador, menos el stock, redondeada al formato. Un producto sin máximo queda en 0 y avisado.
6. Cambia una cantidad (múltiplo del formato, nunca negativa), quita otra línea y pulsa Guardar. El total del proveedor cambia al editar. Si sales con cambios sin guardar, avisa.
7. Tras importar, la línea ya trae proveedor y unidad si la ficha de stock máximo los tiene (el proveedor de la ficha manda sobre la última compra; la unidad, si no está en la ficha, sale del formato base). Solo queda «Sin proveedor» o sin unidad cuando de verdad no hay ninguno: en esas líneas elige proveedor y unidad, guarda, y comprueba que quedan marcados como manuales. Recalcular no los pisa. Si Aprobar nombra una línea, es que a esa línea le falta proveedor, unidad o cantidad, no un fallo de Ágora.
8. Con una línea que sí tenga proveedor, unidad y cantidad mayor que 0: **Aprobar** pide confirmación (proveedor, líneas, importe, borrador). Un doble clic no manda dos pedidos. Si Ágora rechaza, el proveedor vuelve a Generado.
9. **Confirmar** solo aparece con el permiso `mia.confirmar_agora` y el pedido va Confirmed. Sin ese permiso, no se degrada a borrador en silencio.
10. **Aprobar todos** manda en borrador, uno a uno, y resume enviados y fallidos.
11. PDF de un proveedor y el zip de todos, en Generado y también en Pedido. Nombres sin tildes y con guiones.
12. Si un proveedor se queda en **Enviando** más de 10 minutos, se ve «atascado». **Comprobar en Ágora** no reenvía: si el pedido está, pasa a Pedido o a Confirmado según Ágora; si no está, vuelve a Generado; si Ágora no responde, sigue en Enviando.

## Entregas

Cuando Ágora tenga cantidad entregada en ese pedido MIA, lanza la sync de entregas del almacén. La línea del conteo muestra lo entregado y un informe de consumo antiguo del mismo almacén sigue actualizándose como hasta ahora, sin cambiar su estado.
