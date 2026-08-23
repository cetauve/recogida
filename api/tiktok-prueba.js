/* /api/tiktok-prueba — la primera llamada de verdad.
 *
 * Toca los cuatro sitios que van a hacer falta para los pasos 2, 3 y 4, y
 * dice de cada uno si contesta o con que se queja. Sirve para saber, ANTES de
 * mover ningun paso, que los permisos estan bien dados y la firma cuadra.
 *
 *   GET ?d=CODIGO&cuenta=billysvlc
 *
 * Se puede borrar el dia que todo funcione, pero conviene dejarlo: cuando algo
 * falle en directo, lo primero es saber si falla la API o fallamos nosotros.
 */
const { puerta, puedeLeer, noAutorizado, aTexto } = require('./_lib');
const T = require('./_tiktok');

/* Un intento suelto. Nunca revienta: lo que interesa es el parte de los
 * cuatro, no que el primero corte la pagina. */
async function probar(cuenta, nombre, opciones) {
  const t0 = Date.now();
  try {
    const r = await T.comoCuenta(cuenta, opciones);
    const d = r && r.data;
    return {
      que: nombre,
      ok: r && r.code === 0,
      code: r && r.code,
      mensaje: aTexto(r && r.message).slice(0, 200),
      ms: Date.now() - t0,
      /* Un resumen, no el volcado entero: aqui solo queremos saber si hay
       * datos al otro lado. */
      cuantos: d ? (Array.isArray(d.orders) ? d.orders.length
                  : Array.isArray(d.packages) ? d.packages.length
                  : Array.isArray(d.products) ? d.products.length
                  : Array.isArray(d.shops) ? d.shops.length
                  : Object.keys(d).length) : 0,
      claves: d ? Object.keys(d).slice(0, 8) : []
    };
  } catch (e) {
    return { que: nombre, ok: false, error: String((e && e.message) || e).slice(0, 300), ms: Date.now() - t0 };
  }
}

