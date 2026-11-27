const net = require('net');

// Host y puerto del servidor TCP: se pasan por variables de entorno para no
// dejar la IP del servidor escrita en el código público.
//   TCP_HOST=<IP_EC2> node demo-tcp.js
const HOST = process.env.TCP_HOST || 'localhost';
const PORT = Number(process.env.TCP_PORT || 6061);

const email = `demo${Date.now()}@test.com`;

const socket = net.createConnection(PORT, HOST, () => {
  console.log(`Conectado al servidor TCP en ${HOST}:${PORT}`);
  socket.write(`{insert:{"nombre":"Demo","email":"${email}"}}\n`);
});

socket.setEncoding('utf8');
socket.on('data', (d) => console.log('Respuesta:', d.trim()));
socket.on('error', (e) => console.log('ERROR:', e.message));

setTimeout(() => socket.end(), 2000);
