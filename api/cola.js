/* /api/cola — la cola de empaquetado.
 *
 *   POST { accion:'meter',     quien, paquetes:[{pedido, apodo, prendas, tanda, ficha, en, incidencia, motivo}] }
 *   POST { accion:'siguiente', quien }
 *   POST { accion:'cerrar',    quien, pedido }
 *   POST { accion:'cerrarLista', quien, paquetes:[...] }  ← el "Listo" del que empaqueta, desde la lista
 *   POST { accion:'reabrir',   quien, pedido }            ← su "Atrás"
 *   POST { accion:'soltar',    quien, pedido }
 *   POST { accion:'coger',     quien, pedido }        ← me llevo ESE, aunque lo tenga otro
 *   POST { accion:'resolver',  quien, pedido }        ← la incidencia ya está arreglada
 *   GET  ?d=CODIGO&dia=YYYY-MM-DD
 *
 * LOS CINCO ESTADOS DE UN PAQUETE, Y POR QUÉ HAY CINCO
 *
 *   espera    · deslizado y esperando a que alguien lo pida
 *   haciendo  · alguien lo tiene en la mesa
 *   cerrado   · hecho
 *   parado    · se deslizó como INCIDENCIA: falta una prenda o algo no cuadra.
 *               No se reparte, pero EXISTE, tiene número y se ve.
 *   retirado  · el recogedor deshizo el deslice. No se borra: se marca.
 *
 * LOS DOS ÚLTIMOS SON DEL 17 AGO 2026, y son la reparación de un agujero que se
 * vio con los datos del día en la mano: de 73 paquetes recogidos solo 56 habían
 * entrado en la cola. Los 17 que faltaban eran las INCIDENCIAS —19 de un
 * recogedor y 2 de otra—, que se quedaban fuera de la cola sin aparecer en
 * ningún sitio: nadie las empaquetaba y nadie podía saber que existían. Y el
 * hueco del número 26 era un "Atrás" que borraba la fila y dejaba la
 * numeración saltando sin explicación, que es lo que se veía como "se salta
 * pedidos".
 *
 * La regla de ahora: TODO lo que se desliza entra en la cola y coge número.
 * Que esté parado o retirado es un estado, no una desaparición.
 *
 * PARA QUÉ EXISTE
 * Hasta hoy, quien recogía y quien empaquetaba recorrían la MISMA lista, cada
 * uno en su móvil, y se cruzaban al final por comprador. Eso funciona con una
 * pareja fija. No funciona cuando hay un solo recogedor y tres personas
 * doblando, que es como se trabaja de verdad: no hay forma de que los tres
 * sepan cuál coger sin gritárselo, y dos acaban haciendo el mismo paquete.
 *
 * Así que el recogedor deja de mandar una lista y pasa a EMPUJAR: cada vez que
 * desliza un paquete, ese paquete entra aquí. Los que empaquetan no eligen:
 * piden "el siguiente" y el servidor reparte.
 *
 * EL REPARTO
 * `for update skip locked` es lo único que garantiza que a dos móviles no les
 * toque el mismo paquete cuando pulsan en el mismo instante. Sin eso, dos
 * transacciones leen la misma fila "en espera" y las dos se la llevan. No es
 * un caso raro: con tres personas pidiendo trabajo pasa el primer día.
 *
 * Si quien pide ya tiene uno a medias, se le devuelve EL SUYO en vez de darle
 * otro. Así recargar la página o volver de la pantalla de bloqueo no deja
 * paquetes huérfanos ni le quita el trabajo de las manos.
 *
 * ESCRIBE CON EL CÓDIGO, NO CON EL TOKEN
 * Por lo mismo que /api/toques y /api/tiempos: los móviles del almacén abren la
 * página con el código en la dirección. Si escribir aquí exigiera el token, el
 * token acabaría en la dirección de un móvil compartido.
 */
const {
  db, puerta, puedeLeer, noAutorizado, diaDe, aFecha, aEntero, aTexto, cuerpo
} = require('./_lib');

/* A partir de cuántos minutos un paquete cogido y no cerrado se considera
 * atascado. Doce: los paquetes que se cierran bien tardan de uno a cinco
 * minutos, así que doce es holgado de sobra para uno difícil y corto para
 * que nadie espere media hora por un móvil que se apagó. */
const ATASCO_MIN = 12;

