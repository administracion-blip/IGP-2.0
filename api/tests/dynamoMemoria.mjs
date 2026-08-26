/**
 * Doble en memoria de DynamoDB para las pruebas.
 *
 * No es un emulador completo: cubre el subconjunto que usan los módulos de
 * facturación, pero **de verdad**, no de mentira. Interpreta de forma literal
 * `ConditionExpression`, `FilterExpression`, `KeyConditionExpression`,
 * `ProjectionExpression` y `UpdateExpression`, porque lo que se quiere probar es
 * precisamente eso: que la escritura condicional que impide facturar dos veces
 * un pedido falla cuando tiene que fallar. Un doble que ignorase las condiciones
 * daría por buenas todas las pruebas de concurrencia sin comprobar nada.
 *
 * Dos detalles importantes que imitan al servicio real y suelen esconder bugs:
 * el `ProjectionExpression` recorta de verdad los atributos devueltos (si el
 * código lee un campo que no proyectó, aquí se ve), y las consultas paginan si
 * se pide un tamaño de página (si un bucle `do/while` está mal, aquí se ve).
 */

import { strict as assert } from 'node:assert';

// ─── Expresiones ───

const FUNCIONES = new Set(['attribute_exists', 'attribute_not_exists', 'begins_with', 'contains']);

