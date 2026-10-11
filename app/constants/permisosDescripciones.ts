/**
 * Explicación en lenguaje sencillo de qué permite cada permiso. Se muestra en
 * Ajustes → Permisos al pulsar el icono de ojo de cada fila.
 *
 * Las descripciones reflejan lo que el código comprueba hoy (frontend y API).
 * Si un permiso no se comprueba en ningún sitio, se indica explícitamente para
 * no dar a entender que protege algo.
 */

const SIN_EFECTO = 'Actualmente no controla ninguna acción de la aplicación.';

export const PERMISOS_DESCRIPCIONES: Record<string, string> = {
  // Configuración (engranaje)
  'permisos.ver':
    'Muestra la entrada Permisos en el engranaje y permite consultar los permisos de otros roles. Asignar o quitar permisos sigue reservado al rol Administrador.',
  'permisos.crear': `${SIN_EFECTO} Crear roles y asignar permisos está reservado al rol Administrador.`,
  'permisos.editar': `${SIN_EFECTO} Modificar permisos está reservado al rol Administrador.`,
  'permisos.borrar': `${SIN_EFECTO} Quitar permisos o borrar roles está reservado al rol Administrador.`,
  'ajustes.ver':
    'Muestra la pantalla Ajustes del engranaje y permite cambiar la configuración general: personalización, informe diario, enlaces del Planning del día y desplazamientos de mantenimiento.',
  'ajustes.sincronizaciones.agora_productos':
    'Permite lanzar desde Ajustes la sincronización de productos con Ágora y consultar su estado.',
  'ajustes.sincronizaciones.agora_usuarios':
    'Permite lanzar desde Ajustes la sincronización de usuarios de Ágora.',
  'ajustes.sincronizaciones.compras_proveedor':
    'Permite lanzar desde Ajustes la sincronización de compras a proveedor (albaranes) desde Ágora.',
  'ajustes.sincronizaciones.closeouts':
    'Permite lanzar desde Ajustes la sincronización de cierres de caja y de formas de pago desde Ágora.',
  'ajustes.sincronizaciones.almacenes':
    'Permite lanzar desde Ajustes la sincronización de almacenes desde Ágora.',
  'ajustes.sincronizaciones.empleados':
    'Permite lanzar desde Ajustes la sincronización de empleados desde Factorial.',
  'ajustes.sincronizaciones.ventas_producto':
    'Permite lanzar desde Ajustes la sincronización de ventas por producto desde Ágora.',

  // Base de datos
  'base_datos.ver':
    'Muestra el módulo Base de datos en el menú y da acceso a la ficha de Departamentos.',
  'usuarios.ver':
    'Permite ver el listado de usuarios de la aplicación y ver los nombres de las personas en proyectos, tareas y reuniones.',
  'usuarios.crear':
    'Permite dar de alta usuarios de la aplicación. También permite el alta rápida de un local desde el formulario de usuario.',
  'usuarios.editar':
    'Permite modificar usuarios existentes (datos, rol y locales). También permite el alta rápida de un local desde el formulario de usuario.',
  'usuarios.borrar': 'Permite borrar usuarios de la aplicación.',
  'locales.ver': 'Muestra la tarjeta Locales en Base de datos.',
  'locales.crear': 'Permite dar de alta locales nuevos en Base de datos.',
  'locales.editar': 'Permite modificar los datos de los locales en Base de datos.',
  'locales.borrar': 'Permite borrar locales en Base de datos.',
  'empresas.ver':
    'Permite ver el listado de empresas y sus cuentas bancarias, y los accesos a empresas desde Facturación y Banca.',
  'empresas.crear':
    'Permite dar de alta empresas, también desde el registro masivo de facturas.',
  'empresas.editar':
    'Permite modificar empresas y gestionar sus cuentas bancarias (añadir, cambiar, marcar predeterminada y borrar), también al asignar la cuenta de un extracto en Banca.',
  'empresas.importar': SIN_EFECTO,
  'departamentos.editar':
    'Permite crear, modificar y dar de baja departamentos y sus responsables.',
  'productos.ver': 'Muestra la tarjeta Productos en Base de datos.',
  'productos.editar':
    'Permite dar de alta, modificar y borrar productos del maestro de productos.',
  'productos.sincronizar':
    'Permite sincronizar los productos con Ágora desde la pantalla de Productos.',
  'almacenes.ver': 'Muestra la tarjeta Almacenes en Base de datos.',
  'almacenes.crear': 'Permite dar de alta almacenes nuevos.',
  'almacenes.editar': 'Permite modificar los datos de los almacenes.',
  'almacenes.borrar': 'Permite borrar almacenes.',
  'almacenes.sincronizar': `${SIN_EFECTO} La sincronización de almacenes se controla con «Ajustes · Sync Almacenes».`,
  'usuarios_agora.ver': 'Muestra la tarjeta Usuarios Ágora en Base de datos.',
  'usuarios_agora.sincronizar':
    'Muestra el botón para sincronizar los usuarios de Ágora en su pantalla.',
  'puntos_venta.ver': 'Muestra la tarjeta Puntos de venta en Base de datos.',
  'puntos_venta.editar':
    'Permite modificar los puntos de venta, incluida la tarifa de Ágora asignada a cada local.',

  // Compras
  'compras.ver': 'Muestra el módulo Compras en el menú lateral.',
  'pedidos.ver':
    'Permite entrar en Pedidos, Detalles de pedidos, Abonos por rappel y Ventas por empresa.',
  'pedidos.ver_completados': 'Permite ver la pantalla de pedidos completados.',
  'pedidos.preparar':
    'Permite preparar en el almacén los pedidos enviados por los locales. También muestra el acceso en el Planning del día.',
  'pedidos.exportar_traspaso':
    'Permite exportar a Ágora (Excel) los artículos de los pedidos completados como traspasos.',
  'pedidos.crear':
    'Muestra el botón para crear un pedido nuevo desde la pantalla Preparar pedidos.',
  'pedidos.crear_entre_locales':
    'Permite enviar un pedido desde el almacén de otro local. Genera una factura entre las sociedades del grupo.',
  'pedidos.editar': SIN_EFECTO,
  'pedidos.borrar': 'Permite borrar pedidos que aún están en borrador.',
  'pedidos.editar_enviado':
    'Permite modificar pedidos que ya se han enviado al almacén.',
  'pedidos.borrar_enviado': 'Permite borrar pedidos que ya se han enviado al almacén.',
  'compras_proveedor.ver':
    'Permite entrar en Compras a proveedor (albaranes de Ágora) y en Conciliación de facturas.',
  'compras_proveedor.sincronizar': `${SIN_EFECTO} La sincronización se controla con «Ajustes · Sync Compras Proveedor».`,
  'compras.facturar':
    'Permite generar las facturas mensuales de ventas internas y los abonos de rappel entre sociedades, y cambiar su configuración.',
  'mia.ver':
    'Permite entrar en MIA (aprovisionamiento) y ver su configuración, calendario, agrupaciones de familias e informes.',
  'mia.configurar':
    'Permite cambiar la configuración de MIA: productos, calendario de pedidos y agrupaciones de familias.',
  'mia.sincronizar': 'Permite sincronizar los stocks de los almacenes desde Ágora para MIA.',
  'mia.calcular': 'Permite calcular el pedido recomendado de MIA.',
  'mia.aprobar': 'Permite aprobar los informes de pedido de MIA.',
  'escandallos.ver': 'Permite ver las recetas (escandallos) de los platos.',
  'escandallos.editar':
    'Permite crear, modificar y borrar recetas de platos, incluida su imagen.',

  // Cajas
  'cajas.ver': 'Muestra el módulo Cajas en el menú lateral.',
  'cierres.ver':
    'Permite entrar en Cierres teóricos, Arqueo de caja, Movimientos de caja, Revisión de cajas y Revisión de formas de pago. También permite marcar cajas como revisadas, reabrir jornadas y ver el efectivo a ingresar con su IBAN. Muestra Formas de pago en Base de datos y permite editarlas.',
  'cierres.crear': 'Permite crear cierres teóricos de caja de sus locales.',
  'cierres.editar': 'Permite editar cierres teóricos de caja de sus locales (incluido mover la fecha un día atrás).',
  'cierres.borrar': 'Permite borrar cierres teóricos y arqueos de caja de sus locales.',
  'cierres.sincronizar':
    'Permite sincronizar desde Ágora los cierres de caja de sus locales. También lo permite «Ajustes · Sync Cierres de caja».',
  'cierres.exportar': SIN_EFECTO,
  'formas_pago.editar': 'Permite modificar el maestro de formas de pago.',
  'comparativa.ver':
    'Permite entrar en la Comparativa de fechas de cajas y editar los festivos de la comparativa.',
  'comparativa.crear': SIN_EFECTO,
  'comparativa.editar': SIN_EFECTO,
  'comparativa.borrar': SIN_EFECTO,
  'comparativa.importar': SIN_EFECTO,
  'comparativa.exportar': SIN_EFECTO,
  'objetivos.ver':
    'Permite entrar en Objetivos y en Plantillas de franjas horarias, y modificar la agrupación de locales de los objetivos.',
  'objetivos.compartir': SIN_EFECTO,
  'excepciones.ver': 'Permite entrar en Control de excepciones.',
  'excepciones.exportar': 'Permite exportar el listado de Control de excepciones.',
  'top.ver':
    'Permite ver el ranking Top de ventas y la tarjeta de mejores camareros en el Planning del día.',
  'top.exportar': 'Permite exportar el ranking Top.',

  // Cashflow
  'cashflow.ver':
    'Permite entrar en Cashflow y consultar movimientos, resumen y recibos.',
  'cashflow.registrar':
    'Permite registrar y firmar movimientos de cashflow. Incluye ver los datos de contacto de los empleados al registrar.',
  'cashflow.validar':
    'Permite validar importes altos, anular movimientos y registrar repartos a socios.',

  // Asistentes IA
  'ia.informes':
    'Muestra Informes IA en el menú y permite ver, ejecutar y leer informes de las fuentes a las que se tenga acceso.',
  'ia.informe_objetivos': 'Da acceso a la fuente de datos «Objetivos» (con importes) en los informes IA.',
  'ia.informe_compras':
    'Da acceso a la fuente de datos «Compras» en los informes IA, también desde Compras a proveedor.',
  'ia.informe_ventas_hora': 'Da acceso a la fuente de datos «Ventas por hora» en los informes IA.',
  'ia.informe_dia_a_dia': 'Da acceso a la fuente de datos «Día a día» en los informes IA.',
  'ia.informe_ventas_articulo':
    'Da acceso a la fuente de datos «Ventas por artículo» en los informes IA.',
  'ia.prompts_gestionar': 'Permite crear, modificar y borrar las plantillas de prompt de los informes IA.',
  'ia.ajustes': 'Permite modificar los ajustes de la IA.',

  // Actuaciones
  'actuaciones.ver':
    'Muestra el módulo Actuaciones en el menú, la tarjeta Artistas en Base de datos y las actuaciones del día en el Planning.',
  'actuaciones.programacion':
    'Permite entrar en la programación de actuaciones y gestionar las fichas de artistas.',
  'actuaciones.crear': 'Permite crear actuaciones y huecos en la programación.',
  'actuaciones.editar': 'Permite modificar actuaciones existentes.',
  'actuaciones.borrar': 'Permite borrar actuaciones.',
  'actuaciones.firma': 'Permite firmar en pantalla una actuación realizada.',
  'actuaciones.facturacion':
    'Permite asociar facturas de gasto a las actuaciones.',

  // RRPP
  'rrpp.ver': 'Muestra la tarjeta RRPP dentro del hub de Recursos Humanos.',
  'entradas.ver': 'Permite ver los tipos de entrada, el listado de entradas y los eventos.',
  'entradas.crear': 'Permite emitir entradas y sincronizarlas con Ágora.',
  'entradas.enviar_whatsapp': 'Permite generar el enlace de WhatsApp para enviar una entrada.',
  'entradas.reintentar_agora':
    'Permite reintentar la sincronización con Ágora de una entrada que falló.',
  'entradas.configurar':
    'Permite configurar la conexión de Ágora de cada local y los tipos de entrada.',
  'entradas.anular': 'Permite anular una entrada emitida.',

  // Recursos Humanos
  'recursos_humanos.ver': 'Muestra el módulo Recursos Humanos en el menú lateral.',
  'personal.ver':
    'Permite ver los empleados con sus datos de contacto e identificación (email, teléfono, DNI) y sincronizar empleados.',
  'rrhh.horas':
    'Permite entrar en Horas por facturación, consultar el cuadrante y configurar el ratio de horas por local.',
  'rrhh.bonus.ver': 'Permite ver la pantalla de bonus.',
  'rrhh.bonus.editar': 'Permite modificar los porcentajes del bonus y cerrar el mes.',
  'incentivos_producto.ver':
    'Permite ver las campañas de incentivos por producto y sus resultados, también en el Planning del día.',
  'incentivos_producto.gestionar':
    'Permite crear, cerrar y archivar campañas de incentivos. También permite editarlas y borrarlas.',
  'incentivos_producto.editar': 'Permite modificar campañas de incentivos por producto.',
  'incentivos_producto.borrar': 'Permite borrar campañas de incentivos por producto.',
  'incentivos_producto.exportar': 'Permite exportar los resultados de una campaña de incentivos.',

  // Marketing
  'marketing.proponer':
    'Muestra el módulo Marketing en el menú y permite crear, ver y modificar propuestas, y configurar el estilo de cada local.',
  'marketing.gestionar':
    'Permite gestionar las propuestas de marketing: generar prompts, carteles de músico y trabajar con todos los locales.',

  // Mystery Guest
  'mystery_guest.ver': 'Muestra Mystery Guest en el menú y permite ver y enviar auditorías.',

  // Reservas
  'reservas.ver': 'Muestra el módulo Reservas en el menú y la tarjeta de reservas en su hub.',
  'activaciones.ver':
    'Permite ver las activaciones y sus sesiones, y marcar una sesión como realizada.',
  'activaciones.gestionar':
    'Permite crear, modificar y borrar campañas de activación, sus sesiones y adjuntos.',

  // Acuerdos
  'acuerdos.ver':
    'Permite ver los acuerdos comerciales con proveedores, su seguimiento, documentos y el informe de compras.',
  'acuerdos.crear': 'Permite crear acuerdos comerciales nuevos.',
  'acuerdos.editar':
    'Permite modificar acuerdos, sus productos, imágenes y documentos adjuntos.',
  'acuerdos.borrar': 'Permite borrar acuerdos comerciales.',
  'acuerdos.exportar': 'Permite exportar el informe de compras de los acuerdos.',
  'mayorista.ver': 'Permite ver las operaciones de mayorista y sus clientes.',
  'mayorista.crear': 'Permite crear y duplicar operaciones de mayorista.',
  'mayorista.editar':
    'Permite modificar borradores de mayorista, su configuración, y marcar operaciones como facturadas o pagadas.',
  'mayorista.confirmar': 'Permite confirmar operaciones de mayorista.',
  'mayorista.borrar': 'Permite borrar borradores de mayorista.',
  'mayorista.exportar': 'Permite exportar a PDF una operación de mayorista.',

  // Facturación
  'facturacion.ver':
    'Muestra Facturación en el menú y permite ver facturas emitidas y recibidas, sus adjuntos y el cuadro de mando.',
  'facturacion.crear':
    'Permite crear y duplicar facturas, también con lectura automática (OCR) y desde el registro masivo.',
  'facturacion.editar':
    'Permite modificar y borrar facturas, gestionar adjuntos y enviar facturas y recordatorios por email.',
  'facturacion.emitir':
    'Permite emitir facturas, validar las que están en revisión, rectificarlas y conciliar albaranes.',
  'facturacion.anular': 'Permite anular facturas emitidas.',
  'facturacion.cobrar_pagar':
    'Permite registrar, modificar y borrar cobros y pagos de facturas y conciliarlos con movimientos bancarios. Junto con «Remesas · Gestionar», permite ejecutar remesas.',
  'facturacion.series': 'Permite crear, modificar y borrar las series de facturación.',
  'facturacion.exportar': SIN_EFECTO,
  'refacturacion.ver': 'Permite ver las refacturaciones entre sociedades.',
  'refacturacion.gestionar':
    'Permite escanear tickets, gestionar pendientes y emitir refacturaciones entre sociedades.',
  'remesas.ver': 'Permite ver las remesas de pago.',
  'remesas.gestionar':
    'Permite crear, modificar, revalidar y anular remesas de pago y descargar el fichero para el banco.',

  // Banca
  'banca.ver': 'Muestra Banca en el menú y permite ver los movimientos y ficheros bancarios.',
  'banca.importar': 'Permite importar y borrar extractos bancarios.',

  // Planning del Día
  'planning_dia.ver':
    'Muestra el Planning del día en el menú y permite consultar el cuadrante de personal y las limpiezas pendientes del día.',
  'planning_dia.objetivo_card': 'Muestra la tarjeta de objetivo mensual en el Planning del día.',
  'planning_dia.actuaciones':
    'Muestra las actuaciones del día en el Planning y permite añadir observaciones, valorarlas y firmarlas.',
  'planning_dia.activaciones':
    'Muestra las activaciones del día en el Planning y permite marcarlas como realizadas.',
  'planning_dia.arqueo': 'Permite hacer el arqueo de caja y registrar movimientos de caja de sus locales.',

  // Mantenimiento
  'mantenimiento.ver': 'Muestra el módulo Mantenimiento y permite ver las incidencias.',
  'mantenimiento.crear':
    'Permite reportar incidencias de mantenimiento, también desde el Planning del día.',
  'mantenimiento.editar':
    'Permite cambiar el estado de las incidencias, usar el cronómetro, valorarlas y editarlas.',
  'mantenimiento.borrar': 'Permite borrar incidencias de mantenimiento.',
  'mantenimiento.facturar':
    'Permite generar las facturas mensuales de reparaciones y cambiar su configuración.',

  // Limpieza
  'limpieza.ver':
    'Permite entrar en Limpieza y ver checklists, objetos y reglas. También muestra las limpiezas del día en el Planning.',
  'limpieza.completar': 'Permite completar checklists de limpieza con foto y firma.',
  'limpieza.programar':
    'Permite programar limpiezas: reglas, plantillas, objetos y generación de registros.',
  'limpieza.catalogo': 'Permite gestionar el catálogo de tipos y objetos de limpieza.',
  'limpieza.informes': 'Permite consultar el histórico y las evidencias (fotos) de las limpiezas.',
  'limpieza.borrar': 'Permite borrar registros de limpieza.',

  // Activos
  'activos.ver': 'Permite ver el inventario de activos, sus fichas, custodia y el escáner de etiquetas.',
  'activos.crear': 'Permite dar de alta activos, categorías, modelos y plantillas del catálogo.',
  'activos.editar':
    'Permite modificar activos: trasladar, etiquetar, cambiar estado, entregar y recoger.',
  'activos.borrar': 'Permite dar de baja activos, modelos, categorías y plantillas. El código no se reutiliza.',

  // Proyectos
  'proyectos.ver':
    'Muestra Proyectos en el menú y permite ver proyectos y tareas, la agenda y las notificaciones.',
  'proyectos.crear': 'Permite crear proyectos nuevos, también a partir de plantillas.',
  'proyectos.editar': 'Permite modificar proyectos, gestionar sus miembros y editar sus tareas.',
  'proyectos.borrar': 'Permite borrar proyectos y sus tareas.',
  'tareas.ver_todas':
    'Permite ver todas las tareas aunque no se sea responsable ni miembro del proyecto.',
  'tareas.editar_todas': 'Permite modificar cualquier tarea.',
  'proyectos.presupuesto_ver':
    'Permite ver el presupuesto, lo comprometido y el gasto real de los proyectos.',
  'proyectos.compras_aprobar': SIN_EFECTO,
  'proyectos.plantillas': 'Permite crear, modificar y borrar plantillas de proyecto.',
  'proyectos.cuadro_mando': 'Permite ver el cuadro de mando de dirección de proyectos.',

  // Reuniones
  'reuniones.ver': 'Permite ver las reuniones a las que se tiene acceso, sus tareas y su actividad.',
  'reuniones.gestionar':
    'Permite convocar y modificar reuniones, editar el acta y validar propuestas.',
  'reuniones.ver_direccion': 'Permite ver las reuniones de dirección.',
  'reuniones.borrar_audio': SIN_EFECTO,

  // Legacy
  'rrss.ver':
    'Permiso antiguo: concede lo mismo que «marketing.proponer». Usar ese en su lugar.',
};

