/** Recorded content is data. The opaque outer sandbox and CSP are the final boundary. */
const blocked = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "link",
  "form",
  "audio",
  "video",
  "source",
]);
export function sanitizeReplay(
  value: unknown,
  assets: Record<string, string>,
): unknown {
  const replace = (text: string) =>
    text.replace(
      /replay-asset:\/\/([a-f0-9]{64})/g,
      (_, hash: string) => assets[hash] ?? "about:blank",
    );
  const css = (text: string) =>
    replace(text)
      .replace(/@import\s+[^;]+;?/gi, "")
      .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, q: string, url: string) =>
        url.startsWith("blob:")
          ? `url("${url.replace(/["\\\n\r]/g, "")}")`
          : 'url("about:blank")',
      );
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (!v || typeof v !== "object")
      return typeof v === "string" ? replace(v) : v;
    const o = v as Record<string, unknown>,
      out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (["__proto__", "prototype", "constructor"].includes(k)) continue;
      if (k === "tagName") {
        out[k] =
          blocked.has(String(x).toLowerCase()) ||
          (o.attributes &&
            typeof o.attributes === "object" &&
            (o.attributes as Record<string, unknown>).type === "password")
            ? "div"
            : x;
        continue;
      }
      if (k === "attributes" && x && typeof x === "object") {
        const attrs: Record<string, unknown> = {};
        for (const [name, val] of Object.entries(x)) {
          if (
            /^on/i.test(name) ||
            /^(?:href|srcdoc|action|formaction|target|sandbox|integrity|crossorigin|nonce|password|ping|download|srcset|background|poster)$/i.test(
              name,
            )
          )
            continue;
          if (name === "src" || name === "rr_dataURL") {
            const replaced = replace(String(val));
            if (replaced.startsWith("blob:")) attrs[name] = replaced;
            else attrs["data-replay-missing-asset"] = "true";
            continue;
          }
          if (name === "style" || name === "_cssText") {
            attrs[name] = css(String(val));
            continue;
          }
          attrs[name] = clean(val);
        }
        if (
          ["input", "button", "textarea", "select"].includes(
            String(o.tagName).toLowerCase(),
          )
        ) {
          attrs.disabled = "";
          attrs.readonly = "";
          attrs.tabindex = "-1";
        }
        out[k] = attrs;
        continue;
      }
      if (
        k === "textContent" ||
        k === "rule" ||
        k === "cssText" ||
        k === "_cssText"
      )
        out[k] = css(String(x));
      else if (k === "href") out[k] = "about:blank";
      else out[k] = clean(x);
    }
    return out;
  };
  return clean(value);
}
