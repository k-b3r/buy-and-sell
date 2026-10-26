import type { Response } from 'express'

// What a route handler returns: an HTTP status and a JSON body. Handlers stay
// body-in/result-out, so a unit test drives one without a socket; the router
// built around it is the only place that writes a response.
export interface RouteResult {
  statusCode: number
  body: unknown
}

/** A body-driven route handler. A router calls it with the parsed body. */
export type RouteHandler = (body: unknown) => Promise<RouteResult>

/** Answer a request with a handler's result. */
export function sendResult(res: Response, result: RouteResult): void {
  res.status(result.statusCode).json(result.body)
}
