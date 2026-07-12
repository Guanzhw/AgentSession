import { send } from "./server-helpers.js";

export interface RouteResult {
  status: number;
  body: string;
  contentType?: string;
}

export type RouteHandler = (
  req: any,
  res: any,
  params: any
) => RouteResult | void | Promise<RouteResult | void>;

interface Route {
  method: string;
  pattern: string | RegExp;
  handler: RouteHandler;
}

function isRouteResult(value: unknown): value is RouteResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<RouteResult>;
  return Number.isInteger(result.status) && typeof result.body === "string";
}

export class Router {
  private readonly routes: Route[] = [];

  private add(method: string, pattern: string | RegExp, handler: RouteHandler) {
    this.routes.push({ method, pattern, handler });
  }

  get(pattern: string | RegExp, handler: RouteHandler) {
    this.add("GET", pattern, handler);
  }

  post(pattern: string | RegExp, handler: RouteHandler) {
    this.add("POST", pattern, handler);
  }

  private async runHandler(req: any, res: any, params: any, handler: RouteHandler) {
    const result = await handler(req, res, params);
    if (res.headersSent || res.writableEnded) {
      return;
    }
    if (result === undefined) {
      return;
    }
    if (!isRouteResult(result)) {
      throw new TypeError("Route handler returned an invalid response");
    }
    send(res, result.status, result.body, result.contentType || "text/html; charset=utf-8");
  }

  async dispatch(req: any, res: any, url: URL): Promise<boolean> {
    const pathname = url.pathname;
    const method = req.method || "GET";

    for (const route of this.routes) {
      if (route.method !== method) continue;

      if (typeof route.pattern === "string") {
        const paramNames: string[] = [];
        const regexStr = route.pattern.replace(/:([a-zA-Z][a-zA-Z0-9]*)/g, (_match, name) => {
          paramNames.push(name);
          return "([^/]+)";
        });
        const match = pathname.match(new RegExp(`^${regexStr}$`));
        if (match) {
          const params: Record<string, string> = {};
          paramNames.forEach((name, index) => {
            params[name] = match[index + 1];
          });
          await this.runHandler(req, res, params, route.handler);
          return true;
        }
      } else {
        const match = pathname.match(route.pattern);
        if (match) {
          await this.runHandler(req, res, match, route.handler);
          return true;
        }
      }
    }
    return false;
  }
}
