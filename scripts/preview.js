// The preview never sends catalogue data to external model providers.
process.env.LLM_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_MODEL = "offline-preview";

const { app } = await import("../src/server.js");
const firstPort = Number(process.env.PORT || 3000);
if (!Number.isInteger(firstPort) || firstPort < 1 || firstPort > 65525) throw new Error("Invalid preview port");

let listening = false;
for (let port = firstPort; port < firstPort + 10; port += 1) {
  const server = app.listen(port, "127.0.0.1");
  const error = await new Promise((resolve) => {
    server.once("listening", () => resolve(null));
    server.once("error", resolve);
  });
  if (!error) {
    console.log(`Сайт: http://localhost:${port}`);
    console.log("Объяснения по фактам каталога. Внешние API отключены.");
    listening = true;
    break;
  }
  if (error.code !== "EADDRINUSE") throw error;
}
if (!listening) throw new Error("No available preview port");
