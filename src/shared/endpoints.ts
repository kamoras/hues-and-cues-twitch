/**
 * Runtime constants needed by the browser. Kept free of dependencies so that
 * importing them never pulls server-side libraries (zod) into the bundle.
 */
export const WS_PATH = '/ws';
