/* /api/tiktok-etiquetas — el paso 3, de momento SOLO MIRANDO.
 *
 * Esta puerta no crea ni una etiqueta. Enseña exactamente lo que se haria:
 * que se combinaria con que, cuantos paquetes saldrian, cuantas prendas lleva
 * cada uno y en que tanda cae. Sirve para comprobar el paso 3 entero sin
 * gastar un solo porte.
 *
 * Se hace asi porque CREAR LA ETIQUETA NO TIENE VUELTA ATRAS: cierra el
 * paquete y compra el envio. Todo lo demas de la API se puede repetir; esto
 * no. Asi que primero se mira, y el dia que se apriete de verdad sera con otra
 * puerta y empezando por un paquete, no por trescientos.
 *
 *   GET ?d=CODIGO&cuenta=billysvlc[&cortes=1-1,2-3,4-6,7-10,11-999]
 *
 * DE DONDE SALE CADA COSA:
 *   los pedidos      -> /order/202309/orders/search   (AWAITING_SHIPMENT)
 *   que se combina   -> /fulfillment/202309/combinable_packages/search
 *   el paquete       -> package_id, que ya viene en cada linea del pedido
 *
 * LAS TANDAS SE MANTIENEN. Son un apaño de impresion —TikTok no sabe ordenar
 * por numero de prendas— pero ademas es como esta organizado el trabajo en la
 * app del almacen, asi que aqui se respetan tal cual.
 */
const { puerta, puedeLeer, noAutorizado, aTexto, aEntero } = require('./_lib');
const T = require('./_tiktok');

const PEDIDOS = '/order/202309/orders/search';
const COMBINABLES = '/fulfillment/202309/combinable_packages/search';
const LIMITE_MS = 25000;
const POR_PAGINA = 50;

const CORTES = [[1, 1], [2, 3], [4, 6], [7, 10], [11, 999]];

function leerCortes(texto) {
  const t = aTexto(texto).trim();
  if (!t) return CORTES;
  const fuera = [];
  for (const trozo of t.split(',')) {
    const [a, b] = trozo.split('-').map((x) => aEntero(x));
    if (a != null && b != null) fuera.push([a, b]);
  }
  return fuera.length ? fuera : CORTES;
}

/* Una prenda que no se va a enviar no cuenta para el tamaño del paquete: si
 * contara, un paquete de 6 con 4 canceladas caeria en la tanda que no es. */
const parada = (estado) => /CANCEL|RETURN|REFUND/i.test(aTexto(estado));

async function todosLosPedidos(cuenta, t0) {
  const porId = new Map();
  let token = '', total = null;
  for (let vuelta = 0; vuelta < 40; vuelta++) {
    const params = { page_size: POR_PAGINA, sort_field: 'create_time', sort_order: 'ASC' };
    if (token) params.page_token = token;
    const r = await T.comoCuenta(cuenta, {
      camino: PEDIDOS, metodo: 'POST', params, cuerpo: { order_status: 'AWAITING_SHIPMENT' }
    });
    if (!r || r.code !== 0) throw new Error('pedidos: ' + aTexto(r && r.message));
    const d = r.data || {};
    for (const o of (d.orders || [])) if (o && o.id) porId.set(aTexto(o.id), o);
    if (total == null && d.total_count != null) total = Number(d.total_count);
    token = aTexto(d.next_page_token);
    if (!token || Date.now() - t0 > LIMITE_MS) break;
  }
  return { pedidos: [...porId.values()], total, corto: !!token };
}

async function todosLosCombinables(cuenta, t0) {
  const grupos = [];
  let token = '';
  for (let vuelta = 0; vuelta < 20; vuelta++) {
    const params = { page_size: 50 };
    if (token) params.page_token = token;
    const r = await T.comoCuenta(cuenta, { camino: COMBINABLES, params });
    if (!r || r.code !== 0) throw new Error('combinables: ' + aTexto(r && r.message));
    const d = r.data || {};
    for (const g of (d.combinable_packages || [])) {
      grupos.push({ id: aTexto(g.id), pedidos: (g.order_ids || []).map(aTexto) });
    }
    token = aTexto(d.next_page_token);
    if (!token || Date.now() - t0 > LIMITE_MS) break;
  }
  return grupos;
}

