/* /api/tiktok-webhook — lo que TikTok nos empuja sin que preguntemos.
 *
 * Pedido nuevo, pedido cancelado, paquete actualizado. Esto es lo que hace que
 * el programa deje de tener que mirar la pantalla cada dos minutos: en vez de
 * leer, le avisan.
 *
 *   POST  { type, shop_id, data, timestamp }   lo manda TikTok
 *   GET   ?d=CODIGO&n=50                       para ver que ha llegado
 *
 * DOS REGLAS QUE NO SE TOCAN:
 *
 * 1. Siempre 200. Si devolvemos un error, TikTok reintenta y acaba apagando
 *    el aviso. Si algo va mal por dentro, se apunta y se contesta 200 igual.
 * 2. Aqui no se hace trabajo. Se guarda el aviso crudo y se sale. Procesar
 *    dentro del webhook es como se pierden avisos: si tardamos, se corta.
 */
const { puerta, puedeLeer, noAutorizado, aTexto, aEntero, db, cuerpo } = require('./_lib');
const T = require('./_tiktok');

module.exports = puerta(async (req, res) => {
  if (req.method === 'POST') {
    await T.asegurarTablas();
    const s = db();

    /* Para comprobar la firma hace falta el cuerpo TAL CUAL vino, no el
     * objeto ya parseado y vuelto a serializar: una coma o un espacio de
     * diferencia y el HMAC no cuadra. Vercel nos da el objeto, asi que si
     * hay texto crudo lo usamos y si no, lo reconstruimos y aceptamos que
     * la firma pueda no cuadrar (se apunta como no comprobada). */
    const crudo = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const b = cuerpo(req);
    const firmaOk = T.firmaAvisoVale(crudo, req.headers.authorization);

    try {
      await s`
        insert into tiktok_eventos (tipo, tienda, datos, firma_ok, en)
        values (${aTexto(b.type || b.event_type)}, ${aTexto(b.shop_id)},
                ${s.json(b)}, ${firmaOk}, now())`;
    } catch (e) {
      /* Ni asi devolvemos error: preferimos perder un aviso a que TikTok nos
       * apague el webhook entero por contestar mal. */
      return res.status(200).json({ ok: false, guardado: false });
    }
    return res.status(200).json({ ok: true, firma: firmaOk });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    await T.asegurarTablas();
    const s = db();
    const n = Math.min(Math.max(aEntero((req.query || {}).n) || 50, 1), 200);
    const filas = await s`
      select id, tipo, tienda, datos, firma_ok, en
      from tiktok_eventos order by en desc limit ${n}`;
    return res.status(200).json({ ok: true, hay: filas.length, eventos: filas });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
