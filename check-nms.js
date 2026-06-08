const fs = require("node:fs");

const WP_API_URL =
  "https://www.nomanssky.com/wp-json/wp/v2/posts?per_page=1&_embed=1";

const STATE_FILE = "state.json";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const MIN_CHECK_INTERVAL_MINUTES = Number(
  process.env.MIN_CHECK_INTERVAL_MINUTES || 14
);

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

function htmlToCleanText(html = "") {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function limitText(text = "", maxLength = 3800) {
  const clean = String(text).trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

function extractYoutubeUrl(htmlOrText = "") {
  const decoded = decodeHtmlEntities(htmlOrText);

  const watchMatch = decoded.match(
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[A-Za-z0-9_-]+[^\s"'<>]*/i
  );

  if (watchMatch?.[0]) {
    return watchMatch[0].replace(/&amp;/g, "&");
  }

  const shortMatch = decoded.match(
    /https?:\/\/youtu\.be\/[A-Za-z0-9_-]+[^\s"'<>]*/i
  );

  if (shortMatch?.[0]) {
    return shortMatch[0].replace(/&amp;/g, "&");
  }

  const embedMatch = decoded.match(
    /https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]+)/i
  );

  if (embedMatch?.[1]) {
    return `https://www.youtube.com/watch?v=${embedMatch[1]}`;
  }

  return null;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        lastSeenUrl: state.lastSeenUrl || null,
        lastSeenTitle: state.lastSeenTitle || null,
        lastSeenDate: state.lastSeenDate || null,
        lastCheckedAt: state.lastCheckedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

function shouldSkipBecauseTooSoon(state) {
  if (!state.lastCheckedAt) {
    return false;
  }

  const lastChecked = new Date(state.lastCheckedAt).getTime();

  if (Number.isNaN(lastChecked)) {
    return false;
  }

  const now = Date.now();
  const elapsedMinutes = (now - lastChecked) / 1000 / 60;

  return elapsedMinutes < MIN_CHECK_INTERVAL_MINUTES;
}

async function fetchLatestPost() {
  const response = await fetch(WP_API_URL, {
    headers: {
      "User-Agent": "NMS Discord Alerts",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al leer la API de No Man's Sky`);
  }

  const posts = await response.json();

  if (!Array.isArray(posts) || posts.length === 0) {
    throw new Error("No se encontró ningún post en la API de No Man's Sky.");
  }

  const post = posts[0];

  const title = htmlToCleanText(post.title?.rendered || "Nuevo post de No Man's Sky");
  const contentHtml = post.content?.rendered || "";
  const excerptHtml = post.excerpt?.rendered || "";
  const bodyText =
    htmlToCleanText(contentHtml) ||
    htmlToCleanText(excerptHtml) ||
    "Nuevo contenido publicado en la web oficial de No Man's Sky.";

  const imageUrl =
    post._embedded?.["wp:featuredmedia"]?.[0]?.source_url || null;

  const youtubeUrl =
    extractYoutubeUrl(contentHtml) || extractYoutubeUrl(excerptHtml);

  return {
    id: String(post.id || post.link),
    title,
    url: post.link,
    date: post.date,
    bodyText,
    imageUrl,
    youtubeUrl,
  };
}

async function sendToDiscord(post) {
  if (!DISCORD_WEBHOOK_URL) {
    throw new Error("No existe DISCORD_WEBHOOK_URL. No se puede publicar.");
  }

  const contentLines = [
    "?? **Nuevo post de No Man’s Sky**",
  ];

  if (post.youtubeUrl) {
    contentLines.push(`?? ${post.youtubeUrl}`);
  }

  const embed = {
    title: limitText(post.title, 250),
    url: post.url,
    description: limitText(post.bodyText, 3800),
    fields: [
      {
        name: "Post oficial",
        value: `[Leer completo en nomanssky.com](${post.url})`,
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

  if (post.imageUrl) {
    embed.image = {
      url: post.imageUrl,
    };
  }

  const payload = {
    username: "No Man's Sky Updates",
    content: contentLines.join("\n"),
    embeds: [embed],
  };

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Discord respondió HTTP ${response.status}: ${text}`);
  }
}

async function main() {
  const state = loadState();

  if (shouldSkipBecauseTooSoon(state)) {
    console.log(
      `Saltado: todavía no han pasado ${MIN_CHECK_INTERVAL_MINUTES} minutos desde la última comprobación real.`
    );
    return;
  }

  const latestPost = await fetchLatestPost();

  console.log("Último post detectado:", latestPost.title);
  console.log("URL:", latestPost.url);

  if (!state.lastSeenUrl) {
    saveState({
      lastSeenUrl: latestPost.url,
      lastSeenTitle: latestPost.title,
      lastSeenDate: latestPost.date,
      lastCheckedAt: new Date().toISOString(),
    });

    console.log("Primera ejecución segura: guardado el último post sin publicar.");
    return;
  }

  if (state.lastSeenUrl === latestPost.url) {
    saveState({
      lastSeenUrl: state.lastSeenUrl,
      lastSeenTitle: state.lastSeenTitle,
      lastSeenDate: state.lastSeenDate,
      lastCheckedAt: new Date().toISOString(),
    });

    console.log("Sin novedades. No se publica nada.");
    return;
  }

  await sendToDiscord(latestPost);

  saveState({
    lastSeenUrl: latestPost.url,
    lastSeenTitle: latestPost.title,
    lastSeenDate: latestPost.date,
    lastCheckedAt: new Date().toISOString(),
  });

  console.log("Publicado 1 único post nuevo en Discord.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
