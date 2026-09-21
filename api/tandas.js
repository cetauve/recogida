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

/* ===========================================================================
 * LO QUE EL ALMACÉN DICE QUE ES CADA PRENDA
 * ===========================================================================
 * Vive aquí dentro y no en su propio fichero a propósito: Vercel solo deja un
 * número limitado de funciones en este plan y ya están todas gastadas. El
 * primer intento fue /api/marcado y el despliegue entero se cayó, con lo que
 * eso significa: el almacén sin app. Así que va de polízon en el sitio donde
 * ya viven las tandas, que además es de lo que habla.
 *
 *   GET  ?d=CODIGO&juego=es-2026-09-21&marcas=1
 *        -> { ok, hay, juego, marcas: { "p1.15": "camisa", ... } }
 *   POST ?d=CODIGO   { juego, marcas: { "p1.15": "camisa", "p2.7": null } }
 *        -> une lo que llega con lo que ya había y devuelve el conjunto
 *
 * POR QUÉ EXISTE. 20 sep 2026: lo marcado vivía en el navegador del móvil y
 * Aaron perdió dos tandas enteras ya hechas al salirse de la app. Marcar 190
 * prendas es una hora larga de trabajo de alguien; eso no puede depender de
 * que nadie cierre una pestaña.
 *
 * LA LLAVE ES EL PERCHERO Y EL NÚMERO -p1.15-, no la posición en la lista.
 * Cada paso 2 rehace las tandas y las tarjetas cambian de sitio; con la
 * posición, volver a imprimir habría movido lo marcado a prendas que no son.
 *
 * SE ESCRIBE CON EL CÓDIGO DE LECTURA, a propósito. Los móviles del almacén
 * solo llevan ese código y el de escritura no sale de la extensión. Esto es lo
 * único que pueden escribir: una categoría por prenda. No mueve pedidos, no
 * crea etiquetas y no toca nada de TikTok.
 * ========================================================================= */
async function tablaDeMarcas(s) {
  await s`
    create table if not exists marcado (
      juego  text primary key,
      marcas jsonb not null default '{}'::jsonb,
      cuando timestamptz not null default now()
    )`;
}

const sinNulos = (o) => {
  const r = {};
  for (const k of Object.keys(o || {})) if (o[k] !== null) r[k] = o[k];
  return r;
};

async function leerMarcas(s, res, juego) {
  if (!juego) return res.status(400).json({ ok: false, error: 'sin-juego' });
  await tablaDeMarcas(s);
  const filas = await s`select marcas, cuando from marcado where juego = ${juego}`;
  if (!filas.length) return res.status(200).json({ ok: true, hay: false, juego, marcas: {} });
  return res.status(200).json({ ok: true, hay: true, juego,
    marcas: sinNulos(filas[0].marcas), cuando: filas[0].cuando });
}

async function guardarMarcas(s, res, juego, entran) {
  if (!juego) return res.status(400).json({ ok: false, error: 'sin-juego' });
  await tablaDeMarcas(s);

  /* Solo llaves y valores con pinta de lo que son. Una llave es
   * "perchero.numero" y un valor es el nombre corto de una categoría, o nulo
   * para quitar la marca. Nada más entra en la tabla. */
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
   * se queda como estaba, así dos móviles marcando a la vez no se pisan. */
  const [f] = await s`
    insert into marcado (juego, marcas, cuando)
    values (${juego}, ${s.json(limpio)}, now())
    on conflict (juego) do update set
      marcas = jsonb_strip_nulls(marcado.marcas || excluded.marcas),
      cuando = now()
    returning marcas, cuando`;

  const marcas = sinNulos(f.marcas);
  return res.status(200).json({ ok: true, juego, marcas, cuando: f.cuando,
    total: Object.keys(marcas).length });
}

module.exports = puerta(async (req, res) => {
  const s = db();

  if (req.method === 'POST') {
    const bm = cuerpo(req);
    /* Lo del almacén va con el código de lectura; las tandas siguen pidiendo el
     * de escritura, que es lo de siempre y no se toca. */
    if (bm && bm.marcas && typeof bm.marcas === 'object' && !bm.datos) {
      if (!puedeLeer(req)) return noAutorizado(res, 'leer');
      return guardarMarcas(s, res, aTexto(bm.juego || (req.query || {}).juego).trim(), bm.marcas);
    }
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
    if (q.marcas) return leerMarcas(s, res, aTexto(q.juego).trim());
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
