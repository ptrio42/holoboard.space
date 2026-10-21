/** Embedders and the service wrapper share this HTTP handler boundary. */
export type AccountRequestHandler = (request: Request) => Promise<Response>;
