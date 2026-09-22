/* /api/tandas — lo calculado para el almacén.
 *
 * Esto es lo que mata el enlace de 5.152 caracteres que WhatsApp partía.
 * La extensión manda el mismo objeto que antes metía detrás de la almohadilla,
 * y app-recogida lo pide por su cuenta.
 *
 *   POST  { dia?, directo?, titulo?, datos }   token de escritura
 *   GET   ?d=CODIGO&dia=YYYY-MM-DD             código de lectura
 *
 * Una fila por JUEGO: la extensión recalcula todas las tandas cada vez y vuelve
 * a mandar el conjunto entero, así que sustituir es lo correcto. Si se
 * añadiera en vez de sustituir, quedarían tandas fantasma de un análisis viejo.
 *
 * ANTES ERA UNA FILA POR DÍA, y esa era la raíz de casi todo: solo cabía un
 * juego de tarjetas al día, así que Holanda pisaba a España y hubo que aparcar
 * los juegos en fechas falsas (26, 28 de septiembre) para que convivieran. Y un
 * directo que cruzaba la medianoche se partía en dos aunque fuera el mismo.
 *
 * El juego es la sesión de recogida: lo que sale de un paso 2. Lleva su código
 * —`es-2026-09-08`, `nl-2026-09-08`— y el país va dentro. La fecha se queda
 * como dato y como desempate, ya no como llave.
 *
 * SIN JUEGO SE USA LA FECHA, que es lo que el juego era hasta hoy. Así los
 * enlaces de antes y los móviles con la página en caché siguen funcionando.
 */
const { db, puerta, puedeEscribir, puedeLeer, noAutorizado, diaDe, aTexto, cuerpo } = require('./_lib');

/* ===========================================================================
 * LO QUE EL ALMACÉN DICE QUE ES CADA PRENDA
 * ===========================================================================
 * Vive aquí dentro y no en su propio fichero a propósito: Vercel solo deja un
 * número limitado de funciones en este plan y ya están todas gastadas. El
 * primer intento fue /api/marcado y el despliegue entero se cayó, con lo que
 * eso significa: el almacén sin app. Así que va de polízon en el sitio donde
 * ya viven las tandas, que además es de lo que habla.
 *
 *   GET  ?d=CODIGO&juego=es-2026-09-21&marcas=1
 *        -> { ok, hay, juego, marcas: { "p1.15": "camisa", ... } }
 *   POST ?d=CODIGO   { juego, marcas: { "p1.15": "camisa", "p2.7": null } }
 *        -> une lo que llega con lo que ya había y devuelve el conjunto
 *
 * POR QUÉ EXISTE. 20 sep 2026: lo marcado vivía en el navegador del móvil y
 * Aaron perdió dos tandas enteras ya hechas al salirse de la app. Marcar 190
 * prendas es una hora larga de trabajo de alguien; eso no puede depender de
 * que nadie cierre una pestaña.
 *
 * LA LLAVE ES EL PERCHERO Y EL NÚMERO -p1.15-, no la posición en la lista.
 * Cada paso 2 rehace las tandas y las tarjetas cambian de sitio; con la
 * posición, volver a imprimir habría movido lo marcado a prendas que no son.
 *
 * SE ESCRIBE CON EL CÓDIGO DE LECTURA, a propósito. Los móviles del almacén
 * solo llevan ese código y el de escritura no sale de la extensión. Esto es lo
 * único que pueden escribir: una categoría por prenda. No mueve pedidos, no
 * crea etiquetas y no toca nada de TikTok.
 * ========================================================================= */
async function tablaDeMarcas(s) {
  await s`
    create table if not exists marcado (
      juego  text primary key,
      marcas jsonb not null default '{}'::jsonb,
      cuando timestamptz not null default now()
    )`;
}

const sinNulos = (o) => {
  const r = {};
  for (const k of Object.keys(o || {})) if (o[k] !== null) r[k] = o[k];
  return r;
};

async function leerMarcas(s, res, juego) {
  if (!juego) return res.status(400).json({ ok: false, error: 'sin-juego' });
  await tablaDeMarcas(s);
  const filas = await s`select marcas, cuando from marcado where juego = ${juego}`;
  if (!filas.length) return res.status(200).json({ ok: true, hay: false, juego, marcas: {} });
  return res.status(200).json({ ok: true, hay: true, juego,
    marcas: sinNulos(filas[0].marcas), cuando: filas[0].cuando });
}