module.exports = puerta(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'metodo' });
  if (!puedeLeer(req)) return noAutorizado(res, 'leer');

  const q = req.query || {};
  const cuenta = (aTexto(q.cuenta).trim() || 'billysvlc').toLowerCase();
  const cortes = leerCortes(q.cortes);
  const t0 = Date.now();

  const { pedidos, total, corto } = await todosLosPedidos(cuenta, t0);
  const grupos = await todosLosCombinables(cuenta, t0);

  /* Que pedidos estan pendientes de juntarse con otros del mismo comprador. Si
   * se etiqueta uno de estos por su cuenta, ese comprador acaba con dos bultos
   * y se pagan dos portes: por eso combinar va SIEMPRE antes que etiquetar. */
  const enGrupo = new Map();
  for (const g of grupos) for (const p of g.pedidos) enGrupo.set(p, g.id);

  /* El paquete es la unidad de etiqueta. Viene en cada linea del pedido, asi
   * que no hace falta preguntar por el aparte. */
  const paquetes = new Map();
  const sueltos = [];
  for (const o of pedidos) {
    const lineas = o.line_items || [];
    const vivas = lineas.filter((l) => !parada(l.display_status));
    const idPaquete = aTexto((lineas.find((l) => l.package_id) || {}).package_id) ||
                      aTexto(((o.packages || [])[0] || {}).id);
    const nombre = aTexto((o.recipient_address || {}).name);

    if (!idPaquete) { sueltos.push({ pedido: aTexto(o.id), comprador: nombre }); continue; }

    if (!paquetes.has(idPaquete)) {
      paquetes.set(idPaquete, {
        paquete: idPaquete, comprador: nombre, pedidos: [], prendas: 0,
        numeros: [], aCombinar: null, yaTieneEtiqueta: false
      });
    }
    const p = paquetes.get(idPaquete);
    p.pedidos.push(aTexto(o.id));
    p.prendas += vivas.length;
    for (const l of vivas) {
      const n = parseInt(aTexto(l.seller_sku).replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) p.numeros.push(n);
      if (aTexto(l.tracking_number)) p.yaTieneEtiqueta = true;
    }
    if (enGrupo.has(aTexto(o.id))) p.aCombinar = enGrupo.get(aTexto(o.id));
  }

  /* Las tandas, con el mismo criterio de siempre: de menos prendas a mas. */
  const lista = [...paquetes.values()].filter((p) => p.prendas > 0);
  for (const p of lista) p.numeros.sort((a, b) => a - b);

  const tandas = cortes.map(([min, max]) => {
    const dentro = lista.filter((p) => p.prendas >= min && p.prendas <= max);
    /* Dentro de la tanda, por el numero mas bajo: es el orden en que quien
     * recoge recorre el perchero, y sera el orden del taco de etiquetas. */
    dentro.sort((a, b) => (a.numeros[0] || 0) - (b.numeros[0] || 0));
    return {
      tanda: min === max ? String(min) + ' prenda' : min + '-' + (max >= 999 ? '+' : max) + ' prendas',
      min, max,
      paquetes: dentro.length,
      prendas: dentro.reduce((a, p) => a + p.prendas, 0),
      /* El orden en que saldrian las etiquetas del PDF. */
      orden: dentro.map((p) => ({ paquete: p.paquete, comprador: p.comprador,
                                  prendas: p.prendas, del: p.numeros[0], al: p.numeros[p.numeros.length - 1],
                                  aCombinar: p.aCombinar }))
    };
  });

  const sinTanda = lista.filter((p) => !cortes.some(([a, b]) => p.prendas >= a && p.prendas <= b));

  return res.status(200).json({
    ok: true,
    enSeco: true,
    aviso: 'Esto NO ha creado ninguna etiqueta ni ha combinado nada. Solo mira.',
    cuenta,
    resumen: {
      pedidos: pedidos.length, totalQueDiceTikTok: total, listaCompleta: !corto,
      paquetes: lista.length,
      prendas: lista.reduce((a, p) => a + p.prendas, 0),
      gruposACombinar: grupos.length,
      pedidosDentroDeEsosGrupos: grupos.reduce((a, g) => a + g.pedidos.length, 0),
      paquetesQueYaTienenEtiqueta: lista.filter((p) => p.yaTieneEtiqueta).length,
      pedidosSinPaquete: sueltos.length,
      paquetesFueraDeTanda: sinTanda.length
    },
    /* Lo que se llamaria si esto no fuera en seco. Escrito para poder contarlo
     * antes de apretar, no despues. */
    llamadasQueHaria: {
      'packages/combine': grupos.length,
      'packages/{id}/ship': lista.length,
      'packages/{id}/shipping_documents': lista.length
    },
    tandas,
    sinTanda: sinTanda.map((p) => ({ paquete: p.paquete, prendas: p.prendas })),
    sueltos,
    ms: Date.now() - t0
  });
});
