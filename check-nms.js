// Importamos el módulo fs de Node.js.
// Sirve para leer y escribir archivos, en nuestro caso state.json.
const fs = require("node:fs");

// URL de la API de WordPress de la web oficial de No Man's Sky.
// Esta será la fuente principal para leer noticias/posts.
const WP_API_URL =
  "https://www.nomanssky.com/wp-json/wp/v2/posts?per_page=6&_embed=1";

// URL del feed RSS de No Man's Sky.
// Lo usamos como respaldo si la API de WordPress falla.
const RSS_URL = "https://www.nomanssky.com/feed/";

// Archivo donde guardaremos qué posts ya hemos visto.
// Esto evita publicar la misma noticia varias veces en Discord.
const STATE_FILE = "state.json";

// El webhook de Discord NO se escribe en el código.
// GitHub Actions lo leerá desde un Secret llamado DISCORD_WEBHOOK_URL.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Si esto está en "true", el bot publicará incluso en la primera ejecución.
// Lo normal es dejarlo en "false" para evitar spam de noticias antiguas.
const POST_ON_FIRST_RUN = process.env.POST_ON_FIRST_RUN === "true";

// Si no existe el webhook, paramos el script.
// Esto evita que el script siga funcionando sin poder publicar nada.
if (!DISCORD_WEBHOOK_URL) {
  console.error(
    "Falta DISCORD_WEBHOOK_URL. Debe estar configurado como Secret en GitHub."
  );
  process.exit(1);
}

