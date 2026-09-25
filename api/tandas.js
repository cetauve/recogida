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
/* MISMO CUIDADO QUE CON EL DIRECTO: esta orden no se ejecuta en camino normal.
 * Los moviles del almacen preguntan por lo marcado a todas horas, y cada copia
 * del servidor que arrancaba lanzaba una de estas. Pedir ese candado mientras
 * alguien esta leyendo deja la tabla en cola y se lleva por delante una
 * conexion durante cinco minutos. Ahora solo se crea si de verdad no existe. */
let tablaMarcasHecha = false;

async function crearTablaMarcas(s) {
  if (tablaMarcasHecha) return;
  await s`
    create table if not exists marcado (
      juego  text primary key,
      marcas jsonb not null default '{}'::jsonb,
      cuando timestamptz not null default now()
    )`;
  tablaMarcasHecha = true;
}

async function conMarcado(s, hacer) {
  try {
    return await hacer();
  } catch (e) {
    const m = String((e && e.message) || e);
    if (!(/marcado/.test(m) && /does not exist|no existe|undefined table/i.test(m))) throw e;
    await crearTablaMarcas(s);
    return hacer();
  }
}

const sinNulos = (o) => {
  const r = {};
  for (const k of Object.keys(o || {})) if (o[k] !== null) r[k] = o[k];
  return r;
};

async function leerMarcas(s, res, juego) {
  if (!juego) return res.status(400).json({ ok: false, error: 'sin-juego' });
  const filas = await conMarcado(s, () =>
    s`select marcas, cuando from marcado where juego = ${juego}`);
  if (!filas.length) return res.status(200).json({ ok: true, hay: false, juego, marcas: {} });
  return res.status(200).json({ ok: true, hay: true, juego,
    marcas: sinNulos(filas[0].marcas), cuando: filas[0].cuando });
}

