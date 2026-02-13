import app from "./app.ts";

const port = Number(process.env.PORT) || 4400;
console.log(`Trading server on http://localhost:${port}`);

export default { port, fetch: app.fetch };
