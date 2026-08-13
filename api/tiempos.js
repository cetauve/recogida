/* /api/tiempos — cada "Listo" de quien recoge y de quien empaqueta.
 *
 *   POST  { dia?, quien, modo, equipo?, marcas: [{pedido, apodo, t, estado}] }
 *   GET   ?d=CODIGO&dia=YYYY-MM-DD
 *
 * Esto es lo que hoy sale en un CSV por equipo y hay que juntar a mano. Con la
 * puerta, los tiempos de todos los móviles caen en el mismo sitio y /tiempos
 * los enseña juntos, también desde casa.
 *
 * Escribe con el código de lectura, por lo mismo que /api/toques: los móviles
 * del almacén no pueden llevar el token encima.
 *
 * La clave es (día, quien, pedido, estado): un móvil puede reenviar sus marcas
 * cuantas veces quiera —vuelve la cobertura, se recarga la página— sin que
 * aparezcan paquetes de más.
 */
const {
  db, puerta, puedeLeer, noAutorizado, diaDe, aFecha, aTexto, cuerpo
} = require('./_lib');

const TROZO = 400;

module.exports = puerta(async (req, res) => {
  const s = db();

  if (req.method === 'POST') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const b = cuerpo(req);
    const quien = aTexto(b.quien).trim();
    if (!quien) return res.status(400).json({ ok: false, error: 'sin-quien' });
    const dia = diaDe(b.dia);
    const modo = aTexto(b.modo);
    const equipo = aTexto(b.equipo);

    const lista = (Array.isArray(b.marcas) ? b.marcas : [])
      .map((x) => ({
        dia, quien, modo, equipo,
        pedido: aTexto(x.pedido),
        apodo: x.apodo === undefined ? null : aTexto(x.apodo),
        en: aFecha(x.en || x.t || x.cuando),
        estado: aTexto(x.estado) || 'listo'
      }))
      .filter((x) => x.en && x.pedido);

    const unicos = new Map();
    for (const m of lista) unicos.set(m.pedido + '#' + m.estado, m);
    const filas = [...unicos.values()];

    let guardados = 0;
    for (let i = 0; i < filas.length; i += TROZO) {
      const parte = filas.slice(i, i + TROZO);
      await s`
        insert into tiempos ${s(parte, 'dia', 'quien', 'modo', 'equipo', 'pedido', 'apodo', 'en', 'estado')}
        on conflict (dia, quien, pedido, estado) do update set
          en     = excluded.en,
          modo   = case when excluded.modo = '' then tiempos.modo else excluded.modo end,
          equipo = case when excluded.equipo = '' then tiempos.equipo else excluded.equipo end,
          apodo  = coalesce(excluded.apodo, tiempos.apodo)`;
      guardados += parte.length;
    }

    const total = await s`select count(*)::int as n from tiempos where dia = ${dia} and quien = ${quien}`;
    return res.status(200).json({ ok: true, dia, quien, guardados, total: total[0].n });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const q = req.query || {};
    const dia = diaDe(q.dia);
    const filas = await s`
      select quien, modo, equipo, pedido, apodo, en, estado
      from tiempos where dia = ${dia} order by quien, en`;

    const gente = {};
    for (const f of filas) {
      const g = gente[f.quien] = gente[f.quien] || { quien: f.quien, modo: f.modo, equipo: f.equipo, marcas: 0 };
      g.marcas++;
    }

    return res.status(200).json({
      ok: true, dia, total: filas.length,
      gente: Object.values(gente),
      marcas: filas
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
