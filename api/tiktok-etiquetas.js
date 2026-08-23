/* /api/tiktok-etiquetas — el paso 3.
 *
 *   GET  ?d=CODIGO                      el parte EN SECO: que se haria
 *   GET  ?d=CODIGO&paquete=<id>         un paquete por dentro, para mirar
 *   GET  ?d=CODIGO&pdf=<id>             la etiqueta en PDF (por aqui, no
 *                                       directa, porque la de TikTok caduca y
 *                                       no deja que la lea otra pagina)
 *   POST { accion:'etiquetar', paquetes:[ids], hacer:true }   de verdad
 *
 * TODO VIVE EN UNA SOLA PUERTA A PROPOSITO: el plan gratis de Vercel solo deja
 * doce funciones y estamos en doce. Cada rama nueva aqui es una funcion que no
 * hay que crear.
 *
 * CREAR LA ETIQUETA NO TIENE VUELTA ATRAS: cierra el paquete y compra el
 * envio. Por eso el POST no hace nada sin `hacer: true` y sin una lista
 * explicita de paquetes: no existe el "etiquetalo todo" por accidente.
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
const { puerta, puedeLeer, puedeEscribir, noAutorizado, aTexto, aEntero, cuerpo } = require('./_lib');
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
  const q = req.query || {};
  const cuenta0 = (aTexto(q.cuenta).trim() || 'billysvlc').toLowerCase();

  /* ---------- crear las etiquetas DE VERDAD ---------- */
  if (req.method === 'POST') {
    if (!puedeEscribir(req)) return noAutorizado(res, 'escribir');
    const b = cuerpo(req);
    const cuenta = (aTexto(b.cuenta).trim() || cuenta0);
    if (aTexto(b.accion) !== 'etiquetar') {
      return res.status(400).json({ ok: false, error: 'accion', detalle: "Solo entiendo { accion: 'etiquetar' }" });
    }
    const ids = Array.isArray(b.paquetes) ? b.paquetes.map(aTexto).filter(Boolean) : [];
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: 'sin-paquetes',
        detalle: 'Dime QUE paquetes. Aqui no hay "todos": etiquetar no tiene vuelta atras.' });
    }
    if (b.hacer !== true) {
      return res.status(400).json({ ok: false, error: 'sin-confirmar',
        detalle: 'Falta hacer:true. Son ' + ids.length + ' etiquetas y no se pueden deshacer.' });
    }

    const t0 = Date.now();
    const hechos = [];
    for (const id of ids) {
      if (Date.now() - t0 > 40000) { hechos.push({ paquete: id, ok: false, mensaje: 'no ha dado tiempo, vuelve a pedirlo' }); continue; }
      const paso = { paquete: id };
      try {
        /* 1. Enviar: esto es lo que crea la etiqueta y cierra el paquete. El
         *    cuerpo va tal cual lo mande quien llama (vacio por defecto), para
         *    no inventarse un metodo de entrega que nadie ha pedido. */
        const r = await T.comoCuenta(cuenta, {
          camino: ENVIAR(id), metodo: 'POST',
          params: { idempotency_key: id },
          cuerpo: b.envio || {}
        });
        paso.enviado = !!(r && r.code === 0);
        paso.code = r && r.code;
        paso.mensaje = aTexto(r && r.message).slice(0, 200);

        /* 2. La etiqueta. Se pide aunque el envio se queje: si el paquete ya
         *    estaba enviado de antes, el PDF sigue existiendo. */
        const doc = await documentoDe(cuenta, id, aTexto(b.tamano));
        paso.ok = doc.ok;
        paso.pdf = doc.url || null;
        if (!doc.ok && doc.mensaje) paso.mensajePdf = doc.mensaje;
      } catch (e) {
        paso.ok = false;
        paso.mensaje = String((e && e.message) || e).slice(0, 200);
      }
      hechos.push(paso);
    }

    const bien = hechos.filter((x) => x.ok).length;
    return res.status(200).json({
      ok: bien === hechos.length, cuenta,
      pedidas: ids.length, conEtiqueta: bien,
      /* Las etiquetas en el MISMO orden en que se pidieron: quien llama ya las
       * mando ordenadas por tanda, asi que el taco sale ordenado. */
      etiquetas: hechos, ms: Date.now() - t0
    });
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'metodo' });
  if (!puedeLeer(req)) return noAutorizado(res, 'leer');

  /* ---------- un paquete por dentro ---------- */
  if (aTexto(q.paquete)) {
    const r = await T.comoCuenta(cuenta0, { camino: DETALLE(aTexto(q.paquete)) });
    return res.status(200).json({ ok: r && r.code === 0, code: r && r.code, mensaje: r && r.message, data: r && r.data });
  }

  /* ---------- el PDF de una etiqueta, servido desde aqui ----------
   * La direccion que da TikTok caduca y no se puede leer desde otra pagina
   * (el navegador lo corta). Pasandola por aqui, la pagina de imprimir puede
   * juntar las etiquetas en un solo PDF sin pelearse con nadie. */
  if (aTexto(q.pdf)) {
    const doc = await documentoDe(cuenta0, aTexto(q.pdf), aTexto(q.tamano));
    if (!doc.ok || !doc.url) return res.status(502).json({ ok: false, error: 'sin-documento', detalle: doc.mensaje || 'TikTok no ha dado la etiqueta' });
    const f = await fetch(doc.url);
    if (!f.ok) return res.status(502).json({ ok: false, error: 'sin-pdf', detalle: 'la direccion de TikTok ha respondido ' + f.status });
    const bytes = Buffer.from(await f.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="etiqueta-' + aTexto(q.pdf) + '.pdf"');
    return res.status(200).end(bytes);
  }

  const cuenta = cuenta0;
  const cortes = leerCortes(q.cortes);
  const t0 = Date.now();

  const { pedidos, total, corto } = await todosLosPedidos(cuenta, t0);
  const grupos = await todosLosCombinables(cuenta, t0);

  /* Que pedidos estan pendientes de juntarse con otros del mismo comprador. Si
   * se etiqueta uno de estos por su cuenta, ese comprador acaba con dos bultos
   * y se pagan dos portes: por eso combinar va SIEMPRE antes que etiquetar. */
  const enGrupo = new Map();
  for (const g of grupos) for (const p of g.pedidos) enGrupo.set(p, g.id);

  /* EL PAQUETE DE VERDAD ES EL DE DESPUES DE COMBINAR.
   *
   * Hoy, antes de combinar, cada pedido es su propio bulto de una prenda: si
   * se calculan las tandas ahora, salen 324 paquetes de 1 prenda y las tandas
   * no significan nada. El bulto que se va a etiquetar es el que resulta de
   * juntar los pedidos de un mismo comprador, asi que la clave es el grupo
   * combinable cuando lo hay, y el package_id cuando no.
   *
   * Los grupos traen tambien pedidos que no estan en nuestra lista (de otros
   * dias o ya enviados). Se ignoran: aqui solo cuentan los que se van a
   * etiquetar hoy. */
  const paquetes = new Map();
  const sueltos = [];
  for (const o of pedidos) {
    const lineas = o.line_items || [];
    const vivas = lineas.filter((l) => !parada(l.display_status));
    const idPaquete = aTexto((lineas.find((l) => l.package_id) || {}).package_id) ||
                      aTexto(((o.packages || [])[0] || {}).id);
    const nombre = aTexto((o.recipient_address || {}).name);

    const grupo = enGrupo.get(aTexto(o.id)) || null;
    const clave = grupo || idPaquete;
    if (!clave) { sueltos.push({ pedido: aTexto(o.id), comprador: nombre }); continue; }

    if (!paquetes.has(clave)) {
      paquetes.set(clave, {
        paquete: idPaquete, comprador: nombre, pedidos: [], prendas: 0,
        numeros: [], aCombinar: grupo, yaTieneEtiqueta: false
      });
    }
    const p = paquetes.get(clave);
    p.pedidos.push(aTexto(o.id));
    p.prendas += vivas.length;
    for (const l of vivas) {
      const n = parseInt(aTexto(l.seller_sku).replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) p.numeros.push(n);
      if (aTexto(l.tracking_number)) p.yaTieneEtiqueta = true;
    }
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
      /* Paquetes DESPUES de combinar, que son los que se van a etiquetar. */
      paquetes: lista.length,
      prendas: lista.reduce((a, p) => a + p.prendas, 0),
      gruposACombinar: grupos.length,
      pedidosDentroDeEsosGrupos: grupos.reduce((a, g) => a + g.pedidos.length, 0),
      /* De esos grupos, los que de verdad tocan a la lista de hoy. El resto
       * son de otros dias o ya enviados y no se van a tocar. */
      gruposQueTocanAHoy: lista.filter((p) => p.aCombinar).length,
      pedidosQueSeJuntan: lista.filter((p) => p.aCombinar).reduce((a, p) => a + p.pedidos.length, 0),
      /* Lo que se ahorra: cada pedido que se junta con otro es un porte menos. */
      portesQueSeAhorran: lista.filter((p) => p.aCombinar).reduce((a, p) => a + p.pedidos.length - 1, 0),
      paquetesQueYaTienenEtiqueta: lista.filter((p) => p.yaTieneEtiqueta).length,
      pedidosSinPaquete: sueltos.length,
      paquetesFueraDeTanda: sinTanda.length
    },
    /* Lo que se llamaria si esto no fuera en seco. Escrito para poder contarlo
     * antes de apretar, no despues. */
    llamadasQueHaria: {
      'packages/combine': grupos.length,
      'packages/combine (solo los de hoy)': lista.filter((p) => p.aCombinar).length,
      'packages/{id}/ship': lista.length,
      'packages/{id}/shipping_documents': lista.length
    },
    tandas,
    sinTanda: sinTanda.map((p) => ({ paquete: p.paquete, prendas: p.prendas })),
    sueltos,
    ms: Date.now() - t0
  });
});
