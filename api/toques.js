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

/* Cuánto puede haberse adelantado el dedo a la prenda. El toque se da DESPUÉS
 * de vender, así que lo normal es que la prenda ya esté; estos 5 segundos son
 * solo para el caso de que las dos cosas caigan en el mismo segundo.
 *
 * Estuvo en 90 segundos y con eso un toque se llevaba una prenda que aún no se
 * había vendido. Lo cazó probar-tiempo.js. NO SUBIR. */
const MARGEN_DELANTE_MS = 5000;
/* Y hacia atrás: una prenda vendida hace más de diez minutos ya no es la que
 * acaba de marcar nadie. */
const VENTANA_ATRAS_MS = 10 * 60000;

/* Cada toque se queda con el lote más reciente SIN RECLAMAR anterior a él.
 * "Sin reclamar" es lo que impide que dos vendedoras se lleven la misma
 * prenda; el toque que se quede sin candidato se queda sin cruce y se dice,
 * en vez de inventarle uno. */
async function cruzar(s, dia, toques) {
  const lotes = await s`
    select directo, cuenta, num, vendida_en, precio, titulo
    from lotes where dia = ${dia} and vendida_en is not null and parado = false
    order by vendida_en`;
  const turnos = await s`
    select vendedora, empezo, acabo, lote_inicio, lote_fin
    from turnos where dia = ${dia} order by empezo`;

  const libres = lotes.map((l) => ({ l, tomado: false }));
  const ms = (x) => new Date(x).getTime();
  const filas = [];

  /* ---------------------------------------------------------- 1 · EL LOTE
   * Si la tablet tenía el panel abierto, el toque lleva pegado el número de
   * prenda por el que iba el directo en ese instante. Eso no hay que
   * adivinarlo: gana a cualquier cálculo por horas. */
  const porNumero = new Map();
  for (const x of libres) porNumero.set(x.l.cuenta + '#' + x.l.num, x);

  const sinLote = [];
  for (const t of toques) {
    const sellado = t.lote == null ? null : (porNumero.get((t.cuenta || '') + '#' + t.lote) ||
      libres.find((x) => !x.tomado && x.l.num === t.lote));
    if (sellado && !sellado.tomado) {
      sellado.tomado = true;
      filas.push(hacerFila(t, sellado.l, 'lote'));
    } else {
      sinLote.push(t);
    }
  }

  /* ---------------------------------------------------------- 2 · LA HORA
   * Cada toque se queda con la prenda más reciente SIN RECLAMAR anterior a
   * él. "Sin reclamar" es lo que impide que dos vendedoras se lleven la
   * misma prenda. */
  for (const t of sinLote.slice().sort((a, b) => ms(a.en) - ms(b.en))) {
    const tt = ms(t.en);
    let elegido = null;
    for (let k = libres.length - 1; k >= 0; k--) {
      if (libres[k].tomado) continue;
      const lt = ms(libres[k].l.vendida_en);
      if (lt > tt + MARGEN_DELANTE_MS) continue;
      if (tt - lt > VENTANA_ATRAS_MS) break;
      elegido = libres[k];
      break;
    }
    if (elegido) elegido.tomado = true;
    filas.push(hacerFila(t, elegido && elegido.l, elegido ? 'hora' : null));
  }

  /* --------------------------------------------------------- 3 · EL TURNO
   * EL PLAN B DE VERDAD. Si una prenda se vendió y nadie la marcó —se le
   * olvidó pulsar, se quedó sin batería, la tablet no tenía el panel—, pero
   * en ese momento SOLO HABÍA UNA VENDEDORA en turno, es suya y no hay
   * ninguna duda. Con dos o más a la vez no se adjudica: preferimos decir
   * "sin dueño" antes que repartir a ojo y que alguien cobre lo de otra.
   *
   * El rango se mira por hora y, si el turno trae números de lote apuntados,
   * también por número: es la red de seguridad para cuando las horas de
   * TikTok vienen mal. */
  const enTurno = (tu, l) => {
    const dentroPorHora = tu.empezo && ms(l.vendida_en) >= ms(tu.empezo) &&
      (!tu.acabo || ms(l.vendida_en) <= ms(tu.acabo));
    const dentroPorLote = tu.lote_inicio != null && tu.lote_fin != null &&
      l.num >= tu.lote_inicio && l.num <= tu.lote_fin;
    return dentroPorHora || dentroPorLote;
  };

  for (const x of libres) {
    if (x.tomado) continue;
    const suyas = turnos.filter((tu) => enTurno(tu, x.l));
    if (suyas.length !== 1) continue;          // cero o varias: no se inventa
    x.tomado = true;
    filas.push({
      vendedora: suyas[0].vendedora, en: x.l.vendida_en, categoria: '',
      lote: x.l.num, cuenta: x.l.cuenta, precio: x.l.precio, titulo: x.l.titulo,
      metodo: 'turno', sinToque: true
    });
  }

  const porVendedora = {};
  for (const f of filas) {
    const g = porVendedora[f.vendedora] = porVendedora[f.vendedora] ||
      { vendedora: f.vendedora, prendas: 0, cruzadas: 0, euros: 0,
        porLote: 0, porHora: 0, porTurno: 0 };
    g.prendas++;
    if (f.lote != null) {
      g.cruzadas++;
      g.euros += Number(f.precio || 0);
      if (f.metodo === 'lote')  g.porLote++;
      if (f.metodo === 'hora')  g.porHora++;
      if (f.metodo === 'turno') g.porTurno++;
    }
  }

  return {
    lotes: lotes.length,
    sinDuenyo: libres.filter((x) => !x.tomado).length,
    sinCruzar: filas.filter((f) => f.lote == null).length,
    porVendedora: Object.values(porVendedora).map((g) => ({ ...g, euros: Math.round(g.euros * 100) / 100 })),
    filas: filas.sort((a, b) => new Date(a.en) - new Date(b.en))
  };
}

