import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/profile.css', ['profile.css', 'text/css']],
  ['/profile.js', ['profile.js', 'text/javascript']],
  ['/industrial-strength.webp', ['industrial-strength.webp', 'image/webp']],
  ['/liz.webp', ['liz.webp', 'image/webp']],
  ['/columbina.jpg', ['columbina.jpg', 'image/jpeg']],
  ['/gallery-1.jpg', ['gallery-1.jpg', 'image/jpeg']],
  ['/gallery-2.jpg', ['gallery-2.jpg', 'image/jpeg']],
  ['/gallery-3.jpg', ['gallery-3.jpg', 'image/jpeg']],
]);

createServer(async (request, response) => {
  const file = files.get(request.url?.split('?')[0]);
  if (!file) {
    response.writeHead(404).end();
    return;
  }

  try {
    const [name, type] = file;
    const body = await readFile(new URL(name, import.meta.url));
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
}).listen(3001, '127.0.0.1', () => {
  console.log('Profile demo: http://demo.may-be.localhost:3001');
});