async function guardarMarcas(s, res, juego, entran) {
  if (!juego) return res.status(400).json({ ok: false, error: 'sin-juego' });

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
  const [f] = await conMarcado(s, () => s`
    insert into marcado (juego, marcas, cuando)
    values (${juego}, ${s.json(limpio)}, now())
    on conflict (juego) do update set
      marcas = jsonb_strip_nulls(marcado.marcas || excluded.marcas),
      cuando = now()
    returning marcas, cuando`);

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
/* EL "CREATE TABLE IF NOT EXISTS" NO PUEDE IR EN CADA LECTURA.
 * 22 sep 2026: la pantalla del directo pregunta cada dos segundos y el agente
 * otro tanto. Con esa concurrencia, dos CREATE TABLE a la vez se bloquean
 * entre ellos en Postgres y la llamada se queda colgada PARA SIEMPRE: no da
 * error, no devuelve nada, y la pantalla se queda en "conectando". Así que se
 * hace una vez por instancia y quien lee no toca la estructura nunca. */
/* EL `create table if not exists` NO SE EJECUTA NUNCA EN CAMINO NORMAL.
 *
 * ESTO YA NOS COSTO UN SERVIDOR CAIDO Y HOY CASI OTRO. Aunque la tabla exista,
 * esa orden pide el candado mas fuerte que hay sobre ella. Basta con que una
 * lectura este en marcha para que se quede esperando, y a partir de ese momento
 * TODAS las lecturas y escrituras de esa tabla se ponen en cola detras. El
 * servidor no da error: se queda mudo, que es peor. Con tres directos y cinco
 * tablets preguntando, cada arranque de una copia del servidor era otra orden
 * de esas.
 *
 * Ahora solo se crea SI DE VERDAD NO EXISTE: se intenta lo que se iba a hacer,
 * y unicamente cuando la base contesta "esa tabla no existe" se crea y se
 * reintenta. En funcionamiento normal esto no se ejecuta jamas. */
let tablaDirectoHecha = false;

const noExisteLaTabla = (e) => {
  const m = String((e && e.message) || e);
  return /directo_vivo/.test(m) && /does not exist|no existe|undefined table/i.test(m);
};

async function crearTablaDirecto(s) {
  if (tablaDirectoHecha) return;
  await s`
    create table if not exists directo_vivo (
      sesion text primary key,
      estado jsonb not null default '{}'::jsonb,
      cuando timestamptz not null default now()
    )`;
  tablaDirectoHecha = true;
}

/* Hace lo que se le pida y, solo si la tabla no estaba, la crea y lo repite. */
async function conTabla(s, hacer) {
  try {
    return await hacer();
  } catch (e) {
    if (!noExisteLaTabla(e)) throw e;
    await crearTablaDirecto(s);
    return hacer();
  }
}

/* UNA CAJA NUEVA CADA VEZ, y no un objeto suelto que se copia por encima.
 * Copiar un objeto con `...` copia las listas POR REFERENCIA: todos los
 * directos que empezaban de cero compartian la MISMA lista de ventas, la del
 * propio molde. En el servidor un mismo proceso atiende muchas peticiones
 * seguidas, asi que el segundo directo que estrenaba se encontraba dentro las
 * ventas del primero, y con ellas sus fichas. Con un solo directo no se veia.
 * Con tres a la vez es la forma mas rapida de mezclar dos tiendas. */
function cajaVacia() {
  return { room: '', canal: '', cuenta: '', puesto: '', listados: [], listados_cuando: null, orden: null, ficha: 0, ventas: [] };
}

/* ESCRIBIR SIN PISARSE. Cada directo tiene DOS que le escriben: la tablet
 * (pedir) y el ordenador (listados, ventas, hecha). Antes se leia la caja, se
 * cambiaba y se volvia a guardar entera; si los dos caian en el mismo instante,
 * el segundo borraba lo del primero. Con un directo pasaba poco. Con tres pasa
 * tres veces mas, y lo peor que puede perderse es una VENTA: esa prenda se
 * queda sin ficha para siempre y su tarjeta ya no se puede traducir.
 *
 * Se arregla sin transacciones a proposito, para que funcione igual con el
 * pooler de la base en cualquier modo: se guarda la marca de tiempo que traia
 * la caja y solo se escribe SI NADIE LA HA TOCADO desde entonces. Si la ha
 * tocado otro, se vuelve a leer y se aplica encima. La marca viaja como TEXTO
 * porque las fechas de JavaScript pierden los microsegundos y la comparacion
 * no cuadraria nunca. */
async function leerParaEscribir(s, sesion) {
  let filas = await s`select estado, cuando, cuando::text as marca from directo_vivo where sesion = ${sesion}`;
  if (!filas.length) {
    await s`insert into directo_vivo (sesion) values (${sesion}) on conflict (sesion) do nothing`;
    filas = await s`select estado, cuando, cuando::text as marca from directo_vivo where sesion = ${sesion}`;
  }
  const f = filas[0] || {};
  return { estado: { ...cajaVacia(), ...(f.estado || {}) }, marca: f.marca || null };
}

async function guardarSiNadieToco(s, sesion, estado, marca) {
  const filas = await s`
    update directo_vivo set estado = ${s.json(estado)}, cuando = now()
    where sesion = ${sesion} and cuando::text = ${marca}
    returning cuando`;
  return filas.length ? filas[0].cuando : null;
}

async function leerDirecto(s, sesion) {
  let filas;
  try {
    filas = await s`select estado, cuando from directo_vivo where sesion = ${sesion}`;
  } catch (e) {
    /* Todavia no existe la tabla: es el primer dia y nadie ha escrito nada.
     * Eso no es un error para quien lee, es un "aun no hay nada". */
    if (String(e && e.message || '').includes('directo_vivo')) {
      return { hay: false, estado: cajaVacia() };
    }
    throw e;
  }
  if (!filas.length) return { hay: false, estado: cajaVacia() };
  return { hay: true, estado: { ...cajaVacia(), ...(filas[0].estado || {}) }, cuando: filas[0].cuando };
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

/* Un canal es un nombre corto y sin sorpresas: vale para ir en una direccion
 * y para que nadie lo escriba mal. ES 1, es-1 y "ES  1" son el mismo. */
function limpiarCanal(x) {
  return aTexto(x).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
}

/* A que directo apunta hoy un canal: el ultimo que dijo llamarse asi. Si el
 * ordenador de ES 1 se reinicia y TikTok le da un numero nuevo, el canal pasa
 * a apuntar al nuevo solo y la tablet ni se entera. */
async function sesionDeCanal(s, canal) {
  if (!canal) return '';
  try {
    /* La fecha va PRIMERO a proposito: asi la base solo abre el contenido de
     * los directos de hoy y no el de todos los que ha habido nunca. */
    const filas = await s`
      select sesion from directo_vivo
      where cuando > now() - interval '24 hours'
        and estado->>'canal' = ${canal}
      order by cuando desc limit 1`;
    return filas.length ? filas[0].sesion : '';
  } catch (e) { return ''; }
}

/* DOS ORDENADORES NO PUEDEN LLAMARSE IGUAL. Si el de ES 2 se dejo abierto con
 * el nombre de ES 1, las dos tablets mandarian al mismo directo y nadie se
 * enteraria hasta ver las ventas. Se comprueba solo cuando un directo estrena
 * canal, no en cada vuelta: despues ya lo lleva escrito en su propia caja. */
async function canalOcupado(s, canal, sesion, puesto) {
  /* SIN PUESTO NO SE BLOQUEA. Un ordenador con la extension vieja no sabe
   * decir quien es; preferimos que emita a dejarlo fuera por precaucion. */
  if (!puesto) return '';
  try {
    const filas = await s`
      select sesion, coalesce(estado->>'puesto', '') as puesto from directo_vivo
      where cuando > now() - interval '3 minutes'
        and estado->>'canal' = ${canal} and sesion <> ${sesion}
        and coalesce(estado->>'puesto', '') <> ${puesto}
      order by cuando desc limit 1`;
    return filas.length ? filas[0].sesion : '';
  } catch (e) { return ''; }
}

/* LA TABLET TAMBIEN SE APUNTA, para que el panel pueda decir si esta viva. Se
 * escribe como mucho una vez por minuto y sin tocar la marca de tiempo de la
 * caja, asi que no estorba a quien este escribiendo de verdad. */
async function vistaTablet(s, sesion) {
  try {
    await s`
      update directo_vivo
      set estado = jsonb_set(coalesce(estado, '{}'::jsonb), '{tablet}', to_jsonb(now()::text))
      where sesion = ${sesion}
        and (estado->>'tablet' is null or (estado->>'tablet')::timestamptz < now() - interval '60 seconds')`;
  } catch (e) { /* que no se apunte no puede romper la pantalla */ }
}

/* LO QUE VE EL PANEL. Una fila por directo de las ultimas doce horas, y el
 * desglose lo hace la base: aqui solo llegan los cuatro datos que se pintan, no
 * el historial entero de ventas de cada uno. */
async function panelDirectos(s) {
  const filas = await s`
    select sesion,
           estado->>'canal'  as canal,
           estado->>'cuenta' as cuenta,
           estado->>'room'   as room,
           coalesce((estado->>'ficha')::int, 0) as ficha,
           jsonb_array_length(case when jsonb_typeof(estado->'ventas') = 'array'
                                   then estado->'ventas' else '[]'::jsonb end) as ventas,
           estado->'ventas'->-1 as ultima,
           jsonb_array_length(case when jsonb_typeof(estado->'listados') = 'array'
                                   then estado->'listados' else '[]'::jsonb end) as listados,
           estado->>'listados_cuando' as listados_cuando,
           estado->'orden'   as orden,
           estado->>'tablet' as tablet,
           cuando
      from directo_vivo
     where cuando > now() - interval '12 hours'
     order by cuando desc
     limit 40`;
  return filas.map((f) => ({
    sesion: f.sesion,
    canal: f.canal || '',
    cuenta: f.cuenta || '',
    ficha: f.ficha || 0,
    ventas: f.ventas || 0,
    /* DE LA ULTIMA VENTA SOLO LO QUE SE PUEDE ENSENAR. El numero de pedido no
     * sale por pantalla en ninguna de nuestras aplicaciones, y el panel no va a
     * ser el primero. */
    ultima: f.ultima ? { ficha: f.ultima.ficha, nombre: f.ultima.nombre,
                         precio: f.ultima.precio, hora: f.ultima.hora } : null,
    listados: f.listados || 0,
    listados_cuando: f.listados_cuando || null,
    orden: f.orden ? { estado: f.orden.estado, nombre: f.orden.nombre,
                       pedida: f.orden.pedida, error: f.orden.error || '' } : null,
    tablet: f.tablet || null,
    cuando: f.cuando
  }));
}

/* Lo que hace cada accion sobre la caja del directo. Solo toca el objeto que
 * se le pasa; no habla con la base. Asi se puede volver a aplicar tal cual si
 * al guardar resulta que otro habia escrito antes. */
function aplicarAccion(estado, accion, b) {
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
    /* EL CANAL. El numero que TikTok le pone a cada directo cambia cada vez que
     * se arranca, asi que no sirve para poner en el enlace de una tablet. El
     * canal si: es un nombre que se le da UNA VEZ a cada perfil de Chrome
     * -ES 1, ES 2, DE- y ya no cambia nunca. La tablet lleva el nombre en su
     * enlace y el servidor lo apunta al directo que este emitiendo hoy. */
    if (b.canal) estado.canal = limpiarCanal(b.canal);
    if (b.cuenta) estado.cuenta = aTexto(b.cuenta).slice(0, 60);
    /* EL PUESTO es quien dice ser el ordenador, y no cambia aunque TikTok le de
     * un numero nuevo. Sin esto, parar y reanudar el directo se confundiria con
     * un segundo ordenador robando el nombre, y el propio ES 1 se quedaria
     * fuera de su canal justo al reanudar. */
    if (b.puesto) estado.puesto = aTexto(b.puesto).slice(0, 40);
    return null;
  }

  if (accion === 'pedir') {
    const listado = aTexto(b.listado).slice(0, 32);
    if (!listado) return { error: 'sin-listado' };
    /* Una orden pendiente cada vez. Si la vendedora toca dos veces seguidas, la
     * segunda sustituye a la primera en vez de encolarse: lo que quiere es
     * lanzar ESE, no lanzar dos subastas seguidas sin mirar. */
    estado.orden = {
      id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7),
      listado,
      nombre: aTexto(b.nombre).slice(0, 255),
      pedida: new Date().toISOString(),
      estado: 'pendiente',
      error: '',
      /* En prueba no se subasta nada: el ordenador sube ese anuncio al primer
       * puesto, que es inofensivo y se ve en el panel. Sirve para comprobar el
       * camino entero (tablet, servidor, ordenador, TikTok) sin emitir. */
      prueba: !!b.prueba
    };
    return null;
  }

  if (accion === 'hecha') {
    const id = aTexto(b.orden);
    if (estado.orden && estado.orden.id === id) {
      estado.orden.estado = b.error ? 'error' : 'hecha';
      estado.orden.error = aTexto(b.error).slice(0, 300);
      estado.orden.resuelta = new Date().toISOString();
    }
    return null;
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
        /* De que anuncio es. Sin esto no se puede traducir el numero de TikTok
         * al de la ficha, porque cada anuncio numera desde el 1. */
        producto: aTexto(v.producto).slice(0, 32),
        listado: aTexto(v.listado).slice(0, 32),
        nombre: aTexto(v.nombre).slice(0, 255),
        unidad: aTexto(v.unidad).slice(0, 16),
        precio: aTexto(v.precio).slice(0, 24),
        hora: Number(v.hora) || 0
      });
    }
    if (estado.ventas.length > 2000) estado.ventas = estado.ventas.slice(-2000);
    return { nuevas: nuevas.length };
  }

  if (accion === 'ficha') {
    const n = Number(b.ficha);
    if (!Number.isInteger(n) || n < 0 || n > 5000) return { error: 'ficha-rara' };
    estado.ficha = n;
    return null;
  }

  return { error: 'accion-desconocida' };
}

