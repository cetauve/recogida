/* /api/tandas — lo calculado para el almacén.
 *
 * Esto es lo que mata el enlace de 5.152 caracteres que WhatsApp partía.
 * La extensión manda el mismo objeto que antes metía detrás de la almohadilla,
 * y app-recogida lo pide por su cuenta.
 *
 *   POST  { dia?, directo?, titulo?, datos }   token de escritura
 *   GET   ?d=CODIGO&dia=YYYY-MM-DD             código de lectura
 *
 * Una fila por día: la extensión recalcula todas las tandas cada vez y vuelve
 * a mandar el conjunto entero, así que sustituir es lo correcto. Si se
 * añadiera en vez de sustituir, quedarían tandas fantasma de un análisis viejo.
 */
const { db, puerta, puedeEscribir, puedeLeer, noAutorizado, diaDe, aTexto, cuerpo } = require('./_lib');

module.exports = puerta(async (req, res) => {
  const s = db();

  if (req.method === 'POST') {
    if (!puedeEscribir(req)) return noAutorizado(res, 'escribir');
    const b = cuerpo(req);
    const datos = b.datos || b;
    if (!datos || !Array.isArray(datos.tandas)) {
      return res.status(400).json({ ok: false, error: 'sin-tandas',
        detalle: 'Esperaba { datos: { tandas: [...] } }' });
    }
    const dia = diaDe(b.dia || datos.dia);
    const titulo = aTexto(b.titulo || datos.titulo);
    const directo = aTexto(b.directo);

    await s`
      insert into tandas (dia, directo, titulo, datos, generado)
      values (${dia}, ${directo}, ${titulo}, ${s.json(datos)}, now())
      on conflict (dia) do update set
        directo = excluded.directo,
        titulo  = excluded.titulo,
        datos   = excluded.datos,
        generado = now()`;

    const paquetes = datos.tandas.reduce((n, t) => n + ((t.compradores || []).length), 0);
    return res.status(200).json({ ok: true, dia, tandas: datos.tandas.length, paquetes });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const dia = diaDe((req.query || {}).dia);
    const filas = await s`select dia, titulo, datos, generado from tandas where dia = ${dia}`;
    if (!filas.length) {
      /* Sin datos de hoy no devolvemos un 404 pelado: la app necesita poder
       * decir "todavía no hay nada" sin parecer rota. */
      return res.status(200).json({ ok: true, hay: false, dia, datos: null });
    }
    const f = filas[0];
    return res.status(200).json({
      ok: true, hay: true, dia,
      generado: f.generado, titulo: f.titulo, datos: f.datos
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