async function guardarMarcas(s, res, juego, entran) {
  if (!juego) return res.status(400).json({ ok: false, error: 'sin-juego' });
  await tablaDeMarcas(s);

  /* Solo llaves y valores con pinta de lo que son. Una llave es
   * "perchero.numero" y un valor es el nombre corto de una categoría, o nulo
   * para quitar la marca. Nada más entra en la tabla. */
  const limpio = {};
  let n = 0;
  for (const k of Object.keys(entran)) {
    if (n >= 5000) break;
    if (!/^p[0-9]{1,2}\.[0-9]{1,5}$/.test(k)) continue;
    const v = entran[k];
    if (v === null || v === '') { limpio[k] = null; n++; continue; }
    if (typeof v !== 'string' || !/^[a-z]{2,20}$/.test(v)) continue;
    limpio[k] = v; n++;
  }
  if (!Object.keys(limpio).length) return res.status(400).json({ ok: false, error: 'nada-valido' });

  /* `||` en jsonb es unir: lo que llega gana llave a llave y lo que no venía
   * se queda como estaba, así dos móviles marcando a la vez no se pisan. */
  const [f] = await s`
    insert into marcado (juego, marcas, cuando)
    values (${juego}, ${s.json(limpio)}, now())
    on conflict (juego) do update set
      marcas = jsonb_strip_nulls(marcado.marcas || excluded.marcas),
      cuando = now()
    returning marcas, cuando`;

  const marcas = sinNulos(f.marcas);
  return res.status(200).json({ ok: true, juego, marcas, cuando: f.cuando,
    total: Object.keys(marcas).length });
}


/* ===========================================================================
 * EL DIRECTO: QUÉ SE SUBASTA AHORA Y QUÉ FICHA LLEVA CADA PRENDA
 * ===========================================================================
 * Segundo polizón de este fichero, por la misma razón que el marcado: no caben
 * más funciones en el plan y un fichero nuevo en /api tumba el despliegue.
 *
 * PARA QUÉ EXISTE. Desde el 25 sep 2026 TikTok obliga a que cada listado
 * temporal lleve un solo tipo de producto. Eso rompe lo que había: antes había
 * UN anuncio por directo y el número que daba TikTok era el número de la ficha
 * de cartón. Con treinta anuncios hay treinta series que empiezan en el 1, y la
 * ficha deja de coincidir.
 *
 * La solución no cambia nada en el almacén ni en el perchero: se siguen usando
 * los tacos de fichas numeradas del 1 al 500, en orden, y solo se cuelga ficha
 * cuando la prenda SE VENDE. Como las subastas van una detrás de otra y nunca
 * hay dos a la vez, la primera venta del directo es la ficha 1, la segunda la
 * 2, venga del listado que venga. Aquí se guarda ese emparejamiento.
 *
 *   GET  ?d=CODIGO&directo=SESION&live=1
 *        -> { ok, hay, room, listados, orden, ficha, ventas, ultimas }
 *
 *   POST ?d=CODIGO { directo, live:1, accion, ... }
 *        accion 'listados' { room, listados:[{id,nombre,vendidas,stock}] }
 *              el agente del ordenador publica lo que hay en el panel
 *        accion 'pedir'    { listado, nombre }
 *              la tablet pide lanzar ese listado. Deja UNA orden pendiente
 *        accion 'hecha'    { orden, error? }
 *              el agente dice que la lanzó, o por qué no pudo
 *        accion 'ventas'   { ventas:[{pedido,listado,nombre,unidad,precio,hora}] }
 *              el agente manda lo vendido. AQUÍ se reparten las fichas
 *        accion 'ficha'    { ficha }
 *              corregir el contador a mano cuando algo se tuerce
 *
 * LAS FICHAS LAS REPARTE EL SERVIDOR, NO LA TABLET NI EL ORDENADOR. Si las
 * repartiera el ordenador, recargar la pestaña o abrir el panel en dos sitios
 * daría dos veces la misma ficha. El pedido es la llave: una venta que ya tiene
 * ficha no vuelve a coger otra por mucho que se mande dos veces.
 *
 * SE ESCRIBE CON EL CÓDIGO DE LECTURA, como el marcado, porque la tablet del
 * directo solo lleva ese. OJO: a diferencia del marcado, esto SÍ mueve algo de
 * TikTok, porque una orden pendiente acaba lanzando una subasta de verdad. Lo
 * que lo contiene es que la orden no hace nada por sí sola: solo la ejecuta el
 * agente, y el agente solo está vivo mientras el panel esté abierto en el
 * ordenador del directo. Si el código de lectura se filtrara, lo peor que puede
 * pasar es que alguien lance una subasta mientras estáis emitiendo. Cuando haya
 * plan de pago esto debería mudarse a su propio sitio y con su propia llave.
 * ========================================================================= */