async function accionDirecto(s, res, sesion, b) {
  if (!sesion) return res.status(400).json({ ok: false, error: 'sin-directo' });
  const accion = aTexto(b.accion).trim();

  /* Cuatro intentos. Dos escrituras a la vez sobre el mismo directo son cosa de
   * milisegundos; que fallen cuatro seguidas significa que algo va muy mal y es
   * mejor decirlo que dejar a la tablet creyendo que se guardo. */
  for (let intento = 0; intento < 4; intento++) {
    const { estado, marca } = await conTabla(s, () => leerParaEscribir(s, sesion));
    /* Solo al estrenar canal, no en cada vuelta. */
    if (accion === 'listados' && b.canal) {
      const canal = limpiarCanal(b.canal);
      if (canal && estado.canal !== canal) {
        const otro = await canalOcupado(s, canal, sesion, aTexto(b.puesto).slice(0, 40));
        if (otro) return res.status(409).json({ ok: false, error: 'canal-ocupado', canal });
      }
    }
    const r = aplicarAccion(estado, accion, b);
    if (r && r.error) return res.status(400).json({ ok: false, error: r.error });
    const cuando = await guardarSiNadieToco(s, sesion, estado, marca);
    if (cuando) {
      const salida = vistaDirecto(sesion, estado, cuando);
      if (r && typeof r.nuevas === 'number') salida.nuevas = r.nuevas;
      return res.status(200).json(salida);
    }
  }
  return res.status(409).json({ ok: false, error: 'ocupado' });
}

