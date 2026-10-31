// DOURGA DATA REVOLUTION - proxy economique (version 2)
// Mesure les tailles reelles au lieu d'une estimation fixe.

const UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 DourgaData";
const DEFAULT_SIZE = { img: 25000, js: 40000, css: 30000 };
const PER_KIND = 12;

async function gzipSize(text) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(text));
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return buf.byteLength;
}

function collectResources(html, pageUrl) {
  const map = new Map();
  const add = (raw, kind) => {
    try {
      const abs = new URL(raw.replace(/&amp;/g, "&"), pageUrl).href;
      if (/^https?:/.test(abs) && !map.has(abs)) map.set(abs, { url: abs, kind: kind });
    } catch (e) {}
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const s = m[0].match(/\ssrc=["']([^"']+)["']/i);
    if (s) add(s[1], "img");
  }
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const s = m[0].match(/\ssrc=["']([^"']+)["']/i);
    if (s) add(s[1], "js");
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/\srel=["']?stylesheet/i.test(m[0])) {
      const h = m[0].match(/\shref=["']([^"']+)["']/i);
      if (h) add(h[1], "css");
    }
  }
  return Array.from(map.values());
}

async function measureResources(list) {
  const sample = [];
  const rest = [];
  const cnt = { img: 0, js: 0, css: 0 };
  for (const f of list) {
    if (cnt[f.kind] < PER_KIND) {
      cnt[f.kind]++;
      sample.push(f);
    } else {
      rest.push(f);
    }
  }
  const sized = await Promise.all(sample.map(async (f) => {
    try {
      const h = await fetch(f.url, {
        method: "HEAD",
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(3000),
      });
      const n = parseInt(h.headers.get("content-length") || "0", 10);
      return { kind: f.kind, size: n > 0 ? n : 0 };
    } catch (e) {
      return { kind: f.kind, size: 0 };
    }
  }));
  const avg = {};
  for (const k of ["img", "js", "css"]) {
    const known = sized.filter((x) => x.kind === k && x.size > 0).map((x) => x.size);
    avg[k] = known.length ? known.reduce((a, b) => a + b, 0) / known.length : DEFAULT_SIZE[k];
  }
  const totals = { img: 0, js: 0, css: 0 };
  for (const x of sized) totals[x.kind] += x.size || avg[x.kind];
  for (const f of rest) totals[f.kind] += avg[f.kind];
  return {
    totals: totals,
    measured: sized.filter((x) => x.size > 0).length,
    found: list.length,
  };
}

export default {
  async fetch(req) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-original-bytes,x-delivered-bytes,x-measure",
    };

    const p = new URL(req.url).searchParams;
    const target = p.get("url");
    if (!target || !/^https?:\/\//.test(target))
      return new Response("URL invalide", { status: 400, headers: cors });

    const keepImg = p.get("img") === "1";
    const keepJs = p.get("js") === "1";
    const keepCss = p.get("css") !== "0";

    let r;
    try {
      r = await fetch(target, { headers: { "user-agent": UA } });
    } catch (e) {
      return new Response("Page inaccessible", { status: 502, headers: cors });
    }

    const type = r.headers.get("content-type") || "";
    if (!type.includes("text/html"))
      return new Response("Contenu non HTML bloqué (économie de données).", { status: 415, headers: cors });

    const pageUrl = r.url || target;
    const original = await r.text();

    const resources = collectResources(original, pageUrl);
    const results = await Promise.all([gzipSize(original), measureResources(resources)]);
    const origHtmlGz = results[0];
    const m = results[1];

    let html = original;
    html = html.replace(/<!--[\s\S]*?-->/g, "");
    html = html.replace(/<link\b[^>]*rel=["']?(?:preload|prefetch|preconnect|dns-prefetch|modulepreload)[^>]*>/gi, "");

    if (!keepJs) {
      html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
      html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
    }
    if (!keepImg) {
      html = html.replace(/<picture[\s\S]*?<\/picture>/gi, "");
      html = html.replace(/<img\b[^>]*>/gi, "");
      html = html.replace(/<video[\s\S]*?<\/video>/gi, "");
      html = html.replace(/<audio[\s\S]*?<\/audio>/gi, "");
      html = html.replace(/<source\b[^>]*>/gi, "");
      html = html.replace(/<svg[\s\S]*?<\/svg>/gi, "");
    }
    if (!keepCss) {
      html = html.replace(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi, "");
    }

    html = html.replace(/<base\b[^>]*>/gi, "");
    html = html.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n");

    const baseTag = '<base href="' + pageUrl.replace(/"/g, "&quot;") + '">';
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (tag) => tag + baseTag);
    } else {
      html = baseTag + html;
    }

    const newHtmlGz = await gzipSize(html);
    const t = m.totals;
    const origRes = t.img + t.js + t.css;
    const keptRes = (keepImg ? t.img : 0) + (keepJs ? t.js : 0) + (keepCss ? t.css : 0);

    return new Response(html, {
      headers: {
        ...cors,
        "content-type": "text/html; charset=utf-8",
        "x-original-bytes": String(Math.round(origHtmlGz + origRes)),
        "x-delivered-bytes": String(Math.round(newHtmlGz + keptRes)),
        "x-measure": m.measured + "/" + m.found,
      },
    });
  },
};