function tokenizar(expr) {
  const tokens = [];
  const re = /\s*(<=|>=|<>|=|<|>|\(|\)|,|\.|\[\d+\]|[#:]?[A-Za-z_][A-Za-z0-9_]*)/y;
  let i = 0;
  while (i < expr.length) {
    re.lastIndex = i;
    const m = re.exec(expr);
    if (!m) {
      if (expr.slice(i).trim() === '') break;
      throw new Error(`No se entiende la expresión a partir de: ${expr.slice(i)}`);
    }
    tokens.push(m[1]);
    i = re.lastIndex;
  }
  return tokens;
}

/** Analizador descendente recursivo del subconjunto de expresiones soportado. */
function analizar(tokens) {
  let pos = 0;
  const mirar = () => tokens[pos];
  const comer = (t) => {
    if (t !== undefined && tokens[pos] !== t) {
      throw new Error(`Se esperaba "${t}" y hay "${tokens[pos]}"`);
    }
    return tokens[pos++];
  };
  function ruta() {
    const partes = [comer()];
    while (mirar() === '.') {
      comer('.');
      partes.push(comer());
    }
    return { tipo: 'ruta', partes };
  }

  function operando() {
    const t = mirar();
    if (t?.startsWith(':')) return { tipo: 'valor', nombre: comer() };
    return ruta();
  }

  function primaria() {
    const t = mirar();
    if (t === '(') {
      comer('(');
      const nodo = expresionOr();
      comer(')');
      return nodo;
    }
    if (t?.toUpperCase?.() === 'NOT') {
      comer();
      return { tipo: 'not', hijo: primaria() };
    }
    if (FUNCIONES.has(t) && tokens[pos + 1] === '(') {
      const nombre = comer();
      comer('(');
      const args = [operando()];
      while (mirar() === ',') {
        comer(',');
        args.push(operando());
      }
      comer(')');
      return { tipo: 'funcion', nombre, args };
    }
    const izq = operando();
    const op = mirar();
    if (op?.toUpperCase?.() === 'BETWEEN') {
      comer();
      const desde = operando();
      comer('AND');
      const hasta = operando();
      return { tipo: 'between', izq, desde, hasta };
    }
    if (['=', '<>', '<', '<=', '>', '>='].includes(op)) {
      comer();
      return { tipo: 'comparacion', op, izq, der: operando() };
    }
    throw new Error(`Operador no soportado: "${op}"`);
  }

  function expresionAnd() {
    let nodo = primaria();
    while (mirar()?.toUpperCase?.() === 'AND') {
      comer();
      nodo = { tipo: 'and', izq: nodo, der: primaria() };
    }
    return nodo;
  }

  function expresionOr() {
    let nodo = expresionAnd();
    while (mirar()?.toUpperCase?.() === 'OR') {
      comer();
      nodo = { tipo: 'or', izq: nodo, der: expresionAnd() };
    }
    return nodo;
  }

  const raiz = expresionOr();
  if (pos !== tokens.length) throw new Error(`Sobra "${tokens.slice(pos).join(' ')}" en la expresión`);
  return raiz;
}

function resolverNombre(parte, nombres) {
  if (!parte.startsWith('#')) return parte;
  const real = nombres?.[parte];
  if (real === undefined) throw new Error(`Falta ${parte} en ExpressionAttributeNames`);
  return real;
}

function leerRuta(item, nodo, nombres) {
  let actual = item;
  for (const parte of nodo.partes) {
    if (actual == null || typeof actual !== 'object') return undefined;
    actual = actual[resolverNombre(parte, nombres)];
  }
  return actual;
}

function valorDe(nodo, item, { nombres, valores }) {
  if (nodo.tipo === 'valor') {
    if (!(nodo.nombre in (valores ?? {}))) {
      throw new Error(`Falta ${nodo.nombre} en ExpressionAttributeValues`);
    }
    return valores[nodo.nombre];
  }
  return leerRuta(item, nodo, nombres);
}

/** Comparación con la semántica de DynamoDB: tipos distintos no son comparables. */
function comparar(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : a < b ? -1 : 1;
  return NaN;
}

function evaluar(nodo, item, ctx) {
  switch (nodo.tipo) {
    case 'and':
      return evaluar(nodo.izq, item, ctx) && evaluar(nodo.der, item, ctx);
    case 'or':
      return evaluar(nodo.izq, item, ctx) || evaluar(nodo.der, item, ctx);
    case 'not':
      return !evaluar(nodo.hijo, item, ctx);
    case 'funcion': {
      const [primero, segundo] = nodo.args;
      if (nodo.nombre === 'attribute_exists') return leerRuta(item, primero, ctx.nombres) !== undefined;
      if (nodo.nombre === 'attribute_not_exists') return leerRuta(item, primero, ctx.nombres) === undefined;
      if (nodo.nombre === 'begins_with') {
        const v = leerRuta(item, primero, ctx.nombres);
        const p = valorDe(segundo, item, ctx);
        return typeof v === 'string' && typeof p === 'string' && v.startsWith(p);
      }
      if (nodo.nombre === 'contains') {
        const v = leerRuta(item, primero, ctx.nombres);
        const p = valorDe(segundo, item, ctx);
        if (Array.isArray(v)) return v.includes(p);
        return typeof v === 'string' && typeof p === 'string' && v.includes(p);
      }
      throw new Error(`Función no soportada por el doble: ${nodo.nombre}`);
    }
    case 'between': {
      const v = valorDe(nodo.izq, item, ctx);
      const c1 = comparar(v, valorDe(nodo.desde, item, ctx));
      const c2 = comparar(v, valorDe(nodo.hasta, item, ctx));
      return Number.isNaN(c1) || Number.isNaN(c2) ? false : c1 >= 0 && c2 <= 0;
    }
    case 'comparacion': {
      const a = valorDe(nodo.izq, item, ctx);
      const b = valorDe(nodo.der, item, ctx);
      // Un atributo ausente no cumple ninguna comparación, ni siquiera "<>".
      if (a === undefined || b === undefined) return false;
      const c = comparar(a, b);
      if (Number.isNaN(c)) return nodo.op === '<>';
      switch (nodo.op) {
        case '=':
          return c === 0;
        case '<>':
          return c !== 0;
        case '<':
          return c < 0;
        case '<=':
          return c <= 0;
        case '>':
          return c > 0;
        case '>=':
          return c >= 0;
        default:
          throw new Error(`Operador no soportado: ${nodo.op}`);
      }
    }
    default:
      throw new Error(`Nodo no soportado: ${nodo.tipo}`);
  }
}

const cacheExpresiones = new Map();
function compilar(expr) {
  let nodo = cacheExpresiones.get(expr);
  if (!nodo) {
    nodo = analizar(tokenizar(expr));
    cacheExpresiones.set(expr, nodo);
  }
  return nodo;
}

function cumple(expr, item, nombres, valores) {
  if (!expr) return true;
  return evaluar(compilar(expr), item ?? {}, { nombres, valores });
}

/** Aplica el ProjectionExpression: lo que no se proyecta, no vuelve. */
function proyectar(item, projection, nombres) {
  if (!projection) return item;
  const salida = {};
  for (const bruto of projection.split(',')) {
    const partes = bruto.trim().split('.');
    if (partes.length === 1) {
      const nombre = resolverNombre(partes[0], nombres);
      if (item[nombre] !== undefined) salida[nombre] = item[nombre];
    } else {
      // Proyección anidada: no la usa ningún módulo de facturación.
      throw new Error('El doble no soporta proyecciones anidadas');
    }
  }
  return salida;
}

// ─── Update ───

function partirUpdate(expr) {
  const secciones = { SET: '', REMOVE: '', ADD: '', DELETE: '' };
  const re = /\b(SET|REMOVE|ADD|DELETE)\b/gi;
  const cortes = [];
  let m;
  while ((m = re.exec(expr)) !== null) {
    cortes.push({ clave: m[1].toUpperCase(), inicio: m.index, desde: m.index + m[0].length });
  }
  for (let i = 0; i < cortes.length; i += 1) {
    const hasta = i + 1 < cortes.length ? cortes[i + 1].inicio : expr.length;
    secciones[cortes[i].clave] = expr.slice(cortes[i].desde, hasta).trim();
  }
  return secciones;
}

/** Separa por comas de primer nivel (respetando los paréntesis de if_not_exists). */
function partirComas(texto) {
  const partes = [];
  let nivel = 0;
  let actual = '';
  for (const c of texto) {
    if (c === '(') nivel += 1;
    if (c === ')') nivel -= 1;
    if (c === ',' && nivel === 0) {
      partes.push(actual.trim());
      actual = '';
    } else {
      actual += c;
    }
  }
  if (actual.trim() !== '') partes.push(actual.trim());
  return partes;
}

function aplicarUpdate(item, expr, nombres, valores) {
  const secciones = partirUpdate(expr);
  const tocados = {};
  const leerValor = (token) => {
    const t = token.trim();
    if (t.startsWith(':')) {
      if (!(t in (valores ?? {}))) throw new Error(`Falta ${t} en ExpressionAttributeValues`);
      return valores[t];
    }
    return item[resolverNombre(t, nombres)];
  };

  for (const asignacion of partirComas(secciones.SET)) {
    const [rutaBruta, ...resto] = asignacion.split('=');
    const destino = resolverNombre(rutaBruta.trim(), nombres);
    const fuente = resto.join('=').trim();
    let valor;
    const siNoExiste = fuente.match(/^if_not_exists\(\s*([^,\s]+)\s*,\s*(:[A-Za-z0-9_]+)\s*\)$/);
    const aritmetica = fuente.match(/^(\S+)\s*([+-])\s*(\S+)$/);
    if (siNoExiste) {
      const actual = item[resolverNombre(siNoExiste[1], nombres)];
      valor = actual === undefined ? leerValor(siNoExiste[2]) : actual;
    } else if (aritmetica) {
      const a = Number(leerValor(aritmetica[1]) ?? 0);
      const b = Number(leerValor(aritmetica[3]) ?? 0);
      valor = aritmetica[2] === '+' ? a + b : a - b;
    } else {
      valor = leerValor(fuente);
    }
    item[destino] = valor;
    tocados[destino] = valor;
  }

  for (const rutaBruta of partirComas(secciones.REMOVE)) {
    delete item[resolverNombre(rutaBruta.trim(), nombres)];
  }

  for (const suma of partirComas(secciones.ADD)) {
    const [rutaBruta, valorBruto] = suma.split(/\s+/);
    const destino = resolverNombre(rutaBruta.trim(), nombres);
    const incremento = Number(leerValor(valorBruto));
    if (!Number.isFinite(incremento)) throw new Error('El doble solo soporta ADD numérico');
    item[destino] = Number(item[destino] ?? 0) + incremento;
    tocados[destino] = item[destino];
  }

  if (secciones.DELETE) throw new Error('El doble no soporta DELETE en UpdateExpression');
  return tocados;
}

// ─── Tablas ───

function errorCondicion() {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

/**
 * @param {{ paginaTam?: number }} opciones `paginaTam` fuerza la paginación de
 *   Scan y Query para ejercitar los bucles `do/while` de los módulos.
 */
export function crearDynamoMemoria({ paginaTam = 0 } = {}) {
  const tablas = new Map();
  /** Registro de operaciones, para poder afirmar sobre lo que se escribió. */
  const operaciones = [];
  /** Ganchos por tabla y operación, para simular carreras y fallos. */
  const gatillos = [];

  function tabla(nombre) {
    const t = tablas.get(nombre);
    if (!t) throw new Error(`Tabla no creada en el doble: ${nombre}`);
    return t;
  }

  function claveDe(t, item) {
    const partes = [item[t.esquema.hashKey]];
    if (t.esquema.rangeKey) partes.push(item[t.esquema.rangeKey]);
    if (partes.some((p) => p === undefined || p === null)) {
      throw new Error(`Ítem sin clave completa para ${t.nombre}: ${JSON.stringify(partes)}`);
    }
    return JSON.stringify(partes);
  }

  /**
   * Esquema de claves con el que se resuelve una consulta: el de la tabla, o el del
   * índice secundario si se pide uno.
   */
  function esquemaConsulta(t, indexName) {
    if (!indexName) {
      return { hashKey: t.esquema.hashKey, rangeKey: t.esquema.rangeKey, proyeccion: 'ALL' };
    }
    const idx = (t.esquema.indices || {})[indexName];
    if (!idx) {
      throw new Error(
        `Índice no creado en el doble: ${indexName} (tabla ${t.nombre}). ` +
          'Decláralo en crearTabla con { indices: { "<nombre>": { hashKey, rangeKey, proyeccion } } }',
      );
    }
    return { hashKey: idx.hashKey, rangeKey: idx.rangeKey, proyeccion: idx.proyeccion || 'ALL' };
  }

  /**
   * Un GSI solo contiene los ítems que llevan sus atributos de clave. Es lo que hace
   * que `Responsable-Vencimiento-index` tenga solo tareas abiertas: el escritor borra
   * `vencimiento_orden` al cerrarlas y DynamoDB las saca del índice. Sin simular esto,
   * las pruebas darían por bueno un código que en producción lee tareas cerradas.
   */
  function enIndice(item, esq) {
    if (item[esq.hashKey] === undefined || item[esq.hashKey] === null) return false;
    if (esq.rangeKey && (item[esq.rangeKey] === undefined || item[esq.rangeKey] === null)) {
      return false;
    }
    return true;
  }

  /** Como DynamoDB: la clave de continuación de un índice lleva también las de la tabla. */
  function claveContinuacion(t, esq, item) {
    const clave = { [t.esquema.hashKey]: item[t.esquema.hashKey] };
    if (t.esquema.rangeKey) clave[t.esquema.rangeKey] = item[t.esquema.rangeKey];
    if (esq.hashKey !== t.esquema.hashKey) clave[esq.hashKey] = item[esq.hashKey];
    if (esq.rangeKey && esq.rangeKey !== t.esquema.rangeKey) {
      clave[esq.rangeKey] = item[esq.rangeKey];
    }
    return clave;
  }

  /** Proyección `KEYS_ONLY`: claves de la tabla y del índice, nada más. */
  function soloClaves(t, esq, item) {
    return claveContinuacion(t, esq, item);
  }

  function paginar(lista, exclusiveStartKey, t, esq = t.esquema) {
    if (!paginaTam) return { pagina: lista, ultima: null };
    let desde = 0;
    if (exclusiveStartKey) {
      // La coincidencia va por la clave de la tabla, que es única, aunque la consulta
      // sea por índice: la clave de continuación siempre la incluye.
      const clave = claveDe(t, exclusiveStartKey);
      desde = lista.findIndex((it) => claveDe(t, it) === clave) + 1;
    }
    const pagina = lista.slice(desde, desde + paginaTam);
    const hayMas = desde + paginaTam < lista.length;
    const ultimo = pagina[pagina.length - 1];
    const ultima = hayMas && ultimo ? claveContinuacion(t, esq, ultimo) : null;
    return { pagina, ultima };
  }

  async function dispararGatillos(operacion, entrada) {
    for (const g of gatillos) {
      if (g.tabla !== entrada.TableName || g.operacion !== operacion) continue;
      if (g.usado) continue;
      g.usado = true;
      await g.accion(entrada);
    }
  }

  const api = {
    /**
     * Da de alta una tabla con su esquema de clave y, si los tiene, sus índices
     * secundarios:
     *
     * ```js
     * crearTabla('Igp_Tareas', {
     *   hashKey: 'PK',
     *   rangeKey: 'SK',
     *   indices: {
     *     'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'sk_proyecto' },
     *     'Vinculo-index': { hashKey: 'vinculo_clave', rangeKey: 'PK', proyeccion: 'KEYS_ONLY' },
     *   },
     * });
     * ```
     */
    crearTabla(nombre, esquema, items = []) {
      assert.ok(esquema?.hashKey, 'La tabla necesita hashKey');
      for (const [nombreIdx, idx] of Object.entries(esquema.indices || {})) {
        assert.ok(idx?.hashKey, `El índice ${nombreIdx} necesita hashKey`);
      }
      tablas.set(nombre, { nombre, esquema, items: new Map() });
      for (const it of items) api.sembrar(nombre, it);
      return api;
    },
    /** Inserta sin pasar por condiciones ni registro de operaciones. */
    sembrar(nombre, item) {
      const t = tabla(nombre);
      t.items.set(claveDe(t, item), structuredClone(item));
      return api;
    },
    /** Todos los ítems de una tabla, en orden de inserción. */
    listar(nombre) {
      return [...tabla(nombre).items.values()].map((it) => structuredClone(it));
    },
    obtener(nombre, clave) {
      const t = tabla(nombre);
      const it = t.items.get(claveDe(t, clave));
      return it ? structuredClone(it) : null;
    },
    operaciones,
    /**
     * Ejecuta `accion` justo antes de la primera operación que coincida, para
     * simular que otro proceso se adelanta entre la lectura y la escritura.
     */
    interceptar(operacion, nombreTabla, accion) {
      gatillos.push({ operacion, tabla: nombreTabla, accion, usado: false });
      return api;
    },

    /** Sustituye `send` en el cliente de documentos y en el cliente base. */
    instalar(docClient, client) {
      docClient.send = (cmd) => api.enviar(cmd);
      if (client) {
        client.send = (cmd) => {
          const nombre = cmd?.constructor?.name;
          if (nombre !== 'DescribeTableCommand') {
            throw new Error(`El doble no soporta ${nombre} en el cliente base`);
          }
          const t = tabla(cmd.input.TableName);
          return Promise.resolve({
            Table: {
              KeySchema: [
                { AttributeName: t.esquema.hashKey, KeyType: 'HASH' },
                ...(t.esquema.rangeKey ? [{ AttributeName: t.esquema.rangeKey, KeyType: 'RANGE' }] : []),
              ],
            },
          });
        };
      }
      return api;
    },

    async enviar(cmd) {
      const tipo = cmd?.constructor?.name;
      const e = cmd.input;

      if (tipo === 'TransactWriteCommand') {
        operaciones.push({ tipo, tabla: null });
        await dispararGatillos(tipo, e);
        // Secuencial: el doble no simula atomicidad real, pero sí los Puts/Deletes
        // que usan compensación y aplicación de exceso en las pruebas.
        for (const item of e.TransactItems || []) {
          if (item.Put) {
            await api.enviar({ constructor: { name: 'PutCommand' }, input: item.Put });
          } else if (item.Delete) {
            await api.enviar({ constructor: { name: 'DeleteCommand' }, input: item.Delete });
          } else if (item.Update) {
            await api.enviar({ constructor: { name: 'UpdateCommand' }, input: item.Update });
          } else {
            throw new Error('El doble solo soporta Put/Delete/Update en TransactWrite');
          }
        }
        return {};
      }

      if (tipo === 'BatchWriteCommand') {
        const peticiones = Object.entries(e.RequestItems || {});
        const total = peticiones.reduce((n, [, lista]) => n + (lista || []).length, 0);
        operaciones.push({ tipo, tabla: null, peticiones: total });
        await dispararGatillos(tipo, e);
        for (const [nombreTabla, lista] of peticiones) {
          for (const p of lista || []) {
            if (p.PutRequest) {
              await api.enviar({
                constructor: { name: 'PutCommand' },
                input: { TableName: nombreTabla, Item: p.PutRequest.Item },
              });
            } else if (p.DeleteRequest) {
              await api.enviar({
                constructor: { name: 'DeleteCommand' },
                input: { TableName: nombreTabla, Key: p.DeleteRequest.Key },
              });
            } else {
              throw new Error('El doble solo soporta Put/Delete en BatchWrite');
            }
          }
        }
        // El doble nunca deja elementos sin procesar: no simula throttling. Para
        // ejercitar el reintento, usa `interceptar('BatchWriteCommand', …)`.
        return { UnprocessedItems: {} };
      }

      if (tipo === 'BatchGetCommand') {
        const peticiones = Object.entries(e.RequestItems || {});
        // `claves` deja afirmar que una resolución en lote es una sola lectura y
        // no una por fila.
        const claves = peticiones.reduce((n, [, p]) => n + (p.Keys || []).length, 0);
        operaciones.push({ tipo, tabla: null, claves });
        await dispararGatillos(tipo, e);
        const Responses = {};
        for (const [nombreTabla, peticion] of peticiones) {
          const t = tabla(nombreTabla);
          Responses[nombreTabla] = (peticion.Keys || [])
            .map((clave) => t.items.get(claveDe(t, clave)))
            .filter(Boolean)
            .map((it) =>
              proyectar(
                structuredClone(it),
                peticion.ProjectionExpression,
                peticion.ExpressionAttributeNames,
              ),
            );
        }
        // El doble nunca deja claves sin procesar: no simula el throttling real.
        return { Responses, UnprocessedKeys: {} };
      }

      operaciones.push({ tipo, tabla: e.TableName });
      await dispararGatillos(tipo, e);
      const t = tabla(e.TableName);
      const nombres = e.ExpressionAttributeNames;
      const valores = e.ExpressionAttributeValues;

      switch (tipo) {
        case 'GetCommand': {
          const it = t.items.get(claveDe(t, e.Key));
          return { Item: it ? proyectar(structuredClone(it), e.ProjectionExpression, nombres) : undefined };
        }
        case 'PutCommand': {
          const clave = claveDe(t, e.Item);
          const previo = t.items.get(clave);
          if (!cumple(e.ConditionExpression, previo, nombres, valores)) throw errorCondicion();
          t.items.set(clave, structuredClone(e.Item));
          return {};
        }
        case 'DeleteCommand': {
          const clave = claveDe(t, e.Key);
          const previo = t.items.get(clave);
          if (!cumple(e.ConditionExpression, previo, nombres, valores)) throw errorCondicion();
          t.items.delete(clave);
          return {};
        }
        case 'UpdateCommand': {
          const clave = claveDe(t, e.Key);
          const previo = t.items.get(clave);
          if (!cumple(e.ConditionExpression, previo, nombres, valores)) throw errorCondicion();
          // Un Update sobre un ítem inexistente lo crea con su clave.
          const item = previo ? structuredClone(previo) : { ...structuredClone(e.Key) };
          const tocados = aplicarUpdate(item, e.UpdateExpression, nombres, valores);
          t.items.set(clave, item);
          if (e.ReturnValues === 'UPDATED_NEW') return { Attributes: tocados };
          if (e.ReturnValues === 'ALL_NEW') return { Attributes: structuredClone(item) };
          return {};
        }
        case 'ScanCommand': {
          if (e.IndexName) throw new Error('El doble no soporta índices secundarios');
          const todos = [...t.items.values()];
          const { pagina, ultima } = paginar(todos, e.ExclusiveStartKey, t);
          const items = pagina
            .filter((it) => cumple(e.FilterExpression, it, nombres, valores))
            .map((it) => proyectar(structuredClone(it), e.ProjectionExpression, nombres));
          return { Items: items, ...(ultima && { LastEvaluatedKey: ultima }) };
        }
        case 'QueryCommand': {
          const esq = esquemaConsulta(t, e.IndexName);
          const clave = compilar(e.KeyConditionExpression);
          const coincidentes = [...t.items.values()]
            .filter((it) => (e.IndexName ? enIndice(it, esq) : true))
            .filter((it) => evaluar(clave, it, { nombres, valores }))
            .sort((a, b) => {
              const rk = esq.rangeKey;
              if (!rk) return 0;
              const c = comparar(a[rk], b[rk]);
              return Number.isNaN(c) ? 0 : c;
            });
          const ordenados = e.ScanIndexForward === false ? coincidentes.reverse() : coincidentes;
          const { pagina, ultima } = paginar(ordenados, e.ExclusiveStartKey, t, esq);
          const items = pagina
            .filter((it) => cumple(e.FilterExpression, it, nombres, valores))
            .map((it) =>
              esq.proyeccion === 'KEYS_ONLY'
                ? soloClaves(t, esq, it)
                : proyectar(structuredClone(it), e.ProjectionExpression, nombres),
            );
          return { Items: items, ...(ultima && { LastEvaluatedKey: ultima }) };
        }
        default:
          throw new Error(`El doble no soporta ${tipo}`);
      }
    },
  };

  return api;
}