async function tablaDeDirecto(s) {
  await s`
    create table if not exists directo_vivo (
      sesion text primary key,
      estado jsonb not null default '{}'::jsonb,
      cuando timestamptz not null default now()
    )`;
}

const ESTADO_VACIO = { room: '', listados: [], listados_cuando: null, orden: null, ficha: 0, ventas: [] };

async function leerDirecto(s, sesion) {
  await tablaDeDirecto(s);
  const filas = await s`select estado, cuando from directo_vivo where sesion = ${sesion}`;
  if (!filas.length) return { hay: false, estado: { ...ESTADO_VACIO } };
  return { hay: true, estado: { ...ESTADO_VACIO, ...(filas[0].estado || {}) }, cuando: filas[0].cuando };
}

async function guardarDirecto(s, sesion, estado) {
  const [f] = await s`
    insert into directo_vivo (sesion, estado, cuando)
    values (${sesion}, ${s.json(estado)}, now())
    on conflict (sesion) do update set estado = excluded.estado, cuando = now()
    returning cuando`;
  return f.cuando;
}

/* Lo que se devuelve a quien pregunta. Las últimas ventas van recortadas: la
 * tablet solo necesita ver las de ahora mismo, y mandar 400 cada dos segundos
 * es tirar batería y datos del iPad. */
function vistaDirecto(sesion, e, cuando) {
  const ventas = e.ventas || [];
  return {
    ok: true, hay: true, sesion, cuando,
    room: e.room || '',
    listados: e.listados || [],
    listados_cuando: e.listados_cuando || null,
    orden: e.orden || null,
    ficha: e.ficha || 0,
    ventas: ventas.length,
    ultimas: ventas.slice(-12)
  };
}

async function accionDirecto(s, res, sesion, b) {
  if (!sesion) return res.status(400).json({ ok: false, error: 'sin-directo' });
  const { estado } = await leerDirecto(s, sesion);
  const accion = aTexto(b.accion).trim();

  if (accion === 'listados') {
    const entran = Array.isArray(b.listados) ? b.listados : [];
    estado.listados = entran.slice(0, 300).map((x) => ({
      id: aTexto(x.id).slice(0, 32),
      nombre: aTexto(x.nombre).slice(0, 255),
      vendidas: Number(x.vendidas) || 0,
      stock: Number(x.stock) || 0
    })).filter((x) => x.id);
    estado.listados_cuando = new Date().toISOString();
    if (b.room) estado.room = aTexto(b.room).slice(0, 32);
    const cuando = await guardarDirecto(s, sesion, estado);
    return res.status(200).json(vistaDirecto(sesion, estado, cuando));
  }

  if (accion === 'pedir') {
    const listado = aTexto(b.listado).slice(0, 32);
    if (!listado) return res.status(400).json({ ok: false, error: 'sin-listado' });
    /* Una orden pendiente cada vez. Si la vendedora toca dos veces seguidas, la
     * segunda sustituye a la primera en vez de encolarse: lo que quiere es
     * lanzar ESE, no lanzar dos subastas seguidas sin mirar. */
    estado.orden = {
      id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7),
      listado,
      nombre: aTexto(b.nombre).slice(0, 255),
      pedida: new Date().toISOString(),
      estado: 'pendiente',
      error: ''
    };
    const cuando = await guardarDirecto(s, sesion, estado);
    return res.status(200).json(vistaDirecto(sesion, estado, cuando));
  }

  if (accion === 'hecha') {
    const id = aTexto(b.orden);
    if (estado.orden && estado.orden.id === id) {
      estado.orden.estado = b.error ? 'error' : 'hecha';
      estado.orden.error = aTexto(b.error).slice(0, 300);
      estado.orden.resuelta = new Date().toISOString();
    }
    const cuando = await guardarDirecto(s, sesion, estado);
    return res.status(200).json(vistaDirecto(sesion, estado, cuando));
  }

  if (accion === 'ventas') {
    const entran = Array.isArray(b.ventas) ? b.ventas : [];
    const yaHay = new Set((estado.ventas || []).map((v) => v.pedido));
    /* Por hora de pedido: es el orden en que se fueron cerrando las subastas, y
     * ese es exactamente el orden en que se colgaron las fichas del taco. */
    const nuevas = entran
      .filter((v) => v && v.pedido && !yaHay.has(aTexto(v.pedido)))
      .sort((a, b2) => (Number(a.hora) || 0) - (Number(b2.hora) || 0));

    for (const v of nuevas) {
      estado.ficha = (estado.ficha || 0) + 1;
      estado.ventas.push({
        ficha: estado.ficha,
        pedido: aTexto(v.pedido).slice(0, 32),
        listado: aTexto(v.listado).slice(0, 32),
        nombre: aTexto(v.nombre).slice(0, 255),
        unidad: aTexto(v.unidad).slice(0, 16),
        precio: aTexto(v.precio).slice(0, 24),
        hora: Number(v.hora) || 0
      });
    }
    if (estado.ventas.length > 2000) estado.ventas = estado.ventas.slice(-2000);
    const cuando = await guardarDirecto(s, sesion, estado);
    const r = vistaDirecto(sesion, estado, cuando);
    r.nuevas = nuevas.length;
    return res.status(200).json(r);
  }

  if (accion === 'ficha') {
    const n = Number(b.ficha);
    if (!Number.isInteger(n) || n < 0 || n > 5000) {
      return res.status(400).json({ ok: false, error: 'ficha-rara' });
    }
    estado.ficha = n;
    const cuando = await guardarDirecto(s, sesion, estado);
    return res.status(200).json(vistaDirecto(sesion, estado, cuando));
  }

  return res.status(400).json({ ok: false, error: 'accion-desconocida' });
}