function hacerFila(t, l, metodo) {
  return {
    vendedora: t.vendedora, en: t.en, categoria: t.categoria,
    lote: l ? l.num : null,
    cuenta: l ? l.cuenta : null,
    precio: l ? l.precio : null,
    titulo: l ? l.titulo : null,
    metodo: metodo
  };
}

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
        sesion: aTexto(x.sesion || x.sesionDirecto),
        /* Qué botón pulsó: camisetas, sudaderas… La app lo manda desde el
         * primer día y hasta hoy se tiraba aquí. */
        categoria: aTexto(x.categoria || x.c)
      }))
      .filter((x) => x.en);

    const unicos = new Map();
    for (const t of lista) unicos.set(t.en.toISOString(), t);
    const filas = [...unicos.values()];

    let guardados = 0;
    for (let i = 0; i < filas.length; i += TROZO) {
      const parte = filas.slice(i, i + TROZO);
      await s`
        insert into toques ${s(parte, 'dia', 'directo', 'vendedora', 'en', 'lote', 'cuenta', 'sesion', 'categoria')}
        on conflict (dia, vendedora, en) do update set
          lote   = coalesce(excluded.lote, toques.lote),
          cuenta = case when excluded.cuenta = '' then toques.cuenta else excluded.cuenta end,
          categoria = case when excluded.categoria = '' then toques.categoria else excluded.categoria end,
          directo = case when excluded.directo = '' then toques.directo else excluded.directo end`;
      guardados += parte.length;
    }

    /* EL TURNO, si viene. Se manda dos veces: al entrar (solo `empezo`) y al
     * terminar (con `acabo`). La clave lleva `empezo`, así que el segundo
     * envío completa el mismo turno en vez de abrir otro. */
    const t = b.turno;
    let turno = null;
    if (t && (t.empezo || t.inicio)) {
      const empezo = aFecha(t.empezo || t.inicio);
      if (empezo) {
        const [f] = await s`
          insert into turnos (dia, vendedora, empezo, acabo, lote_inicio, lote_fin, directo)
          values (${dia}, ${vendedora}, ${empezo}, ${aFecha(t.acabo || t.fin)},
                  ${aEntero(t.loteInicio)}, ${aEntero(t.loteFin)}, ${directo})
          on conflict (dia, vendedora, empezo) do update set
            acabo       = coalesce(excluded.acabo, turnos.acabo),
            lote_inicio = coalesce(excluded.lote_inicio, turnos.lote_inicio),
            lote_fin    = coalesce(excluded.lote_fin, turnos.lote_fin),
            actualizado = now()
          returning empezo, acabo`;
        turno = f;
      }
    }

    const total = await s`select count(*)::int as n from toques where dia = ${dia} and vendedora = ${vendedora}`;
    return res.status(200).json({ ok: true, dia, vendedora, guardados, turno, total: total[0].n });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const q = req.query || {};
    const dia = diaDe(q.dia);
    const vendedora = aTexto(q.vendedora).trim();

    const filas = vendedora
      ? await s`select vendedora, en, lote, cuenta, sesion, categoria, directo from toques
                where dia = ${dia} and vendedora = ${vendedora} order by en`
      : await s`select vendedora, en, lote, cuenta, sesion, categoria, directo from toques
                where dia = ${dia} order by vendedora, en`;

    const turnos = await s`
      select vendedora, empezo, acabo, lote_inicio, lote_fin
      from turnos where dia = ${dia} order by empezo`;

    const porVendedora = {};
    for (const f of filas) (porVendedora[f.vendedora] = porVendedora[f.vendedora] || []).push(f);

    const salida = {
      ok: true, dia, total: filas.length,
      resumen: Object.keys(porVendedora).map((v) => ({
        vendedora: v,
        toques: porVendedora[v].length,
        turno: turnos.find((t) => t.vendedora === v) || null
      })),
      turnos,
      toques: filas
    };

    /* EL CRUCE, SI SE PIDE.
     *
     * Cada lado escribe lo suyo sin saber del otro —la extensión las prendas
     * con su hora real, la tablet los toques con la suya— y aquí se juntan.
     * Se hace al leer, nunca al escribir: si un día sale torcido se vuelve a
     * pedir con otra ventana y no se ha perdido nada, porque los dos lados
     * siguen guardados en crudo. Sellar el lote en el toque sí sería
     * irreversible, y además dejaría sin prenda todo toque dado sin cobertura.
     */
    if (q.cruce) salida.cruce = await cruzar(s, dia, filas);

    return res.status(200).json(salida);
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
