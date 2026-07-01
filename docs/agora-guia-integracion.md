# Guía del Integrador Ágora — Referencia Compacta (v8.9.3)

> **Fuente oficial (canónica):** `docs/Guía del Integrador Agora - 8.9.3.pdf`.
> Este archivo es solo un resumen para búsqueda rápida en el IDE; ante cualquier
> duda de formato (XML completo, JSON sin truncar, changelog) manda el PDF.
> La versión anterior 8.1.6 se conserva en `docs/agora/legacy/` únicamente como histórico.
>
> XML omitido. JSON truncado. `[Req]` = obligatorio, `[Opt]` = opcional. Changelog omitido.
> Fechas: `aaaa-mm-dd` o `aaaa-mm-ddThh:mm:ss`. Decimales con punto. Sin separador de miles.

---


## Servicios de Integración — ais.exe

Servicios de Integración con Otras
- **Aplicaciones** — Los servicios de integración de Ágora le permiten traspasar información entre Ágora y otras aplic...

- Families: familias
- Sizes: tallas
- Colors: colores
- Products: productos
- Menus: menús
- Offers: promociones
- Warehouses: almacenes
- Stocks: stocks actuales
Si, por ejemplo, desea exportar únicamente usuarios y clientes, debería utilizar la línea
de comandos
ais.exe --export-master datos.xml Users,Customers.
- --validate <file_name>: Valida que el formato del fichero que se va a importar es
correcto, indicando los posibles errores encontrados.
El formato de los ficheros de importación y exportación se detalla en las siguientes secciones de
este manual.
Al ejecutar la aplicación se mostrará en pantalla el resultado de la operación. Además, el código
de retorno del proceso indicará el resultado de la operación:
- 0: Ejecución completada con éxito
- -1: Parámetros de línea de comandos incorrectos
- -2: Error al realizar exportación de ventas
- -3: Error al realizar importación
- -4: Error al realizar validación
- -5: Error al realizar exportación de datos maestros
Importación y Exportación Automática
Si lo desea, puede configurar el módulo de servicios de integración para que el proceso de
importación y exportación de datos se realice de forma automática. Para ello deberá activar las
opciones correspondientes al configurar el módulo de servicios de integración.
Cuando la exportación automática está habilitada, al emitir un factura, realizar un cargo en
cuenta, cancelar un cargo en cuenta, crear un movimiento de caja, cerrar una caja o efectuar
un cierre de sistema, se generará automáticamente un fichero con la información relativa al
evento en la carpeta indicada. El formato de los documentos generados es el mismo que cuando
se realiza una exportación manual utilizando ais.exe.
Cuando se activa la importación automática, Ágora estará continuamente monitorizando el
contenido de la carpeta indicada y, tan pronto como encuentre ficheros con la extensión .xml,
intentará importarlos. Si la importación se produce con éxito, se cambiará la extensión del
fichero a .ok, y si se produce algún error, la extensión se cambiará a .error.

En caso de que se produzca algún error al importar o exportar, Ágora lo reflejará en el log del
servidor.

## Formato del Fichero de Importación

Formato de fichero de importación de datos
El fichero de importación de datos de Ágora permite especificar gran parte de la información
necesaria para trabajar con Ágora, incluyendo familias, productos, centros de venta, usuarios,
precios y clientes.
Al procesar el fichero de importación, Ágora procesará cada registro secuencialmente realizando
las siguientes acciones:
- Si no existe un registro en Ágora con el mismo Id que el registro procesado, se creará
el registro en Ágora.
- Si ya existe un registro en Ágora con el mismo Id que el registro procesado, se
actualizará la información de ese registro.
- Si el registro procesado incluye un valor para el campo fecha de borrado,
DeletionDate, el registro se considerará borrado y será marcado como tal en Ágora. Si
no incluye ese campo se considerará que el registro está activo y, en caso de que
estuviera borrado en Ágora, se volverá a activar.
Ágora no realizará ninguna acción sobre la información existente en Ágora que no aparezca en
el fichero de datos importados. Es decir, si por ejemplo se crea un producto en Ágora y luego el
producto no aparece en el fichero, el producto seguirá existiendo en Ágora.
Este sistema permite mucha flexibilidad, porque es posible realizar importaciones totales o
parciales. Cuando se realiza la puesta en marcha de la aplicación se puede enviar un fichero con
la base de datos completa y, a partir de ese momento, enviar sólo en el fichero aquellos
registros que sea necesario crear, modificar o eliminar. Ante cualquier problema, siempre se
puede volver a enviar la base de datos completa.
La información recibida en el fichero siempre sobreescribe la información existente en Ágora.
Si, por ejemplo, se modifica un precio en Ágora y luego se vuelve a importar un fichero con el
precio original, se perderá la modificación realizada en Ágora.
El tratamiento de los campos opcionales, excepto en el caso de la fecha de borrado que se ha
explicado anteriormente, será el siguiente: Si el campo no aparece en el fichero XML, se
mantendrá el valor que exista actualmente en la base de datos de Ágora. Si el campo aparece
en el fichero XML, se sobreescribirá el valor de Ágora con el valor indicado, incluso si éste es
vacío (siempre que sea posible). Por ejemplo, si el campo FamilyId de un producto no aparece
en el fichero, se mantendrá la familia asociada actualmente a ese producto. Si el campo
FamilyId contiene un Id de familia, se asociará ese producto a la familia indicada, y si el campo
FamilyId está vacío, se quitará la familia que tuviera asociada el producto.
Hay ocasiones en que un campo es opcional pero no puede dejarse vacío. O bien aparece en el
XML con un valor válido, en cuyo caso se sobreescribirá el valor actual en Ágora, o bien no

aparece en el XML, en cuyo caso se mantiene el valor actual de Ágora. Esto ocurre, en general,
con campos que no permiten valores "nulos" o vacíos. Por ejemplo, el descuento de un cliente
puede indicarse con un valor numérico válido (incluyendo 0) para actualizarlo en Ágora, o puede
no indicarse para mantener el valor actual, pero no puede indicarse con un valor vacío porque
no es un valor válido para un número.
exe para
comprobar su validez.
El fichero de importación de datos consta de varias secciones como puede comprobar en el
fichero de ejemplo incluido junto a este manual. Debe respetarse el orden en que aparecen en
el fichero.

<!-- Facturas -->
<!-- Proveedores -->
<!-- Pedidos de Compra -->
<!-- Albaranes de Entrada -->
<!-- Facturas de Compra -->
{
"Colors": [],
"Sizes": [],
"Users": [],
"Customers": [],
"Series": [],
"PaymentMethods": [],
"Vats": [],
"PreparationTypes": [],
"PreparationOrders": [],
"Families": [],
"PriceLists": [],
"SaleCenters": [],
"Products": [],
"Menus": [],
"SalesOrders": [],
"DeliveryNotes": [],
"Invoices": [],
  // ...truncado...
}
En cada sección del fichero habrá información que sea obligatoria e información opcional. Los
campos opcionales ni siquiera es necesario que aparezcan en el documento XML.

Los campos numéricos utilizan como separador de decimales el punto '.' y NO
utilizan separador de millares.
Los campos de tipo fecha utilizando como formato aaaa-mm-dd. Si además
incluye la hora, el formato es aaaa-mm-ddThh:mm:ss, por ejemplo
2012-01-29T21:00:54.
- **Series** — Las series que puede indicar son: - BasicInvoice: facturas simplicadas.
- **Name** `[Req]` — Nombre de la serie.
- **LastNumber** — último documento generado en esa serie.
- **Usuarios** — ", "Color": "#34112a", "CardNumber": "#455232", "CardNumber2": "7896j", "Profile": "Admin", "Show...

## Usuarios

- **Id** `[Req]` — Identificador numérico único del usuario.
- **Name** `[Req]` — Nombre del usuario.
- **Password** — Contraseña del usuario para acceder al TPV.
- **SmartphonePassword** — Contraseña del usuario para acceder a la comandera.
- **WebAdminPassword** — Contraseña del usuario para acceder a la administración.
- **ButtonText** — Texto mostrado en el botón asociado al usuario en el punto de venta.
- **Color** — Color del botón asociado al usuario en el punto de venta.
- **CardNumber** — Código de la tarjeta de acceso asociada al usuario.
- **CardNumber2** — Un segundo códgio de tarjeta de acceso asociada al usuario.
- **IsTrainee** — Indica si es un usuario en formación.
- **Profile** — Perfil del usuario.
- **ShowInClockings** — Indica si el usuario se muestra en la pantalla de fichajes o no.
- **DeletionDate** — Fecha de borrado del registro.
- **SocialSecurityNumber** — Número de la Seguridad Social del usuario.
- **Nif** — NIF del usuario.
- **Telephone** — Número de teléfono del usuario.
- **Email** — Email del usuario.
- **Street** — Dirección del usuario.
- **City** — Población del usuario.
- **Region** — Provincia del usuario.
- **ZipCode** — Código postal del usuario.
- **FullName** — Nombre y apellidos del usuario que se va a usar en las hojas de fichajes..
- **CompanyName** — Nombre de empresa que se va a usar en los informes de fichajes.
- **CompanyCif** — CIF de empresa que se va a usar en los informes de fichajes.
- **CompanyCCC** — Código de cuenta contable de la empresa que se va a usar en los informes de fichajes.
- **CompanyCCC** — Código de cuenta contable de la empresa que se va a usar en los informes de fichajes.
- **AutoClockOutMaxHours** — Max.
- **Name** `[Req]` — Nombre del tipo de cliente.
- **DeletionDate** — Fecha de borrado del registro.
- **Clientes** — Marcos Retuerto, S/N", "City": "Getafe", "Region": "Madrid", "ZipCode": "28054", "DiscountRate": ...

"ValidForAll": true,
"ValidPosGroups": []
},
}
]
}

## Clientes — Customers

- **Id** `[Req]` — Identificador numérico único del cliente.
- **FiscalName** `[Req]` — Nombre fiscal del cliente.
- **BusinessName** — Nombre comercial del cliente.
- **Cif** — CIF/DNI/NIE del cliente.
- **CountryCode** `[Opt]` — Código del pais del cliente.
- **DocumentIdType** `[Opt]` — Tipo de documento de identidad.
- **Street** — Dirección del cliente.
- **City** — Población del cliente.
- **Region** — Provincia del cliente.
- **ZipCode** — Código postal del cliente.
- **DiscountRate** — Tanto por uno de descuento del cliente, por ejemplo, si le desea aplicar un 10% de descuento, est...
- **ApplySurcharge** — Indica si al cliente se le aplica recargo de equivalencia o no.
- **CardNumber** — Código de la tarjeta de acceso asociada al cliente.
- **RequireIdentificationCard** — Indica si el cliente requiere un número de tarjeta para ser identificado.
- **PriceListId** — Identificador de la tarifa asociada al cliente (si la tiene).
- **TypeId** — Identificador del tipo de cliente (si es de algún tipo).
- **ParentCustomerId** — Identificador único del cliente principal de este cliente.
- **Telephone** — Teléfono del cliente.
- **Email** — Correo electrónico del cliente.
- **ContactPerson** — Persona de contacto.
- **Notes** — Notas asociadas al cliente.
- **ShowNotes** — Indica si se muestran las notas del cliente cuando se le asigna a un documento de venta.
- **SendMailing** — Indica si el cliente recibe o no publicidad desde el módulo de e-mailing.
- **AccountCode** — Código de la cuenta contable asignada al cliente.
- **DeletionDate** — Fecha de borrado del registro.
- **Offers** — Promociones que se aplican al ticket de asociado a un cliente.
- **PosGroups** — Grupos de puntos de venta para los que será compartida la información del cliente.

## Formas de Pago — PaymentMethods

