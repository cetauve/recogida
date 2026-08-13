/* /api/directo — el estado del directo y las prendas vendidas.
 *
 *   POST  { directo, dia?, cuenta?, empezo?, acabo?, loteActual?, loteEn?,
 *           lotes: [...], regalos: [...] }        token de escritura
 *   GET   ?d=CODIGO&dia=YYYY-MM-DD[&solo=lote]    código de lectura
 *
 * El `loteActual` es lo que arregla la tablet Android: el servidor le dice a
 * la app de las vendedoras por qué prenda va el directo, y cada toque se sella
 * con esa prenda en vez de adivinarla después por la hora.
 */
const {
  db, puerta, puedeEscribir, puedeLeer, noAutorizado,
  diaDe, aFecha, aEntero, aNumero, aTexto, cuerpo
} = require('./_lib');

const TROZO = 400;   // filas por sentencia; un directo largo pasa de 400 prendas

module.exports = puerta(async (req, res) => {
  const s = db();

  if (req.method === 'POST') {
    if (!puedeEscribir(req)) return noAutorizado(res, 'escribir');
    const b = cuerpo(req);
    const directo = aTexto(b.directo || b.sesion);
    if (!directo) return res.status(400).json({ ok: false, error: 'sin-directo',
      detalle: 'Hace falta un identificador de directo (sesionId).' });
    const dia = diaDe(b.dia);

    await s`
      insert into directos (id, dia, cuenta, empezo, acabo, lote_actual, lote_en, actualizado)
      values (${directo}, ${dia}, ${aTexto(b.cuenta)}, ${aFecha(b.empezo)}, ${aFecha(b.acabo)},
              ${aEntero(b.loteActual)}, ${aFecha(b.loteEn)}, now())
      on conflict (id) do update set
        dia         = excluded.dia,
        cuenta      = excluded.cuenta,
        empezo      = coalesce(directos.empezo, excluded.empezo),
        acabo       = coalesce(excluded.acabo, directos.acabo),
        lote_actual = coalesce(excluded.lote_actual, directos.lote_actual),
        lote_en     = coalesce(excluded.lote_en, directos.lote_en),
        actualizado = now()`;

    let lotes = 0;
    const filas = (Array.isArray(b.lotes) ? b.lotes : [])
      .map((x) => ({
        directo,
        cuenta: aTexto(x.cuenta),
        num: aEntero(x.num !== undefined ? x.num : x.numero),
        dia,
        vendida_en: aFecha(x.vendidaEn || x.vendida_en || x.creado),
        precio: aNumero(x.precio),
        sku: aTexto(x.sku),
        titulo: aTexto(x.titulo),
        parado: !!x.parado,
        comprador: x.comprador === undefined ? null : aTexto(x.comprador)
      }))
      .filter((x) => x.num !== null);

    /* Un mismo número puede venir dos veces en el mismo envío (dos lecturas del
     * panel). Postgres no deja que una sola sentencia toque la misma fila dos
     * veces, así que nos quedamos con la última de cada (cuenta, num). */
    const unicas = new Map();
    for (const f of filas) unicas.set(f.cuenta + '#' + f.num, f);
    const lista = [...unicas.values()];

    for (let i = 0; i < lista.length; i += TROZO) {
      const parte = lista.slice(i, i + TROZO);
      await s`
        insert into lotes ${s(parte, 'directo', 'cuenta', 'num', 'dia', 'vendida_en',
                              'precio', 'sku', 'titulo', 'parado', 'comprador')}
        on conflict (directo, cuenta, num) do update set
          dia        = excluded.dia,
          vendida_en = coalesce(excluded.vendida_en, lotes.vendida_en),
          precio     = coalesce(excluded.precio, lotes.precio),
          sku        = case when excluded.sku = '' then lotes.sku else excluded.sku end,
          titulo     = case when excluded.titulo = '' then lotes.titulo else excluded.titulo end,
          parado     = excluded.parado,
          comprador  = coalesce(excluded.comprador, lotes.comprador)`;
      lotes += parte.length;
    }

    let regalos = 0;
    const reg = (Array.isArray(b.regalos) ? b.regalos : [])
      .map((x) => ({
        dia, directo,
        tier: aTexto(x.tier),
        usuario: x.usuario === undefined ? null : aTexto(x.usuario),
        num: aEntero(x.num),
        en: aFecha(x.en || x.cuando || x.t)
      }))
      .filter((x) => x.tier && x.en);
    const regUnicos = new Map();
    for (const r of reg) regUnicos.set(r.tier + '#' + r.en.toISOString(), r);
    const listaReg = [...regUnicos.values()];
    if (listaReg.length) {
      await s`
        insert into regalos ${s(listaReg, 'dia', 'directo', 'tier', 'usuario', 'num', 'en')}
        on conflict (dia, tier, en) do update set
          usuario = coalesce(excluded.usuario, regalos.usuario),
          num     = coalesce(excluded.num, regalos.num)`;
      regalos = listaReg.length;
    }

    return res.status(200).json({ ok: true, dia, directo, lotes, regalos });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const q = req.query || {};
    const dia = diaDe(q.dia);

    /* El más reciente del día: si hubo dos, manda el que se tocó al final. */
    const ds = await s`
      select id, dia, cuenta, empezo, acabo, lote_actual, lote_en, actualizado
      from directos where dia = ${dia} order by actualizado desc limit 1`;
    if (!ds.length) return res.status(200).json({ ok: true, hay: false, dia, directo: null });
    const d = ds[0];

    const cabecera = {
      ok: true, hay: true, dia,
      directo: d.id, cuenta: d.cuenta,
      empezo: d.empezo, acabo: d.acabo,
      loteActual: d.lote_actual, loteEn: d.lote_en,
      actualizado: d.actualizado
    };
    /* La app de las vendedoras pregunta esto cada pocos segundos y solo
     * necesita el número: no le mandamos cientos de filas por gusto. */
    if (String(q.solo || '') === 'lote') return res.status(200).json(cabecera);

    const lotes = await s`
      select num, cuenta, vendida_en, precio, sku, titulo, parado, comprador
      from lotes where directo = ${d.id} order by cuenta, num`;
    const regalos = await s`
      select tier, usuario, num, en from regalos where dia = ${dia} order by en`;

    return res.status(200).json({ ...cabecera, lotes, regalos });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
