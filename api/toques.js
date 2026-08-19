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
/* Las 00:00 de un día en hora de Valencia, en milisegundos. Se calcula sin
   tablas de zonas: se coge el mediodía UTC —que siempre cae dentro del día
   mire quien lo mire— y se le resta la hora que marca el reloj de Valencia en
   ese instante. */
function inicioDelDia(dia) {
  const medio = Date.parse(String(dia) + 'T12:00:00Z');
  if (!Number.isFinite(medio)) return 0;
  const partes = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(medio));
  const h = Number((partes.find((x) => x.type === 'hour') || {}).value || 12);
  const m = Number((partes.find((x) => x.type === 'minute') || {}).value || 0);
  return medio - (h * 3600000 + m * 60000);
}

/* CUÁNTO SE LE PERDONA A UN TURNO QUE EMPIEZA ANTES DE SU DÍA.
   Seis horas. Un directo que arranca a las once de la noche y cuyas ventas se
   apuntan ya al día siguiente es normal y su turno tiene que quedar entero; un
   turno que empezó anteayer es una tablet que nadie cerró. */
const ANTES_DEL_DIA_OK = 6 * 3600000;

function sinArrastrar(turnos, dia, toques) {
  const t0 = inicioDelDia(dia);
  if (!t0) return turnos;
  return turnos.map((t) => {
    const empezo = new Date(t.empezo).getTime();
    if (!Number.isFinite(empezo) || empezo >= t0 - ANTES_DEL_DIA_OK) return t;
    const nombre = String(t.vendedora || '').trim().toLowerCase();
    let primero = null;
    for (const q of (toques || [])) {
      if (String(q.vendedora || '').trim().toLowerCase() !== nombre) continue;
      const c = new Date(q.en).getTime();
      if (!Number.isFinite(c)) continue;
      if (primero == null || c < primero) primero = c;
    }
    return { ...t, empezo: new Date(primero != null ? primero : t0),
             arrastrado: true, empezoQueVenia: t.empezo };
  });
}