/* ===========================================================================
 * TRADUCIR LOS NUMEROS DE TIKTOK A LOS DE LA FICHA DE CARTON
 * ===========================================================================
 * Desde el 25 sep 2026 un directo lleva decenas de anuncios y CADA UNO numera
 * sus prendas desde el 1. O sea que en un mismo perchero hay treinta prendas
 * con el numero 1, y el numero que manda TikTok en el pedido ya no sirve para
 * encontrarla.
 *
 * El almacen sigue usando sus tacos de fichas numeradas del 1 al 500, en orden
 * y colgando ficha solo cuando la prenda se vende. Aqui se cruzan las dos
 * cosas: la ficha que se le asigno a cada venta (tabla directo_vivo) con el
 * numero que trae la tarjeta (anuncio + numero).
 *
 * SE HACE AQUI Y NO EN LA APP DEL ALMACEN A PROPOSITO. La app tiene 1.685
 * lineas y es lo que usan las chicas cada dia; tocarla dos dias antes de
 * estrenar todo esto es pedir un disgusto. Asi las tarjetas le llegan ya
 * traducidas y su pantalla no cambia ni una linea.
 *
 * SI NO HAY TRADUCCION, NO SE TOCA NADA. Los juegos de antes del 25 de
 * septiembre, y cualquier directo de una sola listing, siguen funcionando
 * exactamente igual.
 * ========================================================================= */