module.exports = puerta(async (req, res) => {
  const s = db();

  if (req.method === 'POST') {
    const bm = cuerpo(req);
    /* Lo del almacén va con el código de lectura; las tandas siguen pidiendo el
     * de escritura, que es lo de siempre y no se toca. */
    /* El directo va primero porque es lo más ruidoso: la tablet pregunta cada
     * dos segundos y el agente escribe cada pocos. Cuanto antes se resuelva,
     * menos trabajo hace el resto. */
    if (bm && bm.live) {
      if (!puedeLeer(req)) return noAutorizado(res, 'leer');
      return accionDirecto(s, res, aTexto(bm.directo || (req.query || {}).directo).trim(), bm);
    }
    if (bm && bm.marcas && typeof bm.marcas === 'object' && !bm.datos) {
      if (!puedeLeer(req)) return noAutorizado(res, 'leer');
      return guardarMarcas(s, res, aTexto(bm.juego || (req.query || {}).juego).trim(), bm.marcas);
    }
    if (!puedeEscribir(req)) return noAutorizado(res, 'escribir');
    const b = cuerpo(req);
    const datos = b.datos || b;
    if (!datos || !Array.isArray(datos.tandas)) {
      return res.status(400).json({ ok: false, error: 'sin-tandas',
        detalle: 'Esperaba { datos: { tandas: [...] } }' });
    }
    const dia = diaDe(b.dia || datos.dia);
    const juego = aTexto(b.juego || datos.juego).trim() || dia;
    const titulo = aTexto(b.titulo || datos.titulo);
    const directo = aTexto(b.directo);
    /* Que el juego viaje TAMBIÉN dentro de los datos: la app lo lee de ahí para
     * separar el avance guardado en cada móvil, y así no depende de que alguien
     * se acuerde de ponerlo en el enlace. */
    datos.juego = juego;

    await s`
      insert into tandas (dia, juego, directo, titulo, datos, generado)
      values (${dia}, ${juego}, ${directo}, ${titulo}, ${s.json(datos)}, now())
      on conflict (juego) do update set
        dia     = excluded.dia,
        directo = excluded.directo,
        titulo  = excluded.titulo,
        datos   = excluded.datos,
        generado = now()`;

    const paquetes = datos.tandas.reduce((n, t) => n + ((t.compradores || []).length), 0);
    return res.status(200).json({ ok: true, dia, juego, tandas: datos.tandas.length, paquetes });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const q = req.query || {};
    if (q.live) {
      const sesion = aTexto(q.directo).trim();
      if (!sesion) return res.status(400).json({ ok: false, error: 'sin-directo' });
      const { hay, estado, cuando } = await leerDirecto(s, sesion);
      if (!hay) {
        return res.status(200).json({ ok: true, hay: false, sesion,
          room: '', listados: [], orden: null, ficha: 0, ventas: 0, ultimas: [] });
      }
      return res.status(200).json(vistaDirecto(sesion, estado, cuando));
    }
    if (q.marcas) return leerMarcas(s, res, aTexto(q.juego).trim());
    const dia = diaDe(q.dia);
    const juego = aTexto(q.juego).trim() || dia;
    const filas = await s`select dia, juego, titulo, datos, generado from tandas where juego = ${juego}`;
    if (!filas.length) {
      /* Sin datos de hoy no devolvemos un 404 pelado: la app necesita poder
       * decir "todavía no hay nada" sin parecer rota. */
      return res.status(200).json({ ok: true, hay: false, dia, juego, datos: null });
    }
    const f = filas[0];
    return res.status(200).json({
      ok: true, hay: true, dia: f.dia, juego: f.juego,
      generado: f.generado, titulo: f.titulo, datos: f.datos
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