// Pequeña función para esperar X milisegundos.
// La usamos entre mensajes para no bombardear Discord.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convierte entidades HTML en texto normal.
// Por ejemplo:
// &amp;  -> &
// &#8217; -> ’
// Esto hace que los títulos y descripciones salgan más limpios.
function decodeHtmlEntities(text = "") {
  return String(text)
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    )
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Elimina etiquetas HTML y deja solo texto limpio.
// Por ejemplo:
// "<p>Hola <strong>mundo</strong></p>" -> "Hola mundo"
function stripHtml(html = "") {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Limita un texto a una longitud máxima.
// Discord tiene límites en los embeds, así que no conviene mandar textos enormes.
function limitText(text = "", maxLength = 400) {
  const clean = String(text).replace(/\s+/g, " ").trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

// Intenta encontrar la primera imagen dentro del HTML de un post.
// Esto sirve para poner una imagen bonita en el embed de Discord.
function extractFirstImage(html = "") {
  const decoded = decodeHtmlEntities(html);

  // Busca una imagen normal:
  // <img src="https://...">
  const imgMatch = decoded.match(/<img[^>]+src=["']([^"']+)["']/i);

  if (imgMatch?.[1]) {
    return imgMatch[1];
  }

  // Busca una imagen tipo Open Graph:
  // <meta property="og:image" content="https://...">
  const ogMatch = decoded.match(
    /property=["']og:image["'][^>]+content=["']([^"']+)["']/i
  );

  if (ogMatch?.[1]) {
    return ogMatch[1];
  }

  return null;
}

// Intenta detectar enlaces de YouTube dentro del post.
// Si encuentra uno, lo pondremos como texto normal en Discord,
// para que Discord pueda generar su vista previa del vídeo.
function extractYoutubeUrl(htmlOrText = "") {
  const decoded = decodeHtmlEntities(htmlOrText);

  // Formato típico:
  // https://www.youtube.com/watch?v=XXXXXXXX
  const watchMatch = decoded.match(
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[A-Za-z0-9_-]+[^\s"'<>]*/i
  );

  if (watchMatch?.[0]) {
    return watchMatch[0].replace(/&amp;/g, "&");
  }

  // Formato corto:
  // https://youtu.be/XXXXXXXX
  const shortMatch = decoded.match(
    /https?:\/\/youtu\.be\/[A-Za-z0-9_-]+[^\s"'<>]*/i
  );

  if (shortMatch?.[0]) {
    return shortMatch[0].replace(/&amp;/g, "&");
  }

  // Formato iframe/embed:
  // https://www.youtube.com/embed/XXXXXXXX
  // Lo convertimos al formato normal de YouTube.
  const embedMatch = decoded.match(
    /https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]+)/i
  );

  if (embedMatch?.[1]) {
    return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
  }

  return null;
}

// Hace una petición HTTP esperando recibir JSON.
// Se usa para leer la API de WordPress.
async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "NMS Discord Alerts",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al leer ${url}`);
  }

  return response.json();
}

// Hace una petición HTTP esperando recibir texto.
// Se usa para leer el RSS si falla la API principal.
async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "NMS Discord Alerts",
      Accept: "application/rss+xml,text/xml,text/html,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al leer ${url}`);
  }

  return response.text();
}

// Convierte un post de WordPress en un objeto más simple.
// Así todo el resto del script trabaja con el mismo formato.
function normalizeWpPost(post) {
  const title = stripHtml(post.title?.rendered || "Nuevo post de No Man's Sky");

  const contentHtml = post.content?.rendered || "";
  const excerptHtml = post.excerpt?.rendered || "";
  const fullText = stripHtml(contentHtml || excerptHtml);

  // Intentamos obtener la imagen destacada.
  // Primero desde _embedded, luego desde el contenido HTML.
  const featuredImage =
    post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ||
    extractFirstImage(contentHtml) ||
    null;

  return {
    // ID único del post.
    // Lo guardaremos en state.json para no repetir publicaciones.
    id: String(post.id || post.link),

    // Título limpio del post.
    title,

    // Enlace a la noticia oficial.
    url: post.link,

    // Fecha del post.
    date: post.date,

    // Resumen corto para el embed de Discord.
    description: limitText(
      stripHtml(excerptHtml) ||
        fullText ||
        "Nuevo contenido publicado en la web oficial.",
      400
    ),

    // Imagen que saldrá en el embed, si existe.
    imageUrl: featuredImage,

    // Enlace de YouTube, si el post incluye uno.
    youtubeUrl: extractYoutubeUrl(contentHtml) || extractYoutubeUrl(excerptHtml),
  };
}

// Lee los últimos posts desde la API de WordPress.
async function getPostsFromWordPressApi() {
  const posts = await fetchJson(WP_API_URL);

  if (!Array.isArray(posts)) {
    throw new Error("La API de WordPress no devolvió una lista de posts.");
  }

  return posts
    .map(normalizeWpPost)
    .filter((post) => post.id && post.title && post.url);
}

// Obtiene el contenido de una etiqueta XML.
// Por ejemplo:
// getTagValue(item, "title") busca <title>...</title>
function getTagValue(xml, tagName) {
  const regex = new RegExp(
    `<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );

  return xml.match(regex)?.[1] || "";
}

// Lee el RSS y lo convierte en posts simples.
// Esto es el plan B si WordPress API falla.
function parseRssFeed(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  return items
    .map((match) => {
      const item = match[1];

      const title = decodeHtmlEntities(getTagValue(item, "title"));
      const link = decodeHtmlEntities(getTagValue(item, "link"));
      const pubDate = decodeHtmlEntities(getTagValue(item, "pubDate"));
      const description = getTagValue(item, "description");
      const contentEncoded = getTagValue(item, "content:encoded");

      const html = contentEncoded || description;

      return {
        id: link,
        title: stripHtml(title),
        url: link,
        date: pubDate,
        description: limitText(
          stripHtml(description || html) ||
            "Nuevo contenido publicado en la web oficial.",
          400
        ),
        imageUrl: extractFirstImage(html),
        youtubeUrl: extractYoutubeUrl(html),
      };
    })
    .filter((post) => post.id && post.title && post.url);
}

// Obtiene los últimos posts.
// Primero prueba la API de WordPress.
// Si falla, usa el RSS como respaldo.
async function getLatestPosts() {
  try {
    const posts = await getPostsFromWordPressApi();

    if (posts.length > 0) {
      console.log("Posts obtenidos desde WordPress API.");
      return posts;
    }
  } catch (error) {
    console.warn(
      "No se pudo leer la API de WordPress. Probando RSS:",
      error.message
    );
  }

  const xml = await fetchText(RSS_URL);
  const posts = parseRssFeed(xml);

  if (posts.length > 0) {
    console.log("Posts obtenidos desde RSS.");
  }

  return posts;
}

// Carga el archivo state.json.
// Si no existe, significa que es la primera ejecución.
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      seen: [],
    };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      seen: [],
    };
  }
}

// Guarda el estado en state.json.
// Solo guardamos los últimos 200 IDs para que el archivo no crezca infinito.
function saveState(state) {
  const uniqueSeen = [...new Set(state.seen || [])];

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        seen: uniqueSeen.slice(-200),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

// Envía un post a Discord usando el webhook.
async function sendToDiscord(post) {
  // Texto normal del mensaje.
  // Si hay YouTube, lo ponemos aquí para que Discord intente generar preview.
  const contentLines = ["🚀 **Nuevo anuncio / parche de No Man’s Sky**"];

  if (post.youtubeUrl) {
    contentLines.push(`▶️ ${post.youtubeUrl}`);
  }

  // Embed bonito de Discord.
  // Es la tarjeta con título, descripción, imagen y enlace.
  const embed = {
    title: limitText(post.title, 250),
    url: post.url,
    description:
      post.description ||
      "Nuevo contenido publicado en la web oficial de No Man’s Sky.",
    fields: [
      {
        name: "Noticia oficial",
        value: `[Leer en nomanssky.com](${post.url})`,
      },
    ],
    footer: {
      text: "No Man's Sky / Hello Games",
    },
    timestamp:
      post.date && !Number.isNaN(Date.parse(post.date))
        ? new Date(post.date).toISOString()
        : new Date().toISOString(),
  };

  // Si hay imagen, la añadimos al embed.
  if (post.imageUrl) {
    embed.image = {
      url: post.imageUrl,
    };
  }

  // Payload final que recibirá Discord.
  const payload = {
    username: "No Man's Sky Updates",
    content: contentLines.join("\n"),
    embeds: [embed],
  };

  // Intentamos enviar el mensaje.
  // Si Discord responde con rate limit 429, esperamos y reintentamos una vez.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return;
    }

    const text = await response.text().catch(() => "");

    if (response.status === 429 && attempt === 1) {
      let retryAfterMs = 3000;

      try {
        const data = JSON.parse(text);
        retryAfterMs = Math.ceil(Number(data.retry_after || 3) * 1000);
      } catch {
        // Si no podemos leer retry_after, esperamos 3 segundos por defecto.
      }

      console.warn(
        `Rate limit de Discord. Reintentando en ${retryAfterMs}ms...`
      );

      await sleep(retryAfterMs);
      continue;
    }

    throw new Error(`Discord respondió HTTP ${response.status}: ${text}`);
  }
}

// Función principal del script.
async function main() {
  // Leemos los últimos posts disponibles.
  const posts = await getLatestPosts();

  if (posts.length === 0) {
    console.log("No se encontraron posts.");
    return;
  }

  console.log("Último post detectado:", posts[0].title);

  // Cargamos el estado anterior.
  const state = loadState();
  const seen = new Set(state.seen || []);

  // Primera ejecución:
  // guardamos los posts actuales como "ya vistos",
  // pero NO los publicamos para evitar spam de noticias antiguas.
  if (seen.size === 0 && !POST_ON_FIRST_RUN) {
    for (const post of posts) {
      seen.add(post.id);
    }

    saveState({
      seen: [...seen],
    });

    console.log(
      "Primera ejecución: estado inicial guardado sin publicar posts antiguos."
    );

    return;
  }

  // Detectamos qué posts son nuevos.
  const newPosts = posts.filter((post) => !seen.has(post.id));

  // Si no hay posts nuevos, guardamos estado y terminamos.
  if (newPosts.length === 0) {
    console.log("Sin novedades.");

    saveState({
      seen: [...seen],
    });

    return;
  }

  // Publicamos los nuevos en orden antiguo -> nuevo.
  // Esto evita que si aparecen varios a la vez salgan al revés.
  for (const post of newPosts.reverse()) {
    console.log("Publicando:", post.title);
    await sendToDiscord(post);
    seen.add(post.id);
    await sleep(1000);
  }

  // Guardamos el estado actualizado.
  saveState({
    seen: [...seen],
  });

  console.log("Hecho.");
}

// Ejecutamos main().
// Si algo falla, mostramos el error y devolvemos código 1 para que GitHub Actions marque fallo.
main().catch((error) => {
  console.error(error);
  process.exit(1);
});