module.exports = puerta(async (req, res) => {
  if (!puedeLeer(req)) return noAutorizado(res, 'leer');
  const q = req.query || {};
  const cuenta = (aTexto(q.cuenta).trim() || 'billysvlc').toLowerCase();

  /* Las 24 horas de ayer y hoy: suficiente para que un dia de directo
   * devuelva algo, y poco para no pedirle a TikTok un historico entero. */
  const hasta = Math.floor(Date.now() / 1000);
  const desde = hasta - 36 * 3600;

  /* ?crudo=1 devuelve UN pedido tal cual lo manda TikTok, sin tocar. Es para
   * saber que campos hay de verdad antes de escribir codigo que los use: la
   * documentacion dice una cosa y la respuesta a veces dice otra. */
  /* LOS PAQUETES QUE TIKTOK DEJA COMBINAR. Solo mira, no combina nada.
   * Hace falta para el paso 3: es lo que hoy hace el dialogo de "combinar
   * pedidos", y combinar mal cuesta dos portes por comprador. */
  if (aTexto(q.crudo) === 'combinables') {
    const r = await T.comoCuenta(cuenta, {
      camino: '/fulfillment/202309/combinable_packages/search',
      params: { page_size: 20 }
    });
    return res.status(200).json({ ok: r && r.code === 0, code: r && r.code, mensaje: r && r.message, data: r && r.data });
  }

  /* Un paquete por dentro: de aqui sale si el envio lo pone la plataforma o
   * nosotros, y que hace falta para pedir la etiqueta. */
  if (aTexto(q.crudo) === 'paquete') {
    const r = await T.comoCuenta(cuenta, {
      camino: '/fulfillment/202309/packages/' + encodeURIComponent(aTexto(q.id))
    });
    return res.status(200).json({ ok: r && r.code === 0, code: r && r.code, mensaje: r && r.message, data: r && r.data });
  }

  /* LOS DIRECTOS DE LA TIENDA, tal cual. Es el unico sitio donde TikTok puede
   * decir de que cuenta es cada venta: el pedido no lo dice, la API de
   * afiliacion tampoco. Si aqui viene el nombre del creador, el rotulo de la
   * cuenta se resuelve solo y nadie tiene que escribir nada al crear el
   * articulo de subasta. */
  if (aTexto(q.crudo) === 'directos') {
    const hoy = new Date();
    const dia = (n) => new Date(hoy.getTime() - n * 86400000).toISOString().slice(0, 10);
    const r = await T.comoCuenta(cuenta, {
      camino: '/analytics/202509/shop_lives/performance',
      params: {
        start_date_ge: aTexto(q.desde) || dia(7),
        end_date_lt: aTexto(q.hasta) || dia(-1),
        page_size: 50
      }
    });
    return res.status(200).json({ ok: r && r.code === 0, code: r && r.code, mensaje: r && r.message, data: r && r.data });
  }

  /* Los productos vendidos en UN directo. La otra mitad del puente:
   * directo -> productos, y el directo si sabe de quien es. */
  if (aTexto(q.crudo) === 'directo') {
    const r = await T.comoCuenta(cuenta, {
      camino: '/analytics/202512/shop/' + encodeURIComponent(aTexto(q.live)) + '/products_performance',
      params: { page_size: 50 }
    });
    return res.status(200).json({ ok: r && r.code === 0, code: r && r.code, mensaje: r && r.message, data: r && r.data });
  }

  if (q.crudo !== undefined && aTexto(q.crudo) === 'productos') {
    /* Los productos de la tienda, para saber si el identificador de producto
     * es estable entre directos o si cambia cada dia. De eso depende que el
     * nombre de la cuenta se pueda poner en config.json una vez y ya. */
    const r = await T.comoCuenta(cuenta, {
      camino: '/product/202309/products/search', metodo: 'POST',
      params: { page_size: 50 }, cuerpo: {}
    });
    const lista = ((r && r.data && r.data.products) || []).map((p) => ({
      id: aTexto(p.id), titulo: aTexto(p.title), estado: aTexto(p.status),
      creado: p.create_time || null, tocado: p.update_time || null,
      skus: (p.skus || []).length
    }));
    return res.status(200).json({ ok: r && r.code === 0, cuantos: lista.length, productos: lista });
  }

  if (q.crudo !== undefined) {
    const r = await T.comoCuenta(cuenta, {
      camino: '/order/202309/orders/search', metodo: 'POST',
      params: { page_size: 1, sort_field: 'create_time', sort_order: 'DESC' },
      cuerpo: { order_status: 'AWAITING_SHIPMENT' }
    });
    const uno = ((r && r.data && r.data.orders) || [])[0] || null;
    return res.status(200).json({ ok: r && r.code === 0, code: r && r.code, mensaje: r && r.message, pedido: uno });
  }

  const partes = [];

  partes.push(await probar(cuenta, 'las tiendas autorizadas',
    { camino: '/authorization/202309/shops', cifra: false }));

  partes.push(await probar(cuenta, 'buscar pedidos (paso 2)',
    { camino: '/order/202309/orders/search', metodo: 'POST',
      params: { page_size: 10 },
      cuerpo: { create_time_ge: desde, create_time_lt: hasta } }));

  partes.push(await probar(cuenta, 'buscar paquetes (paso 3)',
    { camino: '/fulfillment/202309/packages/search', metodo: 'POST',
      params: { page_size: 10 }, cuerpo: {} }));

  partes.push(await probar(cuenta, 'buscar productos',
    { camino: '/product/202309/products/search', metodo: 'POST',
      params: { page_size: 5 }, cuerpo: {} }));

  const bien = partes.filter((p) => p.ok).length;
  return res.status(200).json({
    ok: bien === partes.length,
    cuenta,
    resumen: bien + ' de ' + partes.length + ' llamadas han contestado bien',
    partes
  });
});
