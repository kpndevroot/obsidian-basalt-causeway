/**
 * The bridge to the Dataview plugin, reached through Obsidian's plugin registry.
 *
 * Deliberately not an `import` of `obsidian-dataview`: Dataview is an optional peer that the
 * user may not have installed, and a static import would make this plugin fail to load without
 * it. Everything here degrades to "Dataview is absent", which is an ordinary state — most
 * vaults do not have it.
 *
 * `app.plugins` is not part of Obsidian's public typings, hence the narrow cast. That is the
 * accepted way to talk to another plugin, and the shape is re-checked at runtime rather than
 * trusted.
 */

import type { App } from 'obsidian';

import { bakeDataview, type RenderQuery } from '../sync/dataview';

/** Dataview's `Result<string, string>` — success and failure share one shape. */
type QueryResult = { successful: boolean; value?: string; error?: string };

type DataviewApi = {
  queryMarkdown: (source: string, originFile?: string, settings?: unknown) => Promise<QueryResult>;
};

export function getDataviewApi(app: App): DataviewApi | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: unknown }> } }).plugins;
  const api = plugins?.plugins?.dataview?.api as DataviewApi | undefined;
  return api && typeof api.queryMarkdown === 'function' ? api : null;
}

/**
 * A `RenderQuery` backed by the live Dataview instance.
 *
 * `originFile` matters: a query saying `FROM ""` or using `this.file` resolves relative to the
 * note it sits in, so rendering without it silently produces a *different* table than the one
 * the user sees in Obsidian.
 */
export function createRenderer(api: DataviewApi, onError: (path: string, error: string) => void): RenderQuery {
  return async (query, kind, path) => {
    // `dataviewjs` is arbitrary JavaScript that renders into a DOM node. There is no static
    // markdown for it, and running it here would execute vault code during a sync — so it is
    // published as the code block it is.
    if (kind !== 'dataview') return null;

    try {
      const result = await api.queryMarkdown(query, path);
      if (!result.successful || typeof result.value !== 'string') {
        onError(path, result.error ?? 'the query did not return markdown');
        return null;
      }
      return result.value;
    } catch (err) {
      onError(path, err instanceof Error ? err.message : String(err));
      // Leaving the fence untouched publishes the query verbatim, which is honest. Publishing
      // an error message into the user's note would not be.
      return null;
    }
  };
}

/** The baker the sync engine takes, or null when Dataview is not installed. */
export function createBaker(
  app: App,
  onError: (path: string, error: string) => void,
): ((content: string, path: string) => Promise<string>) | null {
  const api = getDataviewApi(app);
  if (!api) return null;

  const render = createRenderer(api, onError);
  return (content, path) => bakeDataview(content, path, render);
}
