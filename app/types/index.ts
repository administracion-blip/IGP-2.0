/** Registro genérico de DynamoDB donde los valores pueden ser string, number o undefined. */
export type DynamoRecord = Record<string, string | number | undefined>;

export type Pedido = DynamoRecord;
export type Local = DynamoRecord;
export type Almacen = DynamoRecord;
export type Empresa = DynamoRecord;
