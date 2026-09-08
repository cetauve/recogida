/* /api/tandas — lo calculado para el almacén.
 *
 * Esto es lo que mata el enlace de 5.152 caracteres que WhatsApp partía.
 * La extensión manda el mismo objeto que antes metía detrás de la almohadilla,
 * y app-recogida lo pide por su cuenta.
 *
 *   POST  { dia?, directo?, titulo?, datos }   token de escritura
 *   GET   ?d=CODIGO&dia=YYYY-MM-DD             código de lectura
 *
 * Una fila por JUEGO: la extensión recalcula todas las tandas cada vez y vuelve
 * a mandar el conjunto entero, así que sustituir es lo correcto. Si se
 * añadiera en vez de sustituir, quedarían tandas fantasma de un análisis viejo.
 *
 * ANTES ERA UNA FILA POR DÍA, y esa era la raíz de casi todo: solo cabía un
 * juego de tarjetas al día, así que Holanda pisaba a España y hubo que aparcar
 * los juegos en fechas falsas (26, 28 de septiembre) para que convivieran. Y un
 * directo que cruzaba la medianoche se partía en dos aunque fuera el mismo.
 *
 * El juego es la sesión de recogida: lo que sale de un paso 2. Lleva su código
 * —`es-2026-09-08`, `nl-2026-09-08`— y el país va dentro. La fecha se queda
 * como dato y como desempate, ya no como llave.
 *
 * SIN JUEGO SE USA LA FECHA, que es lo que el juego era hasta hoy. Así los
 * enlaces de antes y los móviles con la página en caché siguen funcionando.
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
    const juego = aTexto(b.juego || datos.juego).trim() || dia;
    const titulo = aTexto(b.titulo || datos.titulo);
    const directo = aTexto(b.directo);
    /* Que el juego viaje TAMBIÉN dentro de los datos: la app lo lee de ahí para
     * separar el avance guardado en cada móvil, y así no depende de que alguien
     * se acuerde de ponerlo en el enlace. */
    datos.juego = juego;

    await s`
      insert into tandas (dia, juego, directo, titulo, datos, generado)
      values (${dia}, ${juego}, ${directo}, ${titulo}, ${s.json(datos)}, now())
      on conflict (juego) do update set
        dia     = excluded.dia,
        directo = excluded.directo,
        titulo  = excluded.titulo,
        datos   = excluded.datos,
        generado = now()`;

    const paquetes = datos.tandas.reduce((n, t) => n + ((t.compradores || []).length), 0);
    return res.status(200).json({ ok: true, dia, juego, tandas: datos.tandas.length, paquetes });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const q = req.query || {};
    const dia = diaDe(q.dia);
    const juego = aTexto(q.juego).trim() || dia;
    const filas = await s`select dia, juego, titulo, datos, generado from tandas where juego = ${juego}`;
    if (!filas.length) {
      /* Sin datos de hoy no devolvemos un 404 pelado: la app necesita poder
       * decir "todavía no hay nada" sin parecer rota. */
      return res.status(200).json({ ok: true, hay: false, dia, juego, datos: null });
    }
    const f = filas[0];
    return res.status(200).json({
      ok: true, hay: true, dia: f.dia, juego: f.juego,
      generado: f.generado, titulo: f.titulo, datos: f.datos
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
