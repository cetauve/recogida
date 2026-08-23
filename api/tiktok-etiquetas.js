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
const { PDFDocument } = require('pdf-lib');
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

const DETALLE = (id) => '/fulfillment/202309/packages/' + encodeURIComponent(id);
const ENVIAR = (id) => '/fulfillment/202309/packages/' + encodeURIComponent(id) + '/ship';
const DOCUMENTO = (id) => '/fulfillment/202309/packages/' + encodeURIComponent(id) + '/shipping_documents';
const COMBINAR = '/fulfillment/202309/packages/combine';

/* ===========================================================================
 * JUNTAR LOS PEDIDOS DE UN COMPRADOR EN UN SOLO BULTO
 * ===========================================================================
 * Esto es lo que en el Centro de vendedores hacia el dialogo de "combinar
 * pedidos", y es la mitad del paso 3 que faltaba. Sin esto, cada pedido sale
 * por su cuenta: quien ha ganado seis pujas recibe seis paquetes y le pagas
 * seis portes. El 23 ago 2026 eran 250 portes de mas en un solo dia.
 *
 * VA SIEMPRE ANTES DE ENVIAR, Y SI FALLA NO SE ENVIA. Enviar sin haber juntado
 * es exactamente el error caro, asi que un fallo aqui para ese paquete entero.
 *
 * La documentacion no deja claro como se manda el cuerpo, asi que se prueban
 * las formas que tienen sentido y se guarda cual ha entrado. Solo se pasa a la
 * siguiente si la queja es de FORMA (parametro invalido o falta algo): si
 * TikTok se queja de otra cosa, cambiar de forma no arregla nada y solo
 * esconde el motivo.
 * ========================================================================= */
async function combinar(cuenta, grupo, pedidos) {
  const formas = [
    { como: 'combinable_packages', cuerpo: { combinable_packages: [{ id: grupo, order_ids: pedidos }] } },
    { como: 'combinable_package_id', cuerpo: { combinable_package_id: grupo, order_ids: pedidos } },
    { como: 'id+order_ids', cuerpo: { id: grupo, order_ids: pedidos } },
    { como: 'order_ids', cuerpo: { order_ids: pedidos } }
  ];
  const intentos = [];
  for (const f of formas) {
    let r = null;
    try {
      r = await T.comoCuenta(cuenta, { camino: COMBINAR, metodo: 'POST', cuerpo: f.cuerpo });
    } catch (e) {
      intentos.push({ como: f.como, mensaje: String((e && e.message) || e).slice(0, 160) });
      continue;
    }
    const mensaje = aTexto(r && r.message).slice(0, 160);
    intentos.push({ como: f.como, code: r && r.code, mensaje });
    if (r && r.code === 0) {
      const d = r.data || {};
      const nuevo = aTexto(d.package_id || d.id ||
        ((d.packages || [])[0] || {}).id ||
        ((d.combined_packages || [])[0] || {}).id);
      return { ok: true, como: f.como, paquete: nuevo, intentos, data: d };
    }
    if (!/param|invalid|required|missing|body|format/i.test(mensaje)) break;
  }
  return { ok: false, intentos };
}

/* TIKTOK TARDA UNOS SEGUNDOS EN DEJAR IMPRIMIR LO QUE ACABA DE ENVIAR.
 *
 * Un segundo despues del ship contesta "Documents couldn't be printed before
 * shipped"; seis segundos despues lo da a la primera. Comprobado el 23 ago
 * 2026. Es la tercera vez que TikTok va por detras de si mismo (las
 * cancelaciones y el buscador de pedidos hacen lo mismo), asi que aqui se
 * espera y se reintenta en vez de dar por perdida la etiqueta. */
const ESPERAS = [0, 3000, 5000, 8000];
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* La etiqueta de un paquete, ya creada. Devuelve la direccion del PDF. */
async function documentoDe(cuenta, paquete, tamano, insistir) {
  let ultimo = null;
  for (const espera of (insistir ? ESPERAS : [0])) {
    if (espera) await dormir(espera);
    const r = await T.comoCuenta(cuenta, {
      camino: DOCUMENTO(paquete),
      params: { document_type: 'SHIPPING_LABEL', document_size: tamano || 'A6' }
    });
    if (r && r.code === 0) {
      const d = r.data || {};
      return { ok: true, url: aTexto(d.doc_url || d.url), tipo: aTexto(d.doc_type) };
    }
    ultimo = { ok: false, mensaje: aTexto(r && r.message), code: r && r.code };
    /* Solo se insiste con el "todavia no": si el fallo es otro, insistir es
     * perder el tiempo y esconder el motivo. */
    if (!/before shipped|not shipped|arranged/i.test(ultimo.mensaje)) break;
  }
  return ultimo || { ok: false, mensaje: 'sin respuesta' };
}

/* Varias etiquetas en UN solo PDF, en el orden que se pidan.
 *
 * Es lo que hace que una tanda sea una impresion y no catorce. Y de paso el
 * orden lo ponemos nosotros: TikTok no sabe ordenar por numero de prendas, que
 * es justo el motivo por el que existen las tandas. */
