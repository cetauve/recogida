/* /api/salud — para saber qué falta sin adivinar.
 *
 * Abierta a propósito, pero no enseña nada que valga: dice si cada pieza está
 * puesta (sí/no), nunca su valor. Los conteos solo con el código de lectura.
 *
 * Cuando algo no funcione, esta es la primera dirección que hay que abrir.
 */
const { db, puerta, puedeLeer, aTexto, diaDeHoy } = require('./_lib');
const T = require('./_tiktok');

/* ===========================================================================
 * ?pedido=<id> — DE QUÉ DIRECTO VIENE ESTA VENTA. Prueba, 26 ago 2026.
 * ===========================================================================
 * Lo dijo la account manager de TikTok y hay que comprobarlo antes de fiarse:
 * el DETALLE del pedido trae `room_id`, "the unique ID of the LIVE session
 * where the order line item was created". Si eso viene relleno, se acabó
 * adivinar de qué cuenta es cada producto: TikTok lo dice.
 *
 * Y explica por qué no lo habíamos visto nunca: el paso 2 usa la BÚSQUEDA de
 * pedidos (/order/202309/orders/search) y esto está en el DETALLE
 * (/order/202309/orders?ids=), que no se llama en ningún sitio.
 *
 * Se pregunta por las dos vías a la vez para saber si hace falta la llamada de
 * más o si la búsqueda ya lo traía y lo estábamos tirando.
 *
 * VIVE AQUÍ Y NO EN tiktok-etiquetas.js A PROPÓSITO: esto es una prueba, y el
 * archivo de las etiquetas es el que no se puede romper. Cuando se sepa la
 * respuesta, esta rama se borra.
 *
 * NO DEVUELVE EL PEDIDO ENTERO: nombres y direcciones no salen de aquí. Solo
 * los nombres de los campos y los identificadores que hacen falta. */
async function deQueDirecto(req) {
  const q = req.query || {};
  const pedido = aTexto(q.pedido).trim();
  const cuenta = (aTexto(q.cuenta).trim() || 'billysvlc').toLowerCase();

  const fuera = { pedido, cuenta };

  /* 1. EL DETALLE, que es donde dicen que está. */
  try {
    const r = await T.comoCuenta(cuenta, {
      camino: '/order/202309/orders',
      params: { ids: pedido }
    });
    const o = ((r && r.data && r.data.orders) || [])[0] || null;
    const lineas = (o && o.line_items) || [];
    fuera.detalle = {
      code: r && r.code,
      mensaje: aTexto(r && r.message).slice(0, 160),
      camposDelPedido: o ? Object.keys(o) : null,
      camposDeLaLinea: lineas[0] ? Object.keys(lineas[0]) : null,
      /* lo que importa */
      room_id: lineas.map((l) => aTexto(l.room_id)),
      product_id: lineas.map((l) => aTexto(l.product_id)),
      seller_sku: lineas.map((l) => aTexto(l.seller_sku)),
      product_listing_type: lineas.map((l) => aTexto(l.product_listing_type))
    };
  } catch (e) {
    fuera.detalle = { error: String((e && e.message) || e).slice(0, 200) };
  }

  /* 2. LA BÚSQUEDA, la que ya usamos. ¿Traía el dato y no lo mirábamos? */
  try {
    const r = await T.comoCuenta(cuenta, {
      camino: '/order/202309/orders/search',
      metodo: 'POST',
      params: { page_size: 1 },
      cuerpo: { order_status: 'AWAITING_COLLECTION' }
    });
    const o = ((r && r.data && r.data.orders) || [])[0] || null;
    const lineas = (o && o.line_items) || [];
    fuera.busqueda = {
      code: r && r.code,
      camposDelPedido: o ? Object.keys(o) : null,
      camposDeLaLinea: lineas[0] ? Object.keys(lineas[0]) : null,
      traeRoomId: lineas.some((l) => l && l.room_id !== undefined),
      room_id: lineas.map((l) => aTexto(l.room_id))
    };
  } catch (e) {
    fuera.busqueda = { error: String((e && e.message) || e).slice(0, 200) };
  }

  /* 3. Y los directos de estos días, para poder casar el room_id con un nombre
   *    ahí mismo, sin tener que abrir otra pestaña. */
  try {
    const D = require('./_directos');
    const lista = await D.directos(cuenta, 3);
    fuera.directos = lista.map((d) => ({ sesion: d.id, cuenta: d.cuenta, prendas: d.prendas }));
    const rooms = (fuera.detalle && fuera.detalle.room_id) || [];
    fuera.cuadra = rooms.map((r) => {
      const d = lista.find((x) => x.id === r);
      return { room_id: r, cuenta: d ? d.cuenta : (r ? '(no está en los directos leídos)' : '(vacío)') };
    });
  } catch (e) {
    fuera.directos = { error: String((e && e.message) || e).slice(0, 200) };
  }

  return fuera;
}

module.exports = puerta(async (req, res) => {
  const s = db();
  const hoy = diaDeHoy();

  /* La prueba del room_id va delante y exige código de lectura: llama a TikTok
   * y no tiene por qué contestarle a cualquiera. */
  if (aTexto((req.query || {}).pedido)) {
    if (!puedeLeer(req)) return res.status(401).json({ ok: false, error: 'sin-permiso' });
    const r = await deQueDirecto(req);
    return res.status(200).json({ ok: true, prueba: 'room_id', ...r });
  }

  const estado = {
    ok: true,
    hoy,
    postgres: !!(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL),
    tokenDeEscritura: !!process.env.BILLYS_TOKEN,
    codigoDeLectura: !!process.env.BILLYS_CODIGO,
    tablas: []
  };

  const t = await s`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`;
  estado.tablas = t.map((x) => x.table_name);

  const faltan = ['directos', 'lotes', 'toques', 'tandas', 'tiempos', 'regalos']
    .filter((n) => !estado.tablas.includes(n));
  if (faltan.length) { estado.ok = false; estado.faltanTablas = faltan; }
  if (!estado.tokenDeEscritura) { estado.ok = false; estado.aviso = 'Sin BILLYS_TOKEN no se puede escribir nada.'; }
  if (!estado.codigoDeLectura) { estado.ok = false; estado.aviso2 = 'Sin BILLYS_CODIGO no se puede leer nada.'; }

  if (puedeLeer(req)) {
    const [d] = await s`select count(*)::int as n from directos`;
    const [l] = await s`select count(*)::int as n from lotes`;
    const [q] = await s`select count(*)::int as n from toques`;
    const [n] = await s`select count(*)::int as n from tandas`;
    const [m] = await s`select count(*)::int as n from tiempos`;
    const [g] = await s`select count(*)::int as n from regalos`;
    estado.filas = { directos: d.n, lotes: l.n, toques: q.n, tandas: n.n, tiempos: m.n, regalos: g.n };
  }

  return res.status(200).json(estado);
});
