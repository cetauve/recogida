/* /api/toques — lo que marcan las vendedoras.
 *
 *   POST  { dia?, vendedora, directo?, toques: [{en, lote, cuenta, sesion}] }
 *   GET   ?d=CODIGO&dia=YYYY-MM-DD
 *
 * QUIÉN PUEDE ESCRIBIR AQUÍ, Y POR QUÉ NO ES EL TOKEN.
 * Las tablets de las vendedoras abren la página con el código de lectura en la
 * dirección. Si escribir aquí exigiera el token, el token acabaría en la
 * dirección de una tablet compartida, y entonces cualquiera que la viera
 * podría escribir tandas y borrar el día. Así que estas dos puertas —toques y
 * tiempos— se conforman con el código: solo añaden filas de su propio trabajo,
 * que es el daño más pequeño que se puede hacer.
 *
 * Los toques se mandan en tanda y se pueden reenviar sin miedo: la clave es
 * (día, vendedora, hora exacta), así que repetir un envío no duplica nada.
 */
const {
  db, puerta, puedeLeer, noAutorizado, diaDe, aFecha, aEntero, aTexto, cuerpo
} = require('./_lib');

const TROZO = 400;

module.exports = puerta(async (req, res) => {
  const s = db();

  if (req.method === 'POST') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const b = cuerpo(req);
    const vendedora = aTexto(b.vendedora || b.quien).trim();
    if (!vendedora) return res.status(400).json({ ok: false, error: 'sin-vendedora' });
    const dia = diaDe(b.dia);
    const directo = aTexto(b.directo);

    const lista = (Array.isArray(b.toques) ? b.toques : [])
      .map((x) => ({
        dia, directo, vendedora,
        en: aFecha(x.en || x.t || x.cuando),
        lote: aEntero(x.lote),
        cuenta: aTexto(x.cuenta),
        sesion: aTexto(x.sesion || x.sesionDirecto)
      }))
      .filter((x) => x.en);

    const unicos = new Map();
    for (const t of lista) unicos.set(t.en.toISOString(), t);
    const filas = [...unicos.values()];

    let guardados = 0;
    for (let i = 0; i < filas.length; i += TROZO) {
      const parte = filas.slice(i, i + TROZO);
      await s`
        insert into toques ${s(parte, 'dia', 'directo', 'vendedora', 'en', 'lote', 'cuenta', 'sesion')}
        on conflict (dia, vendedora, en) do update set
          lote   = coalesce(excluded.lote, toques.lote),
          cuenta = case when excluded.cuenta = '' then toques.cuenta else excluded.cuenta end,
          directo = case when excluded.directo = '' then toques.directo else excluded.directo end`;
      guardados += parte.length;
    }

    const total = await s`select count(*)::int as n from toques where dia = ${dia} and vendedora = ${vendedora}`;
    return res.status(200).json({ ok: true, dia, vendedora, guardados, total: total[0].n });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const q = req.query || {};
    const dia = diaDe(q.dia);
    const vendedora = aTexto(q.vendedora).trim();

    const filas = vendedora
      ? await s`select vendedora, en, lote, cuenta, sesion, directo from toques
                where dia = ${dia} and vendedora = ${vendedora} order by en`
      : await s`select vendedora, en, lote, cuenta, sesion, directo from toques
                where dia = ${dia} order by vendedora, en`;

    const porVendedora = {};
    for (const f of filas) (porVendedora[f.vendedora] = porVendedora[f.vendedora] || []).push(f);

    return res.status(200).json({
      ok: true, dia, total: filas.length,
      resumen: Object.keys(porVendedora).map((v) => ({ vendedora: v, toques: porVendedora[v].length })),
      toques: filas
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