- **Id** `[Req]` — Identificador numérico único de la forma de pago.
- **Name** `[Req]` — Nombre de la forma de pago.
- **GiveChange** — Indica si al pagar con esta forma de pago se devolverá cambio, por ejemplo, en el caso de pago en...
- **IncludeInBalance** — Indica si el importe pagado con esta forma de pago debe tenerse en cuenta al hacer el conteo de m...
- **IncludeTipInBalance** — Indica si la propina con esta forma de pago debe tenerse en cuenta al hacer el conteo de monedas ...
- **OpenCashDrawer** — Indica si se debe abrir el cajón portamonedas automáticamente cuando se realiza un cobro con esta...
- **RegisterTip** — Indica si el usuario debe introducir la propina que se ha recibido mediante esta forma de pago.
- **AllowOverPaid** — Indica si se puede pagar más del importe total con esta forma de pago.
- **IsValidForSale** — Indica si la forma de pago es válida para realizar ventas.
- **IsValidForPurchase** — Indica si la forma de pago es válida para realizar compras.
- **IsValidForPhoneOrder** — Indica si la forma de pago es válida para realizar pedidos telefónicos.
- **IsValidForRefund** — Indica si la forma de pago es válida para usarse en las devoluciones.
- **IsRefundVoucher** — Indica si se imprimirán vales devolución.
- **AllowExtraInformation** — Indica si se puede asociar a la forma de pago notas.
- **ButtonText** — Texto mostrado en el botón asociado a la forma de pago en el punto de venta.
- **Color** — Color del botón asociado a la forma de pago en el punto de venta.
- **Priority** — Indica el orden que tomarán las formas de pago en la pantalla de cobros.
- **ExtractTipFromCashdrawer** — Indica si, al aceptar pagos mediante esta forma de pago, las propinas se descuenten del saldo del...
- **RequireCustomer** `[Opt]` — Indica si, al aceptar pagos mediante esta forma de pago, debe obligarse a introducir un cliente.
- **RequiredCustomerTypeId** `[Opt]` — Identificador del tipo de cliente.
- **DeletionDate** — Fecha de borrado del registro.
- **MaxAllowedPayment** — Importe máximo permitido en una factura para la forma de pago especificada.
- **Impuestos** — 00, "SurchargeRate": 0.000 }, { "Id": 2, "Name": "Super reducido", "VatRate": 0.04, "SurchargeRat...

## Tipos de Impuesto — Vats

- **Id** `[Req]` — Identificador numérico único del tipo de impuesto.
- **Name** `[Req]` — Nombre del tipo de impuesto.
- **VatRate** `[Req]` — Tanto por uno de impuesto.
- **SurchargeRate** `[Req]` — Tanto por uno de recargo de equivalencia.
- **Enabled** `[Req]` — Permite indicar si el impuesto está habilitado (true) o no (false).
- **Proveedores** — A.", "BusinessName": "Casbega", "Cif": "A23429423", "Street": "Avd.

## Proveedores — Suppliers

- **Id** `[Req]` — Identificador numérico único del proveedor.
- **FiscalName** `[Req]` — Nombre fiscal del proveedor.
- **BusinessName** — Nombre comercial del proveedor.
- **Cif** `[Req]` — CIF/NIF del proveedor.
- **Street** — Dirección del proveedor.
- **City** — Población del proveedor.
- **Region** — Provincia del proveedor.
- **ZipCode** — Código postal del proveedor.
- **ApplySurcharge** — Indica si al proveedor compramos con recargo de equivalencia o no.
- **Telephone** — Teléfono del cliente.
- **Email** — Correo electrónico del cliente.
- **Web** — Paígina web del proveedor.
- **ContactPerson** — Persona de contacto.
- **AccountCode** — Código de la cuenta contable asignada al proveedor.
- **DeletionDate** — Fecha de borrado del registro.
- **ShowSupplierProductsInPurchaseDocumentOnly** — Indica si, al crear documentos de compra para este proveedor, solo se muestra productos asociados...
- **WarnIfPurchaseDocumentAlreadyExists** — Indica si, al crear documentos de compra para este proveedor con un número de documento ya existe...
- **Almacenes** — Marcos Retuerto, S/N", "City": "Getafe", "Region": "Madrid", "ZipCode": "28054", "PurchaseOrderSe...

## Almacenes — Warehouses

- **Id** `[Req]` — Identificador numérico único del almacén.
- **Name** `[Req]` — Nombre del almacén.
- **Street** — Dirección del almacén.
- **City** — Población del almacén.
- **Region** — Provincia del almacén.
- **ZipCode** — Código postal del almacén.
- **PurchaseOrderSerie** — Serie para los pedidos a proveedor.
- **IncomingDeliveryNoteSerie** — Serie para los albaranes de entrada.
- **PurchaseInvoiceSerie** — Serie para las facturas de proveedor.
- **FiscalInfo** — Información fiscal que se usa para la generación de documentos en pdf de los documentos de compra...
- **FiscalName** — Nombre Fiscal.
- **Cif** — Cif.
- **UseInDocuments** — Sí se usa en los documentos de compra o no.
- **Delivered** — El pedido ha sido servido totalmente desde algún albarán.
- **DeletionDate** — Fecha de borrado del registro.
- **UpdatePricePolicy** — Política de actualización de los precios de coste del Almacén a la hora de crear un Albarán de En...
- **PurchasePrice** — Usar precio de compra.
- **WeightedAvgPrice** — Precio medio ponderado.
- **PurchasePrice30Days** — Precio Medio de Compra (30 días).
- **PurchasePrice90Days** — Precio Medio de Compra (90 días).
- **UpdateProductionPricePolicy** — Política de actualización de los precios de coste del Almacén a la hora de realizar Fabricaciones...
- **ProductionCost** — Usar precio de coste de origen.
- **WeightedAvgCostPrice** — Usar precio medio ponderado.
- **UpdateTransferCostPricePolicy** — Política de actualización de los precios de coste del Almacén a la hora de traspasar mercancía.
- **OriginCostPrice** — Usar precio de coste de origen.
- **WeightedAvgCostPrice** — Usar precio medio ponderado.
- **RestockSupplierSearchMode** — Proveedor por defecto que se usará al realizar los pedidos de reposición.
- **Default** — Usar el primer proveedor de la ficha de producto.
- **BestPurchaseCondition** — Usar el proveedor con mejor condición comercial.
- **BestPurchasePrice** — Usar el proveedor con mejor precio de compra.
- **Name** `[Req]` — Nombre del tipo de preparación.
- **DeletionDate** — Fecha de borrado del registro.
- **Name** `[Req]` — Nombre del orden de preparación.
- **Priority** `[Req]` — Prioridad del orden de preparación.
- **CanBeRequested** `[Req]` — Indica si es posible marchar este órden de preparación (true) o no (false).
- **OnRequestedStartPreparation** `[Opt]` — Indica si debe iniciarse la preparación del plato una vez que se ha marchado la preparación(true)...
- **OnPendingPreparationStartCooking** `[Opt]` — Indica si debe iniciarse la preparación del plato una vez se envía a cocina (true) o no (false).
- **DeletionDate** — Fecha de borrado del registro.
- **Familias** — Name [Obligatorio] Nombre de la familia.
- **Name** `[Req]` — Nombre de la familia.
- **ButtonText** — Texto mostrado en el botón asociado a la familia en el punto de venta.
- **Color** — Color del botón asociado a la familia en el punto de venta.
- **ParentFamilyId** — Identificador único de la familia padre de esta familia.
- **ShowInPos** — Permite indicar si la familia se visualiza o no en el punto de venta.
- **Order** — Posición de la familia en el punto de venta.
- **DeletionDate** — Fecha de borrado del registro.
- **Tarifas** — Name [Obligatorio] Nombre de la tarifa.

## Tarifas — PriceLists

- **Name** `[Req]` — Nombre de la tarifa.
- **VatIncluded** `[Req]` — Indica si los precios en esta tarifa son con impuestos incluidos (true) o no (false).
- **DeletionDate** — Fecha de borrado del registro.
- **Name** `[Req]` — Nombre del centro de venta.
- **PriceListId** `[Req]` — Identificador de la tarifa por defecto del centro de venta.
- **CurrentPriceListId** — Identificador de la tarifa actual del centro de venta.
- **VatIncluded** `[Req]` — Indica si los precios en esta tarifa son con impuestos incluidos (true) o no (false).
- **ButtonText** — Texto mostrado en el botón asociado al centro de venta en el punto de venta.
- **Color** — Color del botón asociado al centro de venta en el punto de venta.

AskForGuests [Obsoleto]
Indica si al seleccionar una ubicación del centro de venta debe solicitarse (true) o no
(false) la introducción del número de comensales. Obsoleto, ver WhenAskForGuests
- **StartTakeOutOrder** — Indica si al seleccionar una ubicación del centro de venta debe iniciarse un pedido telefónico.
- **GuestProductId** — Id del producto que se venderá automáticamente por cada comensal introducido al seleccionar una u...
- **WhenAskForGuests** — Indica cuando se debe solicitar la introducción del número de comensales.
- **WhenAskForFriendlyName** — Indica cuándo se debe solicitar la introducción del identificador de ticket.
- **SaleLocations** `[Req]` — Lista de ubicaciones/mesas existentes en el centro de venta, cada una de ellas debe indicarse en ...
- **DeletionDate** — Fecha de borrado del registro.
- **Tallas** — Name [Obligatorio] Nombre de la talla.
- **Name** `[Req]` — Nombre de la talla.
- **Priority** — Permite ordenar las tallas en las pantallas de Ágora (configuración de productos, selección de ta...
- **Colores** — Name [Obligatorio] Nombre del color.
- **Name** `[Req]` — Nombre del color.
- **Value** — Color usado para representar este color.
- **Priority** — Permite ordenar los colores en las pantallas de Ágora (configuración de productos, selección de c...
- **Productos** — A90", "MinStock": 5, "MaxStock": 25 }, { "WarehouseId": 2, "Location": "S2.A90", "MinStock": 10, ...

"FamilyId": 100,
"VatId": 3,
"ButtonText": "COCA-COLA",
"Color": "#341122",
"Barcode": "255223",
"Order": 1,
"UseAsDirectSale": true,
"AskForPreparationNotes": true,
"AskForAddins": true,
"PreparationTypeId": 1,
"PreparationOrderId": 1,
"PLU": "0001"
},
{
"Id": 103,
"Name": "Pitiusa",
"FamilyId": 100,
"VatId": 3,
"PrintWhenPriceIsZero": false,
"DeletionDate": "1982-10-01T12:00:00"
},
{
"Prices": [
{
"PriceListId": 10,
"MainPrice": 2.50,
"AddinPrice": 0.00,
"MenuItemPrice": 0.00
},
{
"PriceListId": 11,
"MainPrice": 3.00,
"AddinPrice": 0.00,
"MenuItemPrice": 0.00
}
],
"Addins": [
{
"SaleFormatId": 100
  // ...truncado...
}

{
"Id": 301,
"Name": "Bocadillo de Jamon",
"FamilyId": 101,
"VatId": 3
},
{
"Id": 302,
"Name": "Bocadillo de Lomo",
"FamilyId": 101,
"VatId": 3
},
{
"Prices": [
{
"PriceListId": 1,
"MainPrice": 3.0,
"AddinPrice": null
},
{
"PriceListId": 2,
"MainPrice": 4.0,
"AddinPrice": null
}
],
"Addins": [
{
"SaleFormatId": 1
},
{
  // ...truncado...
}
{
"Id": 93,
"Name": "Camiseta",
"BaseSaleFormatId": 103,
"ButtonText": "Camiseta",
"Color": "#BACDE2",
"PLU": "",
"FamilyId": null,
"VatId": 4,
"UseAsDirectSale": false,
"SaleableAsMain": true,
"SaleableAsAddin": false,
"IsSoldByWeight": false,
"AskForPreparationNotes": false,
"AskForAddins": true,
"PrintWhenPriceIsZero": true,
"PreparationTypeId": null,
"PreparationOrderId": null,
  // ...truncado...
}
]

}
- **Id** `[Req]` — Identificador numérico único del producto.

## Productos — Products

- **Name** `[Req]` — Nombre del producto.
- **VatId** `[Req]` — Id del impuesto de venta asociado al producto.
- **BaseSaleFormatId** — Id de formato de venta base del producto.
- **FamilyId** — Id de la familia a la que pertenece el producto.
- **ButtonText** — Texto mostrado en el botón asociado al producto en el punto de venta.
- **PLU** — Código PLU del menú.
- **Color** — Color del botón asociado al producto el punto de venta.
- **Sizes** — Tallas asociadas a este producto.
- **Colors** — Colores asociados a este producto.
- **Barcodes** — Lista de códigos de barras del producto.
- **StorageOptions** — Opciones de almacenamiento del producto en cada almacén.
- **WarehouseId** `[Req]` — Id del almacén.
- **Location** `[Req]` — Ubicación del producto dentro del almacén.
- **MinStock** `[Req]` — Stock mínimo del producto en unidades de venta.
- **MaxStock** `[Req]` — Stock máximo del producto en unidades de venta.
- **Order** — Posición del producto dentro de su familia en el punto de venta.
- **PreparationTime** — Tiempo de preparación del producto.
- **PreparationTimeWarningMinutes** — Tiempo de preaviso antes de que se lleqgue al tiempo de preparación.
- **UseAsDirectSale** — Indica si el producto debe tratarse como un producto de venta directa (true) o no (false).

MinAddins [Obsoleto: Usar AddinRoles]
Número mínimo de añadidos que se deberán seleccionar al vender el producto.
MaxAddins [Obsoleto: Usar AddinRoles]
Número máximo de añadidos que se podrán seleccionar al vender el producto.
- **SaleableAsMain** — Indica si el producto puede venderse como producto principal (true) o no (false).
- **SaleableAsAddin** — Indica si el producto puede venderse como producto añadido (true) o no (false).
- **AskForAddins** — Indica si al vender el producto deben solicitarse automáticamente añadidos (true) o no (false).
- **AskForPreparationNotes** — Indica si al vender el producto deben solicitarse automáticamente notas de preparación (true) o n...
- **PrintWhenPriceIsZero** — Indica si al imprimir un ticket en el cual este producto tiene precio cero, debe mostrarse el pro...
- **PreparationTypeId** — Id del tipo de preparación asociado al producto.
- **PreparationOrderId** — Id del order de preparación asociado al producto.
- **IsSoldByWeight** — Indica si el producto es vendible al peso (true) o no (false).
- **Prices** — Precios del producto en cada centro de venta y tarifa especial.
- **PriceListId** `[Req]` — Id de la tarifa cuyos precios se quieren establecer.
- **MainPrice** `[Req]` — Precio de venta como producto principal.
- **AddinPrice** `[Req]` — Precio de venta como añadido de otro producto.
- **MenuItemPrice** `[Req]` — Suplemento al incluir el producto en un menú.

Addins [Obsoleto: Usar AddinRoles]
Añadidos disponibles para el producto. Cada añadido debe indicarse en un elemento
Addin con los siguientes atributos:
- **SaleFormatId** `[Req]` — Id del formato de venta que se usará como añadido.
- **AddinRoles** — Grupos de añadidos disponibles para el producto.
- **Name** `[Req]` — Nombre del grupo de añadidos.
- **MinAddins** — Número mínimo de añadidos que se deberán seleccionar al vender el producto con un añadido de este...
- **MaxAddins** — Número máximo de añadidos que se podrán seleccionar al vender el producto con un añadido de este ...
- **AdditionMode** — Modo de trabajo al vender varias unidades del producto principal.
- **UsePreparationType** — Tipo de preparación para los añadidos del grupo.
- **AdditionalSaleFormats** — Formatos de venta adicionales del producto.
- **Id** `[Req]` — Identificador único del formato de venta.
- **Name** `[Req]` — Nombre del formato de venta.
- **Ratio** `[Req]` — Relación de la cantidad consumida por este formato con respecto al formato base.
- **ButtonText** — Texto mostrado en el botón asociado al formato de venta en el punto de venta.
- **Color** — Color del botón asociado al formato de venta el punto de venta.
- **SaleableAsMain** — Indica si el formato puede venderse como formato principal (true) o no (false).
- **SaleableAsAddin** — Indica si el formato puede venderse como formato añadido (true) o no (false).
- **AskForAddins** — Indica si al vender el formato deben solicitarse automáticamente añadidos (true) o no (false).

MinAddins [Obsoleto: Usar AddinRoles]
Número mínimo de añadidos que se deberán seleccionar al vender el formato.
MaxAddins [Obsoleto: Usar AddinRoles]
Número máximo de añadidos que se podrán seleccionar al vender el formato.
- **DeletionDate** — Fecha de borrado del registro.
- **Prices** — Precios del formato en cada centro de venta y tarifa especial.
- **PriceListId** `[Req]` — Id de la tarifa cuyos precios se quieren establecer.
- **MainPrice** `[Req]` — Precio de venta como formato principal.
- **AddinPrice** `[Req]` — Precio de venta como añadido de otro producto o formato.
- **MenuItemPrice** `[Req]` — Suplemento al incluir el formato en un menú.

Addins [Obsoleto: Usar AddinRoles]
Añadidos disponibles para el formato. Cada añadido debe indicarse en un
elemento Addin con los siguientes atributos:
- **SaleFormatId** `[Req]` — Id del formato de venta que se usará como añadido.
- **AddinRoles** — Grupos de añadidos disponibles para el formato.
- **Name** `[Req]` — Nombre del grupo de añadidos.
- **MinAddins** — Número mínimo de añadidos que se deberán seleccionar al vender el producto con un añadido de este...
- **MaxAddins** — Número máximo de añadidos que se podrán seleccionar al vender el producto con un añadido de este ...
- **UsePreparationType** — Tipo de preparación para los añadidos del grupo.
- **CostPrice** — Si aparece este nodo, establece el precio de coste para todos los almacenes de este producto y el...
- **CostPrices** — Precios de coste del producto en cada almacén.
- **WarehouseId** `[Req]` — Id del almacén.
- **CostPrice** `[Req]` — Indica el precio de coste del producto en almacén indicado.
- **DeletionDate** — Fecha de borrado del registro.

con ese Id en la base de datos asociado a otro producto, por ejemplo porque ha sido creado
manualmente desde la administración de Ágora, se generará un error.
Menús
00
},
{
"SaleCenterId": 11,
"MainPrice": 10.00
}
],
"MenuGroups": [
{
"Products": [
{
"Id": 100
},
{
"Id": 101
}
],
"Name": "Bebida",
"MaxItems": 1,
"PreparationOrderId": 1
},
{
"Products": [
{
"Id": 301
},
{
"Id": 302
}
],
"Name": "Bocadillo",
"MaxItems": 1,
"PreparationOrderId": 2
}
],
"Id": 401,
"Name": "Menú Merienda",
"VatId": 3,
"FamilyId": 104,
"ButtonText": "M.Merienda",

"Color": "#341122",
"Order": 1,
"UseAsDirectSale": true,
"Tag": "MM",
"PLU": "0001"
}
]
}
Para cada menú podrá indicar información similar a la del producto, pero además deberá indicar
los grupos que forman parte del menú:

## Menús

- **Id** `[Req]` — Identificador numérico único del menú.
- **Name** `[Req]` — Nombre del menú.
- **VatId** `[Req]` — Id del impuesto de venta asociado al menú.
- **FamilyId** — Id de la familia a la que pertenece el menú.
- **ButtonText** — Texto mostrado en el botón asociado al menú en el punto de venta.
- **Color** — Color del botón asociado al menú el punto de venta.
- **Barcodes** — Lista de códigos de barras del menú.
- **Order** — Posición del menú dentro de su familia en el punto de venta.
- **UseAsDirectSale** — Indica si el menú debe tratarse como un producto de venta directa (true) o no (false).
- **SaleableAsMain** — Indica si el menú puede venderse (true) o no (false).
- **Tag** `[Req]` — Texto usado en la comanda impresa y en los monitores de cocina para distinguir los platos de este...
- **PLU** — Código PLU del menú.
- **Prices** — Precios del menú en cada centro de venta y tarifa especial.
- **MainPrice** — Precio de venta del menú.
- **MenuGroups** `[Req]` — Grupos de platos que forman el menú.
- **Name** `[Req]` — Nombre del grupo de platos.
- **MaxItems** `[Req]` — Número máximo de platos de este grupo que puede pedirse.
- **PreparationOrderId** `[Req]` — Id del orden de preparación que se usará al pedir los platos de este grupo.
- **Products** — Lista de productos que se pueden elegir para este grupo de platos.
- **DeletionDate** — Fecha de borrado del registro.

Para cada grupo de platos de los menús, Ágora creará automáticamente una categoría llamada
"Grupo de Menú", por ejemplo, "Bebidas de Menú del Día". La gestión de estas categorías es
realizada automáticamente por Ágora y no deberán ser modificadas desde la administración de
Ágora.
- **Promociones** — Name [Obligatorio] El nombre de la promoción.
- **Name** `[Req]` — El nombre de la promoción.
- **Code** `[Req]` — Código de la promoción.
- **ApplicationMode** `[Req]` — Si el valor es "AllTickets" indica que la promoción se aplica automáticamente a todos los tickets...
- **FromDate** `[Req]` — Fecha de inicio de la promoción.
- **ToDate** `[Req]` — Fecha de fin de la promoción.
- **MaxApplicationsPerTicket** `[Opt]` — Indica el número máximo de veces que se puede aplicar la promoción en un mismo ticket.
- **StartTime** `[Req]` — Hora de inicio de la promoción.
- **EndTime** `[Req]` — Hora de fin de la promoción.
- **ApplyOnMonday** `[Req]` — Indica si la promoción está vigente los lunes.
- **ApplyOnTuesday** `[Req]` — Indica si la promoción está vigente los martes.
- **ApplyOnWednesday** `[Req]` — Indica si la promoción está vigente los miércoles.
- **ApplyOnThursday** `[Req]` — Indica si la promoción está vigente los jueves.
- **ApplyOnFriday** `[Req]` — Indica si la promoción está vigente los viernes.
- **ApplyOnSaturday** `[Req]` — Indica si la promoción está vigente los sábados.
- **ApplyOnSunday** `[Req]` — Indica si la promoción está vigente los domingos.
- **DeletionDate** — Fecha de borrado del registro.