async function mapaDeFichas(s) {
  try {
    /* El desglose se hace EN LA BASE y no aqui. Antes se traia la caja entera de
     * cada directo de los ultimos tres dias, con sus dos mil ventas, y se
     * recorria en memoria. Con un directo se notaba poco; con tres es traerse
     * varios megas en CADA peticion de tarjetas del almacen, y los moviles
     * preguntan a menudo. Asi solo viajan tres columnas por venta. */
    const filas = await s`
      select d.sesion        as sesion,
             v->>'producto' as producto,
             v->>'unidad'   as unidad,
             v->>'ficha'    as ficha
        from directo_vivo d,
             lateral jsonb_array_elements(
               case when jsonb_typeof(d.estado->'ventas') = 'array'
                    then d.estado->'ventas' else '[]'::jsonb end) v
       where d.cuando > now() - interval '3 days'`;
    const m = {}, dueno = {}, dudosas = new Set();
    for (const f of filas) {
      if (!f.producto || !f.unidad || !f.ficha) continue;
      const n = parseInt(String(f.unidad).replace(/[^0-9]/g, ''), 10);
      const ficha = parseInt(String(f.ficha), 10);
      if (!Number.isFinite(n) || !Number.isFinite(ficha)) continue;
      const llave = f.producto + '.' + n;
      /* SEPARAR POR TIENDA. Cada anuncio temporal es de una sola cuenta y su
       * identificador no se repite entre tiendas, asi que dos directos a la vez
       * no se cruzan. Pero si la misma llave apareciera en DOS directos, no hay
       * forma de saber de que taco es la ficha, y las tres de Espana tienen
       * tacos distintos con los mismos numeros. Mandar a la chica al taco
       * equivocado es peor que no traducir: esa tarjeta sale con los numeros de
       * TikTok, que es raro de ver y por tanto se nota. */
      if (llave in dueno && dueno[llave] !== f.sesion) { dudosas.add(llave); continue; }
      dueno[llave] = f.sesion;
      m[llave] = ficha;
    }
    for (const k of dudosas) delete m[k];
    return m;
  } catch (e) {
    /* Sin traduccion se sirven las tandas como siempre. Que esto falle no puede
     * dejar al almacen sin tarjetas. */
    return {};
  }
}

/* LA TARJETA SE QUEDA COMO ESTABA: cada cuenta con su rotulo y sus numeros.
 *
 * ESTO ESTUVO MAL Y ASI SE ARREGLA. La primera version juntaba todos los
 * numeros de la tarjeta en un solo monton y borraba el rotulo de la cuenta,
 * porque con un unico directo el rotulo no distinguia nada. Con tres cuentas
 * espanolas emitiendo a la vez eso es un desastre: cada cuenta tiene su taco de
 * fichas y las tres empiezan por el 1, asi que un monton con "47, 47" sin
 * rotulo manda a quien recoge a dos prendas distintas. Ahora se traduce grupo a
 * grupo y el rotulo no se toca.
 *
 * LAS BOLSAS TAMBIEN. Cuando alguien compra para dos direcciones, TikTok parte
 * el pedido en dos bolsas y la tarjeta las ensena por separado. Esas listas
 * llevan los mismos numeros pero no dicen de que anuncio son, asi que se
 * traducen por el valor. Si un numero sale de dos anuncios distintos en la
 * misma tarjeta no hay forma de saber cual es cual, y entonces esa tarjeta se
 * queda SIN traducir entera. Media tarjeta es peor que ninguna. */
