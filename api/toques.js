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

/* =========================================================================
   CUÁNDO SE DA UN DIRECTO POR TERMINADO
   =========================================================================
   Nadie pulsa un botón de "se acabó". El panel del directo deja de mandar
   cuando se cierra la pestaña, y las vendedoras se van sin pulsar Terminar
   más veces de las que la pulsan. El resultado era un turno abierto para
   siempre: sus horas seguían corriendo, su €/hora se hundía sola y el
   beneficio de su turno no salía nunca, porque solo sale al cerrarlo.

   Así que el fin se DEDUCE: veinte minutos sin vender ni una prenda y el
   directo se da por terminado a la hora de la última venta.

   SE DEDUCE AL LEER, NO SE GUARDA. Si el directo estaba parado y vuelve a
   vender, la deducción se deshace sola en la siguiente lectura. Guardarlo
   sería sellar a ciegas algo que solo es una sospecha razonable.

   Y se dice con todas las letras QUIÉN no pulsó Terminar: su turno sale
   marcado como "cerrado solo". Es un dato de trabajo, no un apaño escondido.
   ========================================================================= */
const FIN_SIN_VENTAS_MS = 20 * 60000;

/* Cada toque se queda con el lote más reciente SIN RECLAMAR anterior a él.
 * "Sin reclamar" es lo que impide que dos vendedoras se lleven la misma
 * prenda; el toque que se quede sin candidato se queda sin cruce y se dice,
 * en vez de inventarle uno. */
