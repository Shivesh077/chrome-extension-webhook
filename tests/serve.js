const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT = 8001;
const FILE = path.join(__dirname, "demo.html");

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(fs.readFileSync(FILE));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Demo page running at http://127.0.0.1:${PORT}`);
});
