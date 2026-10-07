import { createApp } from '../server.mjs';

let app;
export default async function handler(request, response) {
  app ||= createApp({ serverless: true });
  const url = new URL(request.url, 'https://dashboard.invalid');
  const route = url.searchParams.get('route');
  if (route !== null) { url.searchParams.delete('route'); request.url = '/api/' + route + (url.search ? url.search : ''); }
  return app.handler(request, response);
}