async function cruzar(s, dia, toques) {
  const lotes = await s`
    select l.directo, l.cuenta, l.num, l.vendida_en, l.precio, l.titulo
    from lotes l
    where l.dia = ${dia} and l.vendida_en is not null and l.parado = false
      and (
        /* UNA PRENDA, UNA FILA. La misma prenda entra dos veces: en vivo desde
         * el panel (provisional, sin nombre de cuenta) y al final desde la
         * lectura del paso 2 (definitiva). Aquí se descarta la provisional si
         * ya existe la buena.
         *
         * SE HACE AL LEER, NO AL ESCRIBIR. Borrarlas al escribir no vale: el
         * envío en vivo remanda todo el directo cada veinte segundos y las
         * vuelve a meter. El 14 ago 2026 eso hizo que un directo de 72 prendas
         * saliera con 129 y el margen se fuera al garete.
         *
         * Se emparejan por SKU, que es lo único único de verdad: el número se
         * repite entre las dos cuentas. Sin SKU se cae al número. */
        l.provisional = false
        or not exists (
          select 1 from lotes z
          where z.dia = l.dia and z.provisional = false
            and (
              /* Con SKU en los dos lados se empareja por SKU, que es lo único
               * único de verdad y distingue el 47 de una cuenta del 47 de la
               * otra. Si a alguno le falta el SKU se cae al número: se puede
               * pasar de listo entre cuentas, pero es mejor que contar la
               * misma prenda dos veces. */
              (coalesce(l.sku, '') <> '' and coalesce(z.sku, '') = coalesce(l.sku, ''))
              or ((coalesce(l.sku, '') = '' or coalesce(z.sku, '') = '') and z.num = l.num)
            )
        )
      )
    order by l.vendida_en`;
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

  /* ------------------------------------------- LO QUE NADIE MARCÓ SE QUEDA
   * NO SE REPARTE. Y no es una limitación: es la regla del negocio.
   *
   * El toque no existe para saber quién vendió —eso ya se sabe con las horas
   * de entrada y salida y el centro de pedidos—. Existe para saber QUÉ TIPO
   * DE PRENDA era, que no está en ningún otro sitio, y sin eso no hay coste
   * ni margen, que es para lo que existe todo esto.
   *
   * Así que una prenda sin marcar no vale para nada aunque supiéramos de
   * quién es: no tiene categoría. Y si el sistema rellenara los huecos solo,
   * marcar dejaría de dar incentivo y se acabaría el dato.
   *
   * Aaron, 14 ago 2026: "no tengo ningún interés en inventarme o rellenar
   * cosas si no las han marcado".
   *
   * Hubo aquí un reparto automático que daba las prendas no marcadas a quien
   * estuviera sola en turno. Se quitó el 14 ago 2026. NO LO VUELVAS A METER.
   *
   * Lo que sí se hace es CONTARLAS: cuántas se vendieron sin marcar es el
   * número del que cuelga el incentivo. */

  const porVendedora = {};
  for (const f of filas) {
    const g = porVendedora[f.vendedora] = porVendedora[f.vendedora] ||
      { vendedora: f.vendedora, prendas: 0, cruzadas: 0, euros: 0, porLote: 0, porHora: 0 };
    g.prendas++;
    if (f.lote != null) {
      g.cruzadas++;
      g.euros += Number(f.precio || 0);
      if (f.metodo === 'lote') g.porLote++;
      if (f.metodo === 'hora') g.porHora++;
    }
  }

  /* ===================================================================
   *  CUÁNTO DEL DINERO SE HA MARCADO, Y EN EL TURNO DE QUIÉN SE PERDIÓ
   * ===================================================================
   *  Contar prendas no basta. Diez camisetas de 1 € sin marcar no son lo
   *  mismo que dos chaquetas de 30, y el que decide es el dinero.
   *
   *  Y saber QUIÉN estaba cuando se dejó de marcar no es lo mismo que
   *  adjudicarle la venta: la prenda sin marcar sigue sin contar para nadie
   *  —eso no se toca—, pero sí se puede decir que durante el turno de Fulana
   *  se vendieron 40 y marcó 25. Eso es exactamente de lo que cuelga el
   *  incentivo, y no se inventa nada: la hora de la venta y la hora del turno
   *  están las dos guardadas.
   *
   *  CON DOS A LA VEZ NO SE SEÑALA A NADIE. Si dos turnos se solapan, lo no
   *  marcado en ese rato es de los dos o de ninguno; se marca `solapado` y
   *  que lo mire una persona.
   * =================================================================== */
  const eur = (x) => Number(x || 0);
  const euros = lotes.reduce((a, l) => a + eur(l.precio), 0);
  const eurosMarcados = libres.filter((x) => x.tomado).reduce((a, x) => a + eur(x.l.precio), 0);

  /* EL FIN DEDUCIDO DEL DIRECTO. Null mientras siga habiendo movimiento. */
  const ultimaVenta = lotes.length ? lotes[lotes.length - 1].vendida_en : null;
  const finDirecto = (ultimaVenta && Date.now() - ms(ultimaVenta) > FIN_SIN_VENTAS_MS)
    ? ultimaVenta : null;

  /* Cuándo acabó de verdad un turno:
   *   1. la hora que ella pulsó, si la pulsó;
   *   2. si no, el fin deducido del directo;
   *   3. y si volvió a fichar más tarde, no más allá de esa segunda entrada,
   *      que si no un turno se comería al siguiente.
   * Si el directo sigue vivo devuelve null, que es "sigue trabajando". */
  const finDe = (t) => {
    if (t.acabo) return t.acabo;
    if (!finDirecto) return null;
    const otra = turnos.find((o) => o.vendedora === t.vendedora && ms(o.empezo) > ms(t.empezo));
    return (otra && ms(otra.empezo) < ms(finDirecto)) ? otra.empezo : finDirecto;
  };
  const hasta = (t) => { const f = finDe(t); return f ? ms(f) : Date.now(); };

  const enVentana = (t, cuando) => {
    const q = ms(cuando);
    return t.empezo && q >= ms(t.empezo) && q <= hasta(t);
  };
  const porTurno = turnos.map((t) => {
    const dentro = lotes.filter((l) => enVentana(t, l.vendida_en));
    const suyas = filas.filter((f) => f.vendedora === t.vendedora && f.lote != null);
    const solapado = turnos.some((o) => o !== t && o.vendedora !== t.vendedora &&
      ms(o.empezo) < hasta(t) && hasta(o) > ms(t.empezo));
    return {
      vendedora: t.vendedora, empezo: t.empezo,
      /* `acabo` es lo que hay guardado; `fin` es hasta cuándo se cuenta. */
      acabo: t.acabo, fin: finDe(t),
      abierto: !finDe(t), cerradoSolo: !t.acabo && !!finDe(t), solapado,
      /* Lo que se vendió mientras ella estaba. */
      vendidas: dentro.length,
      euros: Math.round(dentro.reduce((a, l) => a + eur(l.precio), 0) * 100) / 100,
      /* Lo que ella marcó y cruzó. */
      marcadas: suyas.length,
      eurosMarcados: Math.round(suyas.reduce((a, f) => a + eur(f.precio), 0) * 100) / 100,
      pct: dentro.length ? Math.round(suyas.length / dentro.length * 100) : null
    };
  });

  /* Hora a hora: es lo que enseña CUÁNDO se dejó de marcar. Un día al 70 % no
   * suele ser un 70 % constante, sino dos horas al 100 % y una a cero. */
  const porHora = [];
  for (const l of lotes) {
    const h = new Date(l.vendida_en);
    const clave = String(h.getHours()).padStart(2, '0') + ':00';
    let f = porHora.find((x) => x.hora === clave);
    if (!f) porHora.push(f = { hora: clave, vendidas: 0, marcadas: 0, euros: 0, eurosMarcados: 0 });
    f.vendidas++; f.euros += eur(l.precio);
  }
  for (const x of libres) {
    if (!x.tomado) continue;
    const clave = String(new Date(x.l.vendida_en).getHours()).padStart(2, '0') + ':00';
    const f = porHora.find((y) => y.hora === clave);
    if (f) { f.marcadas++; f.eurosMarcados += eur(x.l.precio); }
  }
  porHora.sort((a, b) => a.hora.localeCompare(b.hora));
  for (const f of porHora) {
    f.euros = Math.round(f.euros * 100) / 100;
    f.eurosMarcados = Math.round(f.eurosMarcados * 100) / 100;
  }

  const sinMarcar = libres.filter((x) => !x.tomado).length;
  return {
    lotes: lotes.length,
    /* El dinero del directo entero, esté marcado o no. Es la referencia contra
     * la que se mide todo lo demás. */
    euros: Math.round(euros * 100) / 100,
    eurosMarcados: Math.round(eurosMarcados * 100) / 100,
    marcadoEurosPct: euros ? Math.round(eurosMarcados / euros * 100) : null,
    porTurno,
    porHora,
    /* Cuándo entró la última prenda. Si el envío en vivo se para, esto deja de
     * moverse y se puede cantar en pantalla. El 14 ago 2026 estuvo parado
     * horas y nadie se enteró hasta que los números no cuadraron. */
    ultimaVenta,
    /* Cuándo se da por terminado el directo, o null si sigue en marcha. Y con
     * él, los turnos que se cerraron solos porque nadie pulsó Terminar. */
    finDirecto,
    finSinVentasMin: FIN_SIN_VENTAS_MS / 60000,
    cerradosSolos: porTurno.filter((t) => t.cerradoSolo).map((t) => t.vendedora),
    sinMarcar,
    /* Qué parte del día tiene categoría y por tanto entra en el cálculo de
     * margen. Es la cifra que hay que mirar todos los días. */
    marcadoPct: lotes.length ? Math.round((lotes.length - sinMarcar) / lotes.length * 100) : null,
    sinCruzar: filas.filter((f) => f.lote == null).length,
    turnos: turnos.length,
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
