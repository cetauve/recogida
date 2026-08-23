/* /api/tiktok-cancelaciones — el paso 1, sin mirar la pantalla.
 *
 * Hasta hoy esto era: abrir la pestaña de cancelaciones, esperar a que cargue,
 * pulsar "aprobar" una por una y fiarse de un contador que mentia ("68
 * aprobadas, quedan 34" con TikTok enseñando 0). Aqui se pregunta cuantas hay
 * y se aprueban por su id. Si quedan 0, es que quedan 0.
 *
 *   GET   ?d=CODIGO&cuenta=billysvlc          mirar, sin tocar nada
 *   POST  { accion:'aprobar', cuenta, ids? }  aprobar (token de escritura)
 *
 * POR QUE VUELVE A MEDIAS Y HAY QUE VOLVER A LLAMAR:
 * Una lambda de Vercel se corta a los diez segundos. Un dia de 68
 * cancelaciones no cabe en una sola llamada, asi que esta puerta trabaja ocho
 * segundos, devuelve lo hecho y dice `sigue: true`. Quien llama repite hasta
 * que diga que no. Es feo pero es honesto: lo otro es que se corte a la mitad
 * y nadie sepa por donde iba.
 *
 * EL IDEMPOTENCY KEY ES EL cancel_id. Si una llamada se corta despues de
 * aprobar pero antes de contestar, el reintento no aprueba dos veces.
 */
const { puerta, puedeEscribir, puedeLeer, noAutorizado, aTexto, cuerpo } = require('./_lib');
const T = require('./_tiktok');

const BUSCAR = '/return_refund/202602/cancellations/search';
const APROBAR = (id) => '/return_refund/202309/cancellations/' + encodeURIComponent(id) + '/approve';

/* Solo las que esperan a que nosotros decidamos. Las que cancela el sistema o
 * nosotros mismos ya estan cerradas y no hay nada que aprobar. */
const PENDIENTES = {
  cancel_types: ['BUYER_CANCEL'],
  cancel_status: ['CANCELLATION_REQUEST_PENDING']
};

const LIMITE_MS = 8000;
const A_LA_VEZ = 5;

async function pendientes(cuenta, tope = 500) {
  const lista = [];
  let token = '';
  for (let vuelta = 0; vuelta < 20; vuelta++) {
    const params = { page_size: 50, sort_field: 'create_time', sort_order: 'ASC' };
    if (token) params.page_token = token;
    const r = await T.comoCuenta(cuenta, { camino: BUSCAR, metodo: 'POST', params, cuerpo: PENDIENTES });
    if (!r || r.code !== 0) {
      const e = new Error('TikTok no ha querido dar las cancelaciones: ' + aTexto(r && r.message));
      e.code = r && r.code;
      throw e;
    }
    const d = r.data || {};
    for (const c of (d.cancellations || [])) {
      lista.push({
        id: aTexto(c.cancel_id || c.id),
        pedido: aTexto(c.order_id),
        motivo: aTexto(c.cancel_reason || c.cancel_reason_text),
        en: c.create_time || null
      });
    }
    token = aTexto(d.next_page_token);
    if (!token || lista.length >= tope) break;
  }
  return lista;
}

async function aprobarUna(cuenta, id) {
  try {
    const r = await T.comoCuenta(cuenta, {
      camino: APROBAR(id), metodo: 'POST',
      params: { idempotency_key: id }, cuerpo: {}
    });
    if (r && r.code === 0) return { id, ok: true };
    return { id, ok: false, code: r && r.code, mensaje: aTexto(r && r.message).slice(0, 200) };
  } catch (e) {
    return { id, ok: false, mensaje: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = puerta(async (req, res) => {
  const q = req.query || {};
  const b = cuerpo(req);
  const cuenta = (aTexto(b.cuenta || q.cuenta).trim() || 'billysvlc').toLowerCase();

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const lista = await pendientes(cuenta);
    return res.status(200).json({ ok: true, cuenta, quedan: lista.length, cancelaciones: lista });
  }

  if (req.method === 'POST') {
    if (!puedeEscribir(req)) return noAutorizado(res, 'escribir');
    if (aTexto(b.accion) !== 'aprobar') {
      return res.status(400).json({ ok: false, error: 'accion', detalle: "Solo entiendo { accion: 'aprobar' }" });
    }

    const t0 = Date.now();
    /* Si nos dan ids, vamos a por esos. Si no, preguntamos cuales hay: es una
     * llamada mas pero evita aprobar de memoria algo que ya no esta. */
    let ids = Array.isArray(b.ids) ? b.ids.map(aTexto).filter(Boolean) : null;
    if (!ids) ids = (await pendientes(cuenta)).map((c) => c.id);

    const hechas = [];
    const fallos = [];
    let i = 0;
    while (i < ids.length && Date.now() - t0 < LIMITE_MS) {
      const tanda = ids.slice(i, i + A_LA_VEZ);
      const r = await Promise.all(tanda.map((id) => aprobarUna(cuenta, id)));
      for (const x of r) (x.ok ? hechas : fallos).push(x);
      i += tanda.length;
    }

    const sinTocar = ids.length - i;
    return res.status(200).json({
      ok: fallos.length === 0,
      cuenta,
      pedidas: ids.length,
      aprobadas: hechas.length,
      fallos,
      quedan: sinTocar,
      sigue: sinTocar > 0,
      ms: Date.now() - t0
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