async function juntarPdf(cuenta, paquetes, tamano) {
  const fuera = await PDFDocument.create();
  const fallos = [];
  for (const id of paquetes) {
    try {
      const doc = await documentoDe(cuenta, id, tamano, false);
      if (!doc.ok || !doc.url) { fallos.push({ paquete: id, mensaje: doc.mensaje }); continue; }
      const f = await fetch(doc.url);
      if (!f.ok) { fallos.push({ paquete: id, mensaje: 'la direccion de TikTok respondio ' + f.status }); continue; }
      const dentro = await PDFDocument.load(await f.arrayBuffer());
      const hojas = await fuera.copyPages(dentro, dentro.getPageIndices());
      for (const h of hojas) fuera.addPage(h);
    } catch (e) {
      fallos.push({ paquete: id, mensaje: String((e && e.message) || e).slice(0, 160) });
    }
  }
  return { pdf: Buffer.from(await fuera.save()), hojas: fuera.getPageCount(), fallos };
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
    /* Cada entrada puede venir como un id suelto —el paquete ya esta formado—
     * o como el bulto entero que hay que juntar antes: { paquete, grupo,
     * pedidos }. Lo segundo es lo que manda el paso 3, porque hasta que no se
     * combina no existe el paquete de verdad. */
    const ids = Array.isArray(b.paquetes) ? b.paquetes.map((x) => (
      (x && typeof x === 'object')
        ? { paquete: aTexto(x.paquete), grupo: aTexto(x.grupo || x.aCombinar),
            pedidos: (Array.isArray(x.pedidos) ? x.pedidos : []).map(aTexto).filter(Boolean) }
        : { paquete: aTexto(x), grupo: '', pedidos: [] }
    )).filter((x) => x.paquete || x.grupo) : [];
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
    for (const it of ids) {
      if (Date.now() - t0 > 40000) {
        /* Vercel corta a los 60 s. Lo que no ha dado tiempo se dice por su
         * nombre para que quien llama vuelva a pedir SOLO eso, en vez de
         * repetir la tanda entera y arriesgarse a etiquetar dos veces. */
        hechos.push({ paquete: it.paquete, grupo: it.grupo, ok: false, aTiempo: false,
                      mensaje: 'no ha dado tiempo, vuelve a pedirlo' });
        continue;
      }
      let id = it.paquete;
      const paso = { paquete: id, grupo: it.grupo || null };
      try {
        /* 0. JUNTAR PRIMERO. Si este comprador tiene varios pedidos sueltos,
         *    van a un solo bulto antes de enviar nada. Si no se puede juntar,
         *    NO se envia: enviar sin juntar es pagar un porte por pedido. */
        if (it.grupo && it.pedidos.length > 1) {
          const c = await combinar(cuenta, it.grupo, it.pedidos);
          paso.juntados = it.pedidos.length;
          paso.comoSeJunta = c.como || null;
          if (!c.ok) {
            paso.ok = false;
            paso.mensaje = 'no he podido juntar los ' + it.pedidos.length + ' pedidos de este ' +
              'comprador, asi que NO lo envio: ' + ((c.intentos[c.intentos.length - 1] || {}).mensaje || '');
            paso.intentos = c.intentos;
            hechos.push(paso);
            continue;
          }
          if (c.paquete) { id = c.paquete; paso.paquete = id; }
        }

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
        const doc = await documentoDe(cuenta, id, aTexto(b.tamano), true);
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

  /* ---------- juntar UN grupo, a mano ----------
   * Para comprobar contra TikTok que forma acepta la llamada de combinar sin
   * jugarsela con una tanda entera. Hay que decir el grupo Y sus pedidos: aqui
   * no existe "juntalo todo". Juntar no cierra nada ni compra ningun porte
   * —eso lo hace enviar—, asi que se puede probar con un comprador de verdad. */
  if (aTexto(q.combinar)) {
    const suyos = aTexto(q.pedidos).split(',').map((x) => x.trim()).filter(Boolean);
    if (suyos.length < 2) {
      return res.status(400).json({ ok: false, error: 'sin-pedidos',
        detalle: 'Dime los pedidos del comprador separados por comas. Juntar uno solo no es juntar.' });
    }
    const c = await combinar(cuenta0, aTexto(q.combinar), suyos);
    return res.status(200).json(c);
  }

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
    const doc = await documentoDe(cuenta0, aTexto(q.pdf), aTexto(q.tamano), true);
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
        numeros: [], piezas: [], aCombinar: grupo, yaTieneEtiqueta: false
      });
    }
    const p = paquetes.get(clave);
    p.pedidos.push(aTexto(o.id));
    p.prendas += vivas.length;
    for (const l of vivas) {
      const n = parseInt(aTexto(l.seller_sku).replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) p.numeros.push(n);
      p.piezas.push({ num: Number.isFinite(n) ? n : null, rack: aTexto(l.product_id) });
      if (aTexto(l.tracking_number)) p.yaTieneEtiqueta = true;
    }
  }

  const lista = [...paquetes.values()].filter((p) => p.prendas > 0);
  for (const p of lista) p.numeros.sort((a, b) => a - b);

  /* EL ORDEN DEL TACO TIENE QUE SER EL DE LAS TARJETAS.
   *
   * Esta regla NO es mia: esta copiada de calcularTandas() en flujo.js, que es
   * la que ordena las tarjetas que ven quien recoge y quien empaqueta. Si las
   * dos no dicen lo mismo, el empaquetador tiene delante una tarjeta y en la
   * mano la etiqueta de otro. Paso el 11 ago 2026 por ordenar solo por numero
   * de prendas. SI SE TOCA UNA, SE TOCA LA OTRA.
   *
   *   1. Los racks se recorren de mas prendas a menos (cuentasDe).
   *   2. Dentro de un paquete, las prendas van por rack y luego por numero.
   *   3. El CIERRE de un paquete es el numero mas alto del ULTIMO rack que se
   *      recorre: el momento en que ese paquete se puede cerrar.
   *   4. En la tanda: por numero de prendas, y a igualdad, por cierre.
   */
  const porRack = new Map();
  for (const p of lista) for (const x of p.piezas) porRack.set(x.rack, (porRack.get(x.rack) || 0) + 1);
  const ordenRack = new Map([...porRack.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([k], i) => [k, i]));
  const rack = (r) => (ordenRack.get(r) == null ? 99 : ordenRack.get(r));

  for (const p of lista) {
    p.piezas.sort((a, b) => rack(a.rack) - rack(b.rack) ||
                            ((a.num == null ? 1e9 : a.num) - (b.num == null ? 1e9 : b.num)));
    const ultimo = p.piezas.length ? p.piezas[p.piezas.length - 1].rack : '';
    const delUltimo = p.piezas.filter((x) => x.rack === ultimo);
    p.cierre = delUltimo.length ? Math.max(...delUltimo.map((x) => x.num || 0)) : 0;
    p.ordenCierre = rack(ultimo) * 1e6 + p.cierre;
  }

  const tandas = cortes.map(([min, max]) => {
    const dentro = lista.filter((p) => p.prendas >= min && p.prendas <= max);
    dentro.sort((a, b) => a.prendas - b.prendas || (a.ordenCierre || 0) - (b.ordenCierre || 0));
    return {
      tanda: min === max ? String(min) + ' prenda' : min + '-' + (max >= 999 ? '+' : max) + ' prendas',
      min, max,
      paquetes: dentro.length,
      prendas: dentro.reduce((a, p) => a + p.prendas, 0),
      /* El orden en que saldrian las etiquetas del PDF. */
      orden: dentro.map((p) => ({ paquete: p.paquete, comprador: p.comprador,
                                  prendas: p.prendas, del: p.numeros[0], al: p.numeros[p.numeros.length - 1],
                                  cierre: p.cierre, aCombinar: p.aCombinar,
                                  /* Los pedidos van con el bulto: hasta que no se
                                   * juntan, el paquete de verdad no existe, y quien
                                   * llame al POST necesita saber que junta. */
                                  pedidos: p.pedidos }))
    };
  });

  const sinTanda = lista.filter((p) => !cortes.some(([a, b]) => p.prendas >= a && p.prendas <= b));

  /* ---------- UNA TANDA ENTERA, EN UN SOLO PDF ----------
   * ?tandaPdf=3 devuelve las etiquetas de la tanda 3 pegadas y en el orden de
   * las tarjetas. Una direccion, una impresion. Solo junta lo que YA tiene
   * etiqueta: esto no crea ninguna. */
  const cual = aEntero(q.tandaPdf);
  if (cual != null) {
    const t = tandas[cual - 1];
    if (!t) return res.status(400).json({ ok: false, error: 'tanda', detalle: 'Solo hay ' + tandas.length + ' tandas.' });
    if (!t.orden.length) return res.status(400).json({ ok: false, error: 'tanda-vacia', detalle: 'La tanda ' + cual + ' no tiene paquetes.' });

    const junto = await juntarPdf(cuenta, t.orden.map((p) => p.paquete), aTexto(q.tamano));
    if (!junto.hojas) {
      return res.status(502).json({ ok: false, error: 'sin-etiquetas',
        detalle: 'Ninguno de los ' + t.orden.length + ' paquetes tiene etiqueta todavia. Hay que crearlas primero.',
        fallos: junto.fallos.slice(0, 5) });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="tanda-' + cual + '.pdf"');
    /* Si alguna se ha quedado fuera se dice en una cabecera: el PDF sale igual
     * —mas vale imprimir 13 que ninguna— pero queda constancia de cual falta. */
    if (junto.fallos.length) res.setHeader('X-Billys-Fallos', String(junto.fallos.length));
    return res.status(200).end(junto.pdf);
  }

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
