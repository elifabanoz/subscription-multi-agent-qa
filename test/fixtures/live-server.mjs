import { createServer } from 'node:http';

const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>QA Fixture</title><h1>Live QA Ready</h1><label>Email<input name="email"></label><button aria-label="Continue">Continue</button>');
});

server.listen(4173, '127.0.0.1', () => console.log('READY'));
