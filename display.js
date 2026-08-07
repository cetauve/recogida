/* Billy's — pantalla del monitor.
 * Lee el estado de chrome.storage.local y decide qué vista mostrar.
 * No habla con TikTok: de eso se encarga content.js.
 */

(() => {
  'use strict';

  // =========================================================== CONFIGURACIÓN
  // Todo lo editable está aquí arriba.

  const CONFIG = {
    // La barra del pie no tiene meta: se llena cada X prendas y vuelve a
    // empezar. Da sensación de avance constante sin prometer un número.
    prendasPorVuelta: 25,

    /* Qué número enseña el pie. Son dos cosas distintas y no coinciden nunca:
     *   'lotes'    -> el número del lote en curso (#318). Va por delante porque
     *                 cuenta también los lotes desiertos y los de pago fallido.
     *                 Es el número que cantáis en directo.
     *   'vendidas' -> "Attributed items sold" de TikTok (311 en ese momento).
     * En el directo del 1 de agosto: 311 vendidas con el lote en el #318. */
    fuenteContador: 'lotes',
    etiquetaContador: 'prendas vendidas',

    // Fondo con fotos de los eventos. Las carpetas van en fotos/<Ciudad>/.
    ciudades: ['Munich', 'Lisboa', 'Amsterdam'],
    fotoMs: 11000,      // cada cuánto cambia la foto
    fotosPorCiudad: 30, // hasta qué número busca 1.jpg, 2.jpg, 3.jpg...

    /* Dónde cae el encuadre. Un monitor 16:9 solo enseña el 37% de la altura
     * de una foto vertical, así que el número importa mucho:
     *   'top' -> ventana del 0% al 37%: casi todo aire sobre la cabeza
     *   '30%' -> ventana del 21% al 58%: de la cabeza a la cadera
     *   '50%' -> ventana del 31% al 69%: torso y piernas, cara fuera
     * En horizontal el recorte es leve y 40% deja el peso algo por encima
     * del centro, que es donde suele estar la gente. */
    encuadreVertical: '30%',
    encuadreHorizontal: '40%',

    // Segundos que se muestra cada vista. "participar" repite a propósito:
    // el 97% de la audiencia ve la pantalla menos de un minuto, así que
    // para casi todos siempre es la primera vez.
    playlist: [
      { id: 'participar',     ms: 8000 },
      { id: 'adjudicaciones', ms: 7000 },
      { id: 'ranking',        ms: 7000 },
      { id: 'participar',     ms: 8000 },
      { id: 'regalos',        ms: 6000 },
      { id: 'niveles',        ms: 6000 }
    ],

    // Cuando quedan estos segundos o menos de puja, la pantalla se aparta
    // y solo muestra el lote. Nada compite con el momento de pujar.
    segundosLote: 12,

    // Cuánto se queda en pantalla el "premio entregado".
    regaloEntregadoMs: 15000,

    ticker: [
      'Subasta activa · <b>puja ahora</b>',
      'Cada prenda es <b>única</b> · si se va, se fue',
      'Tu primera puja: <b>1 €</b>',
      'Solo pagas el <b>primer envío</b>'
    ],
    tickerMs: 5000,

    niveles: [
      { ico: '🌱', nom: 'Curioso' },
      { ico: '✨', nom: 'Nuevo' },
      { ico: '🔥', nom: 'Fan' },
      { ico: '⭐', nom: 'Habitual' },
      { ico: '💎', nom: 'VIP' },
      { ico: '👑', nom: 'Élite' },
      { ico: '⚡', nom: 'Leyenda' },
      { ico: '🏆', nom: "Billy's" }
    ],

    filasLista: 6,
    filasRanking: 5
  };

  // ================================================================= ESTADO

  let live = { items: {}, current: null, metrics: {} };
  let gift = { status: 'idle', tier: null, log: [] };

  const stage = document.getElementById('stage');
  const titulo = document.getElementById('titulo');
  const ticker = document.getElementById('ticker');
  const objetivoTexto = document.getElementById('objetivoTexto');
  const barra = document.querySelector('#barra i');
  const sinDatos = document.getElementById('sinDatos');

  // El lector guarda en dos claves separadas: la lista de prendas cambia una
  // vez por minuto y el estado de la subasta cada segundo. Se recomponen aquí
  // en un solo objeto para que el resto del archivo no se entere del cambio.
  function aplicar(res) {
    if (res.billysItems) live.items = res.billysItems.items || {};
    if (res.billysNow) {
      live.current = res.billysNow.current || null;
      live.metrics = res.billysNow.metrics || {};
      live.updatedAt = res.billysNow.updatedAt;
      live.lectorVersion = res.billysNow.version;
    }
    if (res.gift) gift = res.gift;
  }

  /* DE DÓNDE SALEN LOS DATOS
   *
   * Esta pantalla se puede abrir de TRES maneras y el archivo detecta sola en
   * cuál está. La diferencia importa mucho, así que aquí queda escrita:
   *
   *   A) chrome-extension://…/display.html   — la de siempre, por HDMI.
   *      Lee chrome.storage directamente. NO se puede transmitir a la tele:
   *      Chrome y Edge no ofrecen "Transmitir" en pestañas de extensión, y eso
   *      no tiene arreglo por nuestra parte.
   *
   *   B) https://…github.io/display.html     — subida a GitHub Pages.
   *      Es una página web normal, así que SÍ se puede transmitir la pestaña.
   *      Los datos se los pasa pantalla-web.js por postMessage desde dentro del
   *      navegador: cero servidores, cero instalaciones, cero permisos de
   *      Windows. A cambio solo funciona en el navegador donde está instalada
   *      la extensión, o sea: vale para transmitir, no para teclear la URL en
   *      la tele.
   *
   *   C) http://IP:8080/pantalla             — servidor/servidor.bat.
   *      También es una página normal, y además se puede abrir DIRECTAMENTE
   *      desde la tele, un Fire Stick o un portátil del WiFi, sin transmitir
   *      nada y sin HDMI. Los datos se piden a /estado.json, que es lo que el
   *      service worker le va empujando al servidor.
   *
   * B y C conviven: se escucha el puente y, si en 2 segundos no ha dicho nada,
   * se empieza a preguntar al servidor. Lo que llegue primero, vale. */
  const EN_EXTENSION = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  /* Las fotos de los eventos NUNCA se suben a la web: viven dentro de la
   * extensión. Cuando la pantalla es una página normal, el puente le dice por
   * dónde alcanzarlas. Hasta que no lo diga, no se cargan: si no, se sondearían
   * rutas relativas que en GitHub no existen. */
  let BASE_RECURSOS = null;
  let fotosArrancadas = false;

  if (EN_EXTENSION) {
    chrome.storage.local.get(['billysItems', 'billysNow', 'gift'], aplicar);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const res = {};
      for (const k of ['billysItems', 'billysNow', 'gift']) {
        if (changes[k]) res[k] = changes[k].newValue;
      }
      aplicar(res);
    });
  } else {
    let hayPuente = false;

    // --- B) el puente de la extensión ---------------------------------------
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const m = e.data;
      if (!m || m.fuente !== 'billys-pantalla') return;
      hayPuente = true;
      if (m.recursos && !BASE_RECURSOS) BASE_RECURSOS = m.recursos;
      aplicar(m.datos || {});
      arrancarFotos();
    });
    // Por si el puente ya había mandado el estado antes de que cargara esto.
    const DESTINO = (location.origin && location.origin !== 'null') ? location.origin : '*';
    window.postMessage({ fuente: 'billys-pantalla-pide' }, DESTINO);

    // --- C) el servidor local, solo si no hay puente -------------------------
    setTimeout(() => {
      if (hayPuente) return;   // en GitHub no hay servidor: no se insiste
      let fallos = 0;
      const preguntar = async () => {
        if (hayPuente) return;
        try {
          const r = await fetch('estado.json', { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          aplicar(await r.json());
          arrancarFotos();
          if (fallos >= 5) console.info("[Billy's] estado recuperado.");
          fallos = 0;
        } catch (err) {
          /* Si el PC deja de emitir no hay que hacer nada especial:
           * live.updatedAt se queda viejo y el testigo rojo de "sin datos" se
           * enciende solo. */
          if (++fallos === 5) console.warn("[Billy's] no llega el estado:", err.message);
        }
      };
      preguntar();
      setInterval(preguntar, 1000);
    }, 2000);
  }

  // =============================================================== DERIVADOS

  function itemsOrdenados() {
    return Object.values(live.items || {})
      .filter((it) => Number.isFinite(it.num))
      .sort((a, b) => b.num - a.num);
  }

  function nombre(it) {
    return it.display || it.username || '—';
  }

  // Ranking del directo actual: por prendas ganadas, desempate por euros.
  function ranking() {
    const porPersona = new Map();
    for (const it of itemsOrdenados()) {
      if (it.paid === false) continue; // no premiamos lo que no se ha pagado
      const clave = (it.username || it.display || '').toLowerCase();
      if (!clave) continue;
      const prev = porPersona.get(clave) || { nombre: nombre(it), prendas: 0, euros: 0 };
      prev.prendas += 1;
      prev.euros += Number(it.price) || 0;
      if (it.display) prev.nombre = it.display;
      porPersona.set(clave, prev);
    }
    return [...porPersona.values()].sort(
      (a, b) => b.prendas - a.prendas || b.euros - a.euros
    );
  }

  function hora(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function eur(n) {
    if (n == null) return '';
    return (Number.isInteger(n) ? n : n.toFixed(2).replace('.', ',')) + ' €';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ================================================================= VISTAS

  const VISTAS = {

    participar: () => ({
      titulo: 'Cómo <ac>participar</ac>',
      html: `
        <div class="vista">
          <div class="pasos">
            <div class="paso">
              <div class="n">1</div>
              <div class="qué">Pulsa pujar</div>
              <div class="detalle">Desde 1 €</div>
            </div>
            <div class="paso">
              <div class="n">2</div>
              <div class="qué">Añade tu tarjeta</div>
              <div class="detalle">Una sola vez, se guarda</div>
            </div>
            <div class="paso">
              <div class="n">3</div>
              <div class="qué">Ya estás listo</div>
              <div class="detalle">Pujas con un toque</div>
            </div>
          </div>
          <div class="remate">
            Solo pagas el primer envío
            <small>Las siguientes prendas de hoy viajan en el mismo paquete</small>
          </div>
        </div>`
    }),

    adjudicaciones: () => {
      const filas = itemsOrdenados().slice(0, CONFIG.filasLista);
      if (!filas.length) {
        return {
          titulo: 'Últimas <ac>adjudicaciones</ac>',
          html: '<div class="vista"><div class="vacio">Esperando la primera prenda del directo…</div></div>'
        };
      }
      return {
        titulo: 'Últimas <ac>adjudicaciones</ac>',
        html: `<div class="vista"><div class="filas">${filas.map((it, i) => `
          <div class="fila ${i === 0 ? 'destacada' : ''}">
            <div class="pos">#${it.num}</div>
            <div class="quien">${esc(nombre(it))}</div>
            <div class="dato">${esc(eur(it.price))}</div>
            <div class="hora">${hora(it.at)}</div>
          </div>`).join('')}</div></div>`
      };
    },

    ranking: () => {
      const top = ranking().slice(0, CONFIG.filasRanking);
      if (!top.length) {
        return {
          titulo: 'Ranking del <ac>directo</ac>',
          html: '<div class="vista"><div class="vacio">El ranking se abre con la primera prenda.</div></div>'
        };
      }
      // La frontera es lo accionable: sin esto el ranking solo habla a cinco personas.
      const corte = top.length < CONFIG.filasRanking ? 1 : top[top.length - 1].prendas;
      const frontera = corte === 1
        ? 'Con <b>1 prenda</b> ya entras en el top 5'
        : `Con <b>${corte} prendas</b> entras en el top 5`;
      return {
        titulo: 'Ranking del <ac>directo</ac>',
        html: `<div class="vista">
          <div class="filas">${top.map((p, i) => `
            <div class="fila ${i === 0 ? 'destacada' : ''}">
              <div class="pos">${i + 1}</div>
              <div class="quien">${esc(p.nombre)}</div>
              <div class="dato">${p.prendas} ${p.prendas === 1 ? 'prenda' : 'prendas'}</div>
              <div class="hora"></div>
            </div>`).join('')}</div>
          <div class="remate">${frontera}</div>
        </div>`
      };
    },

    regalos: () => {
      const log = (gift.log || []).slice(0, CONFIG.filasLista);
      if (!log.length) {
        return {
          titulo: 'Regalos <ac>de hoy</ac>',
          html: '<div class="vista"><div class="vacio">Hoy caen regalos sorpresa. Quédate.</div></div>'
        };
      }
      return {
        titulo: 'Regalos <ac>de hoy</ac>',
        html: `<div class="vista"><div class="filas">${log.map((g) => `
          <div class="fila">
            <div class="pos">${g.num ? '#' + g.num : '🎁'}</div>
            <div class="quien">${esc(g.display || '—')}</div>
            <div class="dato tier-${(g.tier || '').toLowerCase()}">${esc(g.tier || '')}</div>
            <div class="hora">${hora(g.at)}</div>
          </div>`).join('')}</div></div>`
      };
    },

    niveles: () => ({
      titulo: 'Niveles <ac>Billy\'s</ac>',
      html: `<div class="vista">
        <div class="niveles">${CONFIG.niveles.map((n, i) => `
          <div class="nivel ${i >= 4 ? 'alto' : ''}">
            <div class="ico">${n.ico}</div>
            <div class="nom">${esc(n.nom)}</div>
          </div>`).join('')}</div>
        <div class="remate">Cuanto más participas en el directo, más subes</div>
      </div>`
    }),

    lote: () => {
      const c = live.current || {};
      return {
        titulo: 'Pujando <ac>ahora</ac>',
        html: `<div class="vista"><div class="lote">
          <div class="num">#${c.num != null ? c.num : '—'}</div>
          <div class="precio">${esc(eur(c.price))}</div>
          <div class="lider">${c.leader ? esc(c.leader) + ' va ganando' : ''}</div>
        </div></div>`
      };
    },

    regaloTakeover: () => {
      const t = (gift.tier || '').toLowerCase();
      if (gift.status === 'armed') {
        return {
          titulo: '<ac>Atención</ac>',
          html: `<div class="vista"><div class="regalo-grande">
            <div class="cartel">El siguiente lote<br>lleva regalo</div>
            <div class="sub">Quien se lo lleve, se lo lleva con premio</div>
          </div></div>`
        };
      }
      if (gift.status === 'spinning') {
        return {
          titulo: '<ac>Girando</ac>',
          html: `<div class="vista"><div class="regalo-grande">
            <div class="cartel">¿Qué premio cae?</div>
            <div class="tier girando" id="ruleta">···</div>
          </div></div>`
        };
      }
      if (gift.status === 'revealed') {
        return {
          titulo: 'Premio <ac>en juego</ac>',
          html: `<div class="vista"><div class="regalo-grande">
            <div class="cartel">El siguiente lote lleva</div>
            <div class="tier tier-${t}">${esc(gift.tier || '')}</div>
            <div class="sub">Puja: si ganas la prenda, ganas el premio</div>
          </div></div>`
        };
      }
      // assigned
      const a = gift.assigned || {};
      return {
        titulo: '<ac>Premio entregado</ac>',
        html: `<div class="vista"><div class="regalo-grande">
          <div class="tier tier-${t}">${esc(gift.tier || '')}</div>
          <div class="cartel">${esc(a.display || '—')}</div>
          <div class="sub">Prenda #${a.num != null ? a.num : '—'}</div>
        </div></div>`
      };
    }
  };

  // =============================================================== ROTACIÓN

  let idx = 0;
  let desde = Date.now();
  let vistaActual = null;
  let firma = '';

  // ¿El regalo sigue reclamando la pantalla?
  // "assigned" caduca solo, así el service worker no necesita temporizadores
  // (las alarmas de MV3 no bajan de 30 s y aquí hablamos de 15).
  function regaloActivo() {
    if (!gift || !gift.status || gift.status === 'idle') return false;
    if (gift.status !== 'assigned') return true;
    return (Date.now() - (gift.assignedAt || 0)) < CONFIG.regaloEntregadoMs;
  }

  // Para diseñar sin directo: display.html?vista=ranking congela una vista.
  const VISTA_FORZADA = new URLSearchParams(location.search).get('vista');

  function decidirVista() {
    if (VISTA_FORZADA && VISTAS[VISTA_FORZADA]) return VISTA_FORZADA;
    if (regaloActivo()) return 'regaloTakeover';

    const c = live.current;
    if (c && c.seconds != null && c.seconds > 0 && c.seconds <= CONFIG.segundosLote) {
      return 'lote';
    }

    const paso = CONFIG.playlist[idx % CONFIG.playlist.length];
    if (Date.now() - desde >= paso.ms) {
      idx = (idx + 1) % CONFIG.playlist.length;
      desde = Date.now();
    }
    return CONFIG.playlist[idx % CONFIG.playlist.length].id;
  }

  function pintar() {
    const id = decidirVista();
    const render = VISTAS[id] || VISTAS.participar;
    const salida = render();
    const nuevaFirma = id + '|' + salida.html;

    if (nuevaFirma !== firma) {
      // Si solo cambia el contenido dentro de la misma vista, no reanimamos.
      const mismaVista = id === vistaActual;
      titulo.innerHTML = salida.titulo.replace(/<ac>/g, '<span class="ac">').replace(/<\/ac>/g, '</span>');
      stage.innerHTML = salida.html;
      if (mismaVista) {
        const v = stage.querySelector('.vista');
        if (v) v.style.animation = 'none';
      }
      vistaActual = id;
      firma = nuevaFirma;
    }

    if (id === 'regaloTakeover' || id === 'lote') desde = Date.now();
  }

  // ================================================================== FOTOS
  /* Fondo con fotos de los eventos. Cierra el círculo entre quien está pujando
   * ahora y quien ya lleva la ropa puesta por la calle.
   *
   * Una extensión no puede listar el contenido de una carpeta: no existe esa
   * API. Así que hay dos formas de encontrar los archivos y se prueban las dos:
   *   1. fotos/fotos.json, si tiene nombres apuntados.
   *   2. sondeo de 1.jpg, 2.jpg, 3.jpg... hasta que fallan tres seguidas.
   * Con la segunda basta numerar los archivos y no hay que tocar nada más. */

  const urlDe = (ruta) => {
    // Si el puente nos ha dicho dónde está la extensión, de ahí salen las fotos
    // aunque la pantalla se esté viendo desde una URL de GitHub.
    if (BASE_RECURSOS) return BASE_RECURSOS + ruta;
    return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL(ruta)
      : ruta;
  };

  const foto = document.getElementById('foto');
  const credito = document.getElementById('credito');
  let catalogo = [];   // [{src, ciudad, y}]
  let ultimaFoto = -1;

  function existe(src) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => res(true);
      im.onerror = () => res(false);
      im.src = src;
    });
  }

  async function sondearCiudad(ciudad) {
    const encontradas = [];
    let fallosSeguidos = 0;
    for (let i = 1; i <= CONFIG.fotosPorCiudad; i++) {
      let acierto = null;
      for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
        const src = urlDe(`fotos/${ciudad}/${i}.${ext}`);
        if (await existe(src)) { acierto = src; break; }
      }
      if (acierto) { encontradas.push(acierto); fallosSeguidos = 0; }
      else if (++fallosSeguidos >= 3) break; // un hueco se perdona, tres no
    }
    return encontradas;
  }

  async function cargarFotos() {
    let declaradas = {};
    try {
      const r = await fetch(urlDe('fotos/fotos.json'));
      if (r.ok) declaradas = await r.json();
    } catch (_) { /* no hay json o está mal escrito: seguimos con el sondeo */ }

    for (const ciudad of CONFIG.ciudades) {
      const lista = Array.isArray(declaradas[ciudad]) ? declaradas[ciudad] : [];
      if (lista.length) {
        for (const entrada of lista) {
          // Vale la cadena suelta "foto.jpg" y también {"f":"foto.jpg","y":"15%"}
          // para las fotos concretas que pidan otro encuadre.
          const f = typeof entrada === 'string' ? entrada : entrada.f;
          const y = typeof entrada === 'string' ? null : (entrada.y || null);
          if (f) catalogo.push({ src: urlDe(`fotos/${ciudad}/${f}`), ciudad, y });
        }
      } else {
        for (const src of await sondearCiudad(ciudad)) {
          catalogo.push({ src, ciudad, y: null });
        }
      }
    }

    if (!catalogo.length) {
      console.info("[Billy's] sin fotos en fotos/: se usa el fondo liso.");
      return;
    }
    document.body.classList.add('con-foto');
    console.info(`[Billy's] ${catalogo.length} fotos cargadas.`);
    cambiarFoto();
    setInterval(cambiarFoto, CONFIG.fotoMs);
  }

  function cambiarFoto() {
    if (catalogo.length < 1) return;

    // Al azar, pero nunca la misma dos veces seguidas.
    let i = Math.floor(Math.random() * catalogo.length);
    if (catalogo.length > 1 && i === ultimaFoto) i = (i + 1) % catalogo.length;
    ultimaFoto = i;

    const elegida = catalogo[i];
    // Se precarga antes de mostrarla: si no, se ve el salto a mitad de carga.
    const im = new Image();
    im.onload = () => {
      // El encuadre depende de la orientación, y una foto concreta puede
      // pedir el suyo propio desde fotos.json.
      const vertical = im.naturalHeight > im.naturalWidth;
      const y = elegida.y ||
        (vertical ? CONFIG.encuadreVertical : CONFIG.encuadreHorizontal);
      foto.classList.remove('puesta');
      setTimeout(() => {
        foto.style.backgroundImage = `url("${elegida.src}")`;
        foto.style.backgroundPosition = `center ${y}`;
        foto.classList.add('puesta');
        credito.innerHTML =
          `Billy's Tour <span class="punto">·</span> ${esc(elegida.ciudad)}`;
        credito.hidden = false;
      }, 300);
    };
    im.src = elegida.src;
  }

  // ==================================================================== PIE

  /* El contador del pie no puede bajar nunca ni quedarse atrás: es el número
   * que se canta en directo y lo está viendo la audiencia.
   *
   * Se blinda aquí ADEMÁS de en content.js a propósito. Si un día la pestaña
   * del lector se queda con una versión vieja, la pantalla sigue enseñando el
   * número bueno igual, porque lo saca también de las prendas que ya tiene. */
  let piePico = 0;

  function loteMasAlto() {
    let max = 0;
    for (const it of Object.values(live.items || {})) {
      if (Number.isFinite(it.num) && it.num > max) max = it.num;
    }
    if (live.current && Number.isFinite(live.current.num) && live.current.num > max) {
      max = live.current.num;
    }
    return max;
  }

  function pintarPie() {
    const m = live.metrics || {};
    let vendidas;
    if (CONFIG.fuenteContador === 'lotes') {
      /* Nunca se cae a "Attributed items sold" de TikTok: esa métrica va por
       * detrás (con el lote en el 40 marcaba 37) y mezclarla hace que el
       * número salte hacia atrás en cámara. */
      const n = Math.max(Number(m.loteActual) || 0, loteMasAlto());
      if (n > piePico) piePico = n;
      vendidas = piePico;
    } else {
      // La métrica de TikTok manda; el recuento propio solo es red de
      // seguridad para los primeros segundos, antes de que se haya leído.
      vendidas = m.itemsSold != null ? m.itemsSold : itemsOrdenados().length;
    }

    objetivoTexto.textContent = `${vendidas} ${CONFIG.etiquetaContador}`;

    // Barra sin meta: se llena y vuelve a empezar.
    const ciclo = CONFIG.prendasPorVuelta;
    const dentro = ((vendidas % ciclo) + ciclo) % ciclo;
    barra.style.width = Math.round((dentro / ciclo) * 100) + '%';

    // Testigo de que el lector sigue vivo.
    const viejo = !live.updatedAt || (Date.now() - live.updatedAt) > 20000;
    sinDatos.classList.toggle('on', viejo);
  }

  let tIdx = 0;
  function rotarTicker() {
    ticker.innerHTML = CONFIG.ticker[tIdx % CONFIG.ticker.length];
    tIdx++;
  }

  // Animación de la ruleta mientras gira.
  const CARAS = ['PLATA', 'ORO', 'DIAMANTE'];
  setInterval(() => {
    const el = document.getElementById('ruleta');
    if (el) el.textContent = CARAS[Math.floor(Math.random() * CARAS.length)];
  }, 110);

  setInterval(pintar, 250);
  setInterval(pintarPie, 1000);
  setInterval(rotarTicker, CONFIG.tickerMs);

  /* Las fotos solo arrancan una vez, y en la web solo cuando ya se sabe de
   * dónde sacarlas. Si a los 3 segundos no ha hablado nadie, se tira con rutas
   * relativas: es lo que sirve el servidor local. */
  function arrancarFotos() {
    if (fotosArrancadas) return;
    fotosArrancadas = true;
    cargarFotos();
  }

  pintar();
  pintarPie();
  rotarTicker();
  if (EN_EXTENSION) arrancarFotos();
  else setTimeout(arrancarFotos, 3000);
})();
