/* /api/tiktok-pedidos — el paso 2, sin leer la pantalla.
 *
 * Devuelve los pedidos pendientes de envio CON LA MISMA FORMA que tenian
 * cuando se sacaban raspando el Centro de vendedores. Eso es a proposito: el
 * calculo de tandas, la app del almacen y las siete pestañas del panel ya
 * saben leer ese objeto y no hay que tocar ni una linea de todo eso.
 *
 *   GET ?d=CODIGO&cuenta=billysvlc[&token=...]
 *
 * QUE DA LA API Y QUE NO:
 *   seller_sku    -> el numero de la prenda (aqui llega "361", tal cual)
 *   product_id    -> con que cuenta se vendio; es la clave que separa los racks
 *   user_id       -> el comprador. Es mejor clave que el @usuario: un nick se
 *                    cambia, esto no.
 *   recipient_address.name -> el nombre que va impreso en la etiqueta, que es
 *                    lo que ve quien empaqueta. El @usuario de TikTok NO lo da
 *                    la API, por privacidad.
 *   tracking_number viene vacio hasta que se crea la etiqueta. Por eso el
 *                    manifiesto sigue siendo un paso aparte y no sale de aqui.
 *
 * LOS PEDIDOS SE GUARDAN POR ID, NO SE APILAN.
 * TikTok puede devolver el mismo pedido en dos paginas si algo cambia mientras
 * se recorre —lo mismo que hacia que el paso 1 contara 34 donde habia 29—. Con
 * un mapa por id eso no puede inflar nada.
 */
const { puerta, puedeLeer, noAutorizado, aTexto, aNumero } = require('./_lib');
const T = require('./_tiktok');

const BUSCAR = '/order/202309/orders/search';
const LIMITE_MS = 8000;
const POR_PAGINA = 50;

/* Una prenda que no se va a enviar: cancelada, devuelta o en reembolso. Se lee
 * y se cuenta, pero no entra en las tandas. */
const parada = (estado) => /CANCEL|RETURN|REFUND/i.test(aTexto(estado));

function nombreDe(o) {
  const d = o.recipient_address || {};
  const entero = aTexto(d.name).trim();
  if (entero) return entero;
  return [aTexto(d.first_name), aTexto(d.last_name)].filter(Boolean).join(' ').trim();
}

function aPedido(o) {
  const lineas = o.line_items || [];

  const bultos = new Map();
  for (const l of lineas) {
    const k = aTexto(l.package_id);
    if (!k) continue;
    if (!bultos.has(k)) {
      bultos.set(k, {
        bulto: k,
        tracking: aTexto(l.tracking_number),
        transportista: aTexto(l.shipping_provider_name),
        etiqueta: '',
        skus: []
      });
    }
    const b = bultos.get(k);
    if (!b.tracking) b.tracking = aTexto(l.tracking_number);
    b.skus.push(aTexto(l.sku_id));
  }
  for (const p of (o.packages || [])) {
    const k = aTexto(p.id);
    if (k && !bultos.has(k)) bultos.set(k, { bulto: k, tracking: '', transportista: '', etiqueta: '', skus: [] });
  }

  return {
    pedido: aTexto(o.id),
    usuario: aTexto(o.user_id),
    apodo: nombreDe(o) || aTexto(o.user_id),
    creado: o.create_time ? Number(o.create_time) * 1000 : null,
    estado: aTexto(o.status),
    subestado: aTexto((lineas[0] || {}).display_status),
    reverso: lineas.some((l) => parada(l.display_status)),
    prendas: lineas.map((l) => {
      /* El numero sale del SKU del vendedor, que es la ficha fisica. Mismo
       * criterio que cuando se leia de la pantalla: se cogen solo las cifras,
       * porque a veces llega como "361" y a veces con algo pegado delante. */
      const etiqueta = aTexto(l.seller_sku) || aTexto(l.sku_name);
      const n = parseInt(String(etiqueta).replace(/[^\d]/g, ''), 10);
      const precio = aNumero(l.sale_price) || 0;
      return {
        num: Number.isFinite(n) ? n : null,
        etiquetaPrenda: etiqueta,
        skuId: aTexto(l.sku_id),
        producto: aTexto(l.product_name),
        /* El rotulo de la cuenta (billysvlc / billystourvlc) no lo da la API.
         * El reparto por racks no lo necesita: se hace por productoId, que si
         * viene. Quien pinta el panel le pone nombre si lo sabe. */
        productoId: aTexto(l.product_id),
        cuenta: '',
        cantidad: 1,
        precio, total: precio,
        reverso: parada(l.display_status),
        bulto: aTexto(l.package_id),
        tracking: aTexto(l.tracking_number)
      };
    }),
    unidades: [...bultos.values()]
  };
}

module.exports = puerta(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'metodo' });
  if (!puedeLeer(req)) return noAutorizado(res, 'leer');

  const q = req.query || {};
  const cuenta = (aTexto(q.cuenta).trim() || 'billysvlc').toLowerCase();
  const t0 = Date.now();

  const porId = new Map();
  let token = aTexto(q.token);
  let total = null;
  let leidas = 0;
  let corto = false;

  while (true) {
    const params = { page_size: POR_PAGINA, sort_field: 'create_time', sort_order: 'ASC' };
    if (token) params.page_token = token;

    const r = await T.comoCuenta(cuenta, {
      camino: BUSCAR, metodo: 'POST', params,
      cuerpo: { order_status: 'AWAITING_SHIPMENT' }
    });
    if (!r || r.code !== 0) {
      return res.status(502).json({
        ok: false, error: 'tiktok',
        detalle: aTexto(r && r.message) || 'TikTok no ha devuelto los pedidos',
        code: r && r.code, leidos: porId.size
      });
    }

    const d = r.data || {};
    for (const o of (d.orders || [])) {
      const p = aPedido(o);
      if (p.pedido) porId.set(p.pedido, p);
    }
    leidas++;
    if (total == null && d.total_count != null) total = Number(d.total_count);
    token = aTexto(d.next_page_token);

    if (!token) break;
    /* Vercel corta a los diez segundos. Se devuelve por donde iba y quien
     * llama sigue: es feo, pero media lista que se sabe a medias es mucho
     * mejor que media lista que se cree entera. */
    if (Date.now() - t0 > LIMITE_MS) { corto = true; break; }
  }

  return res.status(200).json({
    ok: true,
    cuenta,
    pedidos: [...porId.values()],
    total,
    leidas,
    siguiente: corto ? token : '',
    sigue: corto,
    ms: Date.now() - t0
  });
});