const ACCIONES_GENERICAS: Record<string, (modulo: string) => string> = {
  ver: (m) => `Permite ver el módulo ${m} y su menú.`,
  crear: (m) => `Permite crear registros en ${m}.`,
  editar: (m) => `Permite modificar registros en ${m}.`,
  borrar: (m) => `Permite borrar registros en ${m}.`,
  sincronizar: (m) => `Permite sincronizar ${m} con sistemas externos.`,
  exportar: (m) => `Permite exportar datos de ${m}.`,
  importar: (m) => `Permite importar datos en ${m}.`,
  gestionar: (m) => `Permite gestionar ${m}.`,
};

function nombreModulo(codigo: string, etiqueta?: string): string {
  const desdeEtiqueta = etiqueta?.split('·')[0]?.trim();
  if (desdeEtiqueta && desdeEtiqueta !== codigo) return desdeEtiqueta;
  const prefijo = codigo.split('.')[0] ?? codigo;
  const texto = prefijo.replace(/_/g, ' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Descripción del permiso; si no hay una específica, la deriva de la acción. */
export function descripcionPermiso(codigo: string, etiqueta?: string): string {
  const especifica = PERMISOS_DESCRIPCIONES[codigo];
  if (especifica) return especifica;
  const modulo = nombreModulo(codigo, etiqueta);
  const accion = codigo.split('.').pop() ?? '';
  const generica = ACCIONES_GENERICAS[accion];
  if (generica) return generica(modulo);
  return etiqueta ? `Permite: ${etiqueta}.` : `Permiso «${codigo}».`;
}