/* MISMA PERSONA ESCRITA DE DOS MANERAS.
 *
 * El 17 ago 2026 la misma chica salió como "yasmin" (8 paquetes) y "Yasmine"
 * (26): lo escribe a mano en el móvil y ese día se lo escribió de dos formas.
 * Para el programa eran dos trabajadoras, así que "¿este paquete es mío?" decía
 * que no, el rescate de atascos se lo quitaba a ella misma y los recuentos
 * salían partidos en dos.
 *
 * Se compara sin mayúsculas y sin espacios de sobra. Se GUARDA como lo escribió
 * ella, que es lo que quiere leer en la pantalla. */
const igual = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/* Los dos extremos del reloj de un paquete se guardan además en `tiempos`, que
 * es de donde tira la página /tiempos. Así la cola no obliga a reescribir esa
 * página ni parte el histórico en dos sitios. */
async function apuntarTiempo(s, { dia, quien, modo, pedido, apodo, prendas, en }) {
  if (!quien || !pedido || !en) return;
  await s`
    insert into tiempos (dia, quien, modo, equipo, pedido, apodo, prendas, en, estado)
    values (${dia}, ${quien}, ${modo}, '', ${pedido}, ${apodo || null}, ${prendas}, ${en}, 'listo')
    on conflict (dia, quien, pedido, estado) do update set
      en      = excluded.en,
      prendas = coalesce(excluded.prendas, tiempos.prendas),
      apodo   = coalesce(excluded.apodo, tiempos.apodo)`;
}

