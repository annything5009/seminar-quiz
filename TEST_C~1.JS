const { io } = require("socket.io-client");
const key = process.argv[2];

async function main() {
  const host = io("http://localhost:3000");
  const p1 = io("http://localhost:3000");
  const p2 = io("http://localhost:3000");

  await new Promise(r => setTimeout(r, 300));

  host.emit("host:auth", { key }, (res) => {
    console.log("host auth:", res);
  });

  p1.emit("join", { name: "Alice" });
  p2.emit("join", { name: "Bob" });

  host.on("host:lobby", (d) => console.log("lobby:", d));
  host.on("host:question", (q) => console.log("host sees question:", q.question, "correctIndex", q.correctIndex));
  host.on("host:reveal", (r) => console.log("host reveal dist:", r.distribution, "top3:", r.top3));
  host.on("host:gameOver", (d) => { console.log("GAME OVER top3:", d.top3); process.exit(0); });

  const answers = [0,1,1,1,1,1,1,2,1,0];

  p1.on("question", (q) => {
    setTimeout(() => p1.emit("answer", { choiceIndex: answers[q.index] }), 200); // fast correct
  });
  p2.on("question", (q) => {
    setTimeout(() => p2.emit("answer", { choiceIndex: (answers[q.index]+1) % q.choices.length }), 500); // wrong, slower
  });

  p1.on("reveal", (r) => console.log("Alice reveal:", r));
  p2.on("reveal", (r) => console.log("Bob reveal:", r));

  await new Promise(r => setTimeout(r, 600));
  host.emit("host:start");

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1200));
    host.emit("host:next");
  }

  setTimeout(() => { console.log("TIMEOUT - game did not end"); process.exit(1); }, 3000);
}
main();
