const fs = require("node:fs");

const NEWS_URL = "https://www.nomanssky.com/news/";
const STATE_FILE = "state.json";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const MIN_CHECK_INTERVAL_MINUTES = Number(
  process.env.MIN_CHECK_INTERVAL_MINUTES || 15
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

function limitText(text = "", maxLength = 900) {
  const clean = String(text).trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  return `${clean.slice(0, maxLength - 1).trim()}…`;
}

function absolutizeUrl(url) {
  return new URL(url, NEWS_URL).href;
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

function extractFirstImage(html = "") {
  const decoded = decodeHtmlEntities(html);

  const ogImage = decoded.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
  );

  if (ogImage?.[1]) {
    return absolutizeUrl(ogImage[1]);
  }

  const img = decoded.match(/<img[^>]+src=["']([^"']+)["']/i);

  if (img?.[1]) {
    return absolutizeUrl(img[1]);
  }

  return null;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "NMS Discord Alerts",
      Accept: "text/html,application/xhtml+xml,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al leer ${url}`);
  }

  return response.text();
}

function getLatestArticleUrlFromNewsPage(html) {
  const decoded = decodeHtmlEntities(html);

  const matches = [
    ...decoded.matchAll(
      /href=["']([^"']*\/20\d{2}\/\d{2}\/[^"']+\/?)["']/gi
    ),
  ];

  const urls = matches
    .map((match) => absolutizeUrl(match[1]))
    .filter((url) => url.startsWith("https://www.nomanssky.com/"));

  const uniqueUrls = [...new Set(urls)];

  if (uniqueUrls.length === 0) {
    throw new Error("No se pudo encontrar ningún artículo en la página de noticias.");
  }

  return uniqueUrls[0];
}

function extractTitleFromArticle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  if (h1?.[1]) {
    return htmlToCleanText(h1[1]);
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (title?.[1]) {
    return htmlToCleanText(title[1]).replace(/\s*-\s*No Man'?s Sky\s*$/i, "");
  }

  return "Nuevo post de No Man's Sky";
}

function extractDateFromArticle(html) {
  const text = htmlToCleanText(html);

  const match = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i
  );

  return match?.[0] || null;
}

function extractMainTextFromArticle(html, title, dateText) {
  let articleHtml = html;

  const h1Index = articleHtml.search(/<h1/i);

  if (h1Index >= 0) {
    articleHtml = articleHtml.slice(h1Index);
  }

  articleHtml = articleHtml
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  let text = htmlToCleanText(articleHtml);

  if (title) {
    text = text.replace(title, "").trim();
  }

  if (dateText) {
    text = text.replace(dateText, "").trim();
  }

  text = text
    .replace(/\bContact\s+About\s+News\s+Press\s+Help Centre[\s\S]*$/i, "")
    .replace(/\bCookie Policy\s+Privacy Policy[\s\S]*$/i, "")
    .trim();

  return (
    text ||
    "Nuevo contenido publicado en la web oficial de No Man's Sky."
  );
}

function createCleanSummary(bodyText = "") {
  const text = bodyText
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const beforeBugFixes = text.split(/\bBug Fixes\b/i)[0].trim();

  const usefulText = beforeBugFixes || text;

  const paragraphs = usefulText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .filter((paragraph) => !/^hello everyone[,]?$/i.test(paragraph))
    .filter((paragraph) => !/^thank you[,]?$/i.test(paragraph))
    .filter((paragraph) => paragraph.length > 40);

  const summary = paragraphs.slice(0, 2).join("\n\n");

  return limitText(
    summary || "Nuevo post publicado en la web oficial de No Man’s Sky.",
    900
  );
}

function detectPostType(title = "", bodyText = "") {
  const combined = `${title}\n${bodyText}`.toLowerCase();

  if (
    combined.includes("patch") ||
    combined.includes("hotfix") ||
    combined.includes("bug fixes") ||
    /\b\d+\.\d+/.test(title)
  ) {
    return "Patch / Hotfix";
  }

  if (
    combined.includes("expedition") ||
    combined.includes("update") ||
    combined.includes("release")
  ) {
    return "Update / Anuncio";
  }

  return "Noticia";
}

function hasBugFixes(bodyText = "") {
  return /\bBug Fixes\b/i.test(bodyText) || /•\s*Fixed/i.test(bodyText);
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

  const elapsedMinutes = (Date.now() - lastChecked) / 1000 / 60;

  return elapsedMinutes < MIN_CHECK_INTERVAL_MINUTES;
}

async function fetchLatestPost() {
  const newsHtml = await fetchText(NEWS_URL);
  const latestUrl = getLatestArticleUrlFromNewsPage(newsHtml);

  const articleHtml = await fetchText(latestUrl);

  const title = extractTitleFromArticle(articleHtml);
  const dateText = extractDateFromArticle(articleHtml);
  const bodyText = extractMainTextFromArticle(articleHtml, title, dateText);
  const imageUrl = extractFirstImage(articleHtml);
  const youtubeUrl = extractYoutubeUrl(articleHtml);

  return {
    title,
    url: latestUrl,
    date: dateText,
    bodyText,
    imageUrl,
    youtubeUrl,
    postType: detectPostType(title, bodyText),
    summary: createCleanSummary(bodyText),
    hasBugFixes: hasBugFixes(bodyText),
  };
}

async function sendToDiscord(post) {
  if (!DISCORD_WEBHOOK_URL) {
    throw new Error("No existe DISCORD_WEBHOOK_URL. No se puede publicar.");
  }

  const contentLines = [
    ":rocket: **Nuevo post oficial de No Man's Sky**",
  ];

  if (post.youtubeUrl) {
    contentLines.push(`?? ${post.youtubeUrl}`);
  }

  const fields = [
    {
      name: "Tipo",
      value: post.postType,
      inline: true,
    },
  ];

  if (post.date) {
    fields.push({
      name: "Fecha",
      value: post.date,
      inline: true,
    });
  }

  if (post.hasBugFixes) {
    fields.push({
      name: "Detalles",
      value: "Incluye cambios, correcciones y bug fixes. Ver lista completa en el post oficial.",
      inline: false,
    });
  }

  fields.push({
    name: "Post oficial",
    value: `[Leer completo en nomanssky.com](${post.url})`,
    inline: false,
  });

  const embed = {
    title: limitText(post.title, 250),
    url: post.url,
    description: post.summary,
    fields,
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
