/* /api/marcado — lo que el almacén dice que es cada prenda.
 *
 *   GET  ?d=CODIGO&juego=es-2026-09-21
 *        -> { ok, hay, juego, marcas: { "p1.15": "camisa", ... }, cuando }
 *   POST ?d=CODIGO   { juego, marcas: { "p1.15": "camisa", "p2.7": null } }
 *        -> une lo que llega con lo que ya había y devuelve el conjunto
 *
 * POR QUÉ EXISTE
 *
 * 20 sep 2026. Lo marcado vivía en el navegador del móvil. Aaron se salió de
 * la app y perdió dos tandas enteras ya hechas, y no había forma de
 * recuperarlas: el almacén del navegador se va con la pestaña y nadie se
 * entera hasta que ya no está. Marcar 190 prendas cuesta una hora larga de
 * trabajo de alguien; eso no puede depender de que nadie cierre una pestaña.
 *
 * LA LLAVE ES EL PERCHERO Y EL NÚMERO, no la posición en la lista.
 * Cada paso 2 rehace las tandas y las tarjetas cambian de sitio. Si la llave
 * fuera "tanda 2, bolsa 5, prenda 3", volver a imprimir movería todo lo
 * marcado a prendas que no son. El número dentro de su perchero, en cambio, es
 * la prenda: `p1.15` es la 15 del perchero 1 y lo sigue siendo mañana.
 *
 * SE ESCRIBE CON EL CÓDIGO DE LECTURA, a propósito. Los móviles del almacén
 * solo llevan ese código en el enlace y el de escritura no sale de la
 * extensión. Esto es lo único que pueden escribir: una categoría por prenda de
 * un juego que ya existe. No mueve pedidos, no crea etiquetas y no toca nada
 * de TikTok. Lo peor que puede pasar es que alguien marque una prenda mal, que
 * es exactamente lo que puede pasar de todos modos con el móvil en la mano.
 *
 * SE UNE, NO SE SUSTITUYE. Dos personas marcando tandas distintas a la vez
 * escriben las dos, y ninguna borra lo de la otra: sobre una llave ya escrita
 * gana la última, que es lo que se quiere cuando alguien corrige.
 */
const { db, puerta, puedeLeer, noAutorizado, aTexto, cuerpo } = require('./_lib');

module.exports = puerta(async (req, res) => {
  const s = db();

  await s`
    create table if not exists marcado (
      juego  text primary key,
      marcas jsonb not null default '{}'::jsonb,
      cuando timestamptz not null default now()
    )`;

  if (!puedeLeer(req)) return noAutorizado(res, 'leer');

  const q = req.query || {};

  if (req.method === 'GET') {
    const juego = aTexto(q.juego).trim();
    if (!juego) return res.status(400).json({ ok: false, error: 'sin-juego' });
    const filas = await s`select marcas, cuando from marcado where juego = ${juego}`;
    if (!filas.length) return res.status(200).json({ ok: true, hay: false, juego, marcas: {} });
    return res.status(200).json({
      ok: true, hay: true, juego, marcas: filas[0].marcas || {}, cuando: filas[0].cuando });
  }

  if (req.method === 'POST') {
    const b = cuerpo(req);
    const juego = aTexto(b.juego || q.juego).trim();
    if (!juego) return res.status(400).json({ ok: false, error: 'sin-juego' });

    const entran = (b && b.marcas && typeof b.marcas === 'object') ? b.marcas : null;
    if (!entran) return res.status(400).json({ ok: false, error: 'sin-marcas' });

    /* Solo llaves y valores con pinta de lo que son. Una llave es
     * "perchero.numero" y un valor es el nombre corto de una categoría, o
     * nulo para quitar la marca. Nada más entra en la tabla. */
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
     * se queda como estaba. strip_nulls quita las que se han desmarcado. */
    const [f] = await s`
      insert into marcado (juego, marcas, cuando)
      values (${juego}, ${s.json(limpio)}, now())
      on conflict (juego) do update set
        marcas = jsonb_strip_nulls(marcado.marcas || excluded.marcas),
        cuando = now()
      returning marcas, cuando`;

    const marcas = jsonSinNulos(f.marcas || {});
    return res.status(200).json({ ok: true, juego, marcas, cuando: f.cuando,
      total: Object.keys(marcas).length });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});

/* En la primera escritura de un juego el insert entra tal cual, sin pasar por
 * el strip_nulls del update, así que una desmarca recién llegada podría
 * quedarse dentro como nula. Se limpia también aquí. */
function jsonSinNulos(o) {
  const r = {};
  for (const k of Object.keys(o)) if (o[k] !== null) r[k] = o[k];
  return r;
}
