export default {
  async fetch(req) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-original-bytes,x-delivered-bytes",
    };
    const p = new URL(req.url).searchParams;
    const target = p.get("url");
    if (!target || !/^https?:\/\//.test(target))
      return new Response("URL invalide", { status: 400, headers: cors });
    const keepImg = p.get("img") === "1";
    const keepJs = p.get("js") === "1";

    const r = await fetch(target, { headers: { "user-agent": "Mozilla/5.0 (Android) DourgaData" } });
    const type = r.headers.get("content-type") || "";
    if (!type.includes("text/html"))
      return new Response("Contenu non HTML bloqué (économie de données).", { status: 415, headers: cors });

    let html = await r.text();
    const orig = html.length;
    let removed = 0;
    const count = () => { removed += 15000; return ""; };

    if (!keepJs) {
      html = html.replace(/<script[\s\S]*?<\/script>/gi, count);
      html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, count);
    }
    if (!keepImg) {
      html = html.replace(/<img[^>]*>/gi, count);
      html = html.replace(/<video[\s\S]*?<\/video>/gi, count);
      html = html.replace(/<source[^>]*>/gi, "");
    }
    html = html.replace(/<base[^>]*>/gi, "");
    html = `<base href="${target}">` + html;

    return new Response(html, {
      headers: {
        ...cors,
        "content-type": "text/html; charset=utf-8",
        "x-original-bytes": String(orig + removed),
        "x-delivered-bytes": String(html.length),
      },
    });
  },
};