module.exports = puerta(async (req, res) => {
  const s = db();

  if (req.method === 'POST') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const b = cuerpo(req);
    const dia = diaDe(b.dia);
    const quien = aTexto(b.quien).trim();
    const accion = aTexto(b.accion) || 'meter';

    /* ------------------------------------------------------------ METER
     * Lo llama el recogedor cada vez que desliza. Manda SIEMPRE todo lo que
     * lleva deslizado, no solo lo último: si un envío se perdió por falta de
     * cobertura, el siguiente lo arregla solo. Por eso `do nothing` — repetir
     * un paquete que ya está en la cola no puede tocarlo, que a lo mejor ya lo
     * está haciendo alguien. */
    if (accion === 'meter') {
      const brutos = (Array.isArray(b.paquetes) ? b.paquetes : [])
        .map((x) => ({
          pedido: aTexto(x.pedido).trim(),
          apodo: aTexto(x.apodo),
          tanda: aTexto(x.tanda),
          prendas: aEntero(x.prendas),
          ficha: x.ficha && typeof x.ficha === 'object' ? x.ficha : {},
          en: aFecha(x.en || x.t) || new Date(),
          /* UNA INCIDENCIA TAMBIÉN ES UN PAQUETE.
           *
           * Antes las incidencias no se mandaban: el móvil las guardaba para su
           * pantalla de fin de tanda y ahí se acababa todo. El 17 ago 2026 eso
           * dejó 21 paquetes recogidos que no existían para nadie más. Ahora
           * entran igual, con su número, en 'parado'. No se reparten —falta una
           * prenda, no se puede cerrar— pero se ven y se pueden resolver. */
          incidencia: !!x.incidencia || aTexto(x.estado) === 'inc',
          motivo: aTexto(x.motivo)
        }))
        .filter((x) => x.pedido);
      if (!brutos.length) return res.status(400).json({ ok: false, error: 'sin-paquetes' });

      /* El número de paquete es lo que la gente se dice en voz alta ("voy con
       * el 12"). Tiene que ser correlativo y no saltar huecos, así que se
       * numera solo lo que de verdad es nuevo y se calcula desde el máximo que
       * ya hay guardado ese día. */
      const yaHay = await s`select pedido, estado from cola where dia = ${dia}`;
      const dentro = new Map(yaHay.map((x) => [x.pedido, x.estado]));
      const nuevos = brutos.filter((x) => !dentro.has(x.pedido));
      /* Los que ya estaban PARADOS o RETIRADOS y ahora llegan como buenos: la
       * prenda apareció, o el "Atrás" fue un resbalón y se volvió a deslizar.
       * Vuelven a la cola con su número de siempre. */
      const revividos = brutos.filter((x) => !x.incidencia &&
        ['parado', 'retirado'].includes(dentro.get(x.pedido)));

      let metidos = 0;
      if (nuevos.length) {
        const [mx] = await s`select coalesce(max(numero), 0)::int as n from cola where dia = ${dia}`;
        const filas = nuevos.map((x, k) => ({
          dia, pedido: x.pedido, numero: mx.n + k + 1,
          apodo: x.apodo, tanda: x.tanda, prendas: x.prendas,
          /* s.json y no JSON.stringify: en una columna jsonb, una cadena se
           * guarda COMO cadena y al leerla vuelve texto, no la ficha. */
          ficha: s.json(x.ficha), estado: x.incidencia ? 'parado' : 'espera',
          motivo: x.motivo,
          quien_abrio: quien, abierto_en: x.en
        }));
        await s`
          insert into cola ${s(filas, 'dia', 'pedido', 'numero', 'apodo', 'tanda',
                              'prendas', 'ficha', 'estado', 'motivo', 'quien_abrio', 'abierto_en')}
          on conflict (dia, pedido) do nothing`;
        metidos = filas.length;

        /* El "listo" del recogedor es ABRIR el paquete: ahí arranca el reloj
         * del que empaqueta. Se apunta en el mismo gesto. Las incidencias no:
         * ese paquete no está listo para nadie, y apuntarle la hora de entrega
         * sería contar como entregado algo que sigue en el suelo. */
        for (const x of nuevos) {
          if (x.incidencia) continue;
          await apuntarTiempo(s, { dia, quien, modo: 'recoge', pedido: x.pedido,
                                   apodo: x.apodo, prendas: x.prendas, en: x.en });
        }
      }

      let revueltos = 0;
      for (const x of revividos) {
        const f = await s`
          update cola
             set estado = 'espera', motivo = '', quien_cierra = '', tomado_en = null,
                 abierto_en = ${x.en}, quien_abrio = ${quien},
                 ficha = case when cola.ficha = '{}'::jsonb then ${s.json(x.ficha)} else cola.ficha end
           where dia = ${dia} and pedido = ${x.pedido} and estado in ('parado', 'retirado')
          returning numero`;
        if (f.length) {
          revueltos++;
          await apuntarTiempo(s, { dia, quien, modo: 'recoge', pedido: x.pedido,
                                   apodo: x.apodo, prendas: x.prendas, en: x.en });
        }
      }

      /* ¿ESTE PAQUETE YA LO HABÍA RECOGIDO OTRO?
       *
       * El 17 ago 2026 hubo 124 marcas de recogida sobre 73 paquetes: dos
       * personas recorrieron las mismas tandas sin saberlo. Para el segundo, la
       * cola no hace nada —el paquete ya estaba— así que desde su móvil parece
       * que su deslice se ha perdido: "lo he pasado y no aparece". Es la otra
       * mitad de lo que Aaron veía como "se saltan pedidos".
       *
       * Aquí se dice quién lo recogió y con qué número, para que su móvil pueda
       * avisarle en el momento en vez de que lo descubran al final del día. */
      const repetidos = brutos.filter((x) => dentro.has(x.pedido) &&
        !revividos.some((y) => y.pedido === x.pedido)).map((x) => x.pedido);
      let deOtro = [];
      if (repetidos.length) {
        const filas = await s`
          select pedido, numero, apodo, estado, quien_abrio from cola
           where dia = ${dia} and pedido = any(${repetidos})`;
        deOtro = filas
          .filter((f) => f.quien_abrio && !igual(f.quien_abrio, quien))
          .map((f) => ({ pedido: f.pedido, numero: f.numero, apodo: f.apodo,
                         estado: f.estado, quien: f.quien_abrio }));
      }

      const [c] = await s`
        select count(*) filter (where estado = 'espera')::int   as espera,
               count(*) filter (where estado = 'haciendo')::int as haciendo,
               count(*) filter (where estado = 'cerrado')::int  as cerrado,
               count(*) filter (where estado = 'parado')::int   as parado,
               count(*) filter (where estado = 'retirado')::int as retirado
        from cola where dia = ${dia}`;
      return res.status(200).json({ ok: true, dia, metidos, revueltos, deOtro,
                                    recibidos: brutos.length, ...c });
    }

    if (!quien) return res.status(400).json({ ok: false, error: 'sin-quien' });

    /* --------------------------------------------------------- SIGUIENTE */
    if (accion === 'siguiente') {
      /* Primero, lo suyo. Recargar la página no puede costarle el paquete que
       * tiene en la mesa ni pedir otro encima. */
      const mio = await s`
        select * from cola
        where dia = ${dia} and estado = 'haciendo'
          and lower(btrim(quien_cierra)) = lower(btrim(${quien}))
        order by numero limit 1`;
      if (mio.length) return res.status(200).json({ ok: true, dia, hay: true, yaLoTenias: true, paquete: mio[0] });

      /* El reparto. El `skip locked` hace que dos móviles que pulsan a la vez
       * se lleven filas distintas en vez de pelearse por la misma. */
      const dado = await s`
        with elegido as (
          select pedido from cola
          where dia = ${dia} and estado = 'espera'
          order by numero
          for update skip locked
          limit 1
        )
        update cola c
           set estado = 'haciendo', quien_cierra = ${quien}, tomado_en = now()
          from elegido e
         where c.dia = ${dia} and c.pedido = e.pedido
        returning c.*`;
      if (dado.length) return res.status(200).json({ ok: true, dia, hay: true, paquete: dado[0] });

      /* --------------------------------------------------- LOS ATASCADOS
       * Un paquete que alguien cogió y nunca cerró se queda fuera de la
       * circulación para siempre: nadie más puede pedirlo. Pasa el primer
       * día —se va a comer, cierra la pestaña, cambia de móvil— y el paquete
       * no vuelve solo.
       *
       * No se sueltan solos cada X minutos: eso se lo quitaría de las manos
       * a quien está con uno difícil de verdad. Se rescatan solo cuando NO
       * QUEDA NADA MÁS QUE HACER, que es cuando el rescate no le quita el
       * trabajo a nadie y sí desatasca el día. Y se avisa de quién lo tenía,
       * para que lo compruebe antes de cerrarlo. */
      const rescatado = await s`
        with elegido as (
          select pedido, quien_cierra as antes, tomado_en as desde from cola
          where dia = ${dia} and estado = 'haciendo'
            and lower(btrim(quien_cierra)) <> lower(btrim(${quien}))
            and tomado_en < now() - ${ATASCO_MIN + ' minutes'}::interval
          order by tomado_en
          for update skip locked
          limit 1
        )
        update cola c
           set quien_cierra = ${quien}, tomado_en = now()
          from elegido e
         where c.dia = ${dia} and c.pedido = e.pedido
        returning c.*, e.antes, e.desde`;
      if (rescatado.length) {
        return res.status(200).json({ ok: true, dia, hay: true, rescatado: true,
          loTenia: rescatado[0].antes,
          minutos: Math.round((Date.now() - new Date(rescatado[0].desde)) / 60000),
          paquete: rescatado[0] });
      }

      /* "No hay" nunca es solo "no hay". Puede ser que no quede nada —bien— o
       * que quede algo abierto en el móvil de alguien y veinte paquetes parados
       * por incidencia. Eso último tiene que salir en la pantalla, porque si no
       * el día se acaba con trabajo sin hacer y todos pensando que acabaron. */
      const [c] = await s`
        select count(*) filter (where estado = 'haciendo')::int as haciendo,
               count(*) filter (where estado = 'cerrado')::int  as cerrado,
               count(*) filter (where estado = 'parado')::int   as parado
        from cola where dia = ${dia}`;
      return res.status(200).json({ ok: true, dia, hay: false, ...c });
    }

    /* ------------------------------------------------------------ CERRAR */
    if (accion === 'cerrar') {
      const pedido = aTexto(b.pedido).trim();
      if (!pedido) return res.status(400).json({ ok: false, error: 'sin-pedido' });
      const en = aFecha(b.en || b.t) || new Date();
      const fila = await s`
        update cola set estado = 'cerrado', cerrado_en = ${en},
                        quien_cierra = case when quien_cierra = '' then ${quien} else quien_cierra end
         where dia = ${dia} and pedido = ${pedido}
        returning *`;
      if (!fila.length) return res.status(404).json({ ok: false, error: 'no-esta-en-la-cola' });

      await apuntarTiempo(s, { dia, quien, modo: 'empaqueta', pedido,
                               apodo: fila[0].apodo, prendas: fila[0].prendas, en });

      const [c] = await s`
        select count(*) filter (where estado = 'espera')::int  as espera,
               count(*) filter (where estado = 'cerrado')::int as cerrado
        from cola where dia = ${dia}`;
      return res.status(200).json({ ok: true, dia, pedido, ...c });
    }

    /* ----------------------------------------------- CERRAR UNA LISTA
     * EL "LISTO" DE QUIEN EMPAQUETA, DESDE LA LISTA DE TANDAS.
     *
     * 18 ago 2026, con la mesa llena: los que empaquetan llevaban toda la vida
     * deslizando y dando a "Listo" en la lista, y al meter la cola les quité la
     * lista y les dejé SOLO el botón de "dame el siguiente". Resultado: los
     * paquetes que el recogedor no había empujado —o los que se hicieron sin
     * mirar la cola— no se podían cerrar de ninguna manera. Diecinueve paquetes
     * cerrados de verdad, encima de la mesa, y en el servidor ni uno. Ni sus
     * nombres.
     *
     * Así que vuelve el gesto de siempre, y aquí se recibe:
     *
     *   - Si el paquete está en la cola, se cierra y se apunta a nombre de
     *     quien lo cerró, que es quien lo tuvo delante.
     *   - SI NO ESTÁ, SE CREA YA CERRADO. Un paquete que se ha empaquetado
     *     existió, aunque nadie lo empujara: negarlo es cómo se pierde el
     *     trabajo de una tarde. Coge su número como cualquier otro.
     *
     * Se manda en lista y se puede repetir: cerrar dos veces el mismo paquete
     * lo deja igual de cerrado. */
    if (accion === 'cerrarLista') {
      const lista = (Array.isArray(b.paquetes) ? b.paquetes : [])
        .map((x) => ({
          pedido: aTexto(x.pedido).trim(),
          apodo: aTexto(x.apodo),
          tanda: aTexto(x.tanda),
          prendas: aEntero(x.prendas),
          ficha: x.ficha && typeof x.ficha === 'object' ? x.ficha : {},
          en: aFecha(x.en || x.t) || new Date()
        }))
        .filter((x) => x.pedido);
      if (!lista.length) return res.status(400).json({ ok: false, error: 'sin-paquetes' });

      let cerrados = 0, creados = 0;
      const deOtro = [];        // lo tenía otro en la mesa: se avisa, no se calla
      for (const x of lista) {
        const [antes] = await s`
          select estado, quien_cierra, numero, apodo, prendas from cola
           where dia = ${dia} and pedido = ${x.pedido}`;
        /* Si el paquete ya existe, mandan SUS datos: quien cierra desde la
         * lista de "lo que queda" solo tiene el número a mano, no el nombre del
         * comprador ni cuántas prendas lleva. */
        if (antes) {
          if (!x.apodo) x.apodo = antes.apodo || '';
          if (x.prendas == null) x.prendas = antes.prendas;
        }
        if (antes) {
          /* Quien lo cierra es quien lo tuvo delante. Si estaba abierto en el
           * móvil de otro, se cierra igual —el paquete está hecho— y se dice. */
          if (antes.estado === 'haciendo' && antes.quien_cierra && !igual(antes.quien_cierra, quien)) {
            deOtro.push({ pedido: x.pedido, numero: antes.numero, apodo: x.apodo, quien: antes.quien_cierra });
          }
          await s`
            update cola set estado = 'cerrado', cerrado_en = ${x.en}, quien_cierra = ${quien}
             where dia = ${dia} and pedido = ${x.pedido}`;
          cerrados++;
        } else {
          const [mx] = await s`select coalesce(max(numero), 0)::int as n from cola where dia = ${dia}`;
          await s`
            insert into cola (dia, pedido, numero, apodo, tanda, prendas, ficha, estado,
                              motivo, quien_abrio, abierto_en, quien_cierra, tomado_en, cerrado_en)
            /* abierto_en = la hora del cierre: es lo único que se sabe de un
             * paquete que nadie empujó, y la columna no admite vacío. Queda
             * quien_abrio en blanco, que es lo honesto: no se sabe quién lo
             * recogió, y inventarlo sería peor que dejarlo vacío. */
            values (${dia}, ${x.pedido}, ${mx.n + 1}, ${x.apodo}, ${x.tanda}, ${x.prendas},
                    ${s.json(x.ficha)}, 'cerrado', '', '', ${x.en}, ${quien}, ${x.en}, ${x.en})
            on conflict (dia, pedido) do update set
              estado = 'cerrado', cerrado_en = ${x.en}, quien_cierra = ${quien}`;
          creados++; cerrados++;
        }
        await apuntarTiempo(s, { dia, quien, modo: 'empaqueta', pedido: x.pedido,
                                 apodo: x.apodo, prendas: x.prendas, en: x.en });
      }

      const [c] = await s`
        select count(*) filter (where estado = 'espera')::int   as espera,
               count(*) filter (where estado = 'haciendo')::int as haciendo,
               count(*) filter (where estado = 'cerrado')::int  as cerrado,
               count(*) filter (where estado = 'parado')::int   as parado
        from cola where dia = ${dia}`;
      return res.status(200).json({ ok: true, dia, cerrados, creados, deOtro,
                                    recibidos: lista.length, ...c });
    }

    /* ------------------------------------------------------------ REABRIR
     * El "Atrás" de quien empaqueta. Se le fue el dedo y cerró el que no era.
     *
     * Solo se puede deshacer lo que cerró UNO MISMO: quitarle un cierre a otro
     * con un botón de deshacer sería peor que el error. Vuelve a 'espera' —no
     * a 'haciendo'— para que lo pueda coger cualquiera, y se borra la marca de
     * tiempo del empaquetado, que si no quedaría un paquete cerrado a una hora
     * en la que no se cerró. */
    if (accion === 'reabrir') {
      const pedido = aTexto(b.pedido).trim();
      if (!pedido) return res.status(400).json({ ok: false, error: 'sin-pedido' });
      const fila = await s`
        update cola set estado = 'espera', cerrado_en = null, quien_cierra = '', tomado_en = null
         where dia = ${dia} and pedido = ${pedido} and estado = 'cerrado'
           and lower(btrim(quien_cierra)) = lower(btrim(${quien}))
        returning numero`;
      if (!fila.length) {
        const [ahora] = await s`select estado, quien_cierra from cola where dia = ${dia} and pedido = ${pedido}`;
        return res.status(200).json({ ok: true, dia, reabierto: false,
                                      estado: ahora ? ahora.estado : null,
                                      quien: ahora ? ahora.quien_cierra : '' });
      }
      await s`delete from tiempos
               where dia = ${dia} and pedido = ${pedido} and modo = 'empaqueta'
                 and lower(btrim(quien)) = lower(btrim(${quien}))`;
      return res.status(200).json({ ok: true, dia, reabierto: true, numero: fila[0].numero });
    }

    /* ------------------------------------------------------------- TANDA
     * Quien recoge dice en qué tanda está y por dónde va. No es un candado
     * duro: es para que el otro lo VEA antes de meterse en la misma.
     *
     * Se puede quitar una tanda a alguien solo si lleva un rato largo sin dar
     * señales. Alguien que deja el móvil en la mesa diez minutos sigue
     * trabajando; alguien que cerró la pestaña hace media hora, no. */
    if (accion === 'tanda') {
      const tanda = aTexto(b.tanda).trim();
      if (!tanda) return res.status(400).json({ ok: false, error: 'sin-tanda' });
      const hechos = aEntero(b.hechos) || 0;
      const total = aEntero(b.total);
      const forzar = !!b.forzar;

      const [fila] = await s`
        insert into tandas_toma (dia, tanda, quien, hechos, total, actualizado)
        values (${dia}, ${tanda}, ${quien}, ${hechos}, ${total}, now())
        on conflict (dia, tanda) do update set
          quien       = case when tandas_toma.quien = ''
                              or lower(btrim(tandas_toma.quien)) = lower(btrim(${quien}))
                              or ${forzar}
                              or tandas_toma.actualizado < now() - interval '20 minutes'
                             then ${quien} else tandas_toma.quien end,
          hechos      = case when lower(btrim(tandas_toma.quien)) = lower(btrim(${quien})) or ${forzar}
                             then ${hechos} else tandas_toma.hechos end,
          total       = coalesce(${total}, tandas_toma.total),
          actualizado = case when lower(btrim(tandas_toma.quien)) = lower(btrim(${quien})) or ${forzar}
                             then now() else tandas_toma.actualizado end
        returning quien, hechos, total, actualizado`;

      return res.status(200).json({
        ok: true, dia, tanda,
        /* mia: false significa "esta tanda la está haciendo otro". Quien
         * pregunta decide si entra igual; aquí no se le prohíbe nada. */
        mia: igual(fila.quien, quien),
        quien: fila.quien, hechos: fila.hechos, total: fila.total
      });
    }

    /* ------------------------------------------------------------ SOLTAR
     * Se lo ha pedido y no puede hacerlo (le falta una prenda, se va a comer).
     * Vuelve a la cola para que lo coja otro, en su sitio de siempre. */
    if (accion === 'soltar') {
      const pedido = aTexto(b.pedido).trim();
      if (!pedido) return res.status(400).json({ ok: false, error: 'sin-pedido' });
      const fila = await s`
        update cola set estado = 'espera', quien_cierra = '', tomado_en = null
         where dia = ${dia} and pedido = ${pedido} and estado = 'haciendo'
        returning pedido`;
      return res.status(200).json({ ok: true, dia, soltado: fila.length > 0 });
    }

    /* ----------------------------------------------------------- RETIRAR
     * El recogedor se equivocó de deslice y da a "Atrás".
     *
     * Solo se retira lo que sigue ESPERANDO. Si alguien ya lo tiene en la mesa
     * o ya lo cerró, no se toca y se dice en qué estado está: quitarle un
     * paquete de las manos a otro por un botón de deshacer sería peor que el
     * error que se quería arreglar.
     *
     * NO SE BORRA LA FILA, SE MARCA. Antes esto era un `delete`, y por eso el
     * 17 ago 2026 la cola iba 24, 25, 27: el 26 no existía y no había forma de
     * saber si se había retirado o si el programa se lo había comido. Un hueco
     * sin explicación en una lista que la gente canta en voz alta es lo que se
     * ve como "se salta pedidos". Ahora el 26 sigue ahí, retirado y con nombre.
     *
     * Se borra sí la marca de tiempo de "abierto", que si no quedaría una hora
     * de entrega de un paquete que no se entregó. */
    if (accion === 'retirar') {
      const pedido = aTexto(b.pedido).trim();
      if (!pedido) return res.status(400).json({ ok: false, error: 'sin-pedido' });
      const fila = await s`
        update cola set estado = 'retirado', quien_cierra = '', tomado_en = null
         where dia = ${dia} and pedido = ${pedido} and estado in ('espera', 'parado')
        returning pedido, numero`;
      if (fila.length) {
        await s`delete from tiempos
                 where dia = ${dia} and pedido = ${pedido} and modo = 'recoge'`;
        return res.status(200).json({ ok: true, dia, retirado: true, estado: null, quien: '' });
      }
      const [ahora] = await s`
        select estado, quien_cierra from cola where dia = ${dia} and pedido = ${pedido}`;
      return res.status(200).json({
        ok: true, dia, retirado: false,
        estado: ahora ? ahora.estado : null,
        quien: ahora ? ahora.quien_cierra : ''
      });
    }

    /* ---------------------------------------------------------- RESOLVER
     * La incidencia ya está arreglada: apareció la prenda, o se cambió por otra
     * talla, o era un susto. El paquete pasa a la cola con su número de
     * siempre, para que le toque a alguien como a cualquier otro.
     *
     * Lo puede hacer cualquiera de los dos lados, y es a propósito: la prenda
     * la encuentra quien recoge, pero muchas veces el que se da cuenta de que
     * ese paquete sigue ahí es el que empaqueta cuando ya no le dan más. */
    if (accion === 'resolver') {
      const pedido = aTexto(b.pedido).trim();
      if (!pedido) return res.status(400).json({ ok: false, error: 'sin-pedido' });
      const en = aFecha(b.en) || new Date();
      const fila = await s`
        update cola set estado = 'espera', motivo = '', abierto_en = ${en}
         where dia = ${dia} and pedido = ${pedido} and estado in ('parado', 'retirado')
        returning *`;
      if (!fila.length) {
        const [ahora] = await s`select estado from cola where dia = ${dia} and pedido = ${pedido}`;
        return res.status(200).json({ ok: true, dia, resuelto: false,
                                      estado: ahora ? ahora.estado : null });
      }
      /* Ahora sí arranca el reloj del que empaqueta: hasta este momento el
       * paquete no estaba entregado a nadie. */
      await apuntarTiempo(s, { dia, quien: fila[0].quien_abrio || quien, modo: 'recoge',
                               pedido, apodo: fila[0].apodo, prendas: fila[0].prendas, en });
      return res.status(200).json({ ok: true, dia, resuelto: true, numero: fila[0].numero });
    }

    /* ------------------------------------------------------------- COGER
     * "Ese de ahí no lo cierra nadie, lo hago yo."
     *
     * El reparto normal es a ciegas y está bien: nadie elige el fácil. Pero al
     * final del turno pasa lo del 17 ago 2026: cero en espera, el #56 abierto
     * desde hacía media hora en el móvil de alguien que ya se había ido, y la
     * pantalla de los demás diciendo "no hay paquetes esperando". Ese paquete no
     * se cierra solo.
     *
     * Así que se puede coger uno por su número. No se pregunta cuánto lleva
     * abierto: se devuelve quién lo tenía y desde cuándo, y quien lo coge lo
     * comprueba antes de cerrarlo. Al otro se le avisa en su móvil en cuanto
     * mire (`comprobarMio`), no se le quita en silencio. */
    if (accion === 'coger') {
      const pedido = aTexto(b.pedido).trim();
      if (!pedido) return res.status(400).json({ ok: false, error: 'sin-pedido' });
      const [antes] = await s`
        select estado, quien_cierra, tomado_en from cola where dia = ${dia} and pedido = ${pedido}`;
      if (!antes) return res.status(404).json({ ok: false, error: 'no-esta-en-la-cola' });
      if (antes.estado === 'cerrado') {
        return res.status(200).json({ ok: true, dia, cogido: false, estado: 'cerrado',
                                      loTenia: antes.quien_cierra });
      }
      if (antes.estado === 'parado') {
        return res.status(200).json({ ok: true, dia, cogido: false, estado: 'parado' });
      }
      const fila = await s`
        update cola set estado = 'haciendo', quien_cierra = ${quien}, tomado_en = now()
         where dia = ${dia} and pedido = ${pedido} and estado in ('espera', 'haciendo')
        returning *`;
      if (!fila.length) return res.status(200).json({ ok: true, dia, cogido: false, estado: antes.estado });
      const deOtro = antes.estado === 'haciendo' && !igual(antes.quien_cierra, quien);
      return res.status(200).json({
        ok: true, dia, cogido: true, paquete: fila[0],
        rescatado: deOtro,
        loTenia: deOtro ? antes.quien_cierra : null,
        minutos: deOtro && antes.tomado_en
          ? Math.round((Date.now() - new Date(antes.tomado_en)) / 60000) : null
      });
    }

    return res.status(400).json({ ok: false, error: 'accion-desconocida' });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const dia = diaDe((req.query || {}).dia);

    /* Sin la ficha: para ver cómo va la cola no hacen falta los números de
     * cada paquete, y son cuatrocientos. La ficha solo viaja cuando alguien
     * pide un paquete concreto para hacerlo. */
    const filas = await s`
      select pedido, numero, apodo, tanda, prendas, estado, motivo,
             quien_abrio, abierto_en, quien_cierra, tomado_en, cerrado_en
      from cola where dia = ${dia} order by numero`;

    /* Los recuentos por persona, juntando "yasmin" y "Yasmine": se agrupa por
     * el nombre en minúsculas y se enseña como lo escribió la primera vez. */
    const gente = {};
    for (const f of filas) {
      if (f.estado === 'cerrado' && f.quien_cierra) {
        const k = f.quien_cierra.trim().toLowerCase();
        const g = gente[k] = gente[k] || { quien: f.quien_cierra.trim(), cerrados: 0, prendas: 0 };
        g.cerrados++; g.prendas += (f.prendas || 0);
      }
    }

    /* Quién anda por cada tanda. Las que llevan mucho paradas se devuelven
     * marcadas como frías, para que el menú no diga "la hace Luis" de alguien
     * que se fue hace media hora. */
    const tandas = await s`
      select tanda, quien, hechos, total, actualizado,
             (actualizado < now() - interval '20 minutes') as fria
      from tandas_toma where dia = ${dia} order by tanda`;

    /* "Haciendo" y "atascado" no son lo mismo y confundirlos hace que nadie
     * mire: uno es trabajo en marcha y el otro es trabajo parado. */
    const limite = Date.now() - ATASCO_MIN * 60000;
    /* LO QUE QUEDA POR CERRAR, EN UNA SOLA LISTA.
     *
     * Es la pregunta que nadie podía contestar el 17 ago 2026 mirando un móvil:
     * "¿queda algo?". Había cero en espera, uno abierto desde hacía media hora y
     * veintiún paquetes parados por incidencia, y la pantalla decía "no hay
     * paquetes esperando". Ahora sale todo lo que no está cerrado, con su
     * número, en qué estado está y desde cuándo. Retirado incluido: un hueco
     * explicado no es un hueco. */
    const queda = filas
      .filter((f) => f.estado !== 'cerrado')
      .map((f) => ({
        pedido: f.pedido, numero: f.numero, apodo: f.apodo, prendas: f.prendas,
        estado: f.estado, motivo: f.motivo || '',
        quien_abrio: f.quien_abrio, abierto_en: f.abierto_en,
        quien_cierra: f.quien_cierra, tomado_en: f.tomado_en,
        atascado: f.estado === 'haciendo' && !!f.tomado_en &&
                  new Date(f.tomado_en).getTime() < limite
      }));

    return res.status(200).json({
      ok: true, dia, tandas,
      espera:   filas.filter((f) => f.estado === 'espera').length,
      atascados: filas.filter((f) => f.estado === 'haciendo' &&
                   f.tomado_en && new Date(f.tomado_en).getTime() < limite).length,
      haciendo: filas.filter((f) => f.estado === 'haciendo').length,
      cerrado:  filas.filter((f) => f.estado === 'cerrado').length,
      parado:   filas.filter((f) => f.estado === 'parado').length,
      retirado: filas.filter((f) => f.estado === 'retirado').length,
      queda,
      gente: Object.values(gente),
      paquetes: filas
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