async function cruzar(s, dia, toquesTodos, soloCuenta) {
  const lotesTodos = await s`
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
  const turnosSinArreglar = await s`
    select vendedora, empezo, acabo, lote_inicio, lote_fin, cuenta
    from turnos where dia = ${dia} order by empezo`;

  /* =========================================================================
     UN TURNO NO PUEDE EMPEZAR ANTES DEL DÍA AL QUE PERTENECE
     =========================================================================
     19 ago 2026: a Heikelin le salían 46 HORAS de turno. No era un fallo de
     cálculo: en la base de datos su turno ponía que empezó el 17 y acabó el 19.

     Pasa con las tablets compartidas. La app se queda abierta con el turno sin
     cerrar —nadie pulsa "terminar" cuando se acaba el día, se apaga la tablet y
     ya— y al día siguiente, al cerrarlo o al cambiar de trabajadora, se manda
     ese `empezo` de hace dos días junto al día de HOY. El turno resultante
     abarca dos noches enteras, y como de las horas cuelga el coste por hora,
     eso descuadra el reparto entero.

     Aquí se corta por lo sano al leer: si un turno dice que empezó antes de que
     el día empezara, se le pone la hora de su PRIMER TOQUE de ese día —que es
     la primera prueba de que estaba trabajando— y, si no tiene ninguno, el
     principio del día. Se marca como `arrastrado` para poder decirlo en
     pantalla en vez de disimularlo.

     Se arregla al LEER y no al escribir a propósito: así también quedan bien
     los días que ya están guardados, sin tocar lo que mandó la tablet. */
  const turnosCrudos = sinArrastrar(turnosSinArreglar, dia, toquesTodos);

  /* =========================================================================
     DOS TURNOS CON EL MISMO NOMBRE SON UN TURNO
     =========================================================================
     Lo pidió Aaron el 17 ago 2026: "si se registran dos turnos con exactamente
     el mismo nombre, que se junten, porque muy probablemente es porque se ha
     tenido que cambiar de dispositivo".

     Y es así: la tablet se queda sin batería, o se cambia de móvil, y al poner
     el nombre otra vez se abre un turno nuevo. Sin juntarlos, esa persona sale
     dos veces en la tabla, su rato se parte en dos y las horas trabajadas —de
     las que cuelga el coste— salen mal.

     PERO NO SE JUNTA TODO A CIEGAS. Alguien puede hacer dos turnos de verdad en
     un día: mañana y tarde. Juntar esos dos le colgaría todo lo que se vendió
     mientras no estaba. Así que se juntan los que se SOLAPAN o los que están
     pegados —menos de media hora entre que uno acaba y el siguiente empieza—,
     que es lo que pasa cuando se cambia de aparato. Con un hueco mayor son dos
     turnos y se dejan como dos.

     El nombre se compara sin mayúsculas ni espacios de sobra, por lo mismo que
     en la cola: "yasmin" y "Yasmin " son la misma persona.
     ======================================================================= */
  const HUECO_MISMO_TURNO_MS = 30 * 60000;
  const turnosTodos = (() => {
    const ms0 = (x) => new Date(x).getTime();
    /* La última vez que se supo de esa persona antes de `tope`: su último toque
       dentro del turno abierto. Es la señal de vida que dice si el turno nuevo
       es una continuación o algo aparte. */
    const ultimaSenal = (lista, abierto, tope) => {
      const nombre = String(abierto.vendedora || '').trim().toLowerCase();
      const desde = ms0(abierto.empezo);
      let max = 0;
      for (const q of toquesTodos) {
        if (String(q.vendedora || '').trim().toLowerCase() !== nombre) continue;
        const c = ms0(q.en);
        if (c >= desde && c <= tope && c > max) max = c;
      }
      return max || null;
    };
    const porNombre = new Map();
    for (const t of turnosCrudos) {
      const k = String(t.vendedora || '').trim().toLowerCase();
      if (!porNombre.has(k)) porNombre.set(k, []);
      porNombre.get(k).push({ ...t });
    }
    const fuera = [];
    for (const lista of porNombre.values()) {
      lista.sort((a, b) => ms0(a.empezo) - ms0(b.empezo));
      let actual = null;
      for (const t of lista) {
        if (!actual) { actual = { ...t, unidos: 1 }; continue; }
        /* ¿CUÁNDO SE LE PERDIÓ LA PISTA AL TURNO DE ANTES?
         *
         * Si lo cerró, ahí. Y si se quedó abierto —que es lo normal cuando la
         * tablet se apaga— la última señal de vida es su último toque: si el
         * turno nuevo empieza justo después, cambió de aparato; si empieza tres
         * horas después de su última marca, es otro turno del día y NO se junta.
         *
         * Sin esto, un turno abierto se tragaba cualquier turno posterior de la
         * misma persona, y a alguien que hace mañana y tarde se le colgaba todo
         * lo vendido mientras no estaba. */
        const finActual = actual.acabo ? ms0(actual.acabo)
          : (ultimaSenal(lista, actual, ms0(t.empezo)) || ms0(actual.empezo));
        if (ms0(t.empezo) - finActual <= HUECO_MISMO_TURNO_MS) {
          /* Se junta: empieza cuando empezó el primero y acaba cuando acabe el
             último. Si alguno sigue abierto, el junto sigue abierto. */
          actual.acabo = (!actual.acabo || !t.acabo) ? null
            : (ms0(t.acabo) > ms0(actual.acabo) ? t.acabo : actual.acabo);
          actual.lote_inicio = actual.lote_inicio != null ? actual.lote_inicio : t.lote_inicio;
          actual.lote_fin = t.lote_fin != null ? t.lote_fin : actual.lote_fin;
          if (!actual.cuenta && t.cuenta) actual.cuenta = t.cuenta;
          actual.unidos++;
        } else {
          fuera.push(actual);
          actual = { ...t, unidos: 1 };
        }
      }
      if (actual) fuera.push(actual);
    }
    return fuera.sort((a, b) => ms0(a.empezo) - ms0(b.empezo));
  })();

  const ms = (x) => new Date(x).getTime();

  /* =========================================================================
     CADA TOQUE, CON LAS PRENDAS DE SU CUENTA
     =========================================================================
     Billy's emite desde dos cuentas: billysvlc y billystourvlc. La tablet
     pregunta al empezar desde cuál se emite y eso queda en el turno.

     Sin esto, un toque dado en un directo de la cuenta tour se cruzaba por
     hora con la prenda que acabara de vender la OTRA cuenta, porque las dos
     venden a la vez y el reloj no las distingue.

     UNA PRENDA SIN NOMBRE DE CUENTA ES DE LA CUENTA QUE TIENE PANEL.
     =========================================================================
     Esto es lo que faltaba, y el 17 ago 2026 se vio en la cara de Anny: seis
     ventas de billysvlc atribuidas a ella, que estaba emitiendo en
     billystourvlc.

     El motivo: las prendas que llegan EN VIVO del panel no traen el nombre de
     la cuenta, traen el identificador interno del producto. La regla de antes
     decía "si no lleva nombre, no se descarta", así que ninguna prenda en vivo
     se descartaba nunca y cualquiera podía llevárselas por hora.

     Pero sí se sabe de quién son: EL PANEL DEL DIRECTO ES DE UNA SOLA CUENTA.
     No hay panel de billystourvlc —de esa cuenta no se sabe nada hasta que se
     leen los pedidos, al acabar—. Así que una prenda sin nombre de cuenta es de
     la cuenta que tiene panel, y punto: eso convierte "no se puede saber" en un
     dato, que es lo que hacía falta.
     ======================================================================= */
  /* La cuenta cuyo panel de directo alimenta las prendas en vivo. Se puede
     cambiar por entorno el día que la del tour tenga panel. */
  const CUENTA_CON_PANEL = process.env.BILLYS_CUENTA_PANEL || 'billysvlc';
  const esNombreDeCuenta = (c) => !!c && !/^\d+$/.test(String(c));
  /* De qué cuenta es una prenda. Con nombre, el que traiga; sin nombre, viene
     del panel y el panel es de una sola cuenta. */
  const cuentaDeLote = (l) => (esNombreDeCuenta(l.cuenta) ? String(l.cuenta) : CUENTA_CON_PANEL);

  /* =========================================================================
     UNA CUENTA A LA VEZ  ·  las pestañas de /reparto
     =========================================================================
     Billy's emite desde dos cuentas y a la vez. Mezclarlas en una sola página
     hace dos daños: no se puede comprobar que en billysvlc está solo lo de
     billysvlc, y los totales invitan a comparar cosas que no se pueden comparar
     —de la cuenta del tour no se sabe nada hasta que se leen sus pedidos—.

     Así que se filtra AQUÍ, y todo lo de abajo se calcula ya con una sola
     cuenta: los turnos, las prendas, el dinero, las horas, los tipos. Filtrar en
     la página sería tener que recalcular a mano cada bloque, y el día que se
     añada uno nuevo se olvidaría.

     Sin `cuenta` en la dirección no se filtra nada y sale todo junto, como
     siempre: hay días de una sola cuenta y ahí las pestañas no hacen falta.
     ======================================================================= */
  const cuentasDelDia = [...new Set([
    ...lotesTodos.map(cuentaDeLote),
    ...turnosTodos.map((t) => String(t.cuenta || '').trim()).filter(Boolean)
  ])].sort((a, b) => (a === CUENTA_CON_PANEL ? -1 : b === CUENTA_CON_PANEL ? 1 : a.localeCompare(b)));

  /* La cuenta de un toque sale del turno que lo contiene. Se busca SIEMPRE
     entre todos los turnos del día, no entre los filtrados: si no, al mirar una
     cuenta los toques de la otra se quedarían "sin cuenta" y podrían llevarse
     una prenda que no es suya, que es justo lo que esto evita. */
  const cuentaDelToque = (t) => {
    const suyos = turnosTodos.filter((x) => x.vendedora === t.vendedora && x.cuenta);
    if (!suyos.length) return '';
    const q = ms(t.en);
    /* El turno que lo contiene; si ninguno lo contiene, el último que empezó
       antes: un toque dado dos minutos después de cerrar sigue siendo suyo. */
    const dentro = suyos.find((x) => q >= ms(x.empezo) && q <= ms(x.acabo || Date.now()));
    if (dentro) return dentro.cuenta;
    const antes = suyos.filter((x) => ms(x.empezo) <= q).pop();
    return antes ? antes.cuenta : '';
  };

  const pedida = String(soloCuenta || '').trim();
  const filtrando = !!pedida && cuentasDelDia.includes(pedida);
  /* Los turnos y toques sin cuenta —de antes de que la tablet la preguntara— se
     quedan con la cuenta que tiene panel: sus ventas salían de ahí. */
  const deQuien = (c) => (String(c || '').trim() || CUENTA_CON_PANEL);
  const lotes = filtrando ? lotesTodos.filter((l) => cuentaDeLote(l) === pedida) : lotesTodos;
  const turnos = filtrando ? turnosTodos.filter((t) => deQuien(t.cuenta) === pedida) : turnosTodos;
  const toques = filtrando
    ? toquesTodos.filter((t) => deQuien(cuentaDelToque(t)) === pedida)
    : toquesTodos;

  const libres = lotes.map((l) => ({ l, tomado: false }));
  const filas = [];
  /* Si no sabemos de qué cuenta emitía —turnos viejos, sin cuenta guardada— no
     se descarta nada: eso dejaría el día entero sin cruzar. En cuanto la tablet
     pregunta la cuenta, que es desde el 15 ago 2026, la regla es estricta. */
  const compatible = (t, l) => {
    const suya = cuentaDelToque(t);
    if (!suya) return true;
    return cuentaDeLote(l) === String(suya);
  };

  /* ---------------------------------------------------------- 1 · EL LOTE
   * Si la tablet tenía el panel abierto, el toque lleva pegado el número de
   * prenda por el que iba el directo en ese instante. Eso no hay que
   * adivinarlo: gana a cualquier cálculo por horas. */
  const porNumero = new Map();
  for (const x of libres) porNumero.set(x.l.cuenta + '#' + x.l.num, x);

  const sinLote = [];
  for (const t of toques) {
    /* Incluso el camino sellado tiene que respetar la cuenta: si el número
       vino de un panel que no es el de su directo, no es su prenda. */
    const porClave = t.lote == null ? null : porNumero.get((t.cuenta || '') + '#' + t.lote);
    const sellado = t.lote == null ? null
      : ((porClave && compatible(t, porClave.l)) ? porClave
        : libres.find((x) => !x.tomado && x.l.num === t.lote && compatible(t, x.l)));
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
      if (!compatible(t, libres[k].l)) continue;   // es de la otra cuenta
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
  /* DE QUÉ CUENTAS TENEMOS DATOS DE VENTA, Y DE CUÁLES NO.
   *
   * Las prendas vendidas salen del panel del directo, y ese panel es de
   * billysvlc. De billystourvlc NO HAY PANEL: no hay forma de saber cuántas
   * prendas se vendieron en su directo mientras pasaba.
   *
   * EL 17 AGO 2026 ESO LE CAYÓ ENCIMA A ANNY. Emitía en billystourvlc a la vez
   * que Yasmine en billysvlc, y su fila decía "15 vendidas · 5 marcadas · 33 %
   * · 10 sin marcar · 32 €". Las quince eran de la OTRA cuenta, contadas contra
   * su turno solo porque coincidían en la hora: se le colgaba el trabajo de otra
   * y encima se la señalaba por no haberlo marcado.
   *
   * Un turno de una cuenta de la que no hay datos no vale cero: vale NO SE SABE.
   * Lo que sí se sabe —lo que ella marcó— se sigue enseñando tal cual. */
  const cuentasConDatos = new Set(lotes.map(cuentaDeLote));
  const sinDatos = (t) => !!t.cuenta && !cuentasConDatos.has(String(t.cuenta));

  const porTurno = turnos.map((t) => {
    /* Solo lo vendido EN SU CUENTA. Sin esto, dos directos a la vez se cuentan
       el uno al otro: es lo que le pasó a Anny. Si del turno no se sabe la
       cuenta —turnos de antes del 15 ago— se cuenta como antes. */
    const dentro = sinDatos(t) ? [] : lotes.filter((l) => enVentana(t, l.vendida_en) &&
      (!t.cuenta || cuentaDeLote(l) === String(t.cuenta)));
    const suyas = filas.filter((f) => f.vendedora === t.vendedora && f.lote != null);
    const solapado = turnos.some((o) => o !== t && o.vendedora !== t.vendedora &&
      ms(o.empezo) < hasta(t) && hasta(o) > ms(t.empezo));
    const ciega = sinDatos(t);
    return {
      vendedora: t.vendedora, empezo: t.empezo, cuenta: t.cuenta || '',
      /* `acabo` es lo que hay guardado; `fin` es hasta cuándo se cuenta. */
      acabo: t.acabo, fin: finDe(t),
      abierto: !finDe(t), cerradoSolo: !t.acabo && !!finDe(t), solapado,
      /* true = de esta cuenta no hay datos de venta y no se puede saber. */
      sinDatos: ciega,
      /* Cuántos turnos sueltos se han juntado en este. Más de uno = cambió de
         aparato a mitad, y en pantalla se dice para que no parezca un error. */
      unidos: t.unidos || 1,
      /* Lo que se vendió mientras ella estaba, en SU cuenta. */
      vendidas: ciega ? null : dentro.length,
      euros: ciega ? null : Math.round(dentro.reduce((a, l) => a + eur(l.precio), 0) * 100) / 100,
      /* Lo que ella marcó y cruzó. Esto se sabe siempre. */
      marcadas: suyas.length,
      /* Y lo que marcó, cruce o no. Para un turno del que no hay datos de venta
         es LO ÚNICO que se sabe de su trabajo: sus marcas están, lo que no está
         es la prenda a la que van, y llegará cuando se lean los pedidos de su
         cuenta. Sin esto su fila decía "0 marcadas" y parecía que no hizo nada. */
      marcas: filas.filter((f) => f.vendedora === t.vendedora).length,
      eurosMarcados: Math.round(suyas.reduce((a, f) => a + eur(f.precio), 0) * 100) / 100,
      pct: (ciega || !dentro.length) ? null : Math.round(suyas.length / dentro.length * 100)
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
    /* LAS CUENTAS DEL DÍA Y CUÁL SE ESTÁ MIRANDO. Con esto /reparto pinta sus
     * pestañas: una por cuenta, y cada una con SOLO lo suyo. La del panel
     * primero, que es la que se mira siempre. */
    cuentas: cuentasDelDia,
    cuenta: filtrando ? pedida : null,
    cuentaConPanel: CUENTA_CON_PANEL,
    /* De la cuenta que no tiene panel no se sabe nada hasta que se leen sus
     * pedidos. Que la página lo diga en vez de enseñar ceros. */
    sinPanel: filtrando ? pedida !== CUENTA_CON_PANEL : false,
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

    /* ------------------------------------------------------ LOS DESHECHOS
     * Cuando alguien pulsa "Deshacer" en la tablet, el toque desaparece de su
     * pantalla. Antes se quedaba en el servidor para siempre: la vendedora
     * veía 40 prendas y el reparto le contaba 41, y esa de más se llevaba una
     * venta que no era suya.
     *
     * Se borra por hora exacta y solo lo suyo, de su día. Es idempotente:
     * repetir el envío no borra nada de nadie más. */
    let quitados = 0;
    const fuera = (Array.isArray(b.quitar) ? b.quitar : [])
      .map((x) => aFecha(x)).filter(Boolean);
    if (fuera.length) {
      const r = await s`
        delete from toques
         where dia = ${dia} and vendedora = ${vendedora} and en in ${s(fuera)}
        returning en`;
      quitados = r.length;
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
          insert into turnos (dia, vendedora, empezo, acabo, lote_inicio, lote_fin, directo, cuenta)
          values (${dia}, ${vendedora}, ${empezo}, ${aFecha(t.acabo || t.fin)},
                  ${aEntero(t.loteInicio)}, ${aEntero(t.loteFin)}, ${directo}, ${aTexto(t.cuenta)})
          on conflict (dia, vendedora, empezo) do update set
            acabo       = coalesce(excluded.acabo, turnos.acabo),
            lote_inicio = coalesce(excluded.lote_inicio, turnos.lote_inicio),
            lote_fin    = coalesce(excluded.lote_fin, turnos.lote_fin),
            /* La cuenta solo se pisa si viene puesta: un reenvío sin ella no
               puede borrar la que ya se eligió. */
            cuenta      = case when excluded.cuenta = '' then turnos.cuenta else excluded.cuenta end,
            actualizado = now()
          returning empezo, acabo, cuenta`;
        turno = f;
      }
    }

    const total = await s`select count(*)::int as n from toques where dia = ${dia} and vendedora = ${vendedora}`;
    return res.status(200).json({ ok: true, dia, vendedora, guardados, quitados, turno, total: total[0].n });
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

    /* Mismo arreglo que en el cruce: un turno que dice que empezó antes del día
       es una tablet que se quedó abierta, no 46 horas de trabajo. */
    const turnos = sinArrastrar(await s`
      select vendedora, empezo, acabo, lote_inicio, lote_fin, cuenta
      from turnos where dia = ${dia} order by empezo`, dia, filas);

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
    /* ?cuenta=billysvlc → todo lo de abajo se calcula con esa cuenta y nada
       más. Es lo que hace que /reparto pueda tener una pestaña por cuenta y que
       en la de billysvlc no haya NADA que no sea de billysvlc. */
    if (q.cruce) salida.cruce = await cruzar(s, dia, filas, aTexto(q.cuenta).trim());

    return res.status(200).json(salida);
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