Esta promoción se encuentra dentro del elemento <Discount> que contiene el elemento
{
"Discount": {
"Products": [
{
"Id": 12
},
{
"Id": 13
},
{
"Id": 14
},
{
"Id": 91
},
{
"Id": 92
},
  // ...truncado...
}
Los atributos disponibles son los siguientes:
- **DiscountRate** `[Req]` — Tanto por uno de descuento que aplica la promoción.
- **CashDiscount** `[Req]` — Descuento en moneda que se aplica la promoción.
- **RequiredQuantity** `[Req]` — Cantidad necesaria que se debe comprar de los productos indicados para aplicar la promoción.

ApplyBy [Opccional]
Modo de aplicación de la promoción. Los posibles valores para este atributo son
"Groups" y "Units". Este atributo, si está presente, modifica el comportamiento de
Ágora a la hora de aplicar la promoción. Con el valor "Units", una vez que se alcancen
la cantidad requerida de unidades, se aplicará la promoción a todas ellas. Con el valor
"Groups" la promoción se aplicará a cada tantas unidades como se hayan establecido.
- **TargetSelection** `[Opt]` — Modo de aplicación de la promoción: `Cheapest` para aplicar sobre los productos más baratos, `Mos...
- **Id** `[Req]` — Identificador del producto.
- **RequiredQuantity** `[Req]` — Cantidad necesaria que se debe comprar de los productos para aplicar la promoción.
- **Id** `[Req]` — Identificador del producto.
- **PriceListId** `[Req]` — Id de la tarifa cuyos precios se quieren establecer.
- **Value** `[Req]` — Precio de venta del pack de productos.
- **Personalizada** — Se corresponde con la promoción "Personalizada" y permite relizar el resto de promociones disponi...

{
"Custom": {
"SourceProducts": [
{
"ProductId": 19
},
{
"ProductId": 20
},
{
"ProductId": 21
},
{
"ProductId": 22
},
{
"ProductId": 23
}
  // ...truncado...
}
Los atributos disponibles son los siguientes:
- **RequiredSourceQuantity** `[Req]` — Cantidad necesaria que se debe comprar de los productos indicados para aplicar la promoción.
- **MaxTargetQuantity** `[Req]` — Cantidad de productos sobre los que se aplicará el descuento de la promoción.
- **TargetSelection** `[Opt]` — Modo de aplicación de la promoción: `Cheapest` para aplicar sobre los productos más baratos, `Mos...
- **DiscountRate** `[Req]` — Tanto por uno de descuento que aplica sobre los productos a los que se aplica la promoción.
- **CashDiscount** `[Req]` — Descuento en moneda que aplica sobre los productos a los que se aplica la promoción.
- **Id** `[Req]` — Identificador del producto.
- **Id** `[Req]` — Identificador del producto.
- **Text** `[Req]` — Texto de la nota predefinida.
- **Priority** `[Req]` — Prioridad usada para ordenar las notas predefinidas a la hora de mostrarlas en la pantalla de sel...
- **ValidForAllGroups** `[Req]` — Indica si la nota predefinida se puede aplicar a todas las familias y categorías de productos (tr...
- **ValidGroups** `[Req]` — Lista de familias a las que se puede aplicar la nota predefinida.
- **ButtonText** — Texto mostrado en el botón asociado a la nota predefinida en el punto de venta.
- **Color** — Color del botón asociado a la nota en el punto de venta.
- **DeletionDate** — Fecha de borrado del registro.
- **ShowInPos** — Indica si la nota debe o no mostrarse como opción en el TPV Táctil.
- **ShowInDigitalMenu** — Indica si la nota debe o no mostrarse como opción en la Carta Digital o Delivery si se tiene acti...
- **Pedidos** — El formato de importación de los pedidos es igual que el formato usado para la exportación, con l...

A la hora de importar un pedido en Ágora se tratará de distinta manera según su estado.
Cuando el pedido a importar tiene un estado "Pendiente" (Pending), "Servido" (Served) o
"Facturado" (Invoiced) se tratará de la siguiente manera:
- Si el pedido no existía en Ágora, se guardará un pedido que puede ser editado desde
Ágora, independientemente de que su estado en el documento XML sea "Pendiente" o
"Facturado". Para que un pedido quede como facturado, será necesario importar la
factura correspondiente, y será en ese momento cuando el pedido dejará de ser
editable.
- Si existía en Ágora y no había sido facturado o cancelado previamente, se sobreescribirá
el pedido anterior con los nuevos datos importados. De esta manerá el pedido quedará
actualizado con las últimas modificaciones.
- Si existía en Ágora y ya había sido facturado o cancelado, se ignorará el documento
importado y se respetará la información existente en Ágora.
En cambio, si el pedido que se está importando tiene un estado "Cancelado" (Cancelled):
- Si el pedido no existía en Ágora, se guardará el pedido y se emitirá y guardará su
cancelación, por lo que el pedido pasará a estar en estado "Cancelado" y no podrá ser
editado.
- Si ya existía en Ágora y no aun no estaba cancelado o facturado, se sobreescribirá el
pedido anterior y se guardará y emitirá su cancelación.
- Si ya existía en Ágora y ya se encontraba facturado o cancelado, se ignorará el pedido
importado y se respetará el estado existente en Ágora.
Importante: siempre que se importa un pedido con estado "Cancelado" en una
central de Ágora, el pedido de origen que se encuentre en el local quedará
invalidado y no podrá modificarse.
- **Albaranes** — El formato de importación de los albaranes es igual que el formato usado para la exportación.

A la hora de importar un albarán en Ágora se tratará de distinta manera según su estado.
Cuando el albarán importado tiene un estado "Pendiente" (Pending) o "Facturado" (Invoiced) se
tratará de la siguiente manera:
- Si el albarán no existía en Ágora, se guardará un albarán que puede ser editado desde
Ágora independientemente de que su estado en el documento XML sea "Pendiente" o
"Facturado". Para que un albarán quede como facturado, será necesario importar la
factura correspondiente, y será en ese momento cuando el albarán dejará de ser
editable.
- Si el albarán existía en Ágora pero todavía no había sido facturado o cancelado, se
sobrescribirá el albarán anterior con los datos importados. De esta manerá el albarán
quedará actualizado con las últimas modificaciones.
- Si el albarán existía en Ágora y ya estaba facturado o cancelado, se ignorará el albarán
importado y se respetará la información existente en Ágora.
En cambio, si el albarán que se está importando tiene un estado "Cancelado" (Cancelled):
- Si el albarán no existía en Ágora, se guardará un albarán que no puede ser editado
desde Ágora (por ejemplo, no puede reabrirse ni facturarse).
- Si el albarán ya existía en Ágora pero todavía no estaba cancelado o facturado, se
marcará como que no puede ser editado y se respetarará el contenido del albarán
existente en Ágora. Si necesita actualizar los datos del albarán, deberá primero enviarlo
con estado "Pendiente" (Pending) con los nuevos cambios, y después volver a enviarlo
con el estado "Cancelado" (Cancelled).
- Si el albarán ya existía en Ágora y ya estaba facturado o cancelado, se ignorará el
albarán importado y se respetará el estado existente en Ágora.
Importante: siempre que se importa un albarán, se generan los movimientos de
stock correspondientes. Si se importa un albarán ya existente en Ágora, al
sobreescribirlo se actualizarán también sus movimientos de stock. En el caso de
albaranes cancelados, los movimientos de stock se mantienen. Un albarán
cancelado sólo implica que ya no puede ser modificado desde el TPV (reabierto,
facturado, etc.), pero sus movimientos de stock siguen siendo válidos. En el caso
de querer hacer una devolución de un albarán, será necesario enviar la
cancelación del albarán original, y enviar un nuevo albarán en negativo para
recuperar el stock; este albarán en negativo deberá tener estado cancelado para
evitar que sea facturado.
Importante: siempre que se importa un albarán con estado "Cancelado" en una
central de Ágora, el albarán de origen que se encuentre en el local quedará
invalidado y no podrá modificarse.
- **Facturas** — El formato de importación de las facturas es igual que el formato usado para la exportación.

habilitado el módulo de Ticket BAI se ignorará cualquier elemento <TicketBAIData> incluido en
la factura ya que se considera que es una factura realizada por un sistema externo a Ágora.
Importante: antes de importar cualquier factura en Ágora debe de darse de alta
la serie con la que se va a importar. No se dejará importar una factura con la
serie que esté activada en Ágora.
Si se importa una factura que ya existe en Ágora, sea cual sea su contenido se ignorará porque
ninguna factura puede ser modificada y por tanto es seguro descartar la nueva factura.
Asimismo, si se importa una factura que referencia a otra, la factura referenciada deberá existir
previamente en Ágora.
A la hora de importar una factura que no esté dada de alta se tratará de distinta manera según
su contenido:
- Si el contenido de la factura son albaranes, se crearán los albaranes correspondientes y
se emitirá la factura. Si los albaranes ya existían en la base de datos, su contenido será
sobreescrito con la información procedente del documento XML, siguiendo las reglas
descritas en la importación de albaranes.
- Si el contenido es un ticket que referencia a un pedido, se creará el pedido
correspondiente y se realizará la facturación de dicho pedido. Si el pedido ya existía en
la base de datos, su contenido será sobreescrito con la información procedente del
documento XML, siguiendo las reglas descritas en la importación de pedidos.
- Si el contenido es simplemente un ticket, se creará la factura.
Notas especiales sobre redondeo de facturas
En ocasiones pueden existir desajustes entre los totales de la factura calculados por Ágora y por
el sistema que la generó, generalmente basados por diferencias de redondeo. Para permitir que
el importe total de la factura coincida en ambos sistemas, es posible forzar a que Ágora haga
coincidir el total de la factura con los pagos realizados. Para ello, Ágora añadirá una línea con un
artículo para compensar las diferencias de redondeo al cuerpo de la factura y, si fuera
necesario, ajustará los descuentos a pie de ticket. Este comportamiento sólo está disponible
para facturas generadas a partir de un único ticket (no funcionará con las facturas de varios
albaranes). Para habilitarlo, es necesario indicar en el nodo Invoice el valor
FixTotalToPayments a true:
{
"Serie": "F",
"Number": 1,
"BusinessDay": "2014-09-29",
...
"FixTotalToPayments": true
...
}
Pedidos a Proveedor
El formato de importación de los pedidos a proveedor es igual que el formato usado para la
exportación, con la salvedad de que no es obligatorio añadir el elemento <Totals> y
descuentos y líneas introducidas.
Importante: aunque el elemento <Totals> no es obligatorio, si se añade Ágora
tratara de ajustar los totales del documento para cuadrar con el desglose de
impuestos proporcionado por cada elemento <Tax> dentro de <Totals>. Ágora
ajustará en base al VatAmount (cantidad de impuestos), SurchargeAmount
(cantidad de recargo) y NetAmount (cantidad sin impuestos) de cada elemento
total del documento será la suma de cada Tax.
Importante: Al contrario que en los Pedidos de venta, no es necesario crear una
serie específica para importar Pedidos a Proveedor, aunque la serie indicada debe
existir en Ágora. Sin embargo es importante resaltar que, si se importa un Pedido
a Proveedor con un número de serie inferior al último número de dicha serie, se
actualizará el documento que tuviera asociado dicho número, y la serie
mantendrá su contador inalterado. Si se importa un Pedido con un número de
serie superior al último de dicha serie, el contador de la misma actualizará su
contador para que su último número coincida con el número de serie del Pedido
que se importa.
A la hora de importar un pedido a proveedor en Ágora se tratará de distinta manera según su
estado y si se encontraba registrado previamente en Ágora:
- Si el pedido no existía en Ágora, se guardará un pedido que puede ser editado desde
Ágora ignorando la cantidad servida si se ha indicado. Cuando el pedido a importar
tiene un estado "Borrador" (Draft) se mantendrá como tal. Si por el contrario tiene un
estado distinto como "Confirmado" (Confirmed), "Servido Parcialmente"
(PartialDelivery) o "Servido" (Delivered), el pedido se importará como "Confirmado"
(Confirmed).

- Si el pedido existía en Ágora y no está servido (estado "Borrador" o "Confirmado"), se
sobreescribirá el pedido anterior con los nuevos datos importados. De esta manerá el
pedido quedará actualizado con las últimas modificaciones.
- Si el pedido existía en Ágora y está servido, total o parcialmente, se ignorará el
documento importado y se respetará la información existente en Ágora.
Importante: los totales sólo podrán ser actualizados si el pedido no existía en
Ágora o se encuentra en estado "Borrador" o "Confirmado".
Albaranes de Proveedor
El formato de importación de los albaranes es igual que el formato usado para la exportación.
Con la salvedad de que no es obligatorio añadir el elemento <Totals> y <TotalAmount> de las
líneas del albarán porque serán recalculados en base a los descuentos y líneas introducidas.
Importante: aunque el elemento <Totals> no es obligatorio, si se añade Ágora
tratara de ajustar los totales del documento para cuadrar con el desglose de
impuestos proporcionado por cada elemento <Tax> dentro de <Totals>. Ágora
ajustará en base al VatAmount (cantidad de impuestos), SurchargeAmount
(cantidad de recargo) y NetAmount (cantidad sin impuestos) de cada elemento
total del documento será la suma de cada Tax.
Importante: Al contrario que en los Albaranes, no es necesario crear una serie
específica para importar Albaranes de Proveedor, aunque la serie indicada debe
existir en Ágora. Sin embargo es importante resaltar que, si se importa un
Albarán de Proveedor con un número de serie inferior al último número de dicha
serie, se actualizará el documento que tuviera asociado dicho número, y la serie
mantendrá su contador inalterado. Si se importa un Albarán con un número de
serie superior al último de dicha serie, el contador de la misma actualizará su
contador para que su último número coincida con el número de serie del Albarán
que se importa.
A la hora de importar un albarán de proveedor en Ágora se tratará de distinta manera según su
estado y si existía o no en Ágora:
- Si el albarán no existía en Ágora, se guardará un albarán que puede ser editado desde
Ágora independientemente de que su estado en el documento XML sea "Pendiente" o
"Facturado". Para que un albarán quede como facturado, será necesario importar la
factura de proveedor correspondiente, y será en ese momento cuando el albarán dejará
de ser editable. Si el albarán está sirviendo líneas de pedidos que no existen en Ágora
se producirá un error de importación. Los pedidos que se estén sirviendo en el albarán
quedarán marcados como "Servidos" o "Servidos Parcialmente".
- Si el albarán existía en Ágora pero todavía no había sido facturado o cancelado, se
sobrescribirá el albarán anterior con los datos importados. De esta manerá el albarán

quedará actualizado con las últimas modificaciones y los pedidos servidos quedarán
marcados como "Servidos" o "Servidos Parcialmente".
- Si el albarán existía en Ágora y ya estaba facturado, se ignorará el albarán importado y
se respetará la información existente en Ágora.
Importante: siempre que se importa un albarán de proveedor, se generan los
movimientos de stock correspondientes. Si se importa un albarán ya existente en
Ágora, al sobreescribirlo se actualizarán también sus movimientos de stock.
Importante: si se hace referencia a un número de lote que no existe en Ágora
en alguna línea del albarán de entrada se creará uno nuevo.
Importante: los totales sólo podrán ser actualizados si el pedido no existía en
Ágora o se encuentra sin facturar o cancelar.
Facturas a Proveedor
El formato de importación de las facturas es igual que el formato usado para la exportación.
Con la salvedad de que no es obligatorio añadir cualquier elemento <Totals> porque será
recalculado en base a los descuentos y líneas introducidas.
Importante: aunque el elemento <Totals> no es obligatorio, si se añade Ágora
tratara de ajustar los totales del documento para cuadrar con el desglose de
impuestos proporcionado por cada elemento <Tax> dentro de <Totals>. Ágora
ajustará en base al VatAmount (cantidad de impuestos), SurchargeAmount
(cantidad de recargo) y NetAmount (cantidad sin impuestos) de cada elemento
total del documento será la suma de cada Tax.
Importante: Al contrario que en las Facturas, no es necesario crear una serie
específica para importar Facturas de Proveedor, aunque la serie indicada debe
existir en Ágora. Sin embargo es importante resaltar que, si se importa una
Factura de Proveedor con un número de serie inferior al último número de dicha
serie, se actualizará el documento que tuviera asociado dicho número, y la serie
mantendrá su contador inalterado. Si se importa una Factura con un número de
serie superior al último de dicha serie, el contador de la misma se actualizará
para que su último número coincida con el número de serie de la Factura que se
importa.

A la hora de importar una factura de proveedor en Ágora se tratará de distinta manera según su
estado y si existía o no en Ágora:
- Si la factura no existía en Ágora, esta se importará con el estado indicado, y
reimportará los albaranes que se estén importando en la factura. Esto marcará dichos
albaranes como "Facturados".
- Si la factura existía en Ágora, será reimportada marcando como facturados todos los
albaranes que se incluyan con la factura. Si la factura incluye pagos que la pagan
completamente, la factura se importará con el estado "Pagada", si no, será importada
con el estado "Pendiente de Pago".
Importante: Para marcar una factura como "Contabilizada" ha de importarse con
la propiedad Accounted con el valor true. Además, para que esta importación sea
válida la factura ha de estar pagada completamente y, por tanto, estar en estado
"Pagado".
- **Entradas** — Code [Obligatorio] Código de la entrada.
- **Code** `[Req]` — Código de la entrada.
- **CreatedAt** `[Req]` — Fecha de creación de la entrada.
- **ValidUntil** — Fecha de negocio máxima para consumir la entrada.
- **PrintAtPosId** — Permite indicar un ID de punto de venta donde se desea imprimir la entrada.

Existen varias formas de controla la fecha de validez de las entradas:
- Utilizar la configuración de Ágora. Si no se incluyen los valores ValidUntil, ValidFrom
y ValidTo, al crear la entrada en Ágora se aplicará la configuración establecida para ese
tipo de entrada.
- Permitir usar hasta una fecha de negocio máxima. Si se incluye el valor ValidUntil, la
entrada se podrá usar hasta que esa fecha de negocio (incluida). Al tratarse de una
fecha de negocio, es independiente de la hora, por lo que no se debe indicar hora.
- Permitir usar la entrada durante un intervalo de tiempo determinado. Si se incluyen los
valores ValidFrom y ValidTo, la entrada será válida durante ese periodo de tiempo,
independientemente de la fecha de negocio. Estos valores deben indicar fecha y hora.
Los tres sistemas son incompatibles entre sí y no pueden mezclarse. Si se utiliza
el campo ValidUntil, no se deben incluir los campos ValidFrom y ValidTo (ni
siquiera vacíos). Igualmente, si se utilizan los campos ValidFrom y ValidTo, no
debe incluirse el campo ValidUntil (ni siquiera vacío).
Formato de fichero de exportación de datos de ventas y
compras
El fichero de exportación de datos de Ágora permite obtener la información generada en el
punto de venta, incluyendo Facturas, Cargos a Cuenta, Movimientos de Caja, Cierres de Caja y
Cierres de Sistema. Así mismo también permite obtener los documentos de compra realizados
incluyendo Pedidos a Proveedor, Albaranes de Entrada y Facturas de Proveedor.
Se trata de un fichero xml con las siguientes secciones:

{
"CashTransactions": [
/* Movimientos de Caja */
],
"SalesOrders": [
/* Pedidos */
],
"DeliveryNotes": [
/* Albaranes */
],
"Invoices": [
/* Facturas */
],
"PosCloseOuts": [
/* Cierres de Caja */
],
"SystemCloseOuts": [
/* Cierres de Caja */
  // ...truncado...
}
Los ejemplos que se incluyen en este documento son orientativos y puede que
no cubran todos los casos existentes. 
La información del fichero se generará para la fecha de negocio indicada como parámetro al
ejecutar la aplicación ais.exe. Si no se indica una fecha de negocio, se usará el día actual como
fecha de negocio.
Sólo se incluirán en el documento aquellas secciones que tengan datos. Por ejemplo, si no se ha
generado ninguna factura o no hay ningún cierre de caja, estas secciones no aparecerán en el
documento.
Los campos numéricos utilizan como separador de decimales el punto '.' y NO
utilizan separador de millares.

Los campos de tipo fecha utilizando como formato aaaa-mm-dd. Si además
incluye la hora, el formato es aaaa-mm-ddThh:mm:ss, por ejemplo
2012-01-29T21:00:54.
Movimientos de Caja
00,
"Supplier": "Casbega",
"Description": "Devolución de Mercancía"
},
{
"Id": 2,
"PosId": 1,
"UserId": 3,
"BusinessDay": "2014-09-29",
"Date": "2014-09-29T12:07:20",
"Amount": -100.00,
"Supplier": "Fontanero",
"Description": "Grifo WC Caballeros"
}
]
}

La información indicada para cada movimiento de caja es:
- **Id** — Identificador del movimiento de caja.
- **PosId** — Identificador del punto de venta donde se ha realizado el movimiento de caja.
- **UserId** — Identificador del usuario que ha realizado el movimiento de caja.
- **BusinessDay** — Fecha de negocio en que se ha realizado el movimiento de caja con formato aaaa-mm- dd.
- **Date** — Fecha y hora en que se ha realizado el movimento de caja con formato aaaa-mm- ddThh:mm:ss.
- **Amount** — Importe del movimiento de caja.
- **Supplier** — Proveedor para el que se ha realizado el movimiento de caja.
- **Description** — Motivo o concepto del movimiento de caja.

{
"Tickets": [
{
"BusinessDay": "2014-09-29",
"Guests": 2,
"VatIncluded": true,
"Date": null,
"Pos": {
"Id": 1,
"Name": "TPV"
},
"User": {
"Id": 5,
"Name": "Charo"
},
"SaleCenter": {
"Id": 1,
"Name": "Barra",
  // ...truncado...
}
La información indicada para cada ticket es:
- **GlobalId** — Identificador único global del ticket.
- **BusinessDay** — Fecha de negocio del documento.
- **Guests** — Número de comensales.
- **VatIncluded** — Indica si el documento lleva impuestos incluidos (true) o no (false).
- **Date** — Fecha de cierre de ticket.
- **Pos** — Identificador único y nombre del TPV en que se creó el documento.
- **User** — Identificador único y nombre del usuario que creó el documento.
- **SaleCenter** — Información del centro de venta donde se creó el documento, incluyendo Id, Nombre y Ubicación.
- **Lines** — Líneas del documento, cada una de ellas en un elemento Line con el siguiente formato: Index Índic...
- **Index** — Índice de la línea dentro del documento.
- **Type** — Tipo de línea.
- **CreationDate** — Fecha en que se añadió la línea al documento.
- **ParentIndex** — Índice de la línea a la que está asociada ésta.
- **MenuGroup** — Nombre del grupo de platos del menú al que pertenece esta línea.
- **UserId** — Identificador del usuario que añadió la línea.
- **ProductId** — Identificador del producto principal de la línea.
- **ProductName** — Nombre del producto principal de la línea.
- **SaleFormatId** — Identificador del formamto de venta principal de la línea.
- **SaleFormatName** — Nombre del formato de venta principal de la línea.
- **SaleFormatRatio** — Ratio del formato de venta principal de la línea con respecto a su formato base.
- **MainBarcode** — Código de barras principal del artículo.
- **PLU** — Código PLU del artículo.
- **ProductPrice** — Precio unitario del producto principal de la línea.
- **Quantity** — Cantidad.
- **VatId** — Identificador único del impuesto asociado al producto principal de la línea.
- **VatRate** — Tanto por uno de impuesto asociado al producto principal de la línea.
- **SurchargeRate** — Tanto por uno de recargo de equivalencia asociado al producto principal de la línea.
- **UnitPrice** — Precio unitario de la línea incluyendo tanto el producto principal como los añadidos.
- **DiscountRate** — Tanto por uno de descuento aplicado a la línea.
- **CashDiscount** — Descuento en moneda aplicado a la línea.
- **TotalAmount** — Importe total de la línea tras aplicar descuentos.
- **ProductCostPrice** — Precio de coste del producto principal.
- **UnitCostPrice** — Precio de coste unitario de la línea, incluyendo tanto el producto principal como los añadidos.
- **OfferId** — En caso de que la línea pertenezca a una promoción se incluye este elemento con el identificador ...
- **OfferCode** — En caso de que la línea pertenezca a una promoción se incluye este elemento con el código de la o...
- **NamedDiscountId** `[Opt]` — En caso de que la línea tenga un descuento predefinido aplicado se incluye este elemento con el i...
- **NamedDiscountCode** `[Opt]` — En caso de que la línea tenga un descuento predefinido aplicado se incluye este elemento con el c...
- **SizeId** — Identificador de la talla asociada al producto.
- **ColorId** — Identificador del color asociado al producto.
- **PreparationTypeId** — Identificador del tipo de preparación del producto principal.
- **PreparationTypeName** `[Opt]` — Nombre del tipo de preparación del producto principal.
- **PLU** — PLU del artículo.
- **FamilyId** — Identificador de la familia a la que pertenece el producto.
- **FamilyName** — Nombre de la familia a la que pertenece el producto.
- **PreparationOrderId** — Identificador del orden de preparación del producto principal.
- **PreparationOrderName** `[Opt]` — Nombre del orden del preparación del producto principal.
- **Notes** — Notas de preparación asociadas a la línea.
- **Addins** — En caso de que haya añadidos al producto principal se incluyen en este elemento.
- **Discounts** — Descuentos del documento DiscountRate Tanto por uno de descuento aplicado al documento.
- **DiscountRate** — Tanto por uno de descuento aplicado al documento.
- **CashDiscount** — Descuento en moneda aplicado al documento.
- **NamedDiscountId** `[Opt]` — Identificador del descuento predefinido aplicado al documento.
- **NamedDiscountCode** `[Opt]` — Código del descuento predefinido aplicado al documento.
- **Payments** — Lista con los pagos asociados al documento.
- **MethodId** — Identificador de la forma de pago.
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Cantidad total.
- **PaidAmount** — Cantidad pagada.
- **ChangeAmount** — Cambio entregado.
- **Date** — Fecha en la que se ha realizado el pago.
- **Tip** — Propina recibida.
- **PosId** — Identificador del punto de venta donde se registró el pago IsPrepayment Indica si el pago se real...
- **IsPrepayment** — Indica si el pago se realizó antes de emitir al factura (true) o en el momento de emitirla (false).
- **ExtraInformation** — Información adicional sobre el pago que se haya introducido en el punto de venta.
- **Offers** — Lista con las promociones asignadas: Id Identificador de la promoción.
- **Id** — Identificador de la promoción.
- **Totals** — Contiene el detalle de los descuentos en pie del documento y de los totales, desglosándolos por b...
- **GrossAmount** — Importe incluyendo los impuestos.
- **NetAmount** — Importe tras descontar los impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchageAmount** — Cuota correspondiente al recargo de equivalencia.
- **LoyaltyProgram** `[Opt]` — Información sobre los datos del participante del sistema de fidelización asociados al documento e...
- **Pedidos** — 000" MainBarcode="" ProductPrice="0.50" VatId="3" VatRate="0.1000" SurchargeRate="0.0140" Product...

VatId="3" VatRate="0.1000"
SurchargeRate="0.0140"
UserId="1"
UnitPrice="2.50"
DiscountRate="0.0000" CashDiscount="0.0000"
TotalAmount="2.50"
UnitCostPrice="0.00"
TotalCostPrice="0.00"
PreparationTypeId=""
PreparationTypeName=""
PLU=""
FamilyId="3"
FamilyName="Refrescos"
PreparationOrderId=""
PreparationOrderName="" />
<Line Index="2" CreationDate="2023-03-21T09:23:37" Type="Standard"
ParentIndex="" ProductId="93" ProductName="Pizza Clásica" SaleFormatId="103"
SaleFormatName="Pizza Clásica" SaleFormatRatio="1.00" MainBarcode=""
ProductPrice="4.75" VatId="3" VatRate="0.10" SurchargeRate="0.014" ProductCostPrice="0.00"
MenuGroup="" PreparationTypeId="2" PreparationTypeName="Cocina" PLU="" FamilyId="9"
FamilyName="Pizzas" PreparationOrderId="2" PreparationOrderName="Primeros" Quantity="1.00"
UnitCostPrice="0.00" TotalCostPrice="0.00" UserId="4" UnitPrice="4.75" DiscountRate="0.00"
CashDiscount="0.00" OfferId="" OfferCode="" TotalAmount="4.75" PriceListId="1">
<Discounts DiscountRate="0.0050" CashDiscount="0.00" NamedDiscountId=""
NamedDiscountCode="" />
<Payment MethodId="2" MethodName="Tarjeta" Amount="-6.85"
PaidAmount="-6.85" ChangeAmount="0.00" PosId="1"
IsPrepayment="true" >
<Totals GrossAmount="13.25" NetAmount="11.63"
VatAmount="1.62" SurchargeAmount="0.00">
<Tax VatRate="0.10" SurchargeRate="0.014"

{
"SalesOrders": [
{
"Customer": {
"Id": 2,
"FiscalName": "Sol y Sombra, S.L.",
"Cif": "B0018912",
"AccountCode": "43100001"
"Street": "C/ García de Paredes, 10",
"City": "Madrid",
"Region": "Madrid",
"ZipCode": "28010",
"CountryCode": "es",
"ApplySurcharge": false
},
"DeliveryAddress": {
"Street": "",
"City": "",
  // ...truncado...
}
La información indicada para cada pedido es:
- **Serie** — Serie de pedido.
- **Number** — Número de pedido.
- **Type** `[Opt]` — Tipo de pedido.
- **Standard** — Pedido estándar de Ágora.
- **Delivery** — Pedido de Delivery.
- **TakeAway** — Pedido de TakeAway.
- **Table** — Pedido en Mesa.
- **BusinessDay** — Fecha de negocio en formato aaaa-mm-dd.
- **Guests** — Número de comensales.
- **VatIncluded** — Indica si lleva impuestos incluidos (true) o no (false).
- **Date** — Fecha y hora de creación del pedido en formato aaaa-mm-ddThh:mm:ss.
- **ProcessedDate** `[Opt]` — Fecha y hora en formato aaaa-mm-ddThh:mm:ss en la que Ágora ha sido notificada de que el document...
- **DeliveryDate** — Fecha y hora de entrega del pedido en formato aaaa-mm-ddThh:mm:ss.
- **Pos** — Identificador único y nombre del TPV en que se creó el pedido.
- **Workplace** — Identificador único y nombre del Local en que se creó el pedido.
- **User** — Identificador único y nombre del usuario que creó el pedido.
- **Status** — Estado del pedido.
- **Pending** — El pedido está pendiente de facturar.
- **Cancelled** — El pedido no ha sido facturado y ya no podrá facturarse nunca más (por ejempo, porque ha sido can...
- **Served** — El ha sido servido en un albarán.
- **Invoiced** — El pedido ha sido facturado.
- **AutoPrepare** `[Opt]` — Indica si se deben enviar las comandas a los puntos de preparación al importar el documento.
- **ScheduledPreparation** `[Opt]` — Indica si se debe mandar el pedido a preparar un tiempo antes de la fecha de entrega true o no fa...
- **AutoPrint** `[Opt]` — Indica si se debe imprimir el pedido al importar el documento.
- **ProcessPayments** `[Opt]` — Indica si se deben procesar los pagos con tarjeta a través de Ágora Payments.
- **GlobalId** — Identificador único global del ticket sobre el que se generó el documento.
- **Customer** — Datos del cliente al que se emite la factura, incluyendo: Id Identificador único del cliente.
- **Id** — Identificador único del cliente.
- **FiscalName** — Nombre fiscal del cliente.
- **Cif** — CIF/NIF del cliente.
- **AccountCode** — Código de la cuenta contable del cliente.
- **Street** — Calle del cliente.
- **City** — Población del cliente.
- **Region** — Provincia del cliente.
- **ZipCode** — Código postal del cliente.
- **CountryCode** — Código ISO 3166-1 alpha-2 del país del cliente.
- **ApplySurcharge** — Indica si al cliente se le aplica recargo de equivalencia.
- **DeliveryAddress** — Dirección de Entrega del pedido.
- **Street** — Calle del cliente.
- **City** — Ciudad del cliente.
- **Region** — Población del cliente.
- **ZipCode** — Código Postal del cliente.
- **SaleCenter** — Información del centro de venta donde se ha realizado el pedido, incluyendo Id, Nombre y Ubicación.
- **Notes** — Notas asociadas al pedido.
- **CustomerDocumentNumber** — Número de referencia del documento de compra del cliente.
- **Lines** — Líneas del documento, cada una de ellas en un elemento Line con el siguiente formato: Index Índic...
- **Index** — Índice de la línea dentro del documento.
- **Type** — Tipo de línea.
- **CreationDate** — Fecha en que se añadió la línea al documento.
- **ParentIndex** — Índice de la línea a la que está asociada ésta.
- **MenuGroup** — Nombre del grupo de platos del menú al que pertenece esta línea.
- **UserId** — Identificador del usuario que añadió la línea.
- **ProductId** — Identificador del producto principal de la línea.
- **ProductName** — Nombre del producto principal de la línea.
- **SaleFormatId** — Identificador del formamto de venta principal de la línea.
- **SaleFormatName** — Nombre del formato de venta principal de la línea.
- **SaleFormatRatio** — Ratio del formato de venta principal de la línea con respecto a su formato base.
- **MainBarcode** — Código de barras principal del artículo.
- **ProductPrice** — Precio unitario del producto principal de la línea.
- **Quantity** — Cantidad.
- **VatId** — Identificador único del impuesto asociado al producto principal de la línea.
- **VatRate** — Tanto por uno de impuesto asociado al producto principal de la línea.
- **SurchargeRate** — Tanto por uno de recargo de equivalencia asociado al producto principal de la línea.
- **UnitPrice** — Precio unitario de la línea incluyendo tanto el producto principal como los añadidos.
- **DiscountRate** — Tanto por uno de descuento aplicado a la línea.
- **CashDiscount** — Descuento en moneda aplicado a la línea.
- **TotalAmount** — Importe total de la línea tras aplicar descuentos.
- **ProductCostPrice** — Precio de coste del producto principal.
- **UnitCostPrice** — Precio de coste unitario de la línea, incluyendo tanto el producto principal como los añadidos.
- **OfferId** — En caso de que la línea pertenezca a una promoción se incluye este elemento con el identificador ...
- **OfferCode** — En caso de que la línea pertenezca a una promoción se incluye este elemento con el código de la o...
- **NamedDiscountId** `[Opt]` — En caso de que la línea tenga un descuento predefinido aplicado se incluye este elemento con el i...
- **NamedDiscountCode** `[Opt]` — En caso de que la línea tenga un descuento predefinido aplicado se incluye este elemento con el c...
- **PreparationTypeId** — Identificador del tipo de preparación del producto principal.
- **PreparationTypeName** `[Opt]` — Nombre del tipo de preparación del producto principal.
- **PLU** — PLU del artículo.
- **FamilyId** — Identificador de la familia a la que pertenece el producto.
- **FamilyName** — Nombre de la familia a la que pertenece el producto.
- **PriceListId** — Identificador de la tarifa de precios de la línea.
- **PreparationOrderId** — Identificador del orden de preparación del producto principal.
- **PreparationOrderName** `[Opt]` — Nombre del orden del preparación del producto principal.
- **SizeId** — Id de la talla del producto principal.
- **ColorId** — Id del color del producto principal.
- **Addins** — En caso de que haya añadidos al producto principal se incluyen en este elemento.
- **Notes** — Notas de preparación asociadas a la línea.
- **RemovedIngredients** — En caso de que el producto sea una receta y se haya decidido eliminar algún ingrediente, se inclu...
- **Discounts** — Descuentos del documento DiscountRate Tanto por uno de descuento aplicado al documento.
- **DiscountRate** — Tanto por uno de descuento aplicado al documento.
- **CashDiscount** — Descuento en moneda aplicado al documento.
- **NamedDiscountId** `[Opt]` — Identificador del descuento predefinido aplicado al documento.
- **NamedDiscountCode** `[Opt]` — Código del descuento predefinido aplicado al documento.
- **Offers** — Lista con las promociones asignadas: Id Identificador de la promoción.
- **Id** — Identificador de la promoción.
- **Totals** — Contiene el detalle de los descuentos en pie del documento y de los totales, desglosándolos por b...
- **GrossAmount** — Importe incluyendo los impuestos.
- **NetAmount** — Importe tras descontar los impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchageAmount** — Cuota correspondiente al recargo de equivalencia.
- **LoyaltyProgram** `[Opt]` — Información sobre los datos del participante del sistema de fidelización asociados al documento e...
- **Payments** — Lista con los pagos asociados al pedido.
- **MethodId** — Identificador de la forma de pago.
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Cantidad total.
- **PaidAmount** — Cantidad pagada.
- **ChangeAmount** — Cambio entregado.
- **Date** — Fecha en la que se ha realizado el pago.
- **PosId** — Identificador del punto de venta donde se registró el pago
- **IsPrepayment** — Indica si el pago se realizó antes de emitir al factura (true) o en el momento de emitirla (false).
- **ExtraInformation** — Información adicional sobre el pago que se haya introducido en el punto de venta.

TotalCostPrice="0.00"
PreparationTypeId=""
PreparationTypeName=""
PLU="598"
FamilyId="1"
FamilyName="Hamburguesas"
PreparationOrderId=""
PreparationOrderName="">
<Addin ProductId="18" ProductName="Bacon"
SaleFormatId="18"
SaleFormatName="Bacon"
SaleFormatRatio="1.000"
MainBarcode=""
ProductPrice="0.50"
VatId="3" VatRate="0.1000"
SurchargeRate="0.0140"
ProductCostPrice="0.00"
PreparationTypeId=""
PreparationTypeName=""
PLU=""
FamilyId="2"
FamilyName="Complementos Hamburguesas" />
<Addin ProductId="17"
ProductName="Queso"
SaleFormatId="17"
SaleFormatName="Queso"
MainBarcode=""
SaleFormatRatio="1.000"
ProductPrice="0.50"
VatId="3" VatRate="0.1000"
SurchargeRate="0.0140"
ProductCostPrice="0.00"
PreparationTypeId=""
PreparationTypeName=""
PLU=""
FamilyId="2"
FamilyName="Complementos Hamburguesas" />
<Line
Index="1" Type="Standard"
CreationDate="2014-09-29T12:05:00"
ParentIndex="" MenuGroup=""
ProductId="5" ProductName="Fanta Limón"
SaleFormatId="5"
SaleFormatName="Fanta Limón"
SaleFormatRatio="1.000"
MainBarcode=""
ProductPrice="2.50"

Quantity="1.000"
VatId="3" VatRate="0.1000"
SurchargeRate="0.0140"
UnitPrice="2.50"
UserId="1"
DiscountRate="0.0000" CashDiscount="0.0000"
TotalAmount="2.50"
UnitCostPrice="0.00"
TotalCostPrice="0.00"
PreparationTypeId=""
PreparationTypeName=""
PLU=""
FamilyId="3"
FamilyName="Refrescos"
PreparationOrderId=""
PreparationOrderName="" />
<Line Index="2" CreationDate="2023-03-21T09:23:37" Type="Standard"
ParentIndex="" ProductId="93" ProductName="Pizza Clásica" SaleFormatId="103"
SaleFormatName="Pizza Clásica" SaleFormatRatio="1.00" MainBarcode=""
ProductPrice="4.75" VatId="3" VatRate="0.10" SurchargeRate="0.014" ProductCostPrice="0.00"
MenuGroup="" PreparationTypeId="2" PreparationTypeName="Cocina" PLU="" FamilyId="9"
FamilyName="Pizzas" PreparationOrderId="2" PreparationOrderName="Primeros" Quantity="1.00"
UnitCostPrice="0.00" TotalCostPrice="0.00" UserId="4" UnitPrice="4.75" DiscountRate="0.00"
CashDiscount="0.00" OfferId="" OfferCode="" TotalAmount="4.75" PriceListId="1">
<Discounts DiscountRate="0.0050" CashDiscount="0.00" NamedDiscountId=""
NamedDiscountCode="" />
<Payment MethodId="2" MethodName="Tarjeta"
Amount="-6.85" PaidAmount="-6.85"
ChangeAmount="0.00" PosId="1"
IsPrepayment="true" >
<Totals GrossAmount="13.25" NetAmount="11.63"

{
"DeliveryNotes": [
{
"Serie": "A",
"Number": 1,
"VatIncluded": true,
"BusinessDay": "2014-09-29",
"Date": "2014-09-29T12:08:00",
"ProcessedDate": "2014-09-29T12:08:00",
"Guests": null,
"Status": "Pending",
"AutoPrepare": "Always",
"AutoPrint": "Always",
"GlobalId": "f990d051-538e-4438-8406-7170f6e60820",
"CustomerDocumentNumber":"REF-A-123",
"Customer": {
"Id": 2,
"FiscalName": "Sol Sombra, S.L.",
  // ...truncado...
}
La información indicada para cada albarán es:
- **Serie** — Serie de albarán.
- **Number** — Número de albarán.
- **BusinessDay** — Fecha de negocio en formato aaaa-mm-dd.
- **VatIncluded** — Indica si lleva impuestos incluidos (true) o no (false).
- **Date** — Fecha y hora de creación del albarán en formato aaaa-mm-ddThh:mm:ss.
- **ProcessedDate** `[Opt]` — Fecha y hora en formato aaaa-mm-ddThh:mm:ss en la que Ágora ha sido notificada de que el document...

tendrá en cuenta este campo al importar los documentos, salvo que sea un documento
nuevo y la serie no esté ligada a los documentos de Ágora. Por eso la recomendación
es tratar este campo siempre a través del API HTTP /api/doc/processed.
- **Guests** — Número de comensales.
- **Pos** — Identificador único y nombre del TPV en que se creó el albarán.
- **Workplace** — Identificador único y nombre del Local en que se creó el albarán.
- **User** — Identificador único y nombre del usuario que creó el albarán.
- **SaleCenter** — Información del centro de venta donde se ha realizado el albarán, incluyendo Id, Nombre y Ubicación.
- **Notes** — Notas asociadas al albarán.
- **CustomerDocumentNumber** — Número de referencia del documento de compra del cliente.
- **Status** — Estado del albarán.
- **Pending** — El albarán está pendiente de facturar.
- **Cancelled** — El albarán no ha sido facturado y ya no podrá facturarse nunca más (por ejempo, porque ha sido ca...
- **Invoiced** — El albarán ha sido facturado.
- **AutoPrepare** `[Opt]` — Indica si se deben enviar las comandas a los puntos de preparación al importar el documento.
- **AutoPrint** `[Opt]` — Indica si se deben imprimir el albarán al importar el documento.

- Always: Imprimir albarán siempre que se importa el documento.
- OnlyIfNew: Imprimir albarán sólo la primera vez que se importe el documento
(si el documento ya existía y se vuelve a importar, no se volverá a imprimir).
- **GlobalId** — Identificador único global del ticket sobre el que se generó el documento.
- **Customer** — Datos del cliente al que se emite la factura, incluyendo: Id Identificador único del cliente.
- **Id** — Identificador único del cliente.
- **FiscalName** — Nombre fiscal del cliente.
- **Cif** — CIF/NIF del cliente.
- **AccountCode** — Código de la cuenta contable del cliente.
- **Street** — Calle del cliente.
- **City** — Población del cliente.
- **Region** — Provincia del cliente.
- **ZipCode** — Código postal del cliente.
- **CountryCode** — Código ISO 3166-1 alpha-2 del país del cliente.
- **ApplySurcharge** — Indica si al cliente se le aplica recargo de equivalencia.
- **DeliveryAddress** — Dirección de Entrega del albarán.
- **Street** — Calle del cliente.
- **City** — Ciudad del cliente.
- **Region** — Población del cliente.
- **ZipCode** — Código Postal del cliente.
- **SuggestedTip** — Propina sugerida para la factura, incluyendo impuesto aplicado a la propina y modo de aplicación ...
- **ServiceCharge** — Recargo por servicio para la factura, incluyendo impuesto aplicado al servicio por recargo y modo...
- **RelatedSalesOrder** — Serie y número del pedido relacionado con éste documento.
- **RelatedDeliveryNote** — Serie y número del albarán relacionado con éste documento.
- **Lines** — Líneas del documento, cada una de ellas en un elemento Line con el siguiente formato: Index Índic...
- **Index** — Índice de la línea dentro del documento.
- **Type** — Tipo de línea.
- **CreationDate** — Fecha en que se añadió la línea al documento.
- **ParentIndex** — Índice de la línea a la que está asociada ésta.
- **MenuGroup** — Nombre del grupo de platos del menú al que pertenece esta línea.
- **UserId** — Identificador del usuario que añadió la línea.
- **ProductId** — Identificador del producto principal de la línea.
- **ProductName** — Nombre del producto principal de la línea.
- **SaleFormatId** — Identificador del formamto de venta principal de la línea.
- **SaleFormatName** — Nombre del formato de venta principal de la línea.
- **SaleFormatRatio** — Ratio del formato de venta principal de la línea con respecto a su formato base.
- **MainBarcode** — Código de barras principal del artículo.
- **ProductPrice** — Precio unitario del producto principal de la línea.
- **Quantity** — Cantidad.
- **VatId** — Identificador único del impuesto asociado al producto principal de la línea.
- **VatRate** — Tanto por uno de impuesto asociado al producto principal de la línea.
- **SurchargeRate** — Tanto por uno de recargo de equivalencia asociado al producto principal de la línea.
- **UnitPrice** — Precio unitario de la línea incluyendo tanto el producto principal como los añadidos.
- **DiscountRate** — Tanto por uno de descuento aplicado a la línea.
- **CashDiscount** — Descuento en moneda aplicado a la línea.
- **TotalAmount** — Importe total de la línea tras aplicar descuentos.
- **ProductCostPrice** — Precio de coste del producto principal.
- **UnitCostPrice** — Precio de coste unitario de la línea, incluyendo tanto el producto principal como los añadidos.

TotalCostPrice:
Precio de coste total de la línea. Es decir la cantidad por el precio de coste de
la línea.
- **OfferId** — En caso de que la línea pertenezca a una promoción se incluye este elemento con el identificador ...
- **OfferCode** — En caso de que la línea pertenezca a una promoción se incluye este elemento con el código de la o...
- **NamedDiscountId** `[Opt]` — En caso de que la línea tenga un descuento predefinido aplicado se incluye este elemento con el i...
- **NamedDiscountCode** `[Opt]` — En caso de que la línea tenga un descuento predefinido aplicado se incluye este elemento con el c...
- **PreparationTypeId** — Identificador del tipo de preparación del producto principal.
- **PreparationTypeName** `[Opt]` — Nombre del tipo de preparación del producto principal.
- **PLU** — PLU del artículo.
- **FamilyId** — Identificador de la familia a la que pertenece el producto.
- **FamilyName** — Nombre de la familia a la que pertenece el producto.
- **PriceListId** — Identificador de la tarifa de precios de la línea.
- **PreparationOrderId** — Identificador del orden de preparación del producto principal.
- **PreparationOrderName** `[Opt]` — Nombre del orden del preparación del producto principal.
- **SizeId** — Id de la talla del producto principal.
- **ColorId** — Id del color del producto principal.
- **Addins** — En caso de que haya añadidos al producto principal se incluyen en este elemento.
- **Notes** — Notas de preparación asociadas a la línea.
- **RemovedIngredients** — En caso de que el producto sea una receta y se haya decidido eliminar algún ingrediente, se inclu...
- **Discounts** — Descuentos del documento DiscountRate Tanto por uno de descuento aplicado al documento.
- **DiscountRate** — Tanto por uno de descuento aplicado al documento.
- **CashDiscount** — Descuento en moneda aplicado al documento.
- **NamedDiscountId** `[Opt]` — Identificador del descuento predefinido aplicado al documento.
- **NamedDiscountCode** `[Opt]` — Código del descuento predefinido aplicado al documento.
- **Offers** — Lista con las promociones asignadas: Id Identificador de la promoción.
- **Id** — Identificador de la promoción.
- **Totals** — Contiene el detalle de los descuentos en pie del albarán y de los totales, desglosándolos por bas...
- **GrossAmount** — Importe incluyendo los impuestos.
- **NetAmount** — Importe tras descontar los impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchageAmount** — Cuota correspondiente al recargo de equivalencia.
- **LoyaltyProgram** `[Opt]` — Información sobre los datos del participante del sistema de fidelización asociados al documento e...
- **Payments** — Lista con los pagos asociados al albarán.
- **MethodId** — Identificador de la forma de pago.
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Cantidad total.
- **PaidAmount** — Cantidad pagada.
- **ChangeAmount** — Cambio entregado.
- **Date** — Fecha en la que se ha realizado el pago.
- **PosId** — Identificador del punto de venta donde se registró el pago IsPrepayment Indica si el pago se real...
- **IsPrepayment** — Indica si el pago se realizó antes de emitir al factura (true) o en el momento de emitirla (false).
- **ExtraInformation** — Información adicional sobre el pago que se haya introducido en el punto de venta.
- **Facturas** — 000" VatId="3" VatRate="0.1000" SurchargeRate="0.0140" UserId="1" UnitPrice="4.25" DiscountRate="...

CreationDate="2014-09-29T12:08:00"
ParentIndex="" MenuGroup=""
ProductId="5" ProductName="Fanta Limón"
SaleFormatId="5"
SaleFormatName="Fanta Limón"
SaleFormatRatio="1.000"
MainBarcode=""
PLU=""
ProductPrice="2.50"
Quantity="1.000"
VatId="3" VatRate="0.1000"
SurchargeRate="0.0140"
UserId="1"
UnitPrice="2.50"
DiscountRate="0.0000" CashDiscount="0.0000"
TotalAmount="2.50"
UnitCostPrice="0.00"
TotalCostPrice="0.00"
PreparationTypeId=""
PreparationTypeName=""
PLU=""
FamilyId="3"
FamilyName="Refrescos"
PreparationOrderId=""
PreparationOrderName="" />
<Line Index="2" CreationDate="2023-03-21T09:23:37"
Type="Standard" ParentIndex="" ProductId="93" ProductName="Pizza Clásica"
SaleFormatId="103" SaleFormatName="Pizza Clásica" SaleFormatRatio="1.00"
MainBarcode="" ProductPrice="4.75" VatId="3" VatRate="0.10" SurchargeRate="0.014"
ProductCostPrice="0.00" MenuGroup="" PreparationTypeId="2" PreparationTypeName="Cocina"
PLU="" FamilyId="9" FamilyName="Pizzas" PreparationOrderId="2"
PreparationOrderName="Primeros" Quantity="1.00" UnitCostPrice="0.00" TotalCostPrice="0.00"
UserId="4" UnitPrice="4.75" DiscountRate="0.00" CashDiscount="0.00" OfferId=""
OfferCode="" TotalAmount="4.75" PriceListId="1">
<Discounts DiscountRate="0.0050" CashDiscount="0.00" NamedDiscountId=""
NamedDiscountCode="" />
<Payment MethodId="2" MethodName="Tarjeta"
Amount="13.85" PaidAmount="13.85"
ChangeAmount="0.00" PosId="1"
IsPrepayment="true" >
<![CDATA[Tipo de Tarjeta:

{
"Invoices": [
{
"Serie": "F",
"Number": 1,
"BusinessDay": "2014-09-29",
"PrintCount": 1,
"VatIncluded": true,
"Date": "2014-09-29T12:11:01",
"ProcessedDate":"2014-09-29T12:11:01",
"AutoPrepare": "Always",
"AutoPrint": "Always",
"Customer": {
"Id": 2,
"FiscalName": "Sol y Sombra, S.L.",
"Cif": "B0018912",
"AccountCode": "43100001",
"Street": "C/ García de Paredes, 10",
  // ...truncado...
}
La información indicada para cada factura es:
- **Serie** — Serie de factura.
- **Number** — Número de factura.
- **BusinessDay** — Fecha de negocio en formato aaaa-mm-dd.
- **VatIncluded** — Indica si lleva impuestos incluidos (true) o no (false).
- **PrintCount** — Número de veces que ha sido impresa la factura.
- **Date** — Fecha y hora de creación de la factura en formato aaaa-mm-ddThh:mm:ss.
- **ProcessedDate** `[Opt]` — Fecha y hora en formato aaaa-mm-ddThh:mm:ss en la que Ágora ha sido notificada de que el document...
- **DocumentType** — Tipo de factura.
- **RefundSource** — Indica el motivo de por qué se ha realizado una devolución.
- **AutoPrepare** `[Opt]` — Indica si se deben enviar las comandas a los puntos de preparación al importar el documento.
- **AutoPrint** `[Opt]` — Indica si se debe imprimir la factura al importar el documento.
- **Pos** — Identificador único y nombre del TPV en que se creó la factura.
- **Workplace** — Identificador único y nombre del Local en que se creó la factura.
- **User** — Identificador único y nombre del usuario que creó la factura.
- **SaleCenter** — Información del centro de venta donde se ha realizado la factura, incluyendo Id, Nombre y Ubicación.
- **SuggestedTip** — Propina sugerida para la factura, incluyendo impuesto aplicado a la propina y modo de aplicación ...
- **ServiceCharge** — Recargo por servicio para la factura, incluyendo impuesto aplicado al servicio por recargo y modo...
- **RelatedInvoice** — Serie y número de la factura relaccionada con ésta.
- **Customer** — Datos del cliente al que se emite la factura.
- **Id** — Identificador único del cliente.
- **FiscalName** — Nombre fiscal del cliente.
- **Cif** — CIF/NIF del cliente.
- **AccountCode** — Código de la cuenta contable del cliente.
- **Street** — Calle del cliente.
- **City** — Población del cliente.
- **Region** — Provincia del cliente.
- **ZipCode** — Código postal del cliente.
- **CountryCode** — Código ISO 3166-1 alpha-2 del país del cliente.
- **ApplySurcharge** — Indica si al cliente se le aplica recargo de equivalencia.
- **DeliveryAddress** — Dirección de Entrega del documento.
- **Street** — Calle del cliente.
- **City** — Ciudad del cliente.
- **Region** — Población del cliente.
- **ZipCode** — Código Postal del cliente.
- **RelatedInvoice** — Serie y número de la factura relaccionada con ésta.
- **InvoiceItems** — Documentos que forman parte de la factura.
- **ContentType** — Indica si el documento es un ticket (T) o un albarán (D).
- **BusinessDay** — Fecha de negocio del documento.
- **Guests** — Número de comensales.
- **VatIncluded** — Indica si el documento lleva impuestos incluidos (true) o no (false).
- **Date** — Fecha de creación del documento.

Serie [Sólo si ContentType = 'D']
Serie del albarán facturado.
Number [Sólo si ContentType = 'D']
Número del albarán facturado.
- **GlobalId** — Identificador único global del ticket sobre el que se generó el documento.
- **Pos** — Identificador único y nombre del TPV en que se creó el documento.
- **User** — Identificador único y nombre del usuario que creó el documento.
- **SaleCenter** — Información del centro de venta donde se creó el documento, incluyendo Id, Nombre y Ubicación.
- **RelatedSalesOrder** — Este campo sólo se indica cuando el documento ha sido emitido a partir de un pedido.
- **RelatedDeliveryNote** — Serie y número del albarán relacionado con éste documento.
- **Lines** — Líneas del documento, cada una de ellas en un elemento Line con el siguiente formato: Index Índic...
- **Index** — Índice de la línea dentro del documento.
- **Type** — Tipo de línea.
- **CreationDate** — Fecha en que se añadió la línea al documento.
- **ParentIndex** — Índice de la línea a la que está asociada ésta.
- **MenuGroup** — Nombre del grupo de platos del menú al que pertenece esta línea.
- **UserId** — Identificador del usuario que añadió la línea.
- **ProductId** — Identificador del producto principal de la línea.
- **ProductName** — Nombre del producto principal de la línea.
- **SaleFormatId** — Identificador del formamto de venta principal de la línea.
- **SaleFormatName** — Nombre del formato de venta principal de la línea.
- **SaleFormatRatio** — Ratio del formato de venta principal de la línea con respecto a su formato base.
- **MainBarcode** — Código de barras principal del artículo.
- **PLU** — Código PLU del artículo.
- **ProductPrice** — Precio unitario del producto principal de la línea.
- **Quantity** — Cantidad.
- **VatId** — Identificador único del impuesto asociado al producto principal de la línea.
- **VatRate** — Tanto por uno de impuesto asociado al producto principal de la línea.
- **SurchargeRate** — Tanto por uno de recargo de equivalencia asociado al producto principal de la línea.
- **UnitPrice** — Precio unitario de la línea incluyendo tanto el producto principal como los añadidos.
- **DiscountRate** — Tanto por uno de descuento aplicado a la línea.
- **CashDiscount** — Descuento en moneda aplicado a la línea.
- **TotalAmount** — Importe total de la línea tras aplicar descuentos.
- **ProductCostPrice** — Precio de coste del producto principal.
- **UnitCostPrice** — Precio de coste unitario de la línea, incluyendo tanto el producto principal como los añadidos.
- **OfferId** — En caso de que la línea pertenezca a una promoción se incluye este elemento con el identificador ...
- **OfferCode** — En caso de que la línea pertenezca a una promoción se incluye este elemento con el código de la o...
- **NamedDiscountId** `[Opt]` — En caso de que la línea tenga un descuento predefinido aplicado se incluye este elemento con el i...
- **NamedDiscountCode** `[Opt]` — En caso de que la línea tenga un descuento predefinido aplicado se incluye este elemento con el c...
- **PreparationTypeId** — Identificador del tipo de preparación del producto principal.
- **PreparationTypeName** `[Opt]` — Nombre del tipo de preparación del producto principal.
- **PLU** — PLU del artículo.
- **FamilyId** — Identificador de la familia a la que pertenece el producto.
- **FamilyName** — Nombre de la familia a la que pertenece el producto.
- **PriceListId** — Identificador de la tarifa de precios de la línea.
- **PreparationOrderId** — Identificador del orden de preparación del producto principal.
- **PreparationOrderName** `[Opt]` — Nombre del orden del preparación del producto principal.
- **SizeId** — Id de la talla del producto principal.
- **ColorId** — Id del color del producto principal.
- **Notes** — Notas de preparación asociadas a la línea.
- **Addins** — En caso de que haya añadidos al producto principal se incluyen en este elemento.
- **RemovedIngredients** — En caso de que el producto sea una receta y se haya decidido eliminar algún ingrediente, se inclu...
- **Discounts** — Descuentos del documento DiscountRate Tanto por uno de descuento aplicado al documento.
- **DiscountRate** — Tanto por uno de descuento aplicado al documento.
- **CashDiscount** — Descuento en moneda aplicado al documento.
- **NamedDiscountId** `[Opt]` — Identificador del descuento predefinido aplicado al documento.
- **NamedDiscountCode** `[Opt]` — Código del descuento predefinido aplicado al documento.
- **Payments** — Lista con los pagos asociados al documento antes de convertirse en factura.
- **Offers** — Lista con las promociones asignadas: Id Identificador de la promoción.
- **Id** — Identificador de la promoción.
- **Totals** — Contiene el detalle de los descuentos en pie del documento y de los totales, desglosándolos por b...
- **GrossAmount** — Importe incluyendo los impuestos.
- **NetAmount** — Importe tras descontar los impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchageAmount** — Cuota correspondiente al recargo de equivalencia.
- **LoyaltyProgram** `[Opt]` — Información sobre los datos del participante del sistema de fidelización asociados al documento e...
- **Payments** — Lista con los pagos asociados a la factura.
- **MethodId** — Identificador de la forma de pago.
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Cantidad total.
- **PaidAmount** — Cantidad pagada.
- **ChangeAmount** — Cambio entregado.
- **Date** — Fecha en la que se ha realizado el pago.
- **Tip** — Propina recibida.
- **PosId** — Identificador del punto de venta donde se registró el pago IsPrepayment Indica si el pago se real...
- **IsPrepayment** — Indica si el pago se realizó antes de emitir al factura (true) o en el momento de emitirla (false).
- **ExtraInformation** — Información adicional sobre el pago que se haya introducido en el punto de venta.
- **Totals** — Contiene el importe total de la factura, incluyendo todos sus documentos, desglosado por base imp...
- **GrossAmount** — Importe incluyendo los impuestos.
- **NetAmount** — Importe tras descontar los impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchageAmount** — Cuota correspondiente al recargo de equivalencia.
- **TicketBAIData** — Contenido del fichero XML de Ticket BAI que es enviado a la Hacienda Foral Vasca.
- **URL** — Url de la factura en Verifactu El orden en que aparecen los elementos dentro del documento es imp...
- **Id** — Identificador del cierre de caja.
- **PosId** — Identificador del punto de venta donde se ha realizado el movimiento de caja.
- **WorkplaceId** — Identificador del local donde se ha realizado el cierre de caja.
- **BusinessDay** — Fecha de negocio en que se ha realizado el cierre de caja con formato aaaa-mm-dd.
- **InitialAmount** — Cantidad inicial en caja, incluyendo todas las formas de pago que se contabilizan en el arqueo.
- **ExpectedEndAmount** — Cantidad final teórica en caja, incluyendo todas las formas de pago que se contabilizan en el arq...
- **ActualEndAmount** — Cantidad final real en caja, incluyendo todas las formas de pago que se contabilizan en el arqueo.
- **Incident** — Incidencia registrada al cerrar la caja.
- **OpenDate** — Fecha y hora en que se ha realizado la apertura de caja con formato aaaa-mm- ddThh:mm:ss.
- **OpenerUserId** — Id del usuario que ha realizado la apertura de caja.
- **CloseDate** — Fecha y hora en que se ha realizado el cierre de caja con formato aaaa-mm- ddThh:mm:ss.
- **CloserUserId** — Id del usuario que ha realizado el cierre de caja.
- **VerificationCode** — Código de seguridad único para identificar el cierre de caja.
- **Balances** — Arqueos individuales por cada forma de pago incluida en el arqueo de caja.

"DeliveryNotePayments": [{
"MethodName": "Efectivo",
"Amount": 12.07
}, {
"MethodName": "Tarjeta",
"Amount": 0.00
}],
"TicketPayments": [{
"MethodName": "Efectivo",
"Amount": 12.07
}, {
"MethodName": "Tarjeta",
"Amount": 0.00
}]
}]
}
La información indicada para cada cierre de sistema es:
- **Number** — Número único y correlativo de cierre de sistema.
- **BusinessDay** — Fecha de negocio asociada a la jornada de trabajo con formato aaaa-mm-dd.
- **OpenDate** — Fecha y hora en que se ha realizado la apertura de la jornada de trabajo con formato aaaa-mm-ddTh...
- **OpenerUserId** — Id del usuario que ha realizado la apertura de la jornada de trabajo.
- **CloseDate** — Fecha y hora en que se ha realizado el cierre de la jornada de trabajo con formato aaaa-mm-ddThh:...
- **CloserUserId** — Id del usuario que ha realizado el cierre de jornada de trabajo.
- **WokrplaceId** — Id del local que ha realizado el cierre de sistema.
- **Documents** — Información sobre los documentos generados en cada serie de facturas (incluyendo facturas simplif...
- **Serie** — Serie de los documentos.
- **FirstNumber** — Número del primero documento generado en esa serie durante esta jornada de trabajo.
- **LastNumber** — Número del último documento generado en esa serie durante esta jornada de trabajo.
- **Count** — Número total de documentos generados en esa serie durante esta joranada de trabajo.
- **Amount** — Importe total (impuestos incluidos) facturado en esta serie.
- **Amounts** — Importes totales de ventas durante esta jornada de trabajo.
- **GrossAmount** — Importe con impuestos incluidos.
- **NetAmount** — Importe tras descontar impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchargeAmount** — Cuota correspondiente al recargo de equivalencia.
- **InvoicePayments** — Pagos de facturas realizados durante la jornada de trabajo ((impuestos incluidos) desglosada por ...
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Importe cobrado.
- **SalesOrderPayments** — Pagos de pedidos realizados durante la jornada de trabajo (impuestos incluidos) desglosada por fo...
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Importe cobrado.
- **DeliveryNotePayments** — Pagos de albaranes realizados durante la jornada de trabajo ((impuestos incluidos) desglosada por...
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Importe cobrado.
- **TicketPayments** — Pagos de proformas realizados durante la jornada de trabajo ((impuestos incluidos) desglosada por...
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Importe cobrado.

"Discounts": {
"DiscountRate": 0.0000,
"CashDiscount": 0.000
},
"Totals": {
"GrossAmount": 9.79,
"NetAmount": 8.9,
"VatAmount": 0.89,
"SurchargeAmount": 0.0,
"Taxes": [
{
"VatRate": 0.1000,
"SurchargeRate": 0.0140,
"GrossAmount": 9.79,
"NetAmount": 8.9,
"VatAmount": 0.89,
"SurchargeAmount": 0.0
}
]
}
}
]
}
La información indicada para cada pedido es:
- **Serie** — Serie de pedido.
- **Number** — Número de pedido.
- **Date** — Fecha del pedido en formato aaaa-mm-dd.
- **ProcessedDate** `[Opt]` — Fecha y hora en formato aaaa-mm-ddThh:mm:ss en la que Ágora ha sido notificada de que el document...
- **SupplierDocumentNumber** — Número del pedido del proveedor.
- **Status** — Estado del pedido.
- **Draft** — El pedido está en borrador.
- **Confirmed** — El pedido ha sido confirmado para enviar al proveedor (por ejempo, porque ha sido cancelado).
- **PartialDelivery** — El pedido ha sido servido parcialmente desde algún albarán.
- **Delivered** — El pedido ha sido servido totalmente desde algún albarán.
- **Warehouse** — Datos del almacén, incluyendo: Id Identificador único del cliente.
- **Id** — Identificador único del cliente.
- **Name** — Nombre del almacén.
- **Street** — Calle del almacén.
- **City** — Ciudad del almacén.
- **Region** — Provincia del almacén ZipCode Código postal del almacén.
- **ZipCode** — Código postal del almacén.
- **Cif** — Cif asociado al almacén.
- **FiscalName** — Nommbre fiscal asociado al almacén.
- **Proveedor** — Datos del proveedor, incluyendo: Id Identificador único del proveedor.
- **Id** — Identificador único del proveedor.
- **FiscalName** — Nombre fiscal del proveedor.
- **Cif** — CIF/NIF del proveedor.
- **Street** — Calle del almacén.
- **City** — Ciudad del almacén.
- **Region** — Provincia del almacén ZipCode Código postal del almacén.
- **ZipCode** — Código postal del almacén.
- **Cif** — Cif asociado al almacén.
- **ApplySurcharge** — Si al proveedor se compra con recargo de equivalencia.
- **Lines** — Líneas del documento, cada una de ellas en un elemento Line con el siguiente formato: Index Índic...
- **Index** — Índice de la línea dentro del documento.
- **ProductId** — Identificador del producto principal de la línea.
- **ProductName** — Nombre del producto principal de la línea.
- **PurchaseUnitId** — Identificador único de la unidad de compra.
- **PurchaseUnitName** — Nombre de la unidad de compra.
- **FamilyId** — Identificador único de la familia asociada al producto de la línea, o cadena vacía si este no tuv...
- **FamilyName** — Nombre de la familia asociada al producto de la línea, o cadena vacía si este no tuviera asociada...
- **OrderedQuantity** — Cantidad pedida.
- **DeliveredQuantity** — Cantidad servida.
- **VatId** — Identificador único del impuesto asociado al producto de la línea.
- **VatRate** — Tanto por uno de impuesto asociado al producto de la línea.
- **SurchargeRate** — Tanto por uno de recargo de equivalencia asociado al producto de la línea.
- **Price** — Precio unitario de la unidad comprada.
- **DiscountRate** — Tanto por uno de descuento aplicado a la línea.
- **CashDiscount** — Descuento en moneda aplicado a la línea.
- **TotalAmount** — Importe total de la línea tras aplicar descuentos.
- **Notes** — Notas a nivel de línea de pedido.
- **SizeId** — Id de la talla del producto.
- **ColorId** — Id del color del producto.
- **Notas** — Notas del pedido.
- **Discounts** — Descuentos del documento DiscountRate Tanto por uno de descuento aplicado al documento.
- **DiscountRate** — Tanto por uno de descuento aplicado al documento.
- **CashDiscount** — Descuento en moneda aplicado al documento.
- **Totals** — Contiene el detalle de los descuentos en pie del documento y de los totales, desglosándolos por b...
- **GrossAmount** — Importe incluyendo los impuestos.
- **NetAmount** — Importe tras descontar los impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchageAmount** — Cuota correspondiente al recargo de equivalencia.

Los documentos aparecen ordenados primero por Nombre y Número de Serie y
luego por Id.
Albaranes de Entrada
1000,
"SurchargeRate": 0.0140,
"Quantity": 10.000,
"Price": 1.00000000,
"LotId": 0,
"LotNumber": "",
"DiscountRate": 0.1000,
"CashDiscount": 0.00000000,
"TotalAmount": 9.00000000,
"Notes": "Es fanta de limón"
}
],

"Discounts": {
"DiscountRate": 0.0000,
"CashDiscount": 0.000
},
"Totals": {
"GrossAmount": 9.9,
"NetAmount": 9.0,
"VatAmount": 0.9,
"SurchargeAmount": 0.0,
"Taxes": [
{
"VatRate": 0.1000,
"SurchargeRate": 0.0140,
"GrossAmount": 9.9,
"NetAmount": 9.0,
"VatAmount": 0.9,
"SurchargeAmount": 0.0
}
]
},
"Invoiced": true,
"Confirmed": true
}
]
}
La información indicada para cada pedido es:
- **Serie** — Serie del albarán de entrada.
- **Number** — Número del albarán de entrada.
- **Date** — Fecha del albarán de entrada en formato aaaa-mm-dd.
- **ProcessedDate** `[Opt]` — Fecha y hora en formato aaaa-mm-ddThh:mm:ss en la que Ágora ha sido notificada de que el document...
- **SupplierDocumentNumber** — Número del documento del albarán de entrada del proveedor.
- **Invoiced** — Si el pedido tiene ha sido facturado o no.
- **Confirmed** — Si el pedido esta confirmado o no.
- **Warehouse** — Datos del almacén, incluyendo: Id Identificador único del cliente.
- **Id** — Identificador único del cliente.
- **Name** — Nombre del almacén.
- **Street** — Calle del almacén.
- **City** — Ciudad del almacén.
- **Region** — Provincia del almacén ZipCode Código postal del almacén.
- **ZipCode** — Código postal del almacén.
- **Cif** — Cif asociado al almacén.
- **FiscalName** — Nommbre fiscal asociado al almacén.
- **Proveedor** — Datos del proveedor, incluyendo: Id Identificador único del proveedor.
- **Id** — Identificador único del proveedor.
- **FiscalName** — Nombre fiscal del proveedor.
- **Cif** — CIF/NIF del proveedor.
- **Street** — Calle del almacén.
- **City** — Ciudad del almacén.
- **Region** — Provincia del almacén ZipCode Código postal del almacén.
- **ZipCode** — Código postal del almacén.
- **Cif** — Cif asociado al almacén.
- **ApplySurcharge** — Si al proveedor se compra con recargo de equivalencia.
- **Lines** — Líneas del documento, cada una de ellas en un elemento Line con el siguiente formato: Index Índic...
- **Index** — Índice de la línea dentro del documento.
- **ProductId** — Identificador del producto principal de la línea.
- **ProductName** — Nombre del producto principal de la línea.
- **PurchaseUnitId** — Identificador único de la unidad de compra.
- **PurchaseUnitName** — Nombre de la unidad de compra.
- **FamilyId** — Identificador único de la familia asociada al producto de la línea, o cadena vacía si este no tuv...
- **FamilyName** — Nombre de la familia asociada al producto de la línea, o cadena vacía si este no tuviera asociada...
- **Quantity** — Cantidad del producto entregada.
- **VatId** — Identificador único del impuesto asociado al producto de la línea.
- **VatRate** — Tanto por uno de impuesto asociado al producto de la línea.
- **SurchargeRate** — Tanto por uno de recargo de equivalencia asociado al producto de la línea.
- **Price** — Precio unitario de la unidad comprada.
- **DiscountRate** — Tanto por uno de descuento aplicado a la línea.
- **CashDiscount** — Descuento en moneda aplicado a la línea.
- **TotalAmount** — Importe total de la línea tras aplicar descuentos.
- **Notes** — Notas a nivel de línea del albarán.
- **LotId** — Identificador del lote del producto.
- **LotNumber** — Número de lote del producto.
- **DeliveredOrder** — Referencia de la línea del pedido que sirve.
- **Serie** — Serie del pedido Number Número del pedido.
- **Number** — Número del pedido.
- **LineIndex** — Indice de la línea del pedido.
- **SizeId** — Id de la talla del producto.
- **ColorId** — Id del color del producto.
- **Notas** — Notas del albarán.
- **Discounts** — Descuentos del documento DiscountRate Tanto por uno de descuento aplicado al documento.
- **DiscountRate** — Tanto por uno de descuento aplicado al documento.
- **CashDiscount** — Descuento en moneda aplicado al documento.
- **Totals** — Contiene el detalle de los descuentos en pie del documento y de los totales, desglosándolos por b...
- **GrossAmount** — Importe incluyendo los impuestos.
- **NetAmount** — Importe tras descontar los impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchageAmount** — Cuota correspondiente al recargo de equivalencia.

{
"VatRate": 0.1000,
"SurchargeRate": 0.0140,
"GrossAmount": 9.9,
"NetAmount": 9.0,
"VatAmount": 0.9,
"SurchargeAmount": 0.0
}
]
},
"Accounted": false
}
]
}
La información indicada para cada pedido es:
- **Serie** — Serie de la factura.
- **Number** — Número de factura.
- **Date** — Fecha de emisión de la factura en formato aaaa-mm-dd.
- **ProcessedDate** `[Opt]` — Fecha y hora en formato aaaa-mm-ddThh:mm:ss en la que Ágora ha sido notificada de que el document...
- **ReceptionDate** — Fecha de recepción de la factura en formato aaaa-mm-dd.
- **SupplierDocumentNumber** — Número de la factura del proveedor.
- **Accounted** — Si la factura ha sido procesada y contabilizada.
- **Proveedor** — Datos del proveedor, incluyendo: Id Identificador único del proveedor.
- **Id** — Identificador único del proveedor.
- **FiscalName** — Nombre fiscal del proveedor.
- **Cif** — CIF/NIF del proveedor.
- **Street** — Calle del almacén.
- **City** — Ciudad del almacén.
- **Region** — Provincia del almacén ZipCode Código postal del almacén.
- **ZipCode** — Código postal del almacén.
- **Cif** — Cif asociado al almacén.
- **ApplySurcharge** — Si al proveedor se compra con recargo de equivalencia.
- **IncomingDeliveryNotes** — Albaranes de entrada que incluye la factura.
- **Totals** — Contiene el detalle de los descuentos en pie del documento y de los totales, desglosándolos por b...
- **GrossAmount** — Importe incluyendo los impuestos.
- **NetAmount** — Importe tras descontar los impuestos.
- **VatAmount** — Cuota correspondiente al impuesto.
- **SurchageAmount** — Cuota correspondiente al recargo de equivalencia.
- **Payments** — Lista con los pagos asociados a la factura.
- **MethodId** — Identificador de la forma de pago.
- **MethodName** — Nombre de la forma de pago.
- **Amount** — Cantidad pagada
- **Date** — Fecha en la que se ha realizado el pago.

{
"Id": 3,
"Name": "Ullo/TPVs",
"PointsOfSale": [
{
"Id": 15,
"Name": "UT1"
}
]
}
],
"Warehouses": [
{
"Id": 3,
"Name": "Ullo/Almacén"
}
]
}
]
}
La información en cada elemento es:
- **Id** — Id del local.
- **Name** — Nombre del local.
- **DeletionDate** — Fecha de borrado del registro.
- **PosGroups** — Contiene los grupos de puntos de venta asociados al local.
- **Id** — Id del grupo de puntos de venta.
- **Name** — Nombre del grupo de puntos de venta.
- **DeletionDate** — Fecha de borrado del registro.
- **PointsOfSale** — Puntos de venta asociados al grupo.
- **Id** — Id del punto de venta.
- **Name** — Nombre del punto de venta.
- **DeletionDate** — Fecha de borrado del registro.
- **Warehouses** — Almacenes asociados a alguno de los grupos de puntos de venta del local.
- **Id** — Id del almacén.
- **Name** — Nombre del almacén.
- **DeletionDate** — Fecha de borrado del registro.
- **Stocks** — Es posible exportar el stock de cada producto en cada almacén utilizando el parámetro stocks al i...
- **WarehouseId** — Id del almacén.
- **ProductId** — Id del producto.
- **Quantity** — Cantidad en unidades de venta disponible actualmente en stock.
- **SizeId** — Id de la talla del producto (si la hubiera).
- **ColorId** — Id del color del producto (si lo hubiera).

## Imágenes de Productos — API HTTP

Imágenes de Productos
Esta opción sólo está disponible a través del API Http y sólo es posible exportar
imágenes, no se pueden importar.
Las imágenes de las fichas de producto se indican ProductImages en sucesivos elementos
ProductImage:
{
"ProductImages": [
{
"ProductId": 1,
"ImageContent": "...imagen en base64..."
},
{
"ProductId": 2,
"ImageContent": ""
}
]
}
La información en cada elemento es:
- **ProductId** — Id del producto.
- **ImageContent** — Contenido de la imagen como un array de bytes codificado en base64.

## Precios Especiales — API HTTP

Precios Especiales
Los precios especiales se indican en el elemento CustomerSpecialPrices en sucesivos
elementos CustomerSpecialPrice:
{
"CustomerSpecialPrices": [
{
"SaleFormatId": 1,
"CustomerId": 1,
"Main": 5.50000000,
"MenuItem": 0.00000000,
"Addin": null
},
{
"SaleFormatId": 2,
"CustomerId": 1,
"Main": 4.50000000,
"MenuItem": 0.00000000,
"Addin": null
},
{
"SaleFormatId": 3,
"CustomerId": 1,
"Main": 7.50000000,
"MenuItem": 0.00000000,
"Addin": null
},
{
"SaleFormatId": 4,
"CustomerId": 1,
"Main": 2.00000000,
"MenuItem": 0.00000000,
"Addin": 0.50000000
}
}
La información indicada para cada precio especial es:
- **SaleFormatId** — Identificador del formato de venta.
- **CustomerId** — Identificador del cliente.
- **Main** — Precio especial del formato de venta como principal.
- **MenuItem** — Precio especial del formato de venta como suplemento de menú.
- **Addin** — Precio especial del formato de venta como añadido.

## API HTTP — Referencia General

Integración mediante API HTTP
Ágora también soporta la importación y exportación de datos mediante una API HTTP. Para ello,
deberá activar la opción correspondiente al configurar el módulo de servicios de integración. Al
activar el API HTTP deberá indicar un token de autenticación, que tendrá que ser enviado junto
con cada petición que quiera enviar u obtener datos del API.
El servidor HTTP utilizado será el mismo que el de la Administración de Ágora. Todas las URLs
que aparecen en este manual son relativas a la URL base de la administración, por defecto,
http://SERVIDOR:8984/.
El API soporta los mismos tipos de exportación e importación que la aplicación de línea de
comandos ais.exe por lo que puede usarla para exportar e importar datos maestros de Ágora,
así como exportar e importar datos de ventas.
A diferencia de la integración mediante ficheros, el API soporta tanto XML como JSON. El
formato es el descrito en las secciones correspondientes de este manual.
Formato de Petición y Respuesta
A la hora de solicitar o enviar datos al API es necesario indicar algunas cabeceras en la petición
HTTP:
Api-Token
Valor de la clave (token de autenticación) que se haya configurado en Ágora desde la
pantalla de Activar Módulos Adicionales. Ejemplo:
- Api-Token: gtSUwbHbxwg3hRXhZ01Kictq
- **Accept** — Formato de serialización empleado.

Content-Type
Formato del contenido enviado en las peticiones POST. Es necesario indicar el
encoding para evitar problemas con caracateres no ASCII. Los formatos más
habituales son:
- Content-Type: application/xml; charset=utf-8 para XML.
- Content-Type: application/json; charset=utf-8 para JSON.
El código de estado de la respuesta será 200 OK en caso de que la petición se ha procesado con
éxito, o un código de error en caso contrario. Si se trata de una solicitud de exportación de
datos, el cuerpo de la respuesta contendrá los datos exportados en el formato indicado.
Además, se incluiría una cabecerá Api-Version con la versión de Ágora que ha generado la
respuesta para permitir que los sistemas externos puedan amoldarse a cambios de versiones.
Exportación de ventas y compras
Para obtener los datos de ventas (facturas, albaranes, pedidos, cierres de caja, movimientos de
caja, pedidos a proveedor, albaranes de entrada, facturas de proveedor etc.) deberá utilizar la
siguiente URL:
/api/export/
Deberá lanzar una petición GET a esta URL. Opcionalmente se pueden incluir los siguientes
parámetros:
business-day
Indica la fecha de negocio en formato aaaa-mm-dd para los documentos de venta o
documentos de compra para la cual se desean obtener los datos. Si no se especifica se
exportarán las ventas y compras de hoy.
- /api/export/?business-day=2013-05-21
filter
Permite restringir el tipo de datos exportado. Si no se establece se exportan todos los
datos disponibles, pero puede indicar los tipos de datos que desee exportar separados
por comas:
- CashTransactions: movimientos de caja
- DeliveryNotes: alabaranes
- SalesOrders: pedidos
- Invoices: facturas
- PosCloseOuts: cierres de caja
- SystemCloseOuts: cierres de sistema
- PurchaseOrders: pedidos a proveedor
- IncomingDeliveryNotes: albaranes de entrada

- PurchaseInvoices: facturas de proveedor
Por ejemplo, si sólo desea obtener las facturas de hoy:
- /api/export/?filter=Invoices
O si necesita conocer los pedidos y albaranes de un día concreto:
- /api/export/?business-
day=2018-04-28&filter=SalesOrders,DeliveryNotes
workplaces
Permite limitar la exportación a los locales con los ids indicados. Si no se establece se
exportan datos para todos los locales, pero puede indicar los locales para los cuales
quiere exportar datos pasando sus ids separados por comas:
- /api/export/?workplaces=2,3,5,7
include-processed
Permite incluir en la exportación los documentos de ventas que hayan sido procesados
previamente. Por defecto, si no se indica se considera que no deben incluirse los
documentos procesados. Consulta la sección de este manual sobre Procesar
documentos de venta para obtener más información.
- /api/export/?business-
day=2018-04-28&filter=SalesOrders,DeliveryNotes&include-
processed=true
Exportación de tickets abiertos
Para exportar los tickets abiertos actualmente en el sistema puede utilizar la siguiente URL:
/api/export/tickets/
La respuesta contendrá un array con los tickets abiertos usando el formato indicando en la
sección de exportar tickets de este manual.
Por defecto, se exportarán todos los tickets abiertos. Es posible filtrar los resultado usando
alguno de los los siguientes parámetros opcionales:
sale-center-id y sale-location-name
Permite obtener la información de los tickets abiertos en una ubicación concreta,
definida por el ID de centro de centa y el nombre de la ubicación. Puede obtener la
lista de centros de centros de venta y ubicaciones a través de la opción de exportar
maestros.
- /api/export/tickets/?sale-center-id=1&sale-location-name=B3

ticket-global-id
Permite obtener la información del ticket abierto con el GlobalId indicado. La
respuesta será siempre un array que contendrá un único ticket si se ha podido
encontrar (y sigue estando abierto), o un array vacío en caso de que el ticket haya sido
cerrado y no exista ningún ticket con ese identificador global.
- /api/export/tickets/?ticket-global-
id=f990d051-538e-4438-8406-7170f6e60820
ticket-barcode
Permite obtener la información de un ticket abierto a partir del código de barras
impreso en la factura proforma. La respuesta será siempre un array que contendrá un
único ticket si se ha podido encontrar (y sigue estando abierto), o un array vacío en
caso de que el ticket haya sido cerrado y no exista ningún ticket asociado a ese código
de barras.
- /api/export/tickets/?ticket-barcode=82148769
Los parámetros anteriores son excluyentes. Sólo es posible filtar por alguno de los
tres criterios a la vez (ubicación, global id, o código de barras).
Procesar documentos
Al exportar datos hacia un sistema externo, puede ser útil indicar a Ágora qué documentos
(pedidos, albaranes o facturas), tanto de venta como de compra, ya han sido procesados para
evitar que Ágora vuelva a enviarlos al realizar una exportación.
Cuando se marca un documento como procesado, Ágora dejará de exportarlo en posteriores
llamadas al API de exportación, excepto si el documento ha sido modificado en Ágora. En ese
caso, Ágora volverá a considerarlo como no procesado para que el sistema externo pueda
recibir los cambios y actuar en consecuencia.
Para indicar que los documentos (facturas, albaranes y pedidos) deberá realizar una petición
POST a la siguiente URL:
/api/doc/processed
Al realizar está petición debe enviar datos en formato json codificados como utf-8, para ello
deberá usar las siguientes cabeceras:

Api-Token: gtSUwbHbxwg3hRXhZ01Kictq
Accept: application/json
Content-Type: application/json; charset=utf-8
Y en el cuerpo de la petición incluir el documento JSON que incluye las series y los números de
los documentos procesados. Ejemplo:
[{"Serie": "F", "Number": 121}, {"Serie": "A", Number: 20}]
Crear un albarán a partir de un ticket abierto
A través del API HTTP es posible crear un albarán a partir de un ticket abierto. Para ello, deberá
realizar una petición POST a la siguiente URL:
/api/tickets/create-delivery-note/
En el cuerpo de la petición deberá incluir la información necesaria para crear el albarán. Todos
los campos son obligatorios. Esta información puede estar indicada en formato JSON o 

{
"TicketGlobalId": "413c3046-4aaa-41c7-a77b-fa91085df489",
"PosId": 1,
"UserId": 1,
"Date": "2023-10-24T15:26:00",
"Notes": "Albarán creado por servicios de integración",
"Print": true,
"InvoiceCanBeEmitted": false,
"CustomerDocumentNumber": "REF-P-1234",
"Customer": {
"Id": 2,
"FiscalName": "Consultoría Random, S.L.",
"Cif": "T981241682",
"ApplySurcharge": false,
"Street": "Calle del Pez",
"City": "Leganés",
"Region": "Madrid",
"ZipCode": "81012",
"AccountCode": "00012312323",
"CountryCode": "es",
}
}
Donde cada propiedad indica lo siguiente:
- **TicketGlobalId** — Identificador global único de ticket.
- **PosId** — Identificador del punto de venta donde se desea generar el albarán.
- **UserId** — Identificador del usuario que ha creado el albarán.
- **Date** — Fecha en que se genera el albarán.
- **Notes** — Observaciones asociadas al albarán.
- **CustomerDocumentNumber** — Número de referencia del documento de compra del cliente.
- **Print** — Indica si debe imprimir ("true") o no ("false") el albarán.
- **InvoiceCanBeEmitted** — Indica si el albarán se puede facturar ("true") o no ("false").
- **Customer** — Datos del cliente al que se emite el albarán, incluyendo: Id Identificador único del cliente.
- **Id** — Identificador único del cliente.
- **FiscalName** — Nombre fiscal del cliente.
- **Cif** — CIF/NIF del cliente.
- **AccountCode** — Código de la cuenta contable del cliente.
- **Street** — Calle del cliente.
- **City** — Población del cliente.
- **Region** — Provincia del cliente.
- **ZipCode** — Código postal del cliente.
- **CountryCode** — Código ISO 3166-1 alpha-2 del país del cliente.
- **ApplySurcharge** — Indica si al cliente se le aplica recargo de equivalencia.

Api-Token: gtSUwbHbxwg3hRXhZ01Kictq
Accept: application/json
Content-Type: application/json; charset=utf-8
Y en el cuerpo de la petición incluir el documento JSON que incluye los parámetros de la
consulta. Ejemplo:
{
"QueryGuid": "{110ACB7C-EC37-4170-A440-35AD6CD2B7DB}",
"Params": {
"from": "2021-02-25",
"to": "2021-02-25",
"posGroupIds": "1,2",
}
}
Por último, en el cuerpo de la respuesta se incluirá el resultado de la consulta en formato JSON.
Ejemplo:
[
{
"BusinessDay": "2021-02-25T00:00:00",
"Cobros Efectivo": 12.500,
"Propinas Efectivo": 2.000,
"Cobros Tarjeta": 10.000,
"Propinas Tarjeta": 1.000,
"Cobros Cheque restaurante": 0.000,
"Propinas Cheque restaurante": 0.000
}
]
Para realizar las consultas es indispensable indicar el identificador de la consulta "QueryGuid"
como se ve en el ejemplo y los parámetros necesarios para ejecutarla. Además a la hora de
incluir los parámetros deberá incluirlos con el mismo nombre que tengan en la consulta
personalizada y dependiendo del tipo del parámetro que tengan deberá tener en cuenta ciertas
consideraciones.
En el caso de tipos simples, los valores tienen el siguiente formato:
- Date: "yyyy-MM-dd HH:mm:ss" o "yyyy-MM-dd". Ejemplos: "2021-02-25 00:00:00",
"2021-02-25".
- Int: El entero entre comillas. Ejemplos: "1", "2"

- String: La cadena de texto entre comillas. Ejemplos: "Lunes", "Martes".
- Decimal: El número decimal entre comillas y separador de decimales con punto.
Ejemplos: "2.25", "5.50".
- Bool: "true" o "false".
En el caso de tipos complejos (Family, Category, Supplier, PosGroup, Warehouse, PriceList,
Product, TimeFrameGroup etc.), se corresponderá con los IDs de los valores seleccionados
separados por comas. Ejemplo: "1,2,3,32"
Por último los valores personalizados se envían como como una cadena de texto. En el caso de
incluir más de un valor irá separado por comas. Ejemplos: "Lunes", "Lunes,Martes".
Exportación de datos maestros
Para obtener los datos maestros de Ágora (productos, precios, tarifas, etc. deberá utilizar la
siguiente URL:
/api/export-master/
Deberá lanzar una petición GET a esta URL. Opcionalmente se pueden incluir los siguientes
parámetros:
filter
Permite restringir el tipo de datos a exportar, separándolos por comas. Si no se indica
este parámetro, se exportará toda la información. Los posibles valores son:
- WorkplacesSummary: resumen de locales
- Series: series
- Customers: clientes
- Users: usuarios
- Vats: tipos de impuestos
- PaymentMethods: formas de pago
- PriceLists: tarifas
- SaleCenters: centros de venta
- Families: familias
- Sizes: tallas
- Colors: colores
- Products: productos
- Menus: menús
- Offers: promociones
- Suppliers: proveedores

- Warehouses: almacenes
- Stocks: stocks actuales
- PredefinedNotes: notas predefinidas
Por ejemplo, quiere exportar los datos de series, clientes y familias, se enviaría una
petición a la URL:
- /api/export-master/?filter=Series,Customers,Families
where-product-category-id
Permite limitar la exportación de los datos de productos y stocks a los productos que
tienen asignada la categoría indicada. Este parámetro será ignorado a la hora de
exportar el resto de información. Si no se establece se exportarán datos de todas las
categorías existentes. Para utilizarlo, deberá indicar el id de la categoría cuyos
productos quiere exportar:
- /api/export-master/?filter=Products&where-product-category-id=2
where-stock-warehouse-id
Permite limitar la exportación de los datos de stock al almacén indicado. Este
parámetro será ignorado a la hora de exportar el resto de información. Si no se
establece se exportará el stock para todos los almacenes existentes. Para utilizarlo,
deberá indicar el id del almacén cuyo stock desea exportar:
- /api/export-master/?filter=Stocks&where-stock-warehouse-id=14
Este parámetro puede usarse conjuntamente con el parámetro where-product-
category-id para acotar más exportación de datos de stock. Por ejemplo, para
obtener el stock de los productos de la categoría 17 en el almacén 14, se debe enviar
una petición a la URL:
- /api/export-master/?filter=Stocks&where-stock-warehouse-
id=14&where-product-category-id=17
Imágenes de ficha de producto
Para obtener las imágenes de las fichas de productos deberá utilizar la siguiente URL:
/api/export-master/product-images/?products=[1,2,3]
Deberá lanzar una petición GET a esta URL incluyendo obligatoriamente el siguiente
parámetro:
products
Ids de los productos cuya imagen desea obtener. Debe estar formateado como un
array JSON, por ejemplo [1, 5, 10] o [37]. El número máximo de productos está
limitado a 20 para evitar problemas de rendimiento. La respuesta contendrá las
imágenes de los productos según el formato descrito en la sección sobre exportación
de imágenes de productos.

## API HTTP — Importación/Exportación

Importación (ventas, compras y maestros)
La importación de datos se realiza en una misma URL, independientemente de que sean ventas
o datos maestros. Deberá realizar una petición POST a:
/api/import/
El cuerpo de la petición deberá contener los datos a importar en el formato indicado en las
secciones correspondientes de este manual.

Por ejemplo, para enviar datos en formato XML codificado como utf-8 deberá usar las siguientes
cabeceras:
Api-Token: gtSUwbHbxwg3hRXhZ01Kictq
Accept: application/xml
Content-Type: application/xml; charset=utf-8
Para enviar datos en formato json codificado como utf-8 deberá usar las siguientes cabeceras:
Api-Token: gtSUwbHbxwg3hRXhZ01Kictq
Accept: application/json
Content-Type: application/json; charset=utf-8
Impresión libre
Utilizando los servicios de integración a través del API HTTP es posible imprimir textos y
documentos usando las impresoras configuradas en el sistema. Esto puede ser útil para notificar
a los empleados del establecimiento de determinados eventos, por ejemplo que se acaba de
recibir un nuevo pedido, o que se ha activado una promoción.
Para ello deberá realizar una petición POST a la siguiente URL:
/api/print/
El cuerpo de la petición deberá ser un documento JSON con el siguiente formato:

{
"PrinterName": "tickets-pr80",
"Format": "plain",
"Data": "Primera línea de texto\nSegunda línea de texto\nTercera línea de texto"
}
Donde:
- **PrinterName** — Es el nombre en Windows de la impresora por la que desea imprmir.
- **Format** — Formato en el que se están enviando lo datos.
- **Data** — Información que se enviará a la impresora.

curl -X POST http://url_agora_central:8984/api/hub/generate-data/ -H 'Api-Token:
api_token'
Donde:
url_agora_central
Es la dirección de internet de la central de la instalación.
api_token
El token configurado en el monitor de servicio de Ágora, especificado al activar el
módulo de Servicios de Integración y el API web.
Obtención de documento en base al GlobalId
Puede obtener toda la información de un documento (tickets, albaranes, pedidos y facturas) en
base al GlobalId del mismo. Dicho GlobalId se puede obtener de diferentes fuentes, como por
ejemplo mediante los servicios de integración, o mediante los códigos QR incluidos en los
documentos Esc/Pos de Ágora previamente configurados en las plantillas de ticket.
Para ello deberá realizar una petición GET a la siguiente URL:
/api/document/
Se deberá incluir el siguiente parámetro:
globalId
Código identificador del documento en formato GUID. Este parámetro es obligatorio y
debe ser un valor único en el sistema. Si no se indica este parámetro o está mal
formateado, la respuesta será un error 400 indicando que no se ha indicado el GlobalId
del documento a consultar.
- /api/document/?globalId=4167a91f-ae9e-4010-93a2-fd1bdaa22c61
Se permiten ciertas variaciones en el formato del GUID, como por ejemplo:
- 4167a91fae9e401093a2fd1bdaa22c61
- 4167a91f-ae9e-4010-93a2-fd1bdaa22c61
- 4167A91F-AE9E-4010-93A2-FD1BDAA22C61
- {4167a91f-ae9e-4010-93a2-fd1bdaa22c61}
En cambio, no se permiten otros formatos como por ejemplo:
- {4167A91FAE9E401093A2FD1BDAA22C61}
- [4167a91f-ae9e-4010-93a2-fd1bdaa22c61]
Puede ejecutar fácilmente el envío de datos ejecutando el siguiente script de cURL:
curl -X POST http://url_agora_central:8984/api/document/?globalId=4167a91f-
ae9e-4010-93a2-fd1bdaa22c61 -H 'Api-Token: api_token'

Donde:
url_agora_central
Es la dirección de internet de la central de la instalación.
api_token
El token configurado en el monitor de servicio de Ágora, especificado al activar el
módulo de Servicios de Integración y el API web.
Como respuesta, obtendrá un XML o un JSON siguiendo el formato de exportación del
documento encontrado, junto al tipo de documento:
{
"Ticket": {
/* Datos del ticket si aún no ha sido cerrado */
},
"SalesOrder": {
/* Datos del pedido si el ticket se cerró como pedido */
},
"DeliveryNote": {
/* Datos del albarán si el ticket se cerró como albarán */
},
"Invoice": {
/* Datos de la factura si el ticket se cerró como factura */
}
}

- Tickets abiertos
- Albaranes
- Pedidos
- Facturas
Las respuestas pueden ser las siguientes:
- 200 OK: Se ha encontrado el documento y se devuelve la información del mismo.
- 400 Bad Request: El GlobalId del documento a consultar no está bien formateado.

## Integración Fidelización

Integración con Sistemas de Fidelización
Ágora se puede integrar con sistemas de fidelización a través de los servicios de integración
incluidos con Ágora. Para poder realizar la integración, es necesario primero conocer los
conceptos sobre los que se va a asentar:
Un programa de fidelización (LoyaltyProgram) permite ofrecer premios (Reward) a sus
participantes (Member) en base a las consumiciones realizadas previamente con el fin de
aumentar las ventas del comercio (Merchant) que lanza el programa. Para ello, será necesario:
- Que Ágora pueda identificar un participante del programa y conocer los premios que
tiene disponibles.
- Que Ágora pueda notificar al sistema de fidelización las consumiciones realizadas y los
premios redimidos por un participante cuando se le emite una factura.
Participantes en el programa de fidelización
Los participantes del programa de fidelización no tienen por qué ser clientes (Customer) de
Ágora. Ágora no mantendrá información de los participantes del programa de fidelización, más
allá de la necesaria para mantener la integración entre ambos sistemas, y esa información
siempre será algo que podrá decidir el sistema externo. Esto cumple varios objetivos:
- Evitar posibles problemas legales. Habrá sistemas de fidelización en los que el acuerdo
de cesión de datos se haya realizado entre el participante del programa y el sistema de
fidelización, pero no sea legal cederle esos datos al establecimiento.
- Dar libertad al programa de fidelización para definir sus participantes con la información
que quiera, sin necesidad de buscar un modelo que sea compatible con los requisitos de
Ágora para crear un cliente.
- Poder desligar el cliente de una factura del participante del programa de fidelización,
cubriendo así casos como que la factura se emita a una empresa pero los puntos los
acumule otra persona.
El único requisito que impone Ágora es que en el programa de fidelización los participantes
cuenten con un identificador único. El programa de fidelización podrá decidir si ese identificador
es una clave numérica, un código QR, un número de telefóno, un DNI, etc. Desde el punto de
vista de Ágora se tratará como un valor alfanumérico y se usará para acceder al sistema de
fidelización para validar el participante, obtener sus promociones o imputarle los consumos.
Ágora sólo permite identificar participantes del programa de fidelización a partir de su
identificador único. No existe opción de buscar por otros campos, y el sistema de fidelización
debe responder con un único resultado a las peticiones de validación de participante del
programa realizadas por Ágora. Esto se hace por varios motivos:
- Simplificar al máximo el interface de usuario y la operativa en el punto de venta.

- Evitar dependencias en la forma de modelar los datos del sistema de fidelización y
Ágora. Para poder buscar por campos que no fuesen el código único, ambos sistemas
deberían coordinarse sobre los campos que existen, perdiendo flexibilidad.
- Aumentar la seguridad del sistema. Al hacer obligatorio leer el identificador único del
cliente, si éste se encuentra en una tarjeta/app de fidelización, es más complicado
(aunque posible) para el empleado del comercio realizar operativas ilegales.
- **Premios** — Los participantes del programa de fidelización pueden obtener distintos tipos de premio en base a...
- **Consumiciones** — Cada vez que se emite una factura en Ágora se notificará al sistema de fidelización de ello, indi...

- Al unir dos tickets, si sólo uno de ellos está asociado a un participante, se respetará ese
participante. En caso de que ambos tengan participantes asociados, no se permitirá
realizar la unión.
- Al emitir una devolución asociada a un participante, se notificará al sistema de
fidelización de la misma. Esto es aplicable a devoluciones emitidas también durante la
reapertura de tickets, conversión de facturas simplificadas en facturas o cualquier otro
motivo.
- Al realizar un cambio de forma de pago sobre una factura asociada a un participante, no
se notificará al sistema de fidelización. De esta forma se evita que el sistema de
notificación tenga que distinguir entre facturas nuevas y facturas cuya forma de pago
ha cambiado a la hora de imputar consumos al participante del programa.
- Al emitir un albarán, Ágora no notificará al sistema de fidelización. La notificación se
realizará en el momento de la factura. Esto es una limitación del diseño actual que
podría llevar a redimir varias veces el mismo premio si en lugar de facturar los tickets
se generan albaranes. En cualquier caso, el sistema de fidelización siempre tiene la
última palabra a la hora de redimir premios y podría rechazar el envío de una factura si
detecta que hay premios que ya han sido redimidos previamente.
Protocolo de Integración
La integración entre Ágora y el sistema de fidelización se realizará a través de peticiones HTTP
realizadas desde Ágora. Cada petición se hará a una URL diferente configurable en Ágora, pero
deberá ajustarse al protocolo definido en este documento.
Dado que cada sistema de fidelización puede tener su propio esquema de autenticación y
autorización, no existirá ningún mecanismo explícito para autenticar Ágora frente a las URLs
proporcionadas. Es recomendable que todo el acceso se realice a través de SSL y, en caso de
considerarse necesario, se puede incluir un token de autorización como parte de la URL para
poder limitar el acceso de Ágora revocando el token si fuera necesario.
Todas las peticiones y respuestas serán en formato JSON codificado en utf8. Esto se reflejará en
las cabeceras HTTP de las peticiones y respuestas. Adicionalmente, en las peticiones realizadas
con Ágora se enviará una cabecera Agora-Version para indicar la versión de Ágora que está
generando la petición, por si el sistema de fidelización tuviera que tenerlo en cuenta (por
ejemplo, porque una versión antigua de Ágora no soportase nuevos formatos de premios).
Peticiones:
Accept: application/json
Agora-Version: 5.0.4
Respuestas:

Accept: application/json
Content-Type: application/json; charset=utf-8
Validación de participante y obtención de premios
Para validar si un identificador único está registrado en el programa de fidelización y obtener
sus premios disponibles se invocará la URL configurada en Ágora. En esta URL se reemplazará el
marcador {member_id} por el identificador único de participante.
Por ejemplo, si la URL configurada en Ágora es la siguiente:
https://api.loyalty-club.com/member/{member_id}/
Al leer el identificador de participante 3hRXhZ01Kictq Ágora lanzará una petición GET a la URL:
https://api.loyalty-club.com/member/3hRXhZ01Kictq/
Si el identificador es válido, la respuesta deberá tener como código de respuesta 200 OK y su
cuerpo ajustarse al siguiente formato:

{
"MemberId": "3hRXhZ01Kictq",
"DisplayText:" "Hola Marcos Gómez, tienes 257 puntos acumulados.",
"Rewards": [
{
"Id": "7cnZDFPw",
"Name": "Descuento de 3€",
"Description": "Descuento de 3€ sobre el total de tu factura.",
"Type": "CashDiscount",
"Value": 5.00
},
{
"Id": "T8j3h6TL",
"Name": "Descuento del 10%",
"Description": "Descuento del 10% sobre el total de tu factura.",
"Type": "DiscountRate",
"Value": 0.10
},
{
"Id": "8xmssMkq",
"Name": "Descuento Cumpleaños",
"Description": "Consigue un descuento por ser tu cumpleaños.",
"Type": "NamedDiscount",
"Code": "HBD"
},
{
"Id": "tu98JVRb",
"Name": "Promoción Postre Gratis",
"Description": "Pide dos platos principales y llévate un postre gratis.",
"Type": "Offer",
"Code": "PPG"
}
]
}
Donde:
- MemberId: es el identificador único del participante en el programa de fidelización.
- DisplayText: es el texto que se mostrará en pantalla al identificar al participante.
Puede incluir información sobre el participante (nombre, teléfono, etc.), saldo
acumulado de puntos, próximas promociones...
- Rewards: contiene la lista de premios disponibles para el participante en este momento.
Cada premio debe incluir la siguiente información:
- Id: identificador único del premio. Este identificador será generado por el
sistema de fidelización y será enviado por Ágora al notificar una venta para que
pueda proceder a redimirlo.

- Name: nombre del premio. Se mostrará al empleado para facilitar la selección
del premio que desea aplicar.
- Description: descripción larga del premio. Podrá ser consultada por el
empleado para facilitar la selección del premio que desea aplicar.
- Type: tipo de premio. Puede ser:
- CashDiscount: descuento directo en moneda sobre total de factura. El
valor del descuento se deberá indicar en la propiedad Value.
- DiscountRate: descuento directo en porcentaje expresado en tanto por
ciento sobre total de factura. El valor del descuento se deberá indicar
en la propiedad Value.
- NamedDiscount: descuento predefinido en Ágora. El código del
descuento se deberá indicar en la propiedad Code y debe
corresponderse con un descuento existente en Ágora de tipo
"Descuento en Ticket". En caso de que el no exista tal descuento en
Ágora se ignorará el premio. Utilizar NamedDiscount en lugar de
descuentos directos permite luego analizar el Ágora más fácilmente los
descuentos aplicados y delegar en Ágora el importe real del descuento
aplicado.
- Offer: promoción definida en Ágora. El código de promoción se deberá
indicar en la propiedad Code y debe corresponderse con una promoción
existente en Ágora de tipo "Sólo clientes y tickets seleccionados". En
caso de que no exista tal promoción en Ágora se ignorará el premio.
Si no hay premios disponibles para redimir se deberá devolver un array vacío, pero el código de
respuesta deberá seguir siendo 200 OK.
En caso de que el identificador no sea válido, el servidor deberá devolver un código de
respuesta 404 Not Found.
Acumulación de puntos y redención de premios
Cada vez que se emita una factura en Ágora asociada a un participante del programa de
fidelización se enviará una notificación mediante una petición POST a la URL configurada en
Ágora, por ejemplo:
https://api.loyalty-club.com/invoices/
Esta URL no incluye información del member_id asociado a la factura porque en el caso de
facturas de varios albaranes, cada albarán podría tener un member_id distinto.
En el cuerpo de la petición se incluirán todos los detalles de la factura en el formato descrito en
la sección de exportación de facturas de este manual. Además de la información propia de la

factura (totales, productos, cantidades, etc.) para permitir acumular los consumos del usuario,
se incluirán los premios redimidos en esa factura como datos adicionales dentro de los cada
elemento InvoiceItem:
"LoyaltyProgram": {
"MemberId": "3hRXhZ01Kictq",
"Rewards": [{
"Id": "7cnZDFPw",
"Name": "Descuento de 3€",
"Type": "CashDiscount",
"Value": 3.000000
}, {
"Id": "8xmssMkq",
"Name": "Descuento Cumpleaños",
"Type": "NamedDiscount",
"Code": "EMPT"
}]
}
En la propiedad LoyaltyProgram se incluirá toda la información relativa al programa de
fidelización:
- **MemberId** — Identificador único del participante del sistema de fidelización.
- **Rewards** — Contiene la lista de premios consumidos por el participante.
- **Id** — Identificador único del premio.
- **Name** — Nombre del premio.
- **Type** — Tipo de premio.
- **CashDiscount** — Descuento directo en moneda sobre total de factura.
- **DiscountRate** — Descuento directo en porcentaje expresado en tanto por uno sobre total de factura (por ejemplo, u...
- **NamedDiscount** — Descuento predefinido en Ágora.
- **Offer** — Promoción definida en Ágora.
- **Status** — Deberá ser el literal accepted para indicar que la factura es aceptada.
- **PrinterText** — Contendrá un texto libre que Ágora imprimirá al final de la factura.
- **Status** — Deberá ser el literal rejected para indicar que la factura es rechazada.
- **RejectReason** — Contendrá un texto libre que Ágora mostrará al usuario para indicar el motivo del rechazo.

## Integración Sistemas Externos

Integración con Sistemas Externos al crear
documentos
Ágora se puede integrar con sistemas externos a través de los servicios de integración incluidos
con Ágora cada vez que se crea un documento de venta. Para ello, deberá activar la opción
correspondiente al configurar el módulo de servicios de integración. Al configurarlo se podrá
elegir a qué documentos de venta afecta: pedidos, albaranes y/o facturas.
Los sistemas externos integrados con Ágora se encargarán de validar los documentos de venta
creados y pueden solicitar en el documento la impresión de cierta información.
La información que se imprime sólo está soportada actualmente sobre las
plantillas ESCPOS.
Por tanto todo sistema externo podrá:
- Rechazar el documento. En este caso el sistema puede indicar el motivo.
- Aceptar el documento. En este caso el sistema nos puede devolver información
adicional al proceso y datos que se desea imprimir. La información adicional puede ser
cualquier cosa que el sistema considere oportuno para identificar la petición, o
simplemte información asociada al proceso que no será tratada por Ágora y que puede
usarse en consultas personalizadas.
Protocolo de Integración de Facturas
La integración entre Ágora y el sistema externo se realizará a través de peticiones HTTP
realizadas desde Ágora. Cada petición se hará a una URL diferente configurable en Ágora, pero
deberá ajustarse al protocolo definido en este documento.
Dado que cada sistema externo puede tener su propio esquema de autenticación y autorización,
no existirá ningún mecanismo explícito para autenticar Ágora frente a las URLs proporcionadas.
Es recomendable que todo el acceso se realice a través de SSL y, en caso de considerarse
necesario, se puede incluir un token de autorización como parte de la URL para poder limitar el
acceso de Ágora revocando el token si fuera necesario.
Todas las peticiones y respuestas serán en formato JSON codificado en utf8. Esto se reflejará en
las cabeceras HTTP de las peticiones y respuestas. Adicionalmente, en las peticiones realizadas
con Ágora se enviará una cabecera Agora-Version para indicar la versión de Ágora que está
generando la petición, por si el sistema externo tuviera que tenerlo en cuenta.
Peticiones:

Accept: application/json
Agora-Version: 7.3.0
Y en el cuerpo de la petición incluir el documento JSON. Ejemplo de envío de factura:
{
"Action": "Create",
"Invoice": {
// ... formato de la factura como se detalla en documentación de cómo
exportar facturas.
}
}
Respuestas:
Accept: application/json
Content-Type: application/json; charset=utf-8
El sistema externo podrá decidir si acepta o rechaza el documento. En caso de que se rechace el
documento, Ágora no realizará el cierre del documento. Esto permite que el sistema externo
tenga la última palabra sobre la creación del ducmento en Ágora.
Tanto si se acepta el documento como si se rechaza, la respuesta deberá ser tener como estado
200 OK.
En caso de que el documento sea rechazado, el cuerpo de la respuesta será:
{
"Status": "rejected",
"RejectReason": "No ha sido posible firmar la factura porque el impuesto aplicado
no es válido"
}
Donde:
- **Status** — Deberá ser el literal rejected para indicar que el documento es rechazado.
- **RejectReason** — Contendrá un texto libre que Ágora mostrará al usuario para indicar el motivo del rechazo.
- **Status** — Deberá ser el literal accepted para indicar que la factura es aceptada.
- **AdditionalData** — Contendrá un string, puede ser un objeto json o xml que desee el sistema externo, esta informació...
- **PrintData** — Contendrá un string con la información que se desea imprimir en el documento.

## Protocolo Pedidos Online

Protocolo de Integración de Pedidos
A la hora de crear pedidos, el sistema funciona de manera muy similar a las facturas, con la
excepción de que la propiedad donde se almacena la información es SalesOrder:
{
"Action": "Create",
"SalesOrder": {
// ... formato de la factura como se detalla en documentación de cómo
exportar pedidos.
}
}
En el caso de los pedidos, no sólo se notifica de la creación de los mismos, sino también de su
cancelación o de su eliminación.
Al cancelar un pedido, se envía la siguiente petición:
{
"Action": "Cancel",
"SalesOrder": {
// ... formato de la factura como se detalla en documentación de cómo
exportar pedidos.
}
}
En esta petición no se puede incluir información adicional en la respuesta. Tan sólo existe
para notificar al sistema externo de la cancelación del pedido, y permitirle aceptarla o
rechazarla.
Al eliminar un pedido, por ejemplo porque ha sido reabierto, se envía la siguiente petición:
{
"Action": "Delete",
"SalesOrder": {
// ... formato de la factura como se detalla en documentación de cómo
exportar pedidos.
}
}

En esta petición no se puede incluir información adicional en la respuesta. Tan sólo existe
para notificar al sistema externo de la eliminación del pedido, y permitirle aceptarla o
rechazarla.
Protocolo de Integración de Albaranes
A la hora de crear albaranes, el sistema funciona de manera muy similar a las facturas, con la
excepción de que la propiedad donde se almacena la información es DeliveryNote:
{
"Action": "Create",
"DeliveryNote": {
// ... formato de la factura como se detalla en documentación de cómo
exportar pedidos.
}
}
En el caso de los albaranes, además de su creación, se notifica su eliminación. Al eliminar un
albarán, por ejemplo porque ha sido reabierto, se envía la siguiente petición:
{
"Action": "Delete",
"DeliveryNote": {
// ... formato de la factura como se detalla en documentación de cómo
exportar pedidos.
}
}
En esta petición no se puede incluir información adicional en la respuesta. Tan sólo existe
para notificar al sistema externo de la eliminación del albarán, y permitirle aceptarla o
rechazarla.

## Integración Plataformas Reparto

Integración con Plataformas de Reparto
Ágora puede integrarse con plataformas externas de gestión de repartidores para delegar la
entrega de los pedidos de delivery.
Teniendo en cuenta que muchas instalaciones de Ágora son realizadas en equipos que no
disponen de una dirección IP fija o dominio, y que no siempre pueden ser accedidos desde
internet por encontrarse tras un router o firewall, todas las operaciones serán iniciadas desde
Ágora hacia el sistema de reparto.
El proceso de integración entre ambos sistemas se basa en dos operaciones: solicitar el
reparto de un pedido y cancelar el reparto de un pedido.
Ambas operaciones se indicarán al sistema de repartos mediante el envío de una petición POST a
una URL diferente configurable en Ágora. En cada URL se deberá incluir la información necesaria
para identificar el establecimiento dentro del sistema de repartos.
Por ejemplo, se podrían tener las siguientes URLs:
- Solicitud de reparto: https://riders.com/some-internal-id/request-pickup
- Cancelación de reparto: https://riders.com/some-internal-id/cancel-pickup
Donde some-internal-id se correspondería con el id del establecimiento en el sistema de
repartos.
Todas las peticiones y respuestas serán en formato JSON codificado en utf8. Esto se reflejará en
las cabeceras HTTP de las peticiones y respuestas. Adicionalmente, en las peticiones realizadas
con Ágora se enviará una cabecera Agora-Version para indicar la versión de Ágora que está
generando la petición.
Solicitud de reparto
Esta operación será invocada por Ágora cuando se necesite realizar un nuevo reparto. Ágora
enviará una petición POST a la url configurada a tal efecto con el siguiente formato:

{
"orderNumber": "P-102",
"deliveryAddress": {
"street": "C/ Río Duero, 24 1ºF",
"city": "Leganés",
"region": "Madrid",
"zipCode": "28913",
"lat": 40.335082,
"long": -3.7668787
},
"pickupTime": "2023-09-11T20:30:00",
"customerName": "Matías Delgado",
"customerPhone": "651112381",
"notes": "Entregar al conserje de la finca",
"orderTotal": 15.00,
"content": [
{ "product": "Hamburguesa doble c/ Queso, Bacon", "quantity": 1, "total":
7.50 },
{ "product": "Coca Cola sin hielo", "quantity": 2, "total": 5.60 }
]
}
En la petición se incluyen los siguientes campos:
- orderNumber (string): Número de pedido en Ágora.
- deliveryAddress: Direccion de entrega. A su vez, está desglosada en:
- street (string): Calle, número y piso.
- city (string): Población.
- region (string): Provincia.
- zipCode (string): Código postal.
- lat (number): Latitud.
- long (number): Longitud.
- pickupTime (string): Hora a la que se debe realizar la recogida. El formato es aaaa-
mm-ddThh:mm:ss y siempre se usa la hora local del establecimiento.
- customerName (string): Nombre del cliente al que se debe entregar el pedido.
- customerPhone (string): Teléfono del cliente al que se debe entregar el pedido.
- notes (string): Notas adicionales del pedido.
- orderTotal (number): Importe del pedido.
- content (array): Contenido del pedido. Cada elemento del array está formado por:
- product (string): descripción de la línea.

- quantity (number): cantidad pedida.
- total (number): total de la línea, con o sin impuestos, depende de la tarifa
usada.
La respuesta del sistema de repartos siempre debe tener código de estado 200 OK.
Si la petición es aceptada por el sistema de reparto, en el cuerpo de la respuesta se deberá
incluir la siguiente información:
{
"status": "accepted"
}
En caso de que el sistema no pueda atender el reparto, en el cuerpo de la respuesta se deberá
indicar el motivo:
{
"status": "rejected",
"reason": "No hay repartidores disponibles para atender esa dirección"
}
Cancelación de solicitud de reparto
En ocasiones puede ser necesario cancelar un reparto que todavía no ha sido recogido por el
repartidor. Para ello, Ágora enviará una petición POST a la URL configurada a tal efecto con el
siguiente formato:
{
"orderNumber": "P-120"
}
Donde orderNumber es el número de pedido cuyo reparto se desea cancelar.
La respuesta del sistema de repartos siempre debe tener código de estado 200 OK.
Si es posible cancelar la solicitud de reparto, en el cuerpo de la respuesta se deberá incluir la
siguiente información:

{
"status": "accepted"
}
En caso de que el sistema no pueda cancelar la solicitud de reparto, en el cuerpo de la
respuesta se deberá indicar el motivo:
{
"status": "rejected",
"reason": "El repartidor ya ha recogido el pedido"
}
Configuración de Urls
Está configuración de Urls se realiza en los usuarios de Ágora que estén configurado como
repartidores. Esto da la posibilidad de tener enlaces con distintas plataformas.

## Integración iFrame

Integración mediante IFrame
Ágora permite incrustar una aplicación web dentro de un iframe para ejecutar acciones
personalizadas desde dentro del propio TPV.
A través de la URL, la aplicación web cargada en el iframe puede recibir parámetros relativos al
estado actual del TPV. Cada parámetro se añade en la URL en base a los siguientes marcadores
de posición:
- user_id: id del usuario que invoca la acción.
- pos_id: id del punto de venta desde el que se invoca la acción.
- ticket_id: id del ticket cargado cuando se invoca la acción.
- ticket_global_id: id global del ticket cargado cuando se invoca la acción.
- ticket_line_index: índice de la línea seleccionada cuando se invoca la acción.
- introduced_value: valor introducido en el teclado numérico de la pantalla principal
cuando se invoca la acción.
Por ejemplo, se podría definir una URL de la forma https://some-server.com/
?user={user_id} que al ser invocada mostrase datos específicos para el usuario actual.
Además, Ágora ofrece un mecanismo para que la aplicación web cargada en el iframe pueda
interactuar con el TPV. Se basa en el API postMessage que facilita la comunicación entre webs
cargadas desde distintos dominios.
Para utilizarlo, desde la aplicación web cargada en el iframe se deben enviar mensajes a la
ventana padre usando window.parent.postMessage(...). Todos los mensajes enviados a
Ágora tienen una propiedad type que indica el tipo de operación a realizar, y parámetros
adicionales en base al tipo de operación.
En caso de que Ágora necesite devolver algún tipo de información a la aplicación web, lo hará
también enviando un mensaje, que podrá ser procesado en la aplicación web manejando el
evento message, con un manejador de la forma window.addEventListener('message', event
=> { ... }).
Para poder correlacionar las respuestas enviadas por Ágora con las peticiones enviadas por la
aplicación web, aquellas operaciones que pueden recibir una respuesta, incluyen en el mensaje
de petición un requestId que será reenviado por Ágora en la respuesta.
Este sistema, pese a la complejidad adicional que introduce, es necesario para garantizar la
comunicación entre distintos dominios de forma segura. No obstante, más adelante se incluye

un pequeño ejemplo de como generar un API sobre este sistema que expone la invocación de
las operaciones de una forma mucho más amigable basada en promesas.
Consideraciones de seguridad
Al enviar un mensaje, es posible limitar los posibles receptores usando la opción targetOrigin,
y al recibirlo, es posible validar el emisor a través de event.origin. Sin embargo, en el caso de
uso más común es complicado hacer esta validación de una forma flexible, a menos que la
aplicación conozca a priori el host (IP o nombre) del servidor de Ágora. Por ello, es frecuente
que la aplicación web cargada en el iframe evite toda comprobación al recibir mensajes, y
permita que cualquier host en el que esté incrustada los reciba, usando:
window.parent.postMessage(..., {sourceTarget: '*'})
Por su parte, Ágora validará que mensajes se reciben desde el host asociado a la URL
configurada en la acción personalizada, y enviará mensajes sólo a ese host. Por tanto, deberá
asegurarse de no realizar ninguna navegación dentro del iframe que implique un cambio de
host.
Operaciones disponibles
Existen varias operaciones que pueden ser invocadas a través del mecanismo descrito
anteriormente:
Cerrar la ventana
Permite cerrar el diálogo de Ágora en que está cargada la aplicación web, y aplicar el flujo
configurado en el TPV para distintas operaciones (cerrar un ticket, prepararlo, etc.).
Para invocar esta operación, desde la aplicación web hay que enviar el siguiente mensaje:
window.parent.postMessage({
type: 'agora:pos:close-window',
applyFlow: 'none'
}, { sourceTarget: '*'});
El tipo de mensaje deberá ser agora:pos:close-window, y la propiedad applyFlow podrá tomar
los siguientes valores en base al tipo de flujo a aplicar:
- none: cierra la ventana sin realizar ninguna acción adicional.

- updateTicket: cierra la ventana y recarga el ticket, sin realizar ninguna acción
adicional.
- afterClose: cierra la ventana y aplica la configuración del punto de venta con la acción
a realizar tras cerrar un ticket (mantener ubicación actual, cambiar de usuario o
cambiar de ubicación).
- afterPrint: cierra la ventana y aplica la configuración del punto de venta con la acción
a realizar tras imprimir un ticket (mantener ubicación actual, cambiar de usuario o
cambiar de ubicación).
- afterPrepare: cierra la ventana y aplica la configuración del punto de venta con la
acción a realizar tras preparar un ticket (mantener ubicación actual, cambiar de usuario
o cambiar de ubicación).
- afterOpenCashdrawer: cierra la ventana y aplica la configuración del punto de venta
con la acción a realizar tras abrir el cajón (mantener ubicación actual, cambiar de
usuario o cambiar de ubicación).
De esta forma, si desde la aplicación web se ha cerrado del ticket (por ejemplo, usando una
invocación al API HTTP como veremos más adelante), se puede indicar a Ágora que debe cerrar
la ventana y que el ticket ha sido cerrado, haciendo que la experiencia de usuario sea
completamente equivalente a haber cerrado el ticket desde el propio Ágora.
Invocar un del API HTTP
endpoint
Permite invocar cualquier endpoint definido por el API HTTP de Ágora. Esta invocación la
realizará directamente Ágora, por lo que se hará desde la misma red donde se está ejecutando
el punto de venta y, por tanto, no será necesario publicar puertos en internet o garantizar que
el servidor de Ágora dispone de una IP pública fija.
Para invocar esta operación, desde la aplicación web hay que enviar el siguiente mensaje:
window.parent.postMessage({
type: 'agora:pos:invoke-api',
endpoint: '/api/print'
apiToken: '123456',
requestId: 'some-random-request-id',
body: {
PrinterName: 'PR80',
Format: 'plain',
Data: '\n\n\nTEXTO A IMPRIMIR EN LA IMPRESORA PR80'
}
}, { targetOrigin: '*' });

El tipo de mensaje deberá ser agora:pos:invoke-api y el resto de parámetros son:
- endpoint del API HTTP de Ágora que se desea invocar. No se debe incluir la dirección
o el puerto del servidor, puesto que la invocación la realizará el propio TPV Web.
- apiToken configurado en los servicios de integración de Ágora.
- requestId con un identificador único de la petición. Como se ha indicado
anteriormente, Ágora enviará un mensaje al iframe usando ese identificador con el
resultado de la invocación al API para poder correlacionar peticiones y respuestas.
- body con el cuerpo de la petición. Puede ser una cadena de texto, o un objeto. En el
caso de ser un objeto, se serializará usando JSON.stringify para obtener el cuerpo de
la petición al API HTTP.
La respuesta de la invocación al API HTTP será enviada por Ágora a través de un mensaje al
iframe. Se puede capturar manejando el evento message:
window.addEventListener('message', ({data}) => {
if (data.error) {
// Something bad happened
}
else {
const response = data.response;
}
});
En la propiedad data del evento recibido existen las siguientes propiedades:
- error: contiene el error devuelto por el servidor de Ágora al realizar la invocación. Si la
invocación se ha completado con éxito, error sera falsy.
- response: contiene la respuesta del servidor de Ágora al realizar la invocación.
Dependiendo del API invocada, este valor puede ser una cadena de texto, o un objeto.
Consulte las distintas APIs disponibles para obtener más detalles sobre el contenido
de la respuesta.
Ejemplo de API de alto nivel
Hasta ahora se ha explicado el funcionamiento de las APIs de interacción entre Ágora y la
aplicación web cargada en el iframe usando postMessage. Sobre este API de bajo nivel, es
posible construir APIs con un mayor nivel de abstracción que faciliten su uso.
A continuación se muestra un ejemplo basado en promesas para encapsular el paso de
mensajes.

/**
* Simple wrapper around the low-level postMessage API between Ágora and a webapp.
*
* In a real world app, this wrapper would be in its own file/module
* (depending on your bundling preferences), and it could be
* a class, an object, or just a couple of exported functions.
*/
const agoraInterop = {
/**
* Closes the window and applies and specific flow after closing it.
* @param { 'none' | 'afterPrepare' | 'afterClose'
* | 'afterPrint' | 'afterOpenCashdrawer'} actionFlow
* @returns {void}
*/
closeWindow(applyFlow) {
window.parent.postMessage({
type: 'agora:pos:close-window',
applyFlow
}, { targetOrigin: '*' });
},
/**
* Invokes an HTTP API endpoint.
*
* @param {Object} args - The arguments for the API invocation.
* @property {string} args.endpoint - The API endpoint. For example:
* - '/api/print'
* - '/api/export-master/?filter=users'
* @property {string} args.apiToken - The API token configured in Ágora.
* @property {string | object} args.body - The request body. It can be a
* string or an object. If it's an object, it will be JSON.stringified.
* Defaults to an empty string.
* @property {number} args.timeout - The timeout for the API request in
* milliseconds. Defaults to 60 seconds.
* @returns {Promise} A promise that will be:
* - Resolved with JSON.parse of the server response if the server
* returned a 200 status and Content-Type = application/json.
* - Resolved with the raw content of the server response if the server
* returned a 200 status and Content-Type = text/plain.
* - Rejected with an {Error} otherwise. An error description will be
* included in {Error.message}.
*/
async invokeApi({
endpoint,
apiToken,
body = '',
timeout = 60_000
}) {
const requestId =
new Date().getTime().toString() + (Math.random() * 1000).toString();

return new Promise((resolve, reject) => {
const timeoutId = setTimeout(() => {
failed('Request timed out');
}, timeout);
function cleanup() {
window.removeEventListener('message', onMessage);
clearTimeout(timeoutId);
}
function failed(errorMessage) {
cleanup();
reject(new Error(errorMessage));
}
function completed(response) {
cleanup();
resolve(response);
}
const onMessage = ({ data }) => {
if (data.requestId !== requestId)
return;
data.error ? failed(data.error) : completed(data.response);
};
window.addEventListener('message', onMessage);
window.parent.postMessage({
type: 'agora:pos:invoke-api',
endpoint,
apiToken,
requestId,
body
}, { targetOrigin: '*' });
});
}
};
Utilizando un wrapper de este estilo, la invocación de las distintas operaciones resulta más
sencilla:

// Cerrar la ventana
agoraInterop.closeWindow('afterClose');
// Invocar el API de exportación de usuarios
const {Users} = await agoraInterop.invoke({
endpoint: '/api/export-master?filter=users',
apiToken: '123456',
})
for (const user of Users) {
console.log(`${user.Name} - ${user.Profile}`);
}
// Invocación del API de impresión controlando posibles errores
try {
await agoraInterop.invokeApi({
endpoint: '/api/print',
apiToken: '123456',
body: {
PrinterName: 'PR80',
Format: 'plain',
Data: '\n\nTexto a imprimir\n\n\n'
}
})
}
catch (error) {
// Gestionar posibles errores durante la impresión,
// por ejemplo, que la impresora no exista
alert(`Ha ocurrido un error al imprimir: ${error.message}`);
}