function traducirTandas(datos, mapa) {
  if (!datos || !Array.isArray(datos.tandas) || !Object.keys(mapa).length) return { datos, n: 0 };
  let n = 0;
  for (const t of datos.tandas) {
    for (const c of (t.compradores || t.detalle || [])) {
      const grupos = (c.porCuenta || []).filter((g) => Array.isArray(g.numeros) && g.numeros.length);
      if (!grupos.length) continue;

      const nuevos = [];
      const porValor = {};          /* numero de TikTok -> ficha, para las bolsas */
      let liada = false;

      for (const g of grupos) {
        const fichas = [];
        for (const num of g.numeros) {
          const f = mapa[(g.producto || '') + '.' + num];
          if (!f) { liada = true; break; }
          fichas.push(f);
          if (porValor[num] === undefined) porValor[num] = f;
          else if (porValor[num] !== f) porValor[num] = null;   /* sale de dos sitios */
        }
        if (liada) break;
        /* Se copia el grupo entero y solo se cambian los numeros: el rotulo de
         * la cuenta y su color siguen exactamente donde estaban. */
        nuevos.push({ ...g, numeros: fichas.slice().sort((a, b) => a - b) });
      }
      if (liada) continue;

      let bolsas = null;
      if (Array.isArray(c.bultos) && c.bultos.length) {
        bolsas = [];
        for (const b of c.bultos) {
          const nums = [];
          for (const num of ((b && b.numeros) || [])) {
            const f = porValor[num];
            if (!f) { liada = true; break; }
            nums.push(f);
          }
          if (liada) break;
          bolsas.push({ ...b, numeros: nums });
        }
        if (liada) continue;
      }

      const todas = nuevos.reduce((a, g) => a.concat(g.numeros), []).sort((a, b) => a - b);
      c.porCuenta = nuevos;
      c.numeros = todas;
      if (bolsas) c.bultos = bolsas;
      n += todas.length;
    }
  }
  return { datos, n };
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
      let sesion = aTexto(bm.directo || (req.query || {}).directo).trim();
      /* La tablet manda su canal, no un numero: su enlace es fijo para siempre. */
      if (!sesion && (bm.canal || (req.query || {}).canal)) {
        const canal = limpiarCanal(bm.canal || (req.query || {}).canal);
        sesion = await sesionDeCanal(s, canal);
        if (!sesion) return res.status(200).json({ ok: false, error: 'canal-sin-directo', canal });
      }
      return accionDirecto(s, res, sesion, bm);
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
    if (q.panel) {
      try {
        return res.status(200).json({ ok: true, ahora: new Date().toISOString(),
                                      directos: await panelDirectos(s) });
      } catch (e) {
        return res.status(200).json({ ok: true, ahora: new Date().toISOString(), directos: [] });
      }
    }
    if (q.live) {
      let sesion = aTexto(q.directo).trim();
      const canal = limpiarCanal(q.canal);
      if (!sesion && canal) sesion = await sesionDeCanal(s, canal);
      if (!sesion) {
        if (canal) return res.status(200).json({ ok: true, hay: false, canal, sesion: '',
          room: '', listados: [], orden: null, ficha: 0, ventas: 0, ultimas: [] });
        return res.status(400).json({ ok: false, error: 'sin-directo' });
      }
      const { hay, estado, cuando } = await leerDirecto(s, sesion);
      if (!hay) {
        return res.status(200).json({ ok: true, hay: false, sesion, canal,
          room: '', listados: [], orden: null, ficha: 0, ventas: 0, ultimas: [] });
      }
      if (canal) await vistaTablet(s, sesion);
      const v = vistaDirecto(sesion, estado, cuando);
      v.canal = estado.canal || canal;
      v.cuenta = estado.cuenta || '';
      return res.status(200).json(v);
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
    const mapa = await mapaDeFichas(s);
    const { datos, n } = traducirTandas(f.datos, mapa);
    return res.status(200).json({
      ok: true, hay: true, dia: f.dia, juego: f.juego,
      generado: f.generado, titulo: f.titulo, datos, traducidas: n
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
