import { ProviderError } from "../errors.js";

/**
 * The pinned version of the extractor, included in logs to track which parser observed a payload.
 */
export const EXTRACTOR_VERSION = "flight-json-v1";

/**
 * Extracts RSC (React Server Component) Flight payloads embedded in Next.js HTML.
 * It finds all `self.__next_f.push(...)` chunks, concatenates the string data,
 * and parses the line-based RSC format into a list of JSON objects.
 */
export function extractFlightJSON(html: string): unknown[] {
  let stream = "";
  const prefix = "self.__next_f.push(";
  let idx = 0;

  while ((idx = html.indexOf(prefix, idx)) !== -1) {
    idx += prefix.length;
    let depth = 1;
    let end = idx;
    let inString = false;
    let escape = false;

    while (end < html.length && depth > 0) {
      const char = html[end];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === "\\") {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
      } else {
        if (char === '"') {
          inString = true;
        } else if (char === "(") {
          depth++;
        } else if (char === ")") {
          depth--;
        }
      }
      end++;
    }

    if (depth !== 0) {
      throw new ProviderError(
        "UPSTREAM_CHANGED",
        "Malformed Flight payload: unbalanced parentheses in chunk",
        { providerMeta: {} },
      );
    }

    const chunk = html.substring(idx, end - 1);
    try {
      const parsed: unknown = JSON.parse(chunk);
      if (Array.isArray(parsed) && typeof parsed[1] === "string") {
        stream += parsed[1];
      }
    } catch (err) {
      throw new ProviderError(
        "UPSTREAM_CHANGED",
        "Malformed Flight payload: chunk failed to parse",
        { providerMeta: { error: String(err) } },
      );
    }
  }

  const lines = stream.split("\n");
  const results: unknown[] = [];

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const id = line.slice(0, colonIdx);
      // RSC IDs are typically alphanumeric
      if (/^[0-9a-zA-Z]+$/.test(id)) {
        const payload = line.slice(colonIdx + 1);
        // Flight row types. Text rows ("T<hexlen>,<text>" — AMC's stream carries
        // NewRelic scripts, CSS, and SVG icons), string references ("S..."), error rows
        // ("E{...}" digests), and hint rows ("H..." preload hints) carry no
        // shape-searchable JSON model data: skip them. Import rows ("I<json>") carry
        // JSON after their marker.
        if (/^[SEH]/.test(payload) || /^T[0-9a-fA-F]+,/.test(payload)) {
          continue;
        }
        const jsonStr = payload.startsWith("I") ? payload.slice(1) : payload;
        try {
          results.push(JSON.parse(jsonStr));
        } catch (err) {
          throw new ProviderError(
            "UPSTREAM_CHANGED",
            "Malformed Flight payload: line failed to parse",
            { providerMeta: { error: String(err) } },
          );
        }
      }
    }
  }

  return results;
}

/**
 * Deeply traverses an object or array to find all objects that match a given predicate.
 */
export function deepFind<T>(
  obj: unknown,
  predicate: (val: Record<string, unknown>) => boolean,
): T[] {
  const results: T[] = [];
  const seen = new Set<unknown>();

  function search(node: unknown) {
    if (!node || typeof node !== "object" || seen.has(node)) {
      return;
    }
    seen.add(node);

    if (!Array.isArray(node) && predicate(node as Record<string, unknown>)) {
      results.push(node as T);
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        search(item);
      }
    } else {
      for (const key of Object.keys(node)) {
        search((node as Record<string, unknown>)[key]);
      }
    }
  }

  search(obj);
  return results;
}

/**
 * Searches the HTML payload for a specific object shape.
 * Throws UPSTREAM_CHANGED if no objects matching the shape are found.
 */
export function extractShapeFromHtml<T>(
  html: string,
  predicate: (val: Record<string, unknown>) => boolean,
  shapeName: string,
): T[] {
  const chunks = extractFlightJSON(html);
  const found = deepFind<T>(chunks, predicate);

  if (found.length === 0) {
    throw new ProviderError(
      "UPSTREAM_CHANGED",
      `Could not locate ${shapeName} shape in Flight payload`,
    );
  }

  return found;
}
