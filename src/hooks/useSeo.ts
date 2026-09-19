import { useEffect } from "react";

export interface SeoOptions {
  title: string;
  description?: string;
  /** Structured data object serialized as application/ld+json */
  jsonLd?: Record<string, unknown>;
  /** Page path used to emit hreflang alternates (en/zh) */
  path?: string;
}

/**
 * SPA-side SEO: sets document.title, description/og meta tags, hreflang
 * alternates, and a JSON-LD script tag. Cleans up the JSON-LD tag on
 * unmount. (Meta/og tags help social scrapers that execute JS; the
 * certification JSON is also available CDN-cacheable via tRPC.)
 */
export function useSeo({ title, description, jsonLd, path }: SeoOptions) {
  const jsonLdText = jsonLd ? JSON.stringify(jsonLd) : "";

  useEffect(() => {
    document.title = title;

    const setMeta = (attr: string, key: string, content: string) => {
      let el = document.head.querySelector(`meta[${attr}="${key}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };

    setMeta("property", "og:title", title);
    if (description) {
      setMeta("name", "description", description);
      setMeta("property", "og:description", description);
    }

    if (path) {
      const origin = window.location.origin;
      for (const lang of ["en", "zh"]) {
        let link = document.head.querySelector(
          `link[rel="alternate"][hreflang="${lang}"]`,
        ) as HTMLLinkElement | null;
        if (!link) {
          link = document.createElement("link");
          link.rel = "alternate";
          link.setAttribute("hreflang", lang);
          document.head.appendChild(link);
        }
        link.href = `${origin}${path}?lang=${lang}`;
      }
    }

    let script: HTMLScriptElement | null = null;
    if (jsonLdText) {
      script = document.createElement("script");
      script.type = "application/ld+json";
      script.text = jsonLdText;
      document.head.appendChild(script);
    }
    return () => {
      script?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, path, jsonLdText]);
}
