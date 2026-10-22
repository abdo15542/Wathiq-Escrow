const { createApp } = require('./app');

const port = Number(process.env.PORT || 4000);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`Wathiq API listening on ${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down Wathiq API`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